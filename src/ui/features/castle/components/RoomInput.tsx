import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { CASTLE } from "../lib/castle-style";

/** Multiline input box at the bottom. Enter sends; Shift+Enter inserts a
 *  newline. Left edge at 24% (aligned with chat log + dialogue), right edge
 *  flush to the viewport corner with paddingRight 16px.
 *
 *  Styles inline (not Tailwind) — detached HTML layer, see castle-style.ts. */
export function RoomInput({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const [value, setValue] = useState("");

  function send() {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const wrapStyle: CSSProperties = {
    position: "absolute",
    pointerEvents: "auto",
    bottom: 16,
    left: "24%",
    right: 0,
    padding: 16,
    paddingRight: 16,
    borderRadius: 6,
    border: `2px solid ${CASTLE.cream}`,
    background: CASTLE.bgTranslucent,
    zIndex: 30,
  };
  const inputStyle: CSSProperties = {
    width: "100%",
    background: "transparent",
    outline: "none",
    resize: "none",
    border: "none",
    color: CASTLE.parchment,
    fontSize: 18,
    fontFamily: "inherit",
    opacity: disabled ? 0.5 : 1,
  };

  return (
    <div style={wrapStyle}>
      <textarea
        data-testid="room-input"
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Press Enter to send..."
        rows={1}
        style={inputStyle}
      />
    </div>
  );
}
