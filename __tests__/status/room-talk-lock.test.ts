import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTalk } from "../../src/ui/features/town/api/talk";
import { withRoomLock } from "../../src/ui/features/town/api/room-lock";
import { getSharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

// A room send must never be silent or stuck: it says when it is queued, a disconnect
// stops the provider call and only then frees the room, a throw before the stream exists frees the room, a
// beat that runs past a limit ends with an error, and a queued send sees the exchange before it.

function makeConfig(name: string, roomsDir: string): string {
  return [
    "identity:", `  name: ${name}`, `  label: ${name}`, "  identityAnchor: test",
    "boot:", "  gene: AGENTS.md", "  soul: SOUL.md", "  sessionContext:", "  - MEMORY.md",
    "memory:", "  store: jsonl",
    "session:", "  defaultMode: plan", "  compactThreshold: 50",
    "provider:", "  type: mock", "  model: mock-model",
    "policy:", "  allowedRoots:", `  - ${join(roomsDir, name)}`,
    "reflection:", "  enabled: false",
  ].join("\n");
}

function setupRoom(roomsDir: string, name: string) {
  const dir = join(roomsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), makeConfig(name, roomsDir));
  writeFileSync(join(dir, "AGENTS.md"), `# ${name}`);
  writeFileSync(join(dir, "SOUL.md"), `# ${name} soul`);
  writeFileSync(join(dir, "MEMORY.md"), "");
}

interface Call { req: ProviderRequest; settled: boolean }

/** A provider whose calls are held open until released, that honours `req.signal`, and that records every call. */
function gatedProvider(name: string, reply = "ok") {
  const calls: Call[] = [];
  const releases: Array<() => void> = [];
  const provider = {
    name,
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      const call: Call = { req, settled: false };
      calls.push(call);
      try {
        await new Promise<void>((resolve, reject) => {
          releases.push(resolve);
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      } finally {
        call.settled = true;
      }
      return { message: { role: "assistant", content: reply }, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  } as unknown as Provider;
  return { provider, calls, releaseAll: () => releases.splice(0).forEach((r) => r()) };
}

const send = (message: string) =>
  new Request("http://localhost/api/talk/eli", {
    method: "POST",
    headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
    body: JSON.stringify({ message }),
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await sleep(5);
  }
}

describe("room talk lock", () => {
  let roomsDir: string;
  let transcriptsDir: string;

  beforeEach(() => {
    __resetSharedNarrativeStore();
    process.env.ANIMA_TEST_PROVIDERS = "true";
    process.env.ANIMA_TALK_STOP_GRACE_MS = "100";
    roomsDir = mkdtempSync(join(tmpdir(), "anima-lock-"));
    transcriptsDir = mkdtempSync(join(tmpdir(), "anima-lock-trans-"));
    process.env.ANIMA_TRANSCRIPTS_DIR = transcriptsDir;
    process.env.ANIMA_UI_STATE_DIR = roomsDir;
    setupRoom(roomsDir, "eli");
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["eli"]);
    store.setPresence({ agentId: "eli", placeId: "chamber_eli", since: 1000 });
  });

  afterEach(() => {
    __resetSharedNarrativeStore();
    delete process.env.ANIMA_TEST_PROVIDERS;
    delete process.env.ANIMA_TRANSCRIPTS_DIR;
    delete process.env.ANIMA_UI_STATE_DIR;
    delete process.env.ANIMA_TALK_BEAT_TIMEOUT_MS;
    delete process.env.ANIMA_TALK_STOP_GRACE_MS;
    rmSync(roomsDir, { recursive: true, force: true });
    rmSync(transcriptsDir, { recursive: true, force: true });
  });

  async function startSend(providers: Map<string, Provider>, message: string, addressee?: string) {
    const req = new Request("http://localhost/api/talk/eli", {
      method: "POST",
      headers: { "content-type": "application/json", referer: "http://localhost/rooms/eli" },
      body: JSON.stringify(addressee ? { message, addressee } : { message }),
    });
    return handleTalk(req, "eli", { roomsDir, providers });
  }

  test("control: a send made after the first has finished sees the earlier exchange", async () => {
    const g = gatedProvider("mock", "first answer");
    const providers = new Map<string, Provider>([["eli", g.provider]]);
    const first = await startSend(providers, "first question");
    const firstText = first.text();
    await until(() => g.calls.length === 1);
    g.releaseAll();
    await firstText;
    const second = await startSend(providers, "second question");
    const secondText = second.text();
    await until(() => g.calls.length === 2);
    const contents = g.calls[1]!.req.messages.map((m) => String(m.content));
    g.releaseAll();
    await secondText;
    expect(contents.some((c) => c.includes("first question"))).toBe(true);
  }, 15000);

  test("SC-5: a send that queued behind another sees the earlier exchange in its context", async () => {
    const g = gatedProvider("mock", "first answer");
    const providers = new Map<string, Provider>([["eli", g.provider]]);
    const first = await startSend(providers, "first question");
    const firstText = first.text();
    await until(() => g.calls.length === 1);
    const secondP = startSend(providers, "second question");
    await sleep(50);
    g.releaseAll();
    await firstText;
    const second = await secondP;
    const secondText = second.text();
    await until(() => g.calls.length === 2);
    const contents = g.calls[1]!.req.messages.map((m) => String(m.content));
    g.releaseAll();
    await secondText;
    expect(contents.some((c) => c.includes("first question"))).toBe(true);
    expect(contents.some((c) => c.includes("first answer"))).toBe(true);
  }, 15000);

  test("SC-1: a send that has to wait answers at once with a queued frame, then the real reply", async () => {
    const g = gatedProvider("mock", "the answer");
    const providers = new Map<string, Provider>([["eli", g.provider]]);
    const first = await startSend(providers, "first");
    const firstText = first.text();
    await until(() => g.calls.length === 1);
    const second = await Promise.race([startSend(providers, "second"), sleep(500).then(() => null)]);
    expect(second).not.toBeNull(); // the response came while the first still held the room
    const reader = second!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"queued"');
    g.releaseAll();
    await firstText;
    await until(() => g.calls.length === 2);
    g.releaseAll();
    let rest = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    expect(rest).toContain("answer");
    expect(rest).toContain("[DONE]");
  }, 15000);

  test("SC-2: closing the stream aborts the provider call, and the next send starts only after it stopped", async () => {
    const g = gatedProvider("mock", "late answer");
    const providers = new Map<string, Provider>([["eli", g.provider]]);
    const first = await startSend(providers, "first");
    await until(() => g.calls.length === 1);
    const secondP = startSend(providers, "second");
    await first.body!.cancel("tab closed");
    await until(() => g.calls[0]!.req.signal?.aborted === true);
    await until(() => g.calls[0]!.settled);
    const second = await secondP;
    await until(() => g.calls.length === 2);
    expect(g.calls[0]!.settled).toBe(true); // never two provider calls at once on one room
    g.releaseAll();
    await second.text();
  }, 15000);

  test("SC-4: a beat that runs past the limit ends with an error naming it, then [DONE], and the room takes the next send", async () => {
    process.env.ANIMA_TALK_BEAT_TIMEOUT_MS = "150";
    const g = gatedProvider("mock", "never");
    const providers = new Map<string, Provider>([["eli", g.provider]]);
    const first = await startSend(providers, "first");
    const text = await first.text();
    expect(text).toContain("150 ms");
    expect(text).toContain("[DONE]");
    delete process.env.ANIMA_TALK_BEAT_TIMEOUT_MS;
    const fresh = gatedProvider("mock", "fine");
    const second = await Promise.race([startSend(new Map<string, Provider>([["eli", fresh.provider]]), "second"), sleep(2000).then(() => "stuck" as const)]);
    expect(second).not.toBe("stuck");
    await until(() => fresh.calls.length === 1);
    fresh.releaseAll();
    expect(await (second as Response).text()).toContain("fine");
  }, 15000);

  test("SC-4: a provider that ignores the abort cannot hold the room past the limit either", async () => {
    process.env.ANIMA_TALK_BEAT_TIMEOUT_MS = "150";
    const stubborn = { name: "mock", async query(): Promise<ProviderResponse> { await new Promise(() => {}); throw new Error("unreachable"); } } as unknown as Provider;
    const startedAt = Date.now();
    const first = await startSend(new Map<string, Provider>([["eli", stubborn]]), "first");
    const text = await first.text();
    expect(text).toContain("150 ms");
    expect(text).toContain("[DONE]");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(240); // the limit plus the grace for the provider to stop
  }, 15000);

  test("SC-6: each beat logs its room, speaker, provider, model, lock wait and provider time", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const g = gatedProvider("mock", "fine");
      const providers = new Map<string, Provider>([["eli", g.provider]]);
      const first = await startSend(providers, "first");
      const firstText = first.text();
      await until(() => g.calls.length === 1);
      const secondP = startSend(providers, "second");
      await sleep(60);
      g.releaseAll();
      await firstText;
      const second = await secondP;
      const secondText = second.text();
      await until(() => g.calls.length === 2);
      g.releaseAll();
      await secondText;
    } finally {
      console.log = orig;
    }
    const beats = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.msg === "talk beat");
    expect(beats.length).toBe(2);
    expect(beats[0]).toMatchObject({ room: "eli", speaker: "eli", model: "mock-model", outcome: "ok" });
    expect(typeof beats[0].lockWaitMs).toBe("number");
    expect(typeof beats[0].providerMs).toBe("number");
    expect(beats[1].lockWaitMs).toBeGreaterThanOrEqual(50); // the second send queued behind the first
  }, 15000);

  test("SC-4: the limit applies to a beat of a multi-speaker send too", async () => {
    setupRoom(roomsDir, "bruno");
    const store = getSharedNarrativeStore(join(roomsDir, "_shared", "memory.db"));
    store.seedPlacesFromRoster(["eli", "bruno"]);
    store.setPresence({ agentId: "bruno", placeId: "chamber_eli", since: 2000 });
    process.env.ANIMA_TALK_BEAT_TIMEOUT_MS = "150";
    const stubborn = { name: "mock", async query(): Promise<ProviderResponse> { await new Promise(() => {}); throw new Error("unreachable"); } } as unknown as Provider;
    const first = await startSend(new Map<string, Provider>([["eli", stubborn], ["bruno", stubborn]]), "both of you", "all");
    const text = await first.text();
    expect(text).toContain("150 ms");
    expect(text).toContain("[DONE]");
  }, 15000);
});
