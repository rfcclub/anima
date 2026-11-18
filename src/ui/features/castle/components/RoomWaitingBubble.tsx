import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { CASTLE } from "../lib/castle-style";
import { waitingStatusPhrase, whimsicalStatusWord } from "../lib/mood-waiting";
import type { BubbleRect } from "../lib/bubble-layout";
import { bubbleGeometry } from "./RoomBubble";

const STATUS_WORD_INTERVAL_MS = 3000;
const TICK_MS = 500;
const SPINNER_TICK_MS = 90;

// Braille-dot spinner — cycling text characters, not a Pixi sprite tween
// (room character animation is explicitly out of v1 scope).
// This is the character animation for the wait: an animated glyph at
// the head of the status line, same spot Claude Code's own spinner sits.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Placeholder shown while the agent's LLM reply is in flight — a
 *  Claude-Code-style status caption: spinner glyph, whimsical verb,
 *  elapsed seconds, and an escalating phrase (thinking → still thinking →
 *  thinking more → remote slow response) so a long ~30-45s wait reads as
 *  "working", not "frozen".
 *
 *  Design: the embodied-mood line that used to sit above this caption was
 *  dropped — it always showed generic "neutral" flavor text since no caller
 *  ever passed a real `mood`, and duplicated the same wait in two languages.
 *  Caption line only now. Requirements:
 *  1. Detailed like Claude Code's status line — live elapsed counter plus a
 *     re-rolling line instead of one frozen line.
 *  2. Whimsical status word, spinner glyph at the start of the sentence, and
 *     the escalating phrase set (elapsed seconds, thinking / still thinking /
 *     thinking more / remote slow response).
 *
 *  Styles inline — detached HTML layer, see castle-style.ts. */
export function RoomWaitingBubble({
  rollKey,
  startedAt,
  rect,
  queued = false,
}: {
  rollKey: number;
  /** The send is waiting behind another one in this room, not running yet. */
  queued?: boolean;
  /** Slot of the speaker being waited on (lib/bubble-layout.ts), so the bubble sits where the answer will. */
  rect: BubbleRect;
  /** `Date.now()` when this send started — drives the elapsed counter and
   *  the periodic re-roll. Not required to be exact; a 0/stale value just
   *  reads as a very large elapsed count, which no caller does today. */
  startedAt: number;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Re-synced whenever a new send starts (startedAt changes) or the bubble
  // unmounts (sending flips false), so there's no leaked interval across
  // turns — this effect owns exactly one send's ticking window.
  useEffect(() => {
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), TICK_MS);
    return () => clearInterval(id);
  }, [startedAt]);

  useEffect(() => {
    const id = setInterval(
      () => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_TICK_MS,
    );
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const statusTick = Math.floor(elapsedMs / STATUS_WORD_INTERVAL_MS);
  const statusWord = useMemo(() => whimsicalStatusWord(), [rollKey, statusTick]);
  const phrase = waitingStatusPhrase(elapsedSec);

  const boxStyle = {
    ...bubbleGeometry(rect),
    width: "fit-content",
    minWidth: "16em",
    "--tail": rect.tail.side === "bottom" ? `${(rect.tail.offset / rect.width) * 100}%` : undefined,
    pointerEvents: "none",
    opacity: 0.85,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  } as CSSProperties;
  const lineStyle: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    flexWrap: "wrap",
  };
  const spinnerStyle: CSSProperties = {
    color: CASTLE.cream,
    fontSize: 15,
    marginRight: 8,
  };
  const captionStyle: CSSProperties = {
    color: CASTLE.creamFaint,
    fontSize: 13,
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div data-testid="room-waiting-bubble" data-mode={rect.mode} data-tail={rect.tail.side} className="castle-bubble" style={boxStyle}>
      <div style={lineStyle} data-testid="room-waiting-caption">
        <span aria-hidden style={spinnerStyle}>{SPINNER_FRAMES[spinnerFrame]}</span>
        <span style={captionStyle}>
          {queued ? `Queued behind another message… (${elapsedSec}s)` : `${statusWord}… (${elapsedSec}s · ${phrase})`}
        </span>
      </div>
    </div>
  );
}
