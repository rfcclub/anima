import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomBubble } from "../../src/ui/features/castle/components/RoomBubble";
import { RoomWaitingBubble } from "../../src/ui/features/castle/components/RoomWaitingBubble";
import { layoutBubbles } from "../../src/ui/features/castle/lib/bubble-layout";

const castleDir = join(import.meta.dir, "../../src/ui/features/castle");
const [first, second] = layoutBubbles(["cleo", "kai"], [{ speakerId: "cleo", textLength: 40 }, { speakerId: "kai", textLength: 40 }]);

describe("RoomBubble (SC-4)", () => {
  test("no hard-coded colour and no CASTLE inline palette in the source", () => {
    const src = readFileSync(join(castleDir, "components/RoomBubble.tsx"), "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba?\(/);
    expect(src).not.toMatch(/CASTLE\./);
  });

  test("the castle-bubble classes take colours from the castle theme tokens", () => {
    const css = readFileSync(join(import.meta.dir, "../../src/ui/styles/tailwind.css"), "utf8");
    const rule = css.slice(css.indexOf(".castle-bubble {"), css.indexOf(".castle-bubble__body"));
    expect(rule).toContain("max-width: 62ch");
    expect(rule).toContain("var(--color-castle-parchment)");
    expect(rule).toContain("var(--color-castle-cream-faint)");
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});

describe("RoomBubble render", () => {
  test("places the bubble by the layout rect, in percent of the stage, with the speaker name and a tail", () => {
    const html = renderToStaticMarkup(<RoomBubble speaker="cleo" text="hello there" rect={first!} />);
    expect(html).toContain('data-testid="room-bubble"');
    expect(html).toContain("Cleo");
    expect(html).toContain("hello there");
    expect(html).toContain(`left:${(first!.left / 1920) * 100}%`);
    expect(html).toContain(`width:${(first!.width / 1920) * 100}%`);
    expect(html).toContain('data-mode="above"');
  });

  test("a stepped-back bubble is marked dim, the newest is not", () => {
    expect(renderToStaticMarkup(<RoomBubble speaker="cleo" text="a" rect={first!} />)).toContain('data-dim="true"');
    expect(renderToStaticMarkup(<RoomBubble speaker="kai" text="b" rect={second!} />)).toContain('data-dim="false"');
  });

  test("a clamp is passed to the body as a CSS variable", () => {
    const rect = { ...first!, clampLines: 4 };
    expect(renderToStaticMarkup(<RoomBubble speaker="cleo" text="a" rect={rect} />)).toContain("--clamp:4");
  });

  test("empty text renders nothing", () => {
    expect(renderToStaticMarkup(<RoomBubble speaker="cleo" text="" rect={first!} />)).toBe("");
  });
});

describe("RoomWaitingBubble", () => {
  test("a send that is queued behind another says so", () => {
    const html = renderToStaticMarkup(<RoomWaitingBubble rollKey={0} startedAt={Date.now()} rect={second!} queued />);
    expect(html).toContain("Queued behind another message");
    const running = renderToStaticMarkup(<RoomWaitingBubble rollKey={0} startedAt={Date.now()} rect={second!} />);
    expect(running).not.toContain("Queued behind");
  });

  test("sits in the slot it is given instead of the old full-width bottom bar", () => {
    const html = renderToStaticMarkup(<RoomWaitingBubble rollKey={0} startedAt={Date.now()} rect={second!} />);
    expect(html).toContain(`left:${(second!.left / 1920) * 100}%`);
    expect(html).not.toContain("left:24%");
    expect(html).toContain('data-testid="room-waiting-bubble"');
  });
});
