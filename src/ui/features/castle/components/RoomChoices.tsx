import type { CSSProperties } from "react";
import type { VNChoice } from "../lib/parse-vn-response";
import { CASTLE } from "../lib/castle-style";

/**
 * Row of action buttons just above the input (bottom:88). Reply bubbles sit next to their speakers
 * (room-chat-bubbles), not on the bottom bar. Same left:24% / right:0 / paddingRight:20 as the input
 * (spills to the right edge).
 * Clicking a choice sends its `value` as the next message.
 *
 * Styles inline — detached HTML layer, see castle-style.ts.
 */
export function RoomChoices({
  choices,
  onPick,
}: {
  choices: VNChoice[];
  onPick: (value: string) => void;
}) {
  if (choices.length === 0) return null;
  const rowStyle: CSSProperties = {
    position: "absolute",
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    pointerEvents: "auto",
    bottom: 88,
    left: "24%",
    right: 0,
    paddingRight: 20,
    zIndex: 30,
  };
  const btnStyle: CSSProperties = {
    borderRadius: 6,
    border: `2px solid ${CASTLE.cream}`,
    background: CASTLE.bgTranslucent,
    color: CASTLE.cream,
    fontSize: 14,
    padding: "6px 12px",
    cursor: "pointer",
    transition: "background 75ms, transform 75ms",
  };
  return (
    <div style={rowStyle}>
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onPick(c.value)}
          style={btnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = CASTLE.hover)}
          onMouseDown={(e) => {
            e.currentTarget.style.background = CASTLE.cream;
            e.currentTarget.style.color = CASTLE.bg;
            e.currentTarget.style.transform = "scale(0.97)";
          }}
          onMouseUp={(e) => {
            e.currentTarget.style.background = CASTLE.bgTranslucent;
            e.currentTarget.style.color = CASTLE.cream;
            e.currentTarget.style.transform = "scale(1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = CASTLE.bgTranslucent;
            e.currentTarget.style.color = CASTLE.cream;
            e.currentTarget.style.transform = "scale(1)";
          }}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
