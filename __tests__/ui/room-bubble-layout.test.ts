import { describe, expect, test } from "bun:test";
import { CANVAS_H, CANVAS_W, portraitRects } from "../../src/ui/features/castle/lib/stage-layout";
import { layoutBubbles, nextPendingSpeaker, planSlots, railClearanceUnits, type BubbleItem, type BubbleRect } from "../../src/ui/features/castle/lib/bubble-layout";
import { expectedSpeakers } from "../../src/ui/features/castle/lib/send-plan";

const STAGE = ["cleo", "kai", "bruno", "milo"];
const item = (speakerId: string, textLength = 200): BubbleItem => ({ speakerId, textLength });
const group = (n: number, len = 200) => STAGE.slice(0, n).map((id) => item(id, len));

interface Box { left: number; top: number; right: number; bottom: number }
const box = (r: BubbleRect): Box => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height });
const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// Everything a bubble must keep clear of, in canvas units.
function keepOut(stage: string[]): Box[] {
  const faces = portraitRects(stage.length).map((p) => ({ left: p.cx - 110, right: p.cx + 110, top: p.headTop, bottom: p.headTop + 190 }));
  const input = { left: 0, right: CANVAS_W, top: 1010, bottom: CANVAS_H };
  const rail = { left: 0, right: 190, top: 0, bottom: 300 };
  return [...faces, input, rail];
}

describe("stage layout", () => {
  test("portraits chain at 0.82 of a portrait width from 13% of the canvas", () => {
    const [a, b, c] = portraitRects(3);
    expect(a!.cx).toBeCloseTo(CANVAS_W * 0.13, 5);
    expect(b!.cx - a!.cx).toBeCloseTo(0.82 * a!.width, 5);
    expect(c!.cx - b!.cx).toBeCloseTo(0.82 * b!.width, 5);
  });
});

describe("bubble width (SC-1)", () => {
  test("one or two speakers: 560 canvas units; three or four: the portrait spacing minus a gap, at most 560", () => {
    expect(layoutBubbles(STAGE, group(1))[0]!.width).toBe(560);
    for (const r of layoutBubbles(STAGE, group(2))) expect(r.width).toBe(560);
    const spacing = portraitRects(4)[1]!.cx - portraitRects(4)[0]!.cx;
    for (const n of [3, 4]) for (const r of layoutBubbles(STAGE, group(n))) expect(r.width).toBe(Math.min(560, spacing - 16));
  });
});

describe("placement (SC-2)", () => {
  test("one speaker: above the portrait, tail pointing down at it", () => {
    const [r] = layoutBubbles(["cleo", "kai"], [item("cleo")]);
    const p = portraitRects(2)[0]!;
    expect(r!.mode).toBe("above");
    expect(r!.tail.side).toBe("bottom");
    expect(r!.left + r!.tail.offset).toBeGreaterThan(p.cx - 110);
    expect(r!.left + r!.tail.offset).toBeLessThan(p.cx + 110);
  });
  test("two speakers: the first above its portrait, the second beside its portrait with the tail on the left", () => {
    const [first, second] = layoutBubbles(["cleo", "kai"], [item("cleo"), item("kai")]);
    const kai = portraitRects(2)[1]!;
    expect(first!.mode).toBe("above");
    expect(second!.mode).toBe("beside");
    expect(second!.tail.side).toBe("left");
    expect(second!.left).toBeGreaterThan(kai.cx);
  });
  test("two speakers with a third portrait to the right: no beside bubble over that face", () => {
    const rects = layoutBubbles(["cleo", "kai", "bruno"], [item("cleo"), item("kai")]);
    expect(rects.every((r) => r.mode === "above")).toBe(true);
  });
  test("a speaker who is not on stage gets a centred bubble below the faces", () => {
    const [r] = layoutBubbles(["cleo", "kai"], [item("narrator")]);
    expect(r!.mode).toBe("bottom");
    expect(r!.left).toBeCloseTo((CANVAS_W - r!.width) / 2, 5);
    expect(r!.top).toBeGreaterThanOrEqual(portraitRects(2)[0]!.headTop + 190);
  });
});

describe("no overlap for 1 to 4 speakers (SC-3, SC-6)", () => {
  for (const n of [1, 2, 3, 4]) {
    for (const len of [20, 200, 800]) {
      test(`${n} speakers, ${len} characters each`, () => {
        const rects = layoutBubbles(STAGE, group(n, len));
        const boxes = rects.map(box);
        boxes.forEach((a, i) => {
          for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
          for (const k of keepOut(STAGE)) expect(overlap(a, k)).toBe(false);
          expect(a.left).toBeGreaterThanOrEqual(0);
          expect(a.right).toBeLessThanOrEqual(CANVAS_W);
        });
      });
    }
  }
});

describe("older bubbles step back (SC-5)", () => {
  test("every bubble but the newest is dim; with three or more speakers the older ones are clamped to 4 lines", () => {
    const two = layoutBubbles(STAGE, group(2));
    expect(two.map((r) => r.dim)).toEqual([true, false]);
    expect(two.every((r) => r.clampLines === null)).toBe(true);
    const four = layoutBubbles(STAGE, group(4));
    expect(four.map((r) => r.dim)).toEqual([true, true, true, false]);
    expect(four.map((r) => r.clampLines)).toEqual([4, 4, 4, null]);
  });
  test("a pending slot does not dim the bubble that is shown", () => {
    const rects = layoutBubbles(STAGE, [item("cleo"), { speakerId: "kai", textLength: 0, pending: true }]);
    expect(rects.map((r) => r.dim)).toEqual([false, false]);
  });
  test("a single bubble is never dim", () => {
    expect(layoutBubbles(STAGE, group(1))[0]!.dim).toBe(false);
  });
});

describe("a bubble that is already shown does not move when the next one arrives", () => {
  const pending = (id: string): BubbleItem => ({ speakerId: id, textLength: 0, pending: true });
  const same = (a: BubbleRect, b: BubbleRect) => expect([a.left, a.top, a.width, a.mode, a.tail.offset]).toEqual([b.left, b.top, b.width, b.mode, b.tail.offset]);

  for (const n of [2, 3]) {
    test(`${n} planned speakers: every step of the send gives each slot the same place`, () => {
      const ids = STAGE.slice(0, n);
      const final = layoutBubbles(STAGE, ids.map((id) => item(id)));
      for (let arrived = 0; arrived <= n; arrived++) {
        const step = layoutBubbles(STAGE, ids.map((id, i) => (i < arrived ? item(id) : pending(id))));
        step.forEach((r, i) => same(r, final[i]!));
      }
    });
  }
  test("a planned speaker who declines leaves the other slots where they were", () => {
    const plan = STAGE.slice(0, 3);
    const full = layoutBubbles(STAGE, plan.map((id) => item(id)));
    const declined = layoutBubbles(STAGE, [item(plan[0]!), pending(plan[1]!), item(plan[2]!)]);
    declined.forEach((r, i) => same(r, full[i]!));
  });
});

describe("speaking order against stage order", () => {
  const perms = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  for (const n of [2, 3, 4]) {
    for (const order of perms(STAGE.slice(0, n))) {
      test(`stage ${STAGE.slice(0, n).join(">")}, speaking ${order.join(">")}: no overlap`, () => {
        const boxes = layoutBubbles(STAGE, order.map((id) => item(id, 800))).map(box);
        boxes.forEach((a, i) => {
          for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
          for (const k of keepOut(STAGE)) expect(overlap(a, k)).toBe(false);
        });
      });
    }
  }
});

describe("planSlots and nextPendingSpeaker", () => {
  test("the plan is kept while it explains the answers; a speaker who declines leaves it unchanged", () => {
    expect(planSlots(["a", "b", "c"], ["a", "c"])).toEqual(["a", "b", "c"]);
  });
  test("an answer from outside the plan, or no plan, falls back to the answers alone", () => {
    expect(planSlots(["a", "b"], ["x"])).toEqual(["x"]);
    expect(planSlots([], ["a", "b", "a"])).toEqual(["a", "b"]);
  });
  test("the next pending speaker is the first planned one after the last who answered", () => {
    expect(nextPendingSpeaker(["a", "b", "c"], [])).toBe("a");
    expect(nextPendingSpeaker(["a", "b", "c"], ["a"])).toBe("b");
    expect(nextPendingSpeaker(["a", "b", "c"], ["a", "c"])).toBeNull();
    expect(nextPendingSpeaker(["a"], ["a"])).toBeNull();
  });
});

describe("expectedSpeakers", () => {
  const occ = ["cleo", "kai", "bruno"];
  test("an ordered send plans its order, at most three", () => {
    expect(expectedSpeakers({ kind: "order", order: ["kai", "cleo"] }, "cleo", occ, "cleo")).toEqual(["kai", "cleo"]);
    expect(expectedSpeakers({ kind: "order", order: ["a", "b", "c", "d"] }, "cleo", occ, "cleo")).toEqual(["a", "b", "c"]);
  });
  test("all plans the owner and the first guest; alone it plans the fallback speaker", () => {
    expect(expectedSpeakers({ kind: "all" }, "cleo", occ, "cleo")).toEqual(["cleo", "kai"]);
    expect(expectedSpeakers({ kind: "all" }, "cleo", ["cleo"], "cleo")).toEqual(["cleo"]);
  });
  test("a clicked agent or no choice plans one speaker", () => {
    expect(expectedSpeakers({ kind: "agent", id: "kai" }, "cleo", occ, "cleo")).toEqual(["kai"]);
    expect(expectedSpeakers({ kind: "none" }, "cleo", occ, "bruno")).toEqual(["bruno"]);
  });
});

describe("clearance of the addressee rail", () => {
  test("the rail's rendered right edge, in canvas units, depends on how far the layer is scaled", () => {
    // 1280 px wide layer at the window's left edge, rail ending at 162.5 px: 162.5 / 1280 * 1920 + gap.
    expect(railClearanceUnits(162.5, 0, 1280)).toBeCloseTo((162.5 / 1280) * 1920 + 12, 5);
    // 1920 px wide layer: the same pixels are fewer canvas units.
    expect(railClearanceUnits(162.5, 0, 1920)).toBeCloseTo(162.5 + 12, 5);
    // a layer that is letterboxed inside the window
    expect(railClearanceUnits(300, 100, 1920)).toBeCloseTo(200 + 12, 5);
  });

  test("no bubble starts left of the measured clearance, for every speaker count and off-stage speakers", () => {
    const minLeft = railClearanceUnits(162.5, 0, 1280);
    for (const stage of [STAGE, ["cleo"], []]) {
      for (const n of [1, 2, 3, 4]) {
        for (const r of layoutBubbles(stage, group(n), { minLeft })) expect(r.left).toBeGreaterThanOrEqual(minLeft);
      }
    }
  });
});

describe("speakers who have left the stage", () => {
  const stages: string[][] = [STAGE, ["cleo", "kai"], ["cleo"], ["kai"], []];
  for (const stage of stages) {
    for (const n of [1, 2, 3, 4]) {
      for (const len of [20, 800]) {
        test(`stage [${stage.join(",")}], ${n} speakers, ${len} characters: no overlap`, () => {
          const rects = layoutBubbles(stage, group(n, len));
          const boxes = rects.map(box);
          boxes.forEach((a, i) => {
            for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
            for (const k of keepOut(stage)) expect(overlap(a, k)).toBe(false);
            expect(a.left).toBeGreaterThanOrEqual(0);
            expect(a.right).toBeLessThanOrEqual(CANVAS_W);
          });
        });
      }
    }
  }
  test("two departed speakers get distinct places, side by side", () => {
    const [a, b] = layoutBubbles(["cleo"], [item("kai"), item("bruno")]);
    expect(a!.mode).toBe("bottom");
    expect(b!.mode).toBe("bottom");
    expect(a!.left).not.toBe(b!.left);
  });
  test("a speaker beside the stage is not placed beside a portrait when another speaker has left", () => {
    const rects = layoutBubbles(["cleo", "kai"], [item("narrator"), item("kai")]);
    expect(rects.map((r) => r.mode)).toEqual(["bottom", "above"]);
  });
});
