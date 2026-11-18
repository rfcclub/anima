import { test, expect, describe } from "bun:test";
import { withRoomLock } from "../../src/ui/features/town/api/room-lock";

// withRoomLock: the lock is freed when the response was never made, a queued send is told it
// is queued, and a disconnect aborts the running work and frees the room only once that work has stopped.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const sse = (...frames: string[]) => new Response(new ReadableStream({
  start(c) { for (const f of frames) c.enqueue(enc.encode(`data: ${f}\n\n`)); c.close(); },
}), { headers: { "content-type": "text/event-stream" } });

async function text(res: Response): Promise<string> { return await res.text(); }

describe("a throw while the response is made", () => {
  test("SC-3: frees the room, and the error reaches the caller", async () => {
    await expect(withRoomLock("w-throw", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const next = await Promise.race([withRoomLock("w-throw", () => new Response("ok")), sleep(500).then(() => "stuck")]);
    expect(next).not.toBe("stuck");
  });
});

describe("lock wait", () => {
  test("the factory is told how long the send waited for the room", async () => {
    let releaseFirst!: () => void;
    const first = await withRoomLock("w-wait", () => new Response(new ReadableStream({ start(c) { releaseFirst = () => c.close(); } })));
    let waited = -1;
    const secondP = withRoomLock("w-wait", (ctx) => { waited = ctx.waitedMs; return new Response("ok"); });
    await sleep(60);
    releaseFirst();
    await text(first);
    await secondP;
    expect(waited).toBeGreaterThanOrEqual(50);
  });
  test("a send that does not wait reports about zero", async () => {
    let waited = -1;
    await withRoomLock("w-nowait", (ctx) => { waited = ctx.waitedMs; return new Response("ok"); });
    expect(waited).toBeLessThan(50);
  });
});

describe("queued sends", () => {
  test("SC-1: a send that has to wait gets an event stream at once, first frame queued, then the real body", async () => {
    let releaseFirst!: () => void;
    const first = await withRoomLock("w-queue", () => new Response(new ReadableStream({
      start(c) { releaseFirst = () => { c.enqueue(enc.encode("data: first\n\n")); c.close(); }; },
    })), { queued: true });
    const secondP = withRoomLock("w-queue", () => sse(JSON.stringify("second")), { queued: true });
    const second = await Promise.race([secondP, sleep(300).then(() => null)]);
    expect(second).not.toBeNull(); // returned while the first still holds the room
    expect(second!.headers.get("content-type")).toContain("text/event-stream");
    const reader = second!.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    expect(firstChunk).toContain('"type":"queued"');
    releaseFirst();
    await text(first);
    let rest = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    expect(rest).toContain('"second"');
  });

  test("a send that does not have to wait is the plain response, with its status", async () => {
    const res = await withRoomLock("w-free", () => new Response(JSON.stringify({ error: "nope" }), { status: 404 }), { queued: true });
    expect(res.status).toBe(404);
    expect(await text(res)).toContain("nope");
  });

  test("a queued send whose response cannot be made ends with an error frame and [DONE], and frees the room", async () => {
    let releaseFirst!: () => void;
    const first = await withRoomLock("w-queue-err", () => new Response(new ReadableStream({
      start(c) { releaseFirst = () => c.close(); },
    })), { queued: true });
    const secondP = withRoomLock("w-queue-err", () => { throw new Error("cannot make it"); }, { queued: true });
    const second = await secondP;
    releaseFirst();
    await text(first);
    const body = await text(second);
    expect(body).toContain('"error":"cannot make it"');
    expect(body).toContain("[DONE]");
    const third = await Promise.race([withRoomLock("w-queue-err", () => new Response("ok")), sleep(500).then(() => "stuck")]);
    expect(third).not.toBe("stuck");
  });
});

describe("a disconnect", () => {
  test("SC-2: aborts the signal and frees the room only after the work has finished", async () => {
    let signal!: AbortSignal;
    let finish!: () => void;
    const finished = new Promise<void>((r) => { finish = r; });
    const res = await withRoomLock("w-abort", (ctx) => {
      signal = ctx.signal;
      return { response: new Response(new ReadableStream({ start() {} })), finished };
    });
    let secondStarted = false;
    const secondP = withRoomLock("w-abort", () => { secondStarted = true; return new Response("ok"); });
    await res.body!.cancel("client closed the tab");
    expect(signal.aborted).toBe(true);
    await sleep(50);
    expect(secondStarted).toBe(false); // the first pipeline has not stopped yet
    finish();
    await secondP;
    expect(secondStarted).toBe(true);
  });

  test("SC-2: if the work ignores the abort, the room is still freed after the grace period", async () => {
    const res = await withRoomLock("w-ignore", () => ({
      response: new Response(new ReadableStream({ start() {} })),
      finished: new Promise<void>(() => {}), // never finishes
    }), { graceMs: 40 });
    let secondStarted = false;
    const secondP = withRoomLock("w-ignore", () => { secondStarted = true; return new Response("ok"); });
    await res.body!.cancel();
    await sleep(10);
    expect(secondStarted).toBe(false);
    await secondP;
    expect(secondStarted).toBe(true);
  });

  test("SC-2: a queued send that is closed while its work runs frees the room only after the work stops", async () => {
    let releaseFirst!: () => void;
    const first = await withRoomLock("w-queued-abort", () => new Response(new ReadableStream({
      start(c) { releaseFirst = () => c.close(); },
    })), { queued: true });
    let signal!: AbortSignal;
    let finish!: () => void;
    const finished = new Promise<void>((r) => { finish = r; });
    const second = await withRoomLock("w-queued-abort", (ctx) => {
      signal = ctx.signal;
      return { response: new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }), finished };
    }, { queued: true });
    let thirdStarted = false;
    const thirdP = withRoomLock("w-queued-abort", () => { thirdStarted = true; return new Response("ok"); });
    releaseFirst();
    await text(first);
    await sleep(30); // the second send now holds the room and is running
    await second.body!.cancel("tab closed");
    expect(signal.aborted).toBe(true);
    await sleep(50);
    expect(thirdStarted).toBe(false);
    finish();
    await thirdP;
    expect(thirdStarted).toBe(true);
  });

  test("regression: a queued send closed while its response is still being made frees the room once the work stops", async () => {
    let releaseFirst!: () => void;
    const first = await withRoomLock("w-mid-make", () => new Response(new ReadableStream({
      start(c) { releaseFirst = () => c.close(); },
    })), { queued: true });
    let signal!: AbortSignal;
    let finish!: () => void;
    const finished = new Promise<void>((r) => { finish = r; });
    let madeResolve!: () => void;
    const made = new Promise<void>((r) => { madeResolve = r; });
    let makeStarted = false;
    const second = await withRoomLock("w-mid-make", async (ctx) => {
      makeStarted = true;
      signal = ctx.signal;
      await made; // e.g. the first `await import(...)` of the pipeline
      return { response: new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }), finished };
    }, { queued: true, graceMs: 100 });
    let thirdStarted = false;
    const thirdP = withRoomLock("w-mid-make", () => { thirdStarted = true; return new Response("ok"); });
    releaseFirst();
    await text(first);
    await sleep(30);
    expect(makeStarted).toBe(true);
    await second.body!.cancel("tab closed"); // the lock is ours, the response is not made yet
    madeResolve();
    await sleep(30);
    expect(signal.aborted).toBe(true); // the pipeline that was started is told to stop
    finish();
    const third = await Promise.race([thirdP, sleep(600).then(() => "stuck")]);
    expect(third).not.toBe("stuck");
    expect(thirdStarted).toBe(true);
  });

  test("regression: once the room is ours the stream says running, before the response is made", async () => {
    let releaseFirst!: () => void;
    const first = await withRoomLock("w-running", () => new Response(new ReadableStream({
      start(c) { releaseFirst = () => c.close(); },
    })), { queued: true });
    let madeResolve!: () => void;
    const made = new Promise<void>((r) => { madeResolve = r; });
    const second = await withRoomLock("w-running", async () => { await made; return sse(JSON.stringify("second")); }, { queued: true });
    const reader = second.body!.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toContain('"type":"queued"');
    releaseFirst();
    await text(first);
    const next = await Promise.race([reader.read().then((r) => dec.decode(r.value)), sleep(300).then(() => "silent")]);
    expect(next).toContain('"type":"running"'); // the provider has not answered yet, the caption can already change
    madeResolve();
  });

  test("a disconnect of a response with no running work frees the room at once", async () => {
    const res = await withRoomLock("w-plain", () => new Response(new ReadableStream({ start() {} })));
    const secondP = withRoomLock("w-plain", () => new Response("ok"));
    await res.body!.cancel();
    const second = await Promise.race([secondP, sleep(300).then(() => "stuck")]);
    expect(second).not.toBe("stuck");
  });
});
