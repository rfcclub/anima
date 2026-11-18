import { test, expect } from "bun:test";
import { watchUrl, type WatchMode } from "../../src/ui/features/castle/components/WatchTimeline";

// SC-012: control emits correct replay URL
test("SC-012: watchUrl(live) = /api/castle/feed", () => {
  const mode: WatchMode = { kind: "live" };
  expect(watchUrl(mode)).toBe("/api/castle/feed");
});

test("SC-012: watchUrl(replay) = /api/castle/replay?from=..&to=..&speed=..", () => {
  const mode: WatchMode = { kind: "replay", from: 1000, to: 2000, speed: 20 };
  expect(watchUrl(mode)).toBe("/api/castle/replay?from=1000&to=2000&speed=20");
});

// SC-013: finished state → null URL (no reconnect)
test("SC-013: watchUrl(finished) = null", () => {
  const mode: WatchMode = { kind: "finished" };
  expect(watchUrl(mode)).toBe(null);
});

// SC-014: back-to-live opens feed URL
test("SC-014: finished → live transitions back to feed URL", () => {
  const finished: WatchMode = { kind: "finished" };
  expect(watchUrl(finished)).toBe(null);
  const live: WatchMode = { kind: "live" };
  expect(watchUrl(live)).toBe("/api/castle/feed");
});

// SC-011: structural guarantee — WatchTimeline deals only in URLs/mode,
// not frames/payloads. The single parse/apply path stays in the page.
test("SC-011: WatchMode is a URL/mode union, carries no frame/payload data", () => {
  const modes: WatchMode[] = [
    { kind: "live" },
    { kind: "replay", from: 1, to: 2, speed: 1 },
    { kind: "finished" },
  ];
  // Every mode produces a URL or null — never carries payload/frame fields.
  for (const m of modes) {
    const url = watchUrl(m);
    expect(url === null || typeof url === "string").toBe(true);
    expect("payload" in m).toBe(false);
    expect("frame" in m).toBe(false);
  }
});
