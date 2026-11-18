import { describe, expect, test } from "bun:test";
import { readBeats, type Beat } from "../../src/ui/features/castle/lib/beat-stream";

const frame = (agent: string, content: string) => `data: ${JSON.stringify({ agent, type: "text", content })}\n\n`;
const beatEnd = (agent: string) => `data: ${JSON.stringify({ agent, type: "beat_end" })}\n\n`;

/** A response whose body sends `before`, waits for `gate`, then sends `after`. */
function gatedResponse(before: string[], gate: Promise<void>, after: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of before) controller.enqueue(enc.encode(chunk));
      await gate;
      for (const chunk of after) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
}

function responseOf(chunks: string[]): Response {
  return gatedResponse(chunks, Promise.resolve(), []);
}

describe("readBeats", () => {
  test("delivers A's answer at its beat_end, before any of B's frames arrive", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: Array<Beat & { released: boolean }> = [];
    let released = false;
    const res = gatedResponse(
      [frame("milo", "Hi "), frame("milo", "there."), beatEnd("milo")],
      gate,
      [frame("sam", "I'm "), frame("sam", "here."), beatEnd("sam"), "data: [DONE]\n\n"],
    );
    const reading = readBeats(res, "milo", (beat) => seen.push({ ...beat, released }));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([{ speaker: "milo", content: "Hi there.", released: false }]);
    released = true;
    release();
    const count = await reading;
    expect(count).toBe(2);
    expect(seen).toEqual([
      { speaker: "milo", content: "Hi there.", released: false },
      { speaker: "sam", content: "I'm here.", released: true },
    ]);
  });

  test("without beat_end, ends A's beat when B's first frame arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: Beat[] = [];
    const res = gatedResponse(
      [frame("milo", "Hi there."), frame("sam", "I'm")],
      gate,
      [frame("sam", " here."), "data: [DONE]\n\n"],
    );
    const reading = readBeats(res, "milo", (beat) => seen.push(beat));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([{ speaker: "milo", content: "Hi there." }]);
    release();
    await reading;
    expect(seen).toEqual([
      { speaker: "milo", content: "Hi there." },
      { speaker: "sam", content: "I'm here." },
    ]);
  });

  test("delivers a narrator frame as its own beat", async () => {
    const seen: Beat[] = [];
    await readBeats(responseOf([`data: ${JSON.stringify({ agent: "narrator", type: "text", content: "The room is empty." })}\n\n`, "data: [DONE]\n\n"]), "milo", (b) => seen.push(b));
    expect(seen).toEqual([{ speaker: "narrator", content: "The room is empty." }]);
  });

  test("falls back to plain text for the owner when no frame is tagged", async () => {
    const seen: Beat[] = [];
    const count = await readBeats(responseOf(['data: "Hello "\n\n', "data: world\n\n", "data: [DONE]\n\n"]), "milo", (b) => seen.push(b));
    expect(count).toBe(1);
    expect(seen).toEqual([{ speaker: "milo", content: "Hello world" }]);
  });

  test("parses a frame split across chunks, including inside the JSON", async () => {
    const whole = frame("milo", "One long sentence.") + "data: [DONE]\n\n";
    const seen: Beat[] = [];
    await readBeats(responseOf([whole.slice(0, 9), whole.slice(9, 27), whole.slice(27)]), "milo", (b) => seen.push(b));
    expect(seen).toEqual([{ speaker: "milo", content: "One long sentence." }]);
  });

  test("ignores error frames and ends the last beat when the body ends without [DONE]", async () => {
    const seen: Beat[] = [];
    await readBeats(responseOf([frame("milo", "Still here."), `data: ${JSON.stringify({ error: "provider down" })}\n\n`]), "milo", (b) => seen.push(b));
    expect(seen).toEqual([{ speaker: "milo", content: "Still here." }]);
  });
});

describe("readBeats status", () => {
  const queuedFrame = `data: ${JSON.stringify({ type: "queued" })}\n\n`;

  test("a queued frame reports queued, the first real frame reports running, and neither is a beat", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const res = gatedResponse([queuedFrame], gate, [frame("milo", "Hi there."), beatEnd("milo"), "data: [DONE]\n\n"]);
    const reading = readBeats(res, "milo", (beat) => events.push(`beat:${beat.speaker}`), (status) => events.push(`status:${status}`));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(["status:queued"]);
    release();
    expect(await reading).toBe(1);
    expect(events).toEqual(["status:queued", "status:running", "beat:milo"]);
  });

  test("regression: a running frame ends the queued state before any beat arrives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const runningFrame = `data: ${JSON.stringify({ type: "running" })}\n\n`;
    const res = gatedResponse([queuedFrame, runningFrame], gate, [frame("milo", "Hi there."), beatEnd("milo"), "data: [DONE]\n\n"]);
    const reading = readBeats(res, "milo", (beat) => events.push(`beat:${beat.speaker}`), (status) => events.push(`status:${status}`));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(["status:queued", "status:running"]); // the provider has not answered yet
    release();
    expect(await reading).toBe(1);
    expect(events).toEqual(["status:queued", "status:running", "beat:milo"]);
  });

  test("a response that was never queued reports no status", async () => {
    const events: string[] = [];
    await readBeats(responseOf([frame("milo", "Hi"), beatEnd("milo"), "data: [DONE]\n\n"]), "milo", () => {}, (status) => events.push(status));
    expect(events).toEqual([]);
  });

  test("the plain-text fallback and an error frame also end the queued state", async () => {
    const plain: string[] = [];
    await readBeats(responseOf([queuedFrame, 'data: "Hello"\n\n', "data: [DONE]\n\n"]), "milo", () => {}, (status) => plain.push(status));
    expect(plain).toEqual(["queued", "running"]);
    const err: string[] = [];
    await readBeats(responseOf([queuedFrame, `data: ${JSON.stringify({ error: "boom" })}\n\n`, "data: [DONE]\n\n"]), "milo", () => {}, (status) => err.push(status));
    expect(err).toEqual(["queued", "running"]);
  });
});
