import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../../src/memory/session-store";
import { buildHeadlessPromptParts } from "../../src/cartridge/headless-profile";

function blockedReviewFixture(autoModeOptIn = true) {
  const root = mkdtempSync(join(tmpdir(), "headless-review-blocked-"));
  const home = join(root, ".anima"), rooms = join(home, "rooms"), providers = join(home, "providers.d");
  const db = join(home, "sessions.db");
  mkdirSync(providers, { recursive: true });
  for (const name of ["finn", "mira"]) {
    const room = join(rooms, name);
    mkdirSync(room, { recursive: true });
    writeFileSync(join(room, "config.yaml"), JSON.stringify({
      identity: { name, label: name },
      provider: { type: "fixture", model: "fixture-model" },
      policy: { allowedRoots: [root], allowedTools: ["anima_github"] },
      session: { defaultMode: "auto", autoModeOptIn },
      boot: { gene: "unused-AGENTS.md", sessionContext: [{ path: "unused-memory.md" }] },
    }));
  }
  let requestCount = 0;
  const notify: Array<() => void> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      requestCount++;
      for (const callback of notify) callback();
      return new Promise<Response>(() => {});
    },
  });
  writeFileSync(join(providers, "fixture.yaml"), JSON.stringify({
    id: "fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`,
    api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model" }],
  }));
  return {
    root, db,
    waitForRequests(count: number): Promise<void> {
      if (requestCount >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("synthetic provider request did not arrive")), 5_000);
        notify.push(() => {
          if (requestCount >= count) { clearTimeout(timer); resolve(); }
        });
      });
    },
    spawn(agent: string, signal: AbortSignal) {
      return Bun.spawn([
        process.execPath, resolve("src/cli.ts"), "talk", "-a", agent, "-m", "Synthetic review",
        "--permission", "auto", "--mode", "programming", "--provider", "fixture", "--model", "fixture-model",
        "--headless-review", "--review-repo", "example/repo",
      ], {
        env: { PATH: process.env.PATH ?? "", HOME: root, ANIMA_HOME: home, ANIMA_ROOMS_DIR: rooms, ANIMA_SESSIONS_DB: db, TMPDIR: root },
        signal, stdout: "ignore", stderr: "pipe",
      });
    },
    session(agent: string): { id: string; ended: string | null } | null {
      const store = new Database(db, { readonly: true });
      try {
        return store.query<{ id: string; ended: string | null }, [string]>(
          "SELECT id, ended FROM sessions WHERE agent = ? AND channel = 'review' ORDER BY rowid DESC LIMIT 1",
        ).get(agent);
      } finally { store.close(); }
    },
    cleanup() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("headless PR review talk", () => {
  test("uses only the review role and authorized review tools with a fresh conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-review-"));
    const home = join(root, ".anima"), rooms = join(home, "rooms"), room = join(rooms, "finn");
    const providers = join(home, "providers.d"), db = join(home, "sessions.db"), action = join(root, "action-ran");
    mkdirSync(room, { recursive: true });
    mkdirSync(providers, { recursive: true });
    for (const [name, content] of [["AGENTS.md", "PERSONA_ONLY"], ["SOUL.md", "SOUL_ONLY"], ["trajectory.md", "TRAJECTORY_ONLY"]]) {
      writeFileSync(join(room, name!), content!);
    }
    writeFileSync(join(room, "config.yaml"), JSON.stringify({
      identity: { name: "finn", label: "Iron Will", identityAnchor: "ANCHOR_ONLY" },
      provider: { type: "fixture", model: "fixture-model" },
      policy: { allowedRoots: [root], allowedTools: ["anima_github", "read", "anima_recall", "anima_bootstrap"] },
      session: { defaultMode: "auto", autoModeOptIn: true },
      boot: { gene: "AGENTS.md", soul: "SOUL.md", sessionContext: [{ path: "trajectory.md" }], extraActions: [{ label: "action", run: `touch ${action}` }] },
      memory: { type: "custom", crossSessionBootstrap: true, entityScript: "missing-memory" },
    }));
    const bodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      bodies.push(await request.json() as Record<string, unknown>);
      return Response.json({ choices: [{ message: { role: "assistant", content: `REVIEW_RESPONSE_${bodies.length}` }, finish_reason: "stop" }] });
    } });
    writeFileSync(join(providers, "fixture.yaml"), JSON.stringify({
      id: "fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model" }],
    }));
    const old = new SessionStore(db);
    const oldSession = old.createSession("finn", "talk");
    old.appendTurn(oldSession.id, "assistant", "OLD_CHAT_ONLY");
    old.close();
    try {
      for (const message of ["FIRST_REVIEW_ONLY", "SECOND_REVIEW_ONLY"]) {
        const proc = Bun.spawn([process.execPath, resolve("src/cli.ts"), "talk", "-a", "finn", "-m", message,
          "--permission", "auto", "--mode", "programming", "--provider", "fixture", "--model", "fixture-model",
          "--headless-review", "--review-repo", "rfcclub/anima"], {
          env: { PATH: process.env.PATH ?? "", HOME: root, ANIMA_HOME: home, ANIMA_ROOMS_DIR: rooms, ANIMA_SESSIONS_DB: db, TMPDIR: root },
          stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toContain("REVIEW_RESPONSE_");
        const records = stderr.split("\n").flatMap((line) => {
          try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
        }).filter((record) => record.msg === "headless profile");
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          level: "info", profile: "work-review",
          promptStaticHash: buildHeadlessPromptParts({ name: "finn", label: "Iron Will", repo: "rfcclub/anima", profile: "review" }).staticHash,
        });
        expect(records[0]!.sessionId).toMatch(/^[a-f0-9-]{36}$/);
        expect(JSON.stringify(records)).not.toContain(message);
        const stored = new SessionStore(db);
        try {
          expect(typeof stored.getSession(String(records[0]!.sessionId))?.ended).toBe("string");
        } finally { stored.close(); }
      }
      expect(bodies).toHaveLength(2);
      expect(bodies[0]!.prompt_cache_key).toMatch(/^[0-9a-f]{64}$/);
      expect(bodies[1]!.prompt_cache_key).toBe(bodies[0]!.prompt_cache_key);
      const second = JSON.stringify(bodies[1]);
      expect(second).toContain("SECOND_REVIEW_ONLY");
      expect(second).toContain("Headless PR review");
      expect(second).toContain("Iron Will");
      for (const marker of ["PERSONA_ONLY", "SOUL_ONLY", "TRAJECTORY_ONLY", "ANCHOR_ONLY", "OLD_CHAT_ONLY", "FIRST_REVIEW_ONLY", "REVIEW_RESPONSE_1", "warmth", "anima_recall", "anima_bootstrap"]) {
        expect(second).not.toContain(marker);
      }
      expect(second).toContain("anima_github");
      expect(existsSync(action)).toBe(false);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("regression: SIGTERM closes the review session while the provider is pending", async () => {
    const fixture = blockedReviewFixture();
    const controller = new AbortController();
    const proc = fixture.spawn("finn", controller.signal);
    try {
      await Promise.race([
        fixture.waitForRequests(1),
        proc.exited.then(async (code) => { throw new Error(`review child exited ${code}: ${await new Response(proc.stderr).text()}`); }),
      ]);
      const before = fixture.session("finn");
      expect(before?.ended).toBeNull();
      controller.abort();
      expect(await proc.exited).toBe(143);
      const after = fixture.session("finn");
      expect(after?.id).toBe(before?.id);
      expect(typeof after?.ended).toBe("string");
    } finally {
      controller.abort();
      await proc.exited;
      fixture.cleanup();
    }
  }, 20_000);

  test("regression: terminating one pending review does not end another review", async () => {
    const fixture = blockedReviewFixture();
    const first = new AbortController(), second = new AbortController();
    const one = fixture.spawn("finn", first.signal);
    let two: ReturnType<typeof fixture.spawn> | undefined;
    try {
      await Promise.race([
        fixture.waitForRequests(1),
        one.exited.then(async (code) => { throw new Error(`first review child exited ${code}: ${await new Response(one.stderr).text()}`); }),
      ]);
      two = fixture.spawn("mira", second.signal);
      const other = two;
      await Promise.race([
        fixture.waitForRequests(2),
        other.exited.then(async (code) => { throw new Error(`second review child exited ${code}: ${await new Response(other.stderr).text()}`); }),
      ]);
      const before = fixture.session("mira");
      expect(before?.ended).toBeNull();
      first.abort();
      expect(await one.exited).toBe(143);
      expect(typeof fixture.session("finn")?.ended).toBe("string");
      expect(fixture.session("mira")).toEqual(before);
    } finally {
      first.abort();
      second.abort();
      await Promise.all([one.exited, ...(two ? [two.exited] : [])]);
      fixture.cleanup();
    }
  }, 20_000);

  test("regression: a setup failure after creating a review session closes it", async () => {
    const fixture = blockedReviewFixture(false);
    const controller = new AbortController();
    const proc = fixture.spawn("finn", controller.signal);
    try {
      expect(await proc.exited).not.toBe(0);
      if (!existsSync(fixture.db)) throw new Error(`fixture failed before session creation: ${await new Response(proc.stderr).text()}`);
      expect(typeof fixture.session("finn")?.ended).toBe("string");
    } finally {
      controller.abort();
      await proc.exited;
      fixture.cleanup();
    }
  }, 20_000);

  test("rejects an unauthorized reviewer tool call even if the model requests it", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-review-denied-"));
    const home = join(root, ".anima"), rooms = join(home, "rooms"), room = join(rooms, "finn");
    const providers = join(home, "providers.d"), marker = join(root, "unauthorized-write");
    mkdirSync(room, { recursive: true });
    mkdirSync(providers, { recursive: true });
    writeFileSync(join(room, "config.yaml"), JSON.stringify({
      identity: { name: "finn", label: "Iron Will" },
      provider: { type: "fixture", model: "fixture-model" },
      policy: { allowedRoots: [root], allowedTools: ["anima_github"] },
      session: { defaultMode: "auto", autoModeOptIn: true },
      boot: { gene: "unused-AGENTS.md", sessionContext: [{ path: "unused-memory.md" }] },
    }));
    const bodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      bodies.push(await request.json() as Record<string, unknown>);
      const message = bodies.length === 1
        ? { role: "assistant", content: null, tool_calls: [{ id: "denied-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `touch ${marker}` }) } }] }
        : { role: "assistant", content: "Denied tool observed." };
      return Response.json({ choices: [{ message, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] });
    } });
    writeFileSync(join(providers, "fixture.yaml"), JSON.stringify({
      id: "fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model" }],
    }));
    try {
      const proc = Bun.spawn([process.execPath, resolve("src/cli.ts"), "talk", "-a", "finn", "-m", "Review this",
        "--permission", "auto", "--mode", "programming", "--provider", "fixture", "--model", "fixture-model",
        "--headless-review", "--review-repo", "rfcclub/anima"], {
        env: { PATH: process.env.PATH ?? "", HOME: root, ANIMA_HOME: home, ANIMA_ROOMS_DIR: rooms, ANIMA_SESSIONS_DB: join(home, "sessions.db"), TMPDIR: root },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("Denied tool observed.");
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[1])).toContain("not in allowedTools");
      expect(existsSync(marker)).toBe(false);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
