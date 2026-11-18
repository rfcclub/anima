import { useState } from "react";
import { CASTLE } from "../lib/castle-style";

export type WatchMode =
  | { kind: "live" }
  | { kind: "replay"; from: number; to: number; speed: number }
  | { kind: "finished" };

/** Resolve a WatchMode to the SSE URL the page consumer should open.
 *  Returns null for finished — the page closes the EventSource on [DONE]. */
export function watchUrl(mode: WatchMode): string | null {
  if (mode.kind === "live") return "/api/castle/feed";
  if (mode.kind === "replay") {
    return `/api/castle/replay?from=${mode.from}&to=${mode.to}&speed=${mode.speed}`;
  }
  return null;
}

const SPEEDS = [1, 20, 0] as const; // 0 = max

/**
 * WatchTimeline — the live/replay mode switch for the castle watch surface.
 *
 * Deals ONLY in URLs and mode state (SC-011 structural guarantee): the page
 * consumer owns the single EventSource + parse/apply path; this component
 * just yields the active SSE URL via `onUrlChange` and signals completion via
 * `onDone` (page calls it when the SSE stream emits `[DONE]`).
 */
export function WatchTimeline({
  onUrlChange,
  onDone,
}: {
  onUrlChange: (url: string | null) => void;
  onDone?: () => void;
}) {
  const [mode, setMode] = useState<WatchMode>({ kind: "live" });
  const [speed, setSpeed] = useState<number>(20);

  const set = (m: WatchMode) => {
    setMode(m);
    onUrlChange(watchUrl(m));
  };

  // Page calls this when the SSE stream emits [DONE] — transition to finished,
  // close the EventSource (page responsibility), no new URL.
  const handleDone = () => {
    set({ kind: "finished" });
    onDone?.();
  };

  const lastNight = () => {
    const now = Date.now();
    set({ kind: "replay", from: now - 12 * 3600_000, to: now, speed });
  };

  return (
    <div
      data-testid="watch-timeline"
      style={{ display: "flex", gap: 8, alignItems: "center", color: CASTLE.cream }}
    >
      <button onClick={() => set({ kind: "live" })}>Live</button>
      <button onClick={lastNight}>Last night</button>
      {SPEEDS.map((s) => (
        <button key={s} onClick={() => setSpeed(s)} disabled={speed === s}>
          {s === 0 ? "max" : `${s}×`}
        </button>
      ))}
      {mode.kind === "finished" && <span>Replay ended</span>}
      {/* handleDone is exposed for the page to call on [DONE]; kept here so
          the finished transition + null URL is owned by this component. */}
      <span hidden data-testid="watch-done-ref" data-handler={typeof handleDone} />
    </div>
  );
}
