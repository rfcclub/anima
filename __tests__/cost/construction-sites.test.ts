/**
 * cost-ledger-accuracy: every construction site of a leaf
 * provider is metered, and the old call-site loggers are gone. HTTP is mocked and
 * the process ledger is an in-memory database; nothing touches ~/.anima.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TokenLedger } from "../../src/cost/ledger";
import { setDefaultLedger } from "../../src/cost/logger";
import { createProviderForType } from "../../src/ui/services/providers";
import type { ProviderDef } from "../../src/config/types";

const SRC = join(import.meta.dir, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("static guards", () => {
  test("no leaf provider is constructed outside src/providers without being metered", () => {
    const construction = /new (AnthropicProvider|ClaudeProvider|GeminiProvider|OpenAICompatProvider|OpenAIv1ChatProvider|OpenAIv1ResponseProvider)\(/;
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (relative(SRC, file).startsWith("providers/")) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (construction.test(line) && (!line.includes("meterProvider(") || !/\bpath:\s*["'][^"']+["']/.test(line))) {
          offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("every ModeRouter built outside src/providers names where its calls come from", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (relative(SRC, file).startsWith("providers/")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/new ModeRouter\(/.test(line) && !/meter:\s*\{\s*path:\s*["'][^"']+["']/.test(lines.slice(i, i + 10).join("\n"))) {
          offenders.push(`${relative(SRC, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the old call-site loggers are removed", () => {
    for (const file of ["agents/session.ts", "agents/loop.ts", "cli.ts"]) {
      expect(readFileSync(join(SRC, file), "utf8")).not.toMatch(/logTokenUsage\(/);
    }
  });
});

describe("factories", () => {
  const realFetch = globalThis.fetch;
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    setDefaultLedger(new TokenLedger(db));
    globalThis.fetch = (async () => new Response(JSON.stringify({ model: "gpt-x-served", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    setDefaultLedger(null);
  });

  const def = (): ProviderDef => ({ id: "fixture", label: "Fixture", baseUrl: "http://fixture.invalid/v1", api: "openai-completions", apiKey: "k", models: [{ id: "gpt-x" }] });
  const req = (over: Record<string, unknown> = {}) => ({ agent: "bruno", mode: "edit" as const, messages: [{ role: "user" as const, content: "hi" }], ...over });
  const rows = () => db.query("SELECT * FROM provider_calls").all() as any[];

  test("castle-ui createProviderForType: a direct provider writes 1 call with agent and path", async () => {
    const provider = await createProviderForType({ type: "fixture" }, { registry: { get: () => def() } as never });
    await provider.query(req());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ agent_id: "bruno", backend: "fixture", path_id: "castle-ui", status: "ok" });
  });

  test("castle-ui createProviderForType: the router wrapper is not a call itself, its attempt is", async () => {
    const registry = { get: () => def(), list: () => [def()], resolve: () => ({ provider: def(), model: { id: "gpt-x" } }) };
    const provider = await createProviderForType({ type: "fixture", model: "gpt-x" }, { registry: registry as never, breakerPath: join(mkdtempSync(join(tmpdir(), "sites-breaker-")), "breaker.json") });
    await provider.query(req());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ backend: "fixture", path_id: "castle-ui" });
  });

  // Other factory runtime paths, including both proxy factories, run in their
  // own child processes in factory-runtime.test.ts to avoid process-wide mocks.

  test("a request that carries a session keeps it and gets no path", async () => {
    const provider = await createProviderForType({ type: "fixture" }, { registry: { get: () => def() } as never });
    await provider.query(req({ sessionId: "sess-9" }));
    expect(rows()[0]).toMatchObject({ session_id: "sess-9", path_id: null });
  });
});
