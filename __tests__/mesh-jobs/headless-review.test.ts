import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../../src/memory/session-store";
import { buildHeadlessPromptParts } from "../../src/cartridge/headless-profile";

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
