/**
 * Room-scene dispatcher — castle owns the trigger for dynamically blending
 * a common room's current occupants into a cached background image, the
 * same "castle notices on its own" pattern as PulseAnimaDispatcher.
 *
 * Core requirement (not an incidental detail): the system must notice
 * occupancy on its own via a periodic tick, not generate only when
 * triggered by hand. Mirrors
 * pulse-anima-dispatcher.ts's DI shape so it's independently testable
 * without real network/fs/timers.
 *
 * Naming/behavior spec:
 * - 1 agent in a common room → look for "<placeId>_<agentId>.png"; if
 *   missing and quota remains, generate + cache it; if quota is exhausted,
 *   leave the room on its plain default background (never crash/never
 *   block the room render on a failed or skipped generation).
 * - 2+ agents → same, keyed by "<placeId>_<sorted_agent_ids_joined_by_'_'>"
 *   (see room-scene-key.ts) so "gus,bruno" and "bruno,gus" both resolve
 *   to the same cached file.
 * - Pulse-anima's Library ticks are a hard exception: while
 *   pulse-anima-dispatcher.ts's LIBRARY_ACTIVE_FLAG is set (a real cycle is
 *   currently occupying library), NEVER generate — that scene already has
 *   its own anima_batchN.png, so even if more agents come in, 5
 *   people are never blended. (Previously this matched the occupant combo
 *   against a frozen snapshot of the 4 rotations, pulse-anima-ticks.ts, which
 *   drifts out of sync because each stage's rotation advances independently, silently
 *   defeating the guard and burning the image quota. That combo list is still
 *   used by the client to pick which static anima_batchN.png to display, just
 *   no longer to gate generation.)
 * - $10 hard budget (~50 images) — IMAGE_GEN_QUOTA_MAX
 *   is a hard ceiling, checked BEFORE any paid call, never bypassed.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { isLibraryActive } from "./pulse-anima-dispatcher";
import { roomSceneFileName } from "../narrative/room-scene-key";

export interface Presence {
  agentId: string;
  placeId: string;
}

/** A $10 budget is roughly 50 images — a hard ceiling, not a soft target. */
export const IMAGE_GEN_QUOTA_MAX = 50;

const QUOTA_FLAG_KEY = "room-scene-gen-count";

export type MarkStore = {
  getMark: (key: string) => { value: string } | null;
  setMark: (key: string, value: string, setBy: string) => void;
};

export function getGenerationCount(store: MarkStore): number {
  const flag = store.getMark(QUOTA_FLAG_KEY);
  if (!flag) return 0;
  const n = parseInt(flag.value, 10);
  return Number.isFinite(n) ? n : 0;
}

export function hasQuotaRemaining(store: MarkStore): boolean {
  return getGenerationCount(store) < IMAGE_GEN_QUOTA_MAX;
}

function incrementGenerationCount(store: MarkStore): void {
  store.setMark(QUOTA_FLAG_KEY, String(getGenerationCount(store) + 1), "room-scene-dispatcher");
}

export interface ImageRef {
  imageBytes: Uint8Array;
  mimeType: string;
}

export interface PortraitRef extends ImageRef {
  agentId: string;
}

export interface BlendedImage {
  bytes: Uint8Array;
  /** Preserved from the actual API response (e.g. "image/jpeg" or
   *  "image/png") — saveBackground must pick a matching file extension, or
   *  the server's content-type header (set from the extension it finds)
   *  mismatches the real bytes. */
  mimeType: string;
}

export interface RoomSceneDispatcherDeps {
  /** All common-room placeIds this dispatcher is allowed to touch. */
  commonRoomPlaceIds: string[];
  listPresence: () => Presence[];
  /** Does `backgrounds/<filename>.<ext>` already exist for any known ext? */
  hasBackgroundFile: (filename: string) => boolean;
  /** Reads an agent's existing portrait, or null if it doesn't exist yet —
   *  can't blend a reference that isn't there. */
  readPortrait: (agentId: string) => Promise<PortraitRef | null>;
  /** Reads the room's own existing default background (e.g. hall_main.png) —
   *  the real scene to blend occupants INTO, not a re-described text prompt
   *  (requirement: blend the existing room background and the occupant's
   *  portrait; both images already exist, so use them as references instead
   *  of reinventing the room from a text label). */
  readRoomBackground: (placeId: string) => Promise<ImageRef | null>;
  /** One human-readable scene description per placeId, supplementary text
   *  guidance alongside the real background reference. */
  roomLabel: (placeId: string) => string;
  /** Calls the real (paid) blend API. `base` is the room's existing
   *  background image when one exists — null only means the room truly has
   *  no default art yet. */
  generateBlend: (base: ImageRef | null, portraits: PortraitRef[], roomLabel: string) => Promise<BlendedImage>;
  saveBackground: (filename: string, image: BlendedImage) => Promise<void>;
  store: MarkStore;
  /** While paid generation is paused, never call
   *  generateBlend — but still drop a `<filename>_placeholder.<ext>` (a copy
   *  of the room's plain default background) so a missing combo is visible
   *  on disk as "needs generating" instead of silently doing nothing. The
   *  room itself keeps rendering the plain default either way. */
  generationPaused: boolean;
}

/** One dispatcher instance owns its own in-flight set — a real 5-agent room
 *  entering over a couple of consecutive ticks (tick interval < generation
 *  latency) must not fire two paid generations for the same combination. */
export class RoomSceneDispatcher {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: RoomSceneDispatcherDeps) {}

  async tick(): Promise<void> {
    const byPlace = new Map<string, string[]>();
    for (const p of this.deps.listPresence()) {
      if (!this.deps.commonRoomPlaceIds.includes(p.placeId)) continue;
      const list = byPlace.get(p.placeId) ?? [];
      list.push(p.agentId);
      byPlace.set(p.placeId, list);
    }

    for (const [placeId, occupants] of byPlace) {
      await this.resolveRoom(placeId, occupants);
    }
  }

  private async resolveRoom(placeId: string, occupants: string[]): Promise<void> {
    if (occupants.length === 0) return;

    // Pulse-anima owns Library's background entirely during a real tick —
    // never blend, never spend quota, regardless of occupant count or
    // whether the occupant combo happens to match a known rotation snapshot
    // (it can drift — see LIBRARY_ACTIVE_FLAG's comment).
    if (placeId === "library" && isLibraryActive(this.deps.store)) return;

    const filename = roomSceneFileName(placeId, occupants);
    if (this.deps.hasBackgroundFile(filename)) return; // already cached
    if (this.inFlight.has(filename)) return; // a previous tick is still generating this exact combo

    // Paused or out of budget: never call the paid API, but still mark the
    // combo as "needs generating" with a placeholder copy of the room's
    // plain default — the room keeps rendering that same default either way.
    if (this.deps.generationPaused || !hasQuotaRemaining(this.deps.store)) {
      await this.writePlaceholder(placeId, filename);
      return;
    }

    this.inFlight.add(filename);
    try {
      const portraits: PortraitRef[] = [];
      for (const agentId of occupants) {
        const p = await this.deps.readPortrait(agentId);
        if (p) portraits.push(p);
      }
      if (portraits.length === 0) return; // nothing to blend against

      const base = await this.deps.readRoomBackground(placeId);
      const blended = await this.deps.generateBlend(base, portraits, this.deps.roomLabel(placeId));
      await this.deps.saveBackground(filename, blended);
      incrementGenerationCount(this.deps.store);
    } catch {
      // A failed/expensive call must never break the room or the dispatcher
      // loop — next tick will simply try again (still gated by quota).
    } finally {
      this.inFlight.delete(filename);
    }
  }

  /** Write-once: skip if a placeholder for this combo already exists. */
  private async writePlaceholder(placeId: string, filename: string): Promise<void> {
    const placeholderName = `${filename}_placeholder`;
    if (this.deps.hasBackgroundFile(placeholderName)) return;
    try {
      const base = await this.deps.readRoomBackground(placeId);
      if (!base) return; // room has no default art yet — nothing to copy
      await this.deps.saveBackground(placeholderName, { bytes: base.imageBytes, mimeType: base.mimeType });
    } catch {
      // Best-effort marker only — never break the tick loop over it.
    }
  }
}

// ── Production wiring ───────────────────────────────────────────────────────

/** One scene descriptor per common-room placeId, for the blend prompt — same
 *  fantasy-castle flavor as PublicRoomPage.tsx's ROOM_AMBIENT_DETAIL, phrased
 *  positively (a place being visited, not described as empty). */
const ROOM_LABELS: Record<string, string> = {
  hall_main: "a grand medieval council hall with a long meeting table and banners",
  library: "a cozy medieval library with tall bookshelves, a fireplace, and warm lamplight",
  observatory: "an observatory with a large telescope beneath a glass-domed ceiling at night",
  workshop: "a busy forge and workshop with an anvil, tools, and glowing embers",
  garden: "a relaxed garden bodega with lanterns, plants, and outdoor seating",
  gate_world: "a stone bridge at the castle's edge overlooking the horizon",
};

function defaultRoomLabel(placeId: string): string {
  return ROOM_LABELS[placeId] ?? "a room in the castle";
}

const IMAGE_FORMATS = ["png", "webp", "jpg", "jpeg", "gif"];
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
};
const EXT_BY_MIME: Record<string, string> = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/gif": "gif" };

function hasBackgroundFileReal(assetsDir: string, filename: string): boolean {
  return IMAGE_FORMATS.some((ext) => existsSync(join(assetsDir, "backgrounds", `${filename}.${ext}`)));
}

async function readPortraitReal(assetsDir: string, agentId: string): Promise<PortraitRef | null> {
  for (const ext of IMAGE_FORMATS) {
    const emotionPath = join(assetsDir, "portraits", agentId, `neutral.${ext}`);
    if (existsSync(emotionPath)) {
      return { agentId, imageBytes: await readFile(emotionPath), mimeType: MIME_BY_EXT[ext] };
    }
  }
  for (const ext of IMAGE_FORMATS) {
    const mainPath = join(assetsDir, "portraits", `${agentId}.${ext}`);
    if (existsSync(mainPath)) {
      return { agentId, imageBytes: await readFile(mainPath), mimeType: MIME_BY_EXT[ext] };
    }
  }
  return null;
}

async function saveBackgroundReal(assetsDir: string, filename: string, image: BlendedImage): Promise<void> {
  const ext = EXT_BY_MIME[image.mimeType] ?? "png";
  await writeFile(join(assetsDir, "backgrounds", `${filename}.${ext}`), image.bytes);
}

/** Reads the room's own existing default background (e.g. backgrounds/
 *  hall_main.png) — the real scene occupants get blended INTO. Null only
 *  when the room genuinely has no default art yet. */
async function readRoomBackgroundReal(assetsDir: string, placeId: string): Promise<ImageRef | null> {
  for (const ext of IMAGE_FORMATS) {
    const path = join(assetsDir, "backgrounds", `${placeId}.${ext}`);
    if (existsSync(path)) {
      return { imageBytes: await readFile(path), mimeType: MIME_BY_EXT[ext] };
    }
  }
  return null;
}

/** Varied poses/actions for the blended pose prompt, because a flat
 *  standing-and-staring result looked unnatural (options include sitting on a
 *  chair, standing next to the wall, looking around curiously). Picked once per portrait at generation time — the
 *  result is cached per combo, so "random" means variety ACROSS different
 *  combos, not a moving target for an already-cached scene. */
// A pose once caused the model to invent a table full
// of new pots/bottles that weren't in the real background; the scenery must
// stay exact, so every pose must only
// reference furniture/fixtures already generically present in these rooms
// (a wall, a window, a chair, a table's edge), never "something" vague
// enough to invite the model to add new objects.
const POSE_OPTIONS = [
  "sitting on one of the existing chairs",
  "standing near a wall, leaning casually against it",
  "looking around the room with curious interest",
  "walking across the room",
  "resting a hand on the edge of the existing table",
  "standing by a window looking outside",
  "mid-stride, caught in a candid walking pose",
  "leaning against a support beam or column",
];

export function pickRandomPose(random: () => number = Math.random): string {
  return POSE_OPTIONS[Math.floor(random() * POSE_OPTIONS.length)];
}

/** Gemini's imageConfig.aspectRatio only accepts this fixed set. The
 *  model once returned a different aspect ratio/resolution than the room's
 *  real background; the requirement is to keep the background resolution and
 *  only blend the portrait in. This is a best-effort hint to reduce how much the
 *  guaranteed hard-resize below (resizeToMatch) has to crop. */
const SUPPORTED_ASPECT_RATIOS: Array<[string, number]> = [
  ["1:1", 1], ["1:4", 0.25], ["1:8", 0.125], ["2:3", 2 / 3], ["3:2", 1.5], ["3:4", 0.75],
  ["4:1", 4], ["4:3", 4 / 3], ["4:5", 0.8], ["5:4", 1.25], ["8:1", 8], ["9:16", 9 / 16],
  ["16:9", 16 / 9], ["21:9", 21 / 9],
];

export function nearestSupportedAspectRatio(width: number, height: number): string {
  const target = width / height;
  let best = SUPPORTED_ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  for (const candidate of SUPPORTED_ASPECT_RATIOS) {
    const diff = Math.abs(candidate[1] - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best[0];
}

/** Guaranteed correctness backstop for resolution — the model's aspectRatio
 *  hint is best-effort (known to sometimes be ignored) and never controls
 *  exact pixel dimensions anyway, so the output is hard-resized to the
 *  room's real background dimensions regardless of what the model returns.
 *  `fit: "cover"` crops rather than stretches, since the composition should
 *  already be close given the base image + aspect hint. */
export async function resizeToMatch(image: BlendedImage, width: number, height: number): Promise<BlendedImage> {
  const isJpeg = image.mimeType === "image/jpeg";
  let pipeline = sharp(Buffer.from(image.bytes)).resize(width, height, { fit: "cover" });
  pipeline = isJpeg ? pipeline.jpeg({ quality: 92 }) : pipeline.png();
  const bytes = await pipeline.toBuffer();
  return { bytes, mimeType: isJpeg ? "image/jpeg" : "image/png" };
}

/** Real (paid) call to Gemini's multi-image blend.
 *  Sends the room's REAL existing background plus each occupant's existing
 *  portrait as inlineData references — not a text-only re-description of
 *  the room (a text-only prompt produced a generic reinvented scene). Returns
 *  the first inlineData image found in the response. Throws on any non-2xx
 *  or missing image data — the dispatcher's caller treats any throw as
 *  "skip this tick, retry later," so this never needs its own fallback. */
async function generateBlendReal(apiKey: string, base: ImageRef | null, portraits: PortraitRef[], roomLabel: string): Promise<BlendedImage> {
  const parts: unknown[] = [];
  if (base) {
    parts.push({ inlineData: { mimeType: base.mimeType, data: Buffer.from(base.imageBytes).toString("base64") } });
  }
  for (const p of portraits) {
    parts.push({ inlineData: { mimeType: p.mimeType, data: Buffer.from(p.imageBytes).toString("base64") } });
  }
  const poses = portraits.map(() => pickRandomPose());
  // A character leaning on a pillar still stared straight at the camera, so
  // pose alone isn't enough: gaze needs its own
  // instruction or the model defaults back to a portrait-style stare.
  const gazeInstruction = "Their gaze should NOT be directed at the camera/viewer — have them looking at something else in the scene (the surroundings, an object, into the distance), like a candid photo rather than a posed portrait.";
  const poseInstruction = portraits.length === 1
    ? `The character should be ${poses[0]} — a candid, natural moment, not simply standing still facing the camera. ${gazeInstruction}`
    : `Give each character a different natural pose or action, not all standing and facing the camera: ${poses.map((pose, i) => `character ${i + 1} ${pose}`).join("; ")}. ${gazeInstruction}`;
  // A pose once caused the model to invent a table full
  // of new pots/bottles that weren't in the real background; the scene must
  // stay exactly as-is; only the character(s) get added, nothing else.
  const noInventionInstruction = "Do NOT add, invent, or change any objects, furniture, decorations, or props in the scene — the background must remain EXACTLY as given, pixel-for-pixel identical aside from the character(s) being inserted into it.";
  const instruction = base
    ? `The first image is this room's actual background (${roomLabel}). Blend the ${portraits.length} character${portraits.length > 1 ? "s" : ""} from the following reference image${portraits.length > 1 ? "s" : ""} naturally into that exact background — keep the room's layout, furniture, and lighting from the first image unchanged, and keep each character's face, hair, and outfit recognizable and consistent with their reference image. ${poseInstruction} ${noInventionInstruction}`
    : `Blend these ${portraits.length} character${portraits.length > 1 ? "s" : ""} together into one single coherent illustrated scene: ${roomLabel}. Keep each character's face, hair, and outfit recognizable and consistent with their reference image. ${poseInstruction}`;
  parts.push({ text: instruction });

  let baseDimensions: { width: number; height: number } | null = null;
  const body: Record<string, unknown> = { contents: [{ parts }] };
  if (base) {
    const meta = await sharp(Buffer.from(base.imageBytes)).metadata();
    if (meta.width && meta.height) {
      baseDimensions = { width: meta.width, height: meta.height };
      body.generationConfig = { imageConfig: { aspectRatio: nearestSupportedAspectRatio(meta.width, meta.height) } };
    }
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`gemini blend failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
  };
  const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    throw new Error("gemini blend: no image data in response");
  }
  const result: BlendedImage = { bytes: Buffer.from(inline.data, "base64"), mimeType: inline.mimeType ?? "image/png" };
  // Hard requirement, not a suggestion: keep the resolution
  // of the background and only blend the portrait in. The aspectRatio hint above is
  // best-effort only; this guarantees the exact pixel dimensions regardless
  // of what the model actually returned.
  return baseDimensions ? resizeToMatch(result, baseDimensions.width, baseDimensions.height) : result;
}

export interface RoomSceneProductionOptions {
  /** e.g. ~/.anima/rooms/_shared/vn/assets */
  assetsDir: string;
  commonRoomPlaceIds: string[];
  listPresence: () => Presence[];
  store: MarkStore;
  /** Resolved Gemini API key (providers.d/gemini.yaml). */
  apiKey: string;
  /** See RoomSceneDispatcherDeps.generationPaused. */
  generationPaused: boolean;
}

/** Real production wiring — fs-backed portraits/backgrounds, the real
 *  Gemini blend call, and the real shared-flags quota store. */
export function createRoomSceneDispatcher(opts: RoomSceneProductionOptions): RoomSceneDispatcher {
  return new RoomSceneDispatcher({
    commonRoomPlaceIds: opts.commonRoomPlaceIds,
    listPresence: opts.listPresence,
    hasBackgroundFile: (filename) => hasBackgroundFileReal(opts.assetsDir, filename),
    readPortrait: (agentId) => readPortraitReal(opts.assetsDir, agentId),
    readRoomBackground: (placeId) => readRoomBackgroundReal(opts.assetsDir, placeId),
    roomLabel: defaultRoomLabel,
    generateBlend: (base, portraits, roomLabel) => generateBlendReal(opts.apiKey, base, portraits, roomLabel),
    saveBackground: (filename, image) => saveBackgroundReal(opts.assetsDir, filename, image),
    store: opts.store,
    generationPaused: opts.generationPaused,
  });
}
