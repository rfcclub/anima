import type { CSSProperties } from "react";
import { CASTLE } from "../lib/castle-style";

/** Floating echo of the user's just-sent message — sits 32px ABOVE the
 *  dialogue bubble, left-aligned with it (24%). Fades in then fades away.
 *  Exists because after Enter the user message has no other home: RoomBubble
 *  only renders the latest assistant reply, and the chat log is collapsed by
 *  default. Without this the message "vanishes without a trace" the instant it's sent. The
 *  `dismissKey` forces React to remount the node on each new send so the
 *  animation restarts from frame 0.
 *
 *  Position: bottom:150 — just above the input and the choices row. Reply bubbles now sit next to their
 *  speakers up in the room (room-chat-bubbles), no longer on the bottom bar. Left 24% matches the
 *  bubble/input so the toast reads as the user's contribution above the reply.
 *
 *  Styles inline — detached HTML layer, see castle-style.ts. */
export function RoomUserToast({ text, dismissKey }: { text: string; dismissKey: number }) {
  if (!text) return null;
  const wrapStyle: CSSProperties = {
    position: "absolute",
    bottom: 150,
    left: "24%",
    right: 0,
    paddingRight: 20,
    zIndex: 40,
    pointerEvents: "none",
    animation: "room-toast-fade 3000ms ease-out forwards",
  };
  const boxStyle: CSSProperties = {
    borderRadius: 6,
    border: `1px solid ${CASTLE.creamFaint}`,
    background: CASTLE.bgTranslucent,
    padding: 16,
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    maxWidth: "60vw",
  };
  return (
    <div key={dismissKey} style={wrapStyle}>
      <div data-testid="room-user-toast" style={boxStyle}>
        <span style={{ color: CASTLE.muted, fontWeight: 600, marginRight: 8, fontSize: 14 }}>
          You
        </span>
        <span style={{ color: CASTLE.parchment, fontSize: 16, lineHeight: 1.35 }}>
          {text}
        </span>
      </div>
    </div>
  );
}
