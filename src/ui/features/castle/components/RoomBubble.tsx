import type { CSSProperties } from "react";
import { renderMarkdown } from "../lib/parse-vn-response";
import type { BubbleRect } from "../lib/bubble-layout";
import { CANVAS_H, CANVAS_W } from "../lib/stage-layout";

/** Stage geometry (canvas units) as CSS percentages of the HTML layer, which is the letterboxed canvas. */
export function bubbleGeometry(rect: Pick<BubbleRect, "left" | "top" | "width" | "maxHeight">): CSSProperties {
  return {
    left: `${(rect.left / CANVAS_W) * 100}%`,
    top: `${(rect.top / CANVAS_H) * 100}%`,
    width: `${(rect.width / CANVAS_W) * 100}%`,
    maxHeight: `${(rect.maxHeight / CANVAS_H) * 100}%`,
  };
}

/** One reply as a bubble next to its speaker (lib/bubble-layout.ts decides where). The latest reply is lit;
 *  earlier ones of the same send step back and open on hover or focus. Renders the reply as markdown.
 *  Look and colours live in `.castle-bubble*` in styles/tailwind.css, on the castle theme tokens. */
export function RoomBubble({ speaker, text, rect }: { speaker: string; text: string; rect: BubbleRect }) {
  if (!text) return null;
  // The speaker is the agent id from the SSE tag; "narrator" renders as-is.
  const nameplate = speaker === "narrator" ? "narrator" : speaker.charAt(0).toUpperCase() + speaker.slice(1);
  const style = {
    ...bubbleGeometry(rect),
    "--tail": rect.tail.side === "bottom" ? `${(rect.tail.offset / rect.width) * 100}%` : undefined,
    "--clamp": rect.clampLines ?? undefined,
  } as CSSProperties;
  return (
    <div
      data-testid="room-bubble"
      data-mode={rect.mode}
      data-dim={rect.dim ? "true" : "false"}
      data-tail={rect.tail.side}
      data-clamp={rect.clampLines ? "true" : undefined}
      tabIndex={rect.dim ? 0 : undefined}
      className="castle-bubble"
      style={style}
    >
      <div className="castle-bubble__who"><i aria-hidden="true" />{nameplate}</div>
      <div className="castle-bubble__body" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
    </div>
  );
}
