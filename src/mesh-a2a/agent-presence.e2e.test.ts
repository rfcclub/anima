import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { sidecarClient } from "colony-mesh/a2a/mesh-sidecar-socket";
import { AnimaMeshPresence, presenceSocketPath } from "./agent-presence";

/**
 * rfcclub/anima#103 slice 1 against the real colony-meshd gateway and the real identity-runtime,
 * both in a child process on temp databases (fixtures/mesh-stack-host.ts).
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function tempDir(prefix: string): string {
  // Unix socket paths are short; keep homes near the root of tmp.
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function meshStack(agents: string[], gate?: string, enrollGate?: string): Promise<{ meshUrl: string; identityUrl: string }> {
  const root = tempDir("ms-");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "mesh-stack-host.ts")], {
    env: { ...process.env, MESH_STACK_ROOT: root, MESH_STACK_AGENTS: agents.join(","), ...(gate ? { MESH_STACK_COMPILE_GATE: gate } : {}), ...(enrollGate ? { MESH_STACK_ENROLL_GATE: enrollGate } : {}) },
    stdout: "pipe", stderr: "inherit",
  });
  cleanups.push(async () => { child.kill(); await child.exited; });
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const part = await reader.read();
    if (part.done) throw new Error("mesh stack host exited before it was ready");
    text += new TextDecoder().decode(part.value);
  }
  reader.releaseLock();
  return JSON.parse(text.split("\n")[0]!);
}

function expectedMeshId(agent: string, home: string): string {
  const key = createHash("sha256").update(realpathSync(home)).digest("hex").slice(0, 8);
  const machine = hostname().split(".")[0]!.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `${agent}-anima-${key}@${machine}`;
}

function presence(stack: { meshUrl: string; identityUrl: string }, agents: string[], animaHome: string, logs: unknown[] = []) {
  const created = new AnimaMeshPresence({
    agents, animaHome, identityUrl: stack.identityUrl, meshUrl: stack.meshUrl, heartbeatIntervalMs: 200, joinRetryMs: 200,
    log: (_level, message, fields) => logs.push({ message, ...fields }),
  });
  cleanups.push(() => created.stop());
  return created;
}

async function firstInboxItem(meshUrl: string, capability: string): Promise<{ conversationId: string; content: string; sender: string }> {
  const response = await fetch(`${meshUrl}/a2a/inbox/events?after=0`, { headers: { authorization: `Bearer ${capability}` } });
  const reader = response.body!.getReader();
  let buffer = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) throw new Error("inbox stream ended");
    buffer += new TextDecoder().decode(part.value);
    const data = buffer.split("\n").find((line) => line.startsWith("data: "));
    if (data) { await reader.cancel(); return JSON.parse(data.slice(6)); }
  }
}

describe("AnimaMeshPresence against a real gateway and identity-runtime", () => {
  test("AJ-1 each hosted agent joins with harness anima and the mesh ID of its ANIMA home", async () => {
    const stack = await meshStack(["finn", "jade"]);
    const home = tempDir("ah-");
    const hosted = presence(stack, ["finn", "jade"], home);
    await hosted.start();
    expect(hosted.meshId("finn")).toBe(expectedMeshId("finn", home));
    expect(hosted.meshId("jade")).toBe(expectedMeshId("jade", home));
    const listed = await hosted.list("finn");
    expect(listed.status).toBe(200);
    const directory = listed.body as Record<string, { harness: string; status: string; cwd: string }>;
    for (const agent of ["finn", "jade"]) {
      expect(directory[expectedMeshId(agent, home)]).toMatchObject({ harness: "anima", status: "online", cwd: realpathSync(home) });
    }
  }, 30_000);

  test("AJ-2 stop takes the agents offline, and a restart from another working directory keeps the same mesh IDs", async () => {
    const stack = await meshStack(["finn", "jade", "watcher"]);
    const home = tempDir("ah-");
    const watcher = presence(stack, ["watcher"], tempDir("aw-"));
    await watcher.start();
    const first = presence(stack, ["finn", "jade"], home);
    await first.start();
    const finn = expectedMeshId("finn", home);
    await first.stop();
    const afterStop = (await watcher.list("watcher")).body as Record<string, { status: string }>;
    expect(afterStop[finn]?.status).toBe("offline");
    expect(afterStop[expectedMeshId("jade", home)]?.status).toBe("offline");

    const previous = process.cwd();
    process.chdir(tempDir("cw-"));
    cleanups.push(() => process.chdir(previous));
    const second = presence(stack, ["finn", "jade"], home);
    await second.start();
    expect(second.meshId("finn")).toBe(finn);
    expect(((await watcher.list("watcher")).body as Record<string, { status: string }>)[finn]?.status).toBe("online");
  }, 30_000);

  test("AJ-4 a send through agent A's socket arrives as A's mesh ID, whatever the body claims", async () => {
    const stack = await meshStack(["finn", "jade"]);
    const home = tempDir("ah-");
    const hosted = presence(stack, ["finn", "jade"], home);
    await hosted.start();
    const jade = hosted.meshId("jade")!;
    const reply = await sidecarClient(presenceSocketPath(home, "finn")).send({
      target: jade, content: "ping from finn", from: "jade-anima-00000000@elsewhere",
    } as never);
    expect(reply.status).toBe(200);
    const item = await firstInboxItem(stack.meshUrl, hosted.inbox("jade")!.capability);
    expect(item.content).toBe(`[mesh from ${hosted.meshId("finn")}]\nping from finn`);
  }, 30_000);

  test("AJ-2/AJ-20 a stop during a join leaves its late registration, and a replacement afterwards keeps a valid one", async () => {
    const stack = await meshStack(["finn", "watcher"]);
    const home = tempDir("ah-");
    const watcher = presence(stack, ["watcher"], tempDir("aw-"));
    await watcher.start();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => {};
    const joinStarted = new Promise<void>((resolve) => { entered = resolve; });
    const gated = (async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/identity-runtime/finn/join")) { entered(); await gate; }
      return fetch(input, init);
    }) as typeof fetch;
    const old = new AnimaMeshPresence({ agents: ["finn"], animaHome: home, identityUrl: stack.identityUrl, meshUrl: stack.meshUrl, heartbeatIntervalMs: 60_000, fetch: gated, log: () => {} });
    cleanups.push(() => old.stop());
    const starting = old.start();
    await joinStarted;
    const stopping = old.stop();
    const early = presence(stack, ["finn"], home);
    await early.start();
    expect(early.state).toBe("busy");
    release();
    await Promise.all([starting, stopping]);
    const finn = expectedMeshId("finn", home);
    expect(((await watcher.list("watcher")).body as Record<string, { status: string }>)[finn]?.status).toBe("offline");
    const replacement = presence(stack, ["finn"], home);
    await replacement.start();
    const registered = replacement.inbox("finn")!;
    const beat = await fetch(`${stack.meshUrl}/mesh/v1/${encodeURIComponent(registered.address)}/heartbeat`, {
      method: "POST", headers: { "x-mesh-registration-credential": registered.capability },
    });
    expect(beat.status).toBe(200);
  }, 30_000);

  test("AJ-20 regression: a join still compiling in identity after the client gave up never revokes a replacement", async () => {
    const gate = tempDir("gt-");
    const stack = await meshStack(["finn"], gate);
    const home = tempDir("ah-");
    const old = new AnimaMeshPresence({
      agents: ["finn"], animaHome: home, identityUrl: stack.identityUrl, meshUrl: stack.meshUrl,
      heartbeatIntervalMs: 60_000, joinDeadlineMs: 300, joinGraceMs: 300, log: () => {},
    });
    cleanups.push(() => old.stop());
    const starting = old.start();
    for (let n = 0; n < 400 && !existsSync(join(gate, "compile-entered")); n++) await Bun.sleep(5);
    expect(existsSync(join(gate, "compile-entered"))).toBe(true);
    await old.stop();
    await starting;
    const replacement = presence(stack, ["finn"], home);
    await replacement.start();
    const registered = replacement.inbox("finn")!;
    const beat = async () => (await fetch(`${stack.meshUrl}/mesh/v1/${encodeURIComponent(registered.address)}/heartbeat`, {
      method: "POST", headers: { "x-mesh-registration-credential": registered.capability },
    })).status;
    expect(await beat()).toBe(200);
    writeFileSync(join(gate, "compile-release"), "release");
    for (let n = 0; n < 20; n++) { await Bun.sleep(20); expect(await beat()).toBe(200); }
  }, 30_000);

  test("AJ-20 regression: an enrollment delayed in transit past the join deadline is refused by Mesh, not committed over a replacement", async () => {
    const gate = tempDir("eg-");
    const stack = await meshStack(["finn"], undefined, gate);
    const home = tempDir("ah-");
    const old = new AnimaMeshPresence({
      agents: ["finn"], animaHome: home, identityUrl: stack.identityUrl, meshUrl: stack.meshUrl,
      heartbeatIntervalMs: 60_000, joinDeadlineMs: 400, joinGraceMs: 300, log: () => {},
    });
    cleanups.push(() => old.stop());
    const starting = old.start();
    for (let n = 0; n < 400 && !existsSync(join(gate, "enroll-entered")); n++) await Bun.sleep(5);
    expect(existsSync(join(gate, "enroll-entered"))).toBe(true);
    await old.stop();
    await starting;
    const replacement = presence(stack, ["finn"], home);
    await replacement.start();
    const registered = replacement.inbox("finn")!;
    const beat = async () => (await fetch(`${stack.meshUrl}/mesh/v1/${encodeURIComponent(registered.address)}/heartbeat`, {
      method: "POST", headers: { "x-mesh-registration-credential": registered.capability },
    })).status;
    expect(await beat()).toBe(200);
    writeFileSync(join(gate, "enroll-release"), "release");
    for (let n = 0; n < 400 && !readdirSync(gate).some((name) => name.startsWith("enroll-forwarded-")); n++) await Bun.sleep(5);
    expect(readdirSync(gate).filter((name) => name.startsWith("enroll-forwarded-"))).toEqual(["enroll-forwarded-401"]);
    for (let n = 0; n < 10; n++) { await Bun.sleep(20); expect(await beat()).toBe(200); }
  }, 30_000);

  test("AJ-20 two ANIMA homes run side by side, and stopping one leaves the other's sockets answering", async () => {
    const stack = await meshStack(["finn"]);
    const homeA = tempDir("ha-");
    const homeB = tempDir("hb-");
    const a = presence(stack, ["finn"], homeA);
    const b = presence(stack, ["finn"], homeB);
    await a.start();
    await b.start();
    expect(a.meshId("finn")).not.toBe(b.meshId("finn"));
    await a.stop();
    expect((await sidecarClient(presenceSocketPath(homeB, "finn")).list()).status).toBe(200);
  }, 30_000);
});
