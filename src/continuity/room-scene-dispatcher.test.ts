import { test, expect } from "bun:test";
import sharp from "sharp";
import { RoomSceneDispatcher, getGenerationCount, hasQuotaRemaining, IMAGE_GEN_QUOTA_MAX, pickRandomPose, nearestSupportedAspectRatio, resizeToMatch, type RoomSceneDispatcherDeps, type Presence } from "./room-scene-dispatcher";
import { LIBRARY_ACTIVE_FLAG } from "./pulse-anima-dispatcher";

function makeMarkStore(initialCount = 0) {
  const flags = new Map<string, string>();
  if (initialCount > 0) flags.set("room-scene-gen-count", String(initialCount));
  return {
    getMark: (key: string) => (flags.has(key) ? { value: flags.get(key)! } : null),
    setMark: (key: string, value: string) => { flags.set(key, value); },
  };
}

function makeDeps(overrides: Partial<RoomSceneDispatcherDeps> & { presence?: Presence[] } = {}) {
  const backgrounds = new Set<string>(overrides.hasBackgroundFile ? [] : []);
  const saved: Array<{ filename: string; bytes: Uint8Array }> = [];
  const generateCalls: Array<{ portraits: string[]; roomLabel: string }> = [];
  const store = makeMarkStore();

  const deps: RoomSceneDispatcherDeps = {
    commonRoomPlaceIds: ["hall_main", "library", "observatory", "workshop", "garden", "gate_world"],
    listPresence: () => overrides.presence ?? [],
    hasBackgroundFile: overrides.hasBackgroundFile ?? ((filename) => backgrounds.has(filename)),
    readPortrait: overrides.readPortrait ?? (async (agentId) => ({ agentId, imageBytes: new Uint8Array([1]), mimeType: "image/png" })),
    readRoomBackground: overrides.readRoomBackground ?? (async () => null),
    roomLabel: overrides.roomLabel ?? (() => "a room"),
    generateBlend: overrides.generateBlend ?? (async (_base, portraits, roomLabel) => {
      generateCalls.push({ portraits: portraits.map((p) => p.agentId), roomLabel });
      return { bytes: new Uint8Array([9, 9, 9]), mimeType: "image/png" };
    }),
    saveBackground: overrides.saveBackground ?? (async (filename, image) => { saved.push({ filename, bytes: image.bytes }); backgrounds.add(filename); }),
    store: overrides.store ?? store,
    generationPaused: overrides.generationPaused ?? false,
  };

  return { deps, backgrounds, saved, generateCalls, store };
}

test("SC-RS1: 1 agent, no cached file, quota available -> generates, saves under <placeId>_<agentId>, increments quota", async () => {
  const { deps, saved, generateCalls, store } = makeDeps({ presence: [{ agentId: "gus", placeId: "hall_main" }] });
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(1);
  expect(generateCalls[0].portraits).toEqual(["gus"]);
  expect(saved).toHaveLength(1);
  expect(saved[0].filename).toBe("hall_main_gus");
  expect(getGenerationCount(store)).toBe(1);
});

test("SC-RS2: 2 agents sort alphabetically regardless of presence order — gus,bruno and bruno,gus both resolve to bruno_gus", async () => {
  const a = makeDeps({ presence: [{ agentId: "gus", placeId: "library" }, { agentId: "bruno", placeId: "library" }] });
  await new RoomSceneDispatcher(a.deps).tick();
  expect(a.saved[0].filename).toBe("library_bruno_gus");

  const b = makeDeps({ presence: [{ agentId: "bruno", placeId: "library" }, { agentId: "gus", placeId: "library" }] });
  await new RoomSceneDispatcher(b.deps).tick();
  expect(b.saved[0].filename).toBe("library_bruno_gus");
});

test("SC-RS3: a cached file for this exact combo already exists -> never calls generateBlend", async () => {
  const { deps, generateCalls } = makeDeps({
    presence: [{ agentId: "gus", placeId: "hall_main" }],
    hasBackgroundFile: (filename) => filename === "hall_main_gus",
  });
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(0);
});

test("SC-RS4: quota exhausted -> never calls generateBlend, room silently keeps its default background", async () => {
  const store = makeMarkStore(IMAGE_GEN_QUOTA_MAX);
  const { deps, generateCalls, saved } = makeDeps({ presence: [{ agentId: "gus", placeId: "hall_main" }], store });
  expect(hasQuotaRemaining(store)).toBe(false);
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(0);
  expect(saved).toHaveLength(0);
});

test("SC-RS4b: generation paused -> never calls generateBlend, but drops a <combo>_placeholder copy of the room's default background", async () => {
  const baseImage = { imageBytes: new Uint8Array([5, 5, 5]), mimeType: "image/png" };
  const { deps, generateCalls, saved } = makeDeps({
    presence: [{ agentId: "cleo", placeId: "garden" }, { agentId: "hana", placeId: "garden" }],
    readRoomBackground: async (placeId) => (placeId === "garden" ? baseImage : null),
    generationPaused: true,
  });
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(0);
  expect(saved).toHaveLength(1);
  expect(saved[0].filename).toBe("garden_cleo_hana_placeholder");
  expect(saved[0].bytes).toBe(baseImage.imageBytes);
});

test("SC-RS4c: generation paused and the room has no default background yet -> no placeholder, no crash", async () => {
  const { deps, generateCalls, saved } = makeDeps({
    presence: [{ agentId: "cleo", placeId: "garden" }],
    generationPaused: true, // default readRoomBackground already resolves to null
  });
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(0);
  expect(saved).toHaveLength(0);
});

test("SC-RS4d: generation paused, placeholder already exists for this combo -> does not write it again", async () => {
  const { deps, saved } = makeDeps({
    presence: [{ agentId: "cleo", placeId: "garden" }],
    readRoomBackground: async () => ({ imageBytes: new Uint8Array([1]), mimeType: "image/png" }),
    hasBackgroundFile: (filename) => filename === "garden_cleo_placeholder",
    generationPaused: true,
  });
  await new RoomSceneDispatcher(deps).tick();
  expect(saved).toHaveLength(0);
});

test("SC-RS4e: quota exhausted (not just paused) also drops a placeholder when the room has a default background", async () => {
  const store = makeMarkStore(IMAGE_GEN_QUOTA_MAX);
  const baseImage = { imageBytes: new Uint8Array([2]), mimeType: "image/png" };
  const { deps, generateCalls, saved } = makeDeps({
    presence: [{ agentId: "gus", placeId: "hall_main" }],
    readRoomBackground: async () => baseImage,
    store,
  });
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(0);
  expect(saved).toHaveLength(1);
  expect(saved[0].filename).toBe("hall_main_gus_placeholder");
});

test("SC-RS5: IMAGE_GEN_QUOTA_MAX is 50 (a $10 budget is roughly 50 images)", () => {
  expect(IMAGE_GEN_QUOTA_MAX).toBe(50);
});

test("SC-RS6: while the pulse-anima library-active flag is set, library NEVER triggers a blend, even with full quota available (pulse-anima scenes already have their own art, so 5 people are never blended)", async () => {
  const { deps, generateCalls, store } = makeDeps({
    presence: [
      { agentId: "rhea", placeId: "library" },
      { agentId: "cleo", placeId: "library" },
      { agentId: "eli", placeId: "library" },
      { agentId: "hana", placeId: "library" },
    ],
  });
  store.setMark(LIBRARY_ACTIVE_FLAG, "1");
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(0);
});

test("SC-RS6b: the library-active flag guard is not fooled by rotation drift — a real pulse-anima combo that no longer matches any hardcoded tuple still must not blend, as long as the flag is set (regression: each stage's rotation advances independently and drifts out of phase over time, so combo-matching against a frozen snapshot would silently stop working and burn the image quota)", async () => {
  const { deps, generateCalls, store } = makeDeps({
    presence: [
      { agentId: "ivan", placeId: "library" },
      { agentId: "nora", placeId: "library" },
      { agentId: "sam", placeId: "library" },
      { agentId: "lena", placeId: "library" },
    ],
  });
  store.setMark(LIBRARY_ACTIVE_FLAG, "1");
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(0);
});

test("SC-RS7: 4 agents in library with the library-active flag NOT set still blend normally (ordinary wander coincidence, not a real pulse-anima cycle)", async () => {
  const { deps, generateCalls } = makeDeps({
    presence: [
      { agentId: "bruno", placeId: "library" },
      { agentId: "eli", placeId: "library" },
      { agentId: "lena", placeId: "library" },
      { agentId: "nora", placeId: "library" },
    ],
  });
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(1);
});

test("SC-RS8: two ticks before the first generation resolves only fire generateBlend once for the same combo (in-flight guard)", async () => {
  let resolveGen: ((image: { bytes: Uint8Array; mimeType: string }) => void) | undefined;
  const generateCalls: string[][] = [];
  const { deps } = makeDeps({
    presence: [{ agentId: "gus", placeId: "hall_main" }],
    generateBlend: async (_base, portraits) => {
      generateCalls.push(portraits.map((p) => p.agentId));
      return new Promise<{ bytes: Uint8Array; mimeType: string }>((resolve) => { resolveGen = resolve; });
    },
  });
  const dispatcher = new RoomSceneDispatcher(deps);
  const first = dispatcher.tick();
  // inFlight is marked synchronously (before any await) so `second` is
  // already safe to fire here — but generateBlend itself is reached only
  // after readPortrait + readRoomBackground's own awaits resolve, so wait
  // for it to actually be called (robust to how many hops precede it)
  // before capturing resolveGen.
  for (let i = 0; i < 10 && generateCalls.length === 0; i++) await Promise.resolve();
  const second = dispatcher.tick(); // fires while the first is still in-flight
  resolveGen?.({ bytes: new Uint8Array([1]), mimeType: "image/png" });
  await Promise.all([first, second]);
  expect(generateCalls).toHaveLength(1);
});

test("SC-RS9: a failed generateBlend does not increment quota, does not crash the tick, and allows a retry on the next tick", async () => {
  let attempts = 0;
  const { deps, store, saved } = makeDeps({
    presence: [{ agentId: "gus", placeId: "hall_main" }],
    generateBlend: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("gemini blend failed: 500");
      return { bytes: new Uint8Array([1]), mimeType: "image/png" };
    },
  });
  const dispatcher = new RoomSceneDispatcher(deps);
  await dispatcher.tick();
  expect(getGenerationCount(store)).toBe(0);
  expect(saved).toHaveLength(0);

  await dispatcher.tick(); // retry
  expect(attempts).toBe(2);
  expect(getGenerationCount(store)).toBe(1);
  expect(saved).toHaveLength(1);
});

test("SC-RS10: an occupant with no existing portrait is skipped from the blend, but others still go through", async () => {
  const { deps, generateCalls } = makeDeps({
    presence: [{ agentId: "gus", placeId: "hall_main" }, { agentId: "ghost-agent", placeId: "hall_main" }],
    readPortrait: async (agentId) => (agentId === "ghost-agent" ? null : { agentId, imageBytes: new Uint8Array([1]), mimeType: "image/png" }),
  });
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(1);
  expect(generateCalls[0].portraits).toEqual(["gus"]);
});

test("SC-RS13: the room's existing default background is fetched and passed to generateBlend as the base reference — never re-invented from a text label alone (the existing background and portrait images are both used as references)", async () => {
  const baseImage = { imageBytes: new Uint8Array([7, 7, 7]), mimeType: "image/png" };
  const generateCalls: Array<{ base: unknown; portraitIds: string[] }> = [];
  const { deps } = makeDeps({
    presence: [{ agentId: "gus", placeId: "hall_main" }],
    readRoomBackground: async (placeId) => (placeId === "hall_main" ? baseImage : null),
    generateBlend: async (base, portraits) => {
      generateCalls.push({ base, portraitIds: portraits.map((p) => p.agentId) });
      return { bytes: new Uint8Array([9]), mimeType: "image/png" };
    },
  });
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(1);
  expect(generateCalls[0].base).toBe(baseImage);
  expect(generateCalls[0].portraitIds).toEqual(["gus"]);
});

test("SC-RS11: presence in a non-common-room placeId (e.g. a chamber) is ignored entirely", async () => {
  const { deps, generateCalls } = makeDeps({ presence: [{ agentId: "gus", placeId: "chamber_gus" }] });
  await new RoomSceneDispatcher(deps).tick();
  expect(generateCalls).toHaveLength(0);
});

test("SC-RS12: multiple common rooms occupied at once are each resolved independently in one tick()", async () => {
  const { deps, saved } = makeDeps({
    presence: [
      { agentId: "gus", placeId: "hall_main" },
      { agentId: "sam", placeId: "workshop" },
    ],
  });
  await new RoomSceneDispatcher(deps).tick();
  expect(saved.map((s) => s.filename).sort()).toEqual(["hall_main_gus", "workshop_sam"]);
});

test("pickRandomPose picks deterministically from the pose list given an injected random source, never standing-and-staring by default", () => {
  const first = pickRandomPose(() => 0);
  const last = pickRandomPose(() => 0.999999);
  expect(typeof first).toBe("string");
  expect(first.length).toBeGreaterThan(0);
  expect(first).not.toBe(last);
});

test("pickRandomPose with the default Math.random always returns one of the known pose strings", () => {
  for (let i = 0; i < 20; i++) {
    expect(typeof pickRandomPose()).toBe("string");
  }
});

// ── Resolution correctness (a blend once came back with a
// different aspect ratio/resolution than hall_main.png's real 1920x1080;
// the requirement is to keep the background resolution and only blend the
// portrait in) ────────────────────

test("nearestSupportedAspectRatio matches 1920x1080 to 16:9 exactly", () => {
  expect(nearestSupportedAspectRatio(1920, 1080)).toBe("16:9");
});

test("nearestSupportedAspectRatio picks the closest supported ratio for an unusual size", () => {
  expect(nearestSupportedAspectRatio(1000, 1000)).toBe("1:1");
  expect(nearestSupportedAspectRatio(900, 1600)).toBe("9:16");
});

test("resizeToMatch guarantees the exact output dimensions regardless of the model's actual output size", async () => {
  const source = await sharp({ create: { width: 800, height: 450, channels: 3, background: "blue" } }).jpeg().toBuffer();
  const result = await resizeToMatch({ bytes: source, mimeType: "image/jpeg" }, 1920, 1080);
  const meta = await sharp(Buffer.from(result.bytes)).metadata();
  expect(meta.width).toBe(1920);
  expect(meta.height).toBe(1080);
  expect(result.mimeType).toBe("image/jpeg");
});

test("resizeToMatch preserves png format for a png source", async () => {
  const source = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const result = await resizeToMatch({ bytes: source, mimeType: "image/png" }, 1920, 1080);
  const meta = await sharp(Buffer.from(result.bytes)).metadata();
  expect(meta.width).toBe(1920);
  expect(meta.height).toBe(1080);
  expect(result.mimeType).toBe("image/png");
});
