import { useEffect, useRef, type CSSProperties } from "react";
import { parseVNResponse, renderVNText, renderMarkdown } from "../lib/parse-vn-response";
import { CASTLE } from "../lib/castle-style";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  speaker?: string;
  ts?: number;
}

function formatTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Scrollable chat history — a semi-transparent strip aligned with the
 * dialogue/input boxes (left 24%, right 32%), sitting ABOVE the dialogue
 * box (bottom 20% ≈ dialogue topY) and below the top toggle row. Collapsed
 * is now prop-controlled (default hidden; the toggle in RoomScreen flips it).
 * Semi-transparent bg so the Pixi background shows through the overlay.
 *
 * Styles inline — detached HTML layer, see castle-style.ts.
 */
export function RoomChatLog({ turns, collapsed }: { turns: ChatTurn[]; collapsed: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns]);

  // Collapsed = render nothing at all. The toggle button lives in RoomScreen
  // (always visible) so the user can still bring the log back.
  if (collapsed) return null;

  const shellStyle: CSSProperties = {
    position: "absolute",
    pointerEvents: "auto",
    display: "flex",
    flexDirection: "column",
    border: `2px solid ${CASTLE.creamFaint}`,
    borderRadius: 6,
    // Solid (not translucent) — the log and the floating dialogue bubble
    // are mutually exclusive (RoomScreen hides the bubble while the log is
    // open), so there's nothing behind the log to show through. A solid
    // background keeps long transcript text readable regardless.
    background: CASTLE.panel,
    top: 64,
    // Bottom sits ABOVE the dialogue bubble. The bubble is bottom:80 +
    // maxHeight 20em (~320px) + padding 32px ≈ 432px from the bottom. Use
    // 440px so the chatlog never overlaps the bubble even at max height.
    bottom: 440,
    left: "24%",
    right: 0,
    zIndex: 10,
    overflow: "hidden",
  };
  const scrollStyle: CSSProperties = {
    flex: 1,
    overflowY: "auto",
    padding: "12px 16px",
    userSelect: "text",
  };

  return (
    <div style={shellStyle}>
      <div style={scrollStyle} ref={logRef} data-testid="room-chatlog">
        {turns.length === 0 && (
          <div style={{ color: CASTLE.muted, fontStyle: "italic", fontSize: 14 }}>
            No messages yet…
          </div>
        )}
        {turns.map((t, i) => {
          const display = t.role === "assistant" ? renderVNText(parseVNResponse(t.content)) : t.content;
          return (
            <div key={i} style={{ color: "#d8c8a8", marginBottom: 8, fontSize: 15, lineHeight: 1.45, userSelect: "text" }}>
              {t.ts && <span style={{ color: CASTLE.muted }}>[{formatTime(t.ts)}] </span>}
              <span style={{ fontWeight: 600 }}>{t.speaker ?? (t.role === "user" ? "You" : "")}:</span>{" "}
              {t.role === "assistant" && display
                ? <span dangerouslySetInnerHTML={{ __html: renderMarkdown(display) }} />
                : display}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Standalone toggle button — always visible so the log can be shown/hidden
 *  even when the log itself is collapsed (rendered null).
 *  Styles inline — detached HTML layer, see castle-style.ts. */
export function RoomChatLogToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="chatlog-toggle"
      onClick={onToggle}
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        borderRadius: 6,
        border: `2px solid ${CASTLE.cream}`,
        background: CASTLE.bgTranslucent,
        color: CASTLE.cream,
        fontSize: 14,
        padding: "4px 12px",
        cursor: "pointer",
        pointerEvents: "auto",
        zIndex: 10,
      }}
    >
      {collapsed ? "Chat ▾" : "Chat ▴"}
    </button>
  );
}
