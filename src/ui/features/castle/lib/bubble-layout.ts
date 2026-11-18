import { CANVAS_W, portraitRects } from "./stage-layout";

/** One reply bubble to place. `pending` is the slot of a speaker whose beat has not ended yet. */
export interface BubbleItem {
  speakerId: string;
  textLength: number;
  pending?: boolean;
}

export type BubbleMode = "above" | "beside" | "bottom";

export interface BubbleRect {
  mode: BubbleMode;
  /** Canvas units. */
  left: number;
  top: number;
  width: number;
  /** Estimated height, used to keep bubbles apart; the real box may be shorter. */
  height: number;
  /** Largest height the box may take before it scrolls. */
  maxHeight: number;
  /** Tail: `bottom` points down at a head, `left` points left at a head; `offset` is along the edge. */
  tail: { side: "bottom" | "left" | "none"; offset: number };
  /** A newer bubble exists: draw this one stepped back. */
  dim: boolean;
  /** Lines to clamp to while stepped back (three or more speakers), else null. */
  clampLines: number | null;
}

const MAX_WIDTH = 560;
const GAP = 16;
/** Default clearance for the addressee rail, in canvas units; the room measures the real one (`railClearanceUnits`). */
const MIN_LEFT = 190;
const RAIL_GAP = 12;
const RIGHT_MARGIN = 24;
const BAND_TOP = 110;
const BAND_STEP = 80;
const FACE_GAP = 24;
const FACE_HEIGHT = 190;
const FACE_HALF_WIDTH = 110;
const BESIDE_OFFSET = 150;
const BESIDE_MAX_HEIGHT = 300;
const BOTTOM_TOP = 640;
const BOTTOM_MAX_HEIGHT = 340;
const CHROME = 70; // padding plus the speaker label
const LINE = 30;
const CHAR = 9.5;
const PENDING_LENGTH = 60;
const OLDER_LINES = 4;

function estimateHeight(textLength: number, width: number, maxHeight: number, clampLines: number | null): number {
  const perLine = Math.max(8, Math.floor((width - 44) / CHAR));
  let lines = Math.max(1, Math.ceil(textLength / perLine));
  if (clampLines !== null) lines = Math.min(lines, clampLines);
  return Math.min(maxHeight, CHROME + lines * LINE);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Place the bubbles of one send, in canvas units. `stageOrder` is the portraits left to right; `items` is
 *  every speaker the send is planned to have, in speaking order: replies that arrived, and `pending` ones
 *  that have not. Because the whole plan is laid out from the start, a bubble that is already shown does not
 *  move when the next one arrives. Pure: no DOM, no Pixi. */
export function layoutBubbles(stageOrder: string[], items: BubbleItem[], opts: { minLeft?: number } = {}): BubbleRect[] {
  const minLeft = opts.minLeft ?? MIN_LEFT;
  const portraits = portraitRects(stageOrder.length);
  const n = items.length;
  const spacing = portraits.length > 1 ? portraits[1]!.cx - portraits[0]!.cx : MAX_WIDTH + GAP;
  const width = n <= 2 ? MAX_WIDTH : Math.min(MAX_WIDTH, spacing - GAP);
  const headTop = portraits[0]?.headTop ?? 410;
  const bandLimit = headTop - FACE_GAP;
  const stageIndex = (id: string) => stageOrder.indexOf(id);
  const allOnStage = items.every((it) => stageIndex(it.speakerId) >= 0);

  // Pass 1: the mode of each bubble.
  const modes: BubbleMode[] = items.map((it, i) => {
    const s = stageIndex(it.speakerId);
    if (s < 0) return "bottom";
    const p = portraits[s]!;
    const besideFree = !portraits.some((q, k) => k !== s && q.cx > p.cx && q.cx - FACE_HALF_WIDTH < p.cx + BESIDE_OFFSET + width);
    return n === 2 && i === 1 && allOnStage && besideFree && p.cx + BESIDE_OFFSET + width <= CANVAS_W - RIGHT_MARGIN ? "beside" : "above";
  });
  const aboveIdx = items.map((_, i) => i).filter((i) => modes[i] === "above");
  const banded = aboveIdx.length >= 2;
  // Bubbles above the heads are packed left to right in portrait order, whatever the speaking order.
  const rankOf = new Map(aboveIdx.slice().sort((a, b) => stageIndex(items[a]!.speakerId) - stageIndex(items[b]!.speakerId)).map((i, rank) => [i, rank]));

  // Pass 2: positions.
  const placed = new Map<number, Omit<BubbleRect, "dim" | "clampLines" | "height">>();
  let bandRight = minLeft - GAP;
  for (const i of aboveIdx.slice().sort((a, b) => rankOf.get(a)! - rankOf.get(b)!)) {
    const p = portraits[stageIndex(items[i]!.speakerId)]!;
    const top = BAND_TOP + (banded ? (rankOf.get(i)! % 2) * BAND_STEP : 0);
    let left = clamp(p.cx - (banded ? width / 2 : 70), minLeft, CANVAS_W - RIGHT_MARGIN - width);
    if (banded) left = Math.max(left, bandRight + GAP);
    bandRight = left + width;
    placed.set(i, { mode: "above", left, top, width, maxHeight: bandLimit - top, tail: { side: "bottom", offset: clamp(p.cx - left, 28, width - 28) } });
  }
  // Speakers who are not on stage share the row below the faces, side by side and centred as a group.
  const bottomIdx = items.map((_, i) => i).filter((i) => modes[i] === "bottom");
  const bottomWidth = Math.min(width, Math.floor((CANVAS_W - RIGHT_MARGIN - minLeft - (bottomIdx.length - 1) * GAP) / Math.max(1, bottomIdx.length)));
  const groupWidth = bottomIdx.length * bottomWidth + (bottomIdx.length - 1) * GAP;
  const groupLeft = Math.max(minLeft, (CANVAS_W - groupWidth) / 2);
  bottomIdx.forEach((i, k) => {
    placed.set(i, { mode: "bottom", left: groupLeft + k * (bottomWidth + GAP), top: BOTTOM_TOP, width: bottomWidth, maxHeight: BOTTOM_MAX_HEIGHT, tail: { side: "none", offset: 0 } });
  });
  items.forEach((it, i) => {
    if (modes[i] === "beside") {
      const p = portraits[stageIndex(it.speakerId)]!;
      placed.set(i, { mode: "beside", left: p.cx + BESIDE_OFFSET, top: headTop + 20, width, maxHeight: BESIDE_MAX_HEIGHT, tail: { side: "left", offset: 96 } });
    }
  });

  // A bubble steps back once a later one has arrived; a pending slot does not dim anything.
  const lastShown = items.reduce((acc, it, i) => (it.pending ? acc : i), -1);
  return items.map((it, i) => {
    const base = placed.get(i)!;
    const dim = !it.pending && i < lastShown;
    const clampLines = dim && n >= 3 ? OLDER_LINES : null;
    const length = it.pending ? PENDING_LENGTH : it.textLength;
    return { ...base, dim, clampLines, height: estimateHeight(length, base.width, base.maxHeight, clampLines) };
  });
}

/** The speakers of a send, in speaking order, from the plan made when it was sent and the speakers who have
 *  answered. The plan is kept while it explains the answers (a speaker who declines leaves a gap, not a new
 *  layout); otherwise the answers alone are the slots, e.g. a send planned in an earlier visit or a speaker
 *  the plan did not expect. */
export function planSlots(plan: string[], answered: string[]): string[] {
  const uniqueAnswered = [...new Set(answered)];
  return plan.length > 0 && uniqueAnswered.every((id) => plan.includes(id)) ? plan : uniqueAnswered;
}

/** The planned speaker whose bubble is expected next: the first one after the last who answered. */
export function nextPendingSpeaker(slots: string[], answered: string[]): string | null {
  const last = answered.reduce((acc, id) => Math.max(acc, slots.indexOf(id)), -1);
  return slots[last + 1] ?? null;
}

/** Canvas units to keep clear on the left for the addressee rail, from its measured right edge and the HTML layer's
 *  rectangle (CSS px). The rail is laid out in fixed CSS pixels while the layer, and so the bubbles, scale with the
 *  window, so the same rail takes more canvas units in a small window. */
export function railClearanceUnits(railRight: number, layerLeft: number, layerWidth: number): number {
  return ((railRight - layerLeft) / layerWidth) * CANVAS_W + RAIL_GAP;
}
