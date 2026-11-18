import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlGardenEventStore } from "../../../garden/event-store";
import { createGardenEvent } from "../../../garden/events";
import { eventToVnPayload, eventToVnPayloads } from "./castle-director";
import { createCastleReplayStream, FRAME_DELAY_CAP_MS } from "./castle-replay";
import { routes } from "./routes";

function seedEvents(roomsDir: string) {
  const store = new JsonlGardenEventStore(join(roomsDir, "_shared", "garden", "events.jsonl"));
  return store;
}

function moved(agentId: string, ts: string, payload: Record<string, unknown> = {}) {
  return createGardenEvent({
    id: `e-${agentId}-${ts}`,
    type: "AGENT_MOVED",
    timestamp: ts,
    agentId,
    instanceId: "test",
    runtime: "test",
    project: "anima",
    payload: { from: "chamber", to: "hall_main", disposition: "wander", seed: 1, ...payload },
  });
}

function tick(agentId: string, ts: string) {
  return createGardenEvent({
    id: `t-${agentId}-${ts}`,
    type: "TICK_ACTION",
    timestamp: ts,
    agentId,
    instanceId: "test",
    runtime: "test",
    project: "anima",
    payload: { action: "rest" },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return out;
}

// Reads the stream and records the wall-clock arrival time of each data frame
// (excluding [DONE]), relative to when reading started.
async function frameArrivalTimes(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const times: number[] = [];
  const start = Date.now();
  let buf = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.startsWith("data: ") && !block.includes("[DONE]")) {
        times.push(Date.now() - start);
      }
    }
  }
  return times;
}

function parseFrames(raw: string): Array<{ id: string; ts: string; payload: unknown }> {
  return raw
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .filter((b) => !b.includes("[DONE]"))
    .map((b) => JSON.parse(b.replace(/^data: /, "")));
}

let dir: string;
let roomsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "castle-replay-"));
  roomsDir = dir;
});

afterEach(() => {
  // tmpdir auto-cleaned by OS; nothing explicit needed
});

// SC-002: in-range event included, out-of-range excluded
test("SC-002: replay stream returns only in-range events", async () => {
  const store = seedEvents(roomsDir);
  await store.append(moved("bruno", "1970-01-01T00:00:01.000Z")); // t=1000
  await store.append(moved("lena", "1970-01-01T00:00:02.000Z")); // t=2000
  await store.append(moved("sam", "1970-01-01T00:00:03.000Z")); // t=3000

  const stream = createCastleReplayStream({ from: 1500, to: 2500, speed: 0, roomsDir });
  const raw = await readStream(stream);
  const frames = parseFrames(raw);

  // Only lena is in range; a move compiles to [exit, enter] = 2 frames.
  expect(frames.length).toBe(2);
  expect(frames[0].id).toBe("e-lena-1970-01-01T00:00:02.000Z");
  expect(frames[1].id).toBe("e-lena-1970-01-01T00:00:02.000Z");
});

// SC-003: empty range → only [DONE]
test("SC-003: empty range yields only [DONE]", async () => {
  const store = seedEvents(roomsDir);
  await store.append(moved("bruno", "1970-01-01T00:00:01.000Z"));

  const stream = createCastleReplayStream({ from: 5000, to: 6000, speed: 0, roomsDir });
  const raw = await readStream(stream);

  expect(raw.trim()).toBe("data: [DONE]");
});

// SC-004: parity — replay frames deep-equal the director's payload sequence
test("SC-004: replay frames match eventToVnPayloads for the same event", async () => {
  const store = seedEvents(roomsDir);
  const event = moved("bruno", "1970-01-01T00:00:01.000Z");
  await store.append(event);

  const stream = createCastleReplayStream({ from: 0, to: 9999999999999, speed: 0, roomsDir });
  const raw = await readStream(stream);
  const frames = parseFrames(raw);

  const directorPayloads = eventToVnPayloads(event);
  // A move compiles to [exit, enter] — replay emits one frame per payload.
  expect(frames.length).toBe(directorPayloads.length);
  for (let i = 0; i < directorPayloads.length; i++) {
    expect(frames[i].payload).toEqual(directorPayloads[i]);
  }
  // Backward-compat: the singular director still returns the enter payload.
  expect(eventToVnPayload(event)).toEqual(directorPayloads[1]);
});

// SC-005: unmapped type (TICK_ACTION) skipped
test("SC-005: unmapped event type is absent from frames", async () => {
  const store = seedEvents(roomsDir);
  await store.append(tick("bruno", "1970-01-01T00:00:01.000Z")); // director returns null
  await store.append(moved("lena", "1970-01-01T00:00:02.000Z"));

  const stream = createCastleReplayStream({ from: 0, to: 9999999999999, speed: 0, roomsDir });
  const raw = await readStream(stream);
  const frames = parseFrames(raw);

  // Only lena's move compiles (TICK_ACTION yields null); [exit, enter] = 2 frames.
  expect(frames.length).toBe(2);
  expect(frames[0].id).toBe("e-lena-1970-01-01T00:00:02.000Z");
});

// SC-006: final frame [DONE], stream closes
test("SC-006: last frame is [DONE] and reader completes", async () => {
  const store = seedEvents(roomsDir);
  await store.append(moved("bruno", "1970-01-01T00:00:01.000Z"));

  const stream = createCastleReplayStream({ from: 0, to: 9999999999999, speed: 0, roomsDir });
  const raw = await readStream(stream);

  expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);
});

// SC-007: speed=0 → no delays (fast)
test("SC-007: speed=0 emits all frames in under 200ms", async () => {
  const store = seedEvents(roomsDir);
  await store.append(moved("bruno", "1970-01-01T00:00:00.000Z"));
  await store.append(moved("lena", "1970-01-01T00:00:10.000Z")); // 10s gap
  await store.append(moved("sam", "1970-01-01T00:00:20.000Z")); // 10s gap

  const start = Date.now();
  const stream = createCastleReplayStream({ from: 0, to: 9999999999999, speed: 0, roomsDir });
  await readStream(stream);
  const elapsed = Date.now() - start;

  expect(elapsed).toBeLessThan(200);
});

// SC-008: speed=100 paces a 10s gap to ~100ms (gap / speed), subject to the cap
test("SC-008: 10s gap at speed=100 emits the second frame after ~100ms", async () => {
  const store = seedEvents(roomsDir);
  await store.append(moved("bruno", "1970-01-01T00:00:00.000Z"));
  await store.append(moved("lena", "1970-01-01T00:00:10.000Z")); // 10s gap

  const start = Date.now();
  const stream = createCastleReplayStream({ from: 0, to: 9999999999999, speed: 100, roomsDir });
  await readStream(stream);
  const elapsed = Date.now() - start;

  // gap/speed = 10,000ms / 100 = 100ms. Allow a slack band either side; the
  // point is that pacing is applied (not ~0 like speed=0, not capped like 1h).
  expect(elapsed).toBeGreaterThanOrEqual(80);
  expect(elapsed).toBeLessThan(600);
});

// SC-009: gap/speed pacing + delay cap
test("SC-009: 1h gap at speed=1 is capped at FRAME_DELAY_CAP_MS", async () => {
  const store = seedEvents(roomsDir);
  await store.append(moved("bruno", "1970-01-01T00:00:00.000Z"));
  await store.append(moved("lena", "1970-01-01T01:00:00.000Z")); // 1h gap

  const start = Date.now();
  const stream = createCastleReplayStream({ from: 0, to: 9999999999999, speed: 1, roomsDir });
  await readStream(stream);
  const elapsed = Date.now() - start;

  // gap/speed = 3,600,000ms, capped at FRAME_DELAY_CAP_MS (2000) + slack
  expect(elapsed).toBeLessThan(FRAME_DELAY_CAP_MS + 1000);
  expect(elapsed).toBeGreaterThanOrEqual(FRAME_DELAY_CAP_MS - 500);
});

void mkdtempSync;

// SC-001 + SC-010: route-level validation
test("SC-001: GET /api/castle/replay returns 200 + text/event-stream", async () => {
  const store = seedEvents(roomsDir);
  await store.append(moved("bruno", "1970-01-01T00:00:01.000Z"));

  const res = await routes(
    new Request("http://x/api/castle/replay?from=0&to=9999999999999"),
    "/api/castle/replay",
    { roomsDir },
  );
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  expect(res!.headers.get("content-type")).toBe("text/event-stream");
});

test("SC-010: invalid params return 400", async () => {
  const cases = [
    "from=abc&to=1000",
    "from=5000&to=1000",
    "from=1000&to=2000&speed=-1",
  ];
  for (const qs of cases) {
    const res = await routes(
      new Request(`http://x/api/castle/replay?${qs}`),
      "/api/castle/replay",
      { roomsDir },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  }
});
