/**
 * cost-ledger-accuracy: router attempts are metered leaf calls.
 * Fake leaves, an in-memory ledger and a breaker file in a temp directory only.
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenLedger } from "../../src/cost/ledger";
import { ModeRouter } from "../../src/providers/router";
import { CircuitBreaker } from "../../src/providers/circuit-breaker";
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse } from "../../src/providers/interface";
import type { ModeMap, ProviderDef } from "../../src/config/types";

function registryOf(ids: string[]) {
  const defs = new Map<string, ProviderDef>(ids.map((id) => [id, { id, label: id, baseUrl: "http://x.invalid/v1", api: "openai-completions", apiKey: "k", models: [{ id: `m-${id}` }] } as ProviderDef]));
  return {
    get: (id: string) => defs.get(id),
    list: () => [...defs.values()],
    resolve: (ref: string) => {
      const at = ref.lastIndexOf("@");
      const provider = defs.get(ref.slice(at + 1))!;
      return { provider, model: provider.models.find((m) => m.id === ref.slice(0, at))! };
    },
  };
}

const modeMap: ModeMap = { chatting: [], programming: [], image: [], private: [], philosophy: [], creative: [] };
const req = (): ProviderRequest => ({ agent: "bruno", sessionId: "s1", mode: "auto", messages: [{ role: "user", content: "hi" }] });

function leafFor(id: string, behaviour: "ok" | "fail"): Provider {
  return {
    name: id,
    async query(): Promise<ProviderResponse> {
      if (behaviour === "fail") throw new ProviderError("SERVER_ERROR", id, "upstream down");
      return { message: { role: "assistant", content: "ok" }, usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}

function setup(behaviours: Record<string, "ok" | "fail">, opts: { breaker?: CircuitBreaker } = {}) {
  const db = new Database(":memory:");
  const ledger = new TokenLedger(db);
  const breaker = opts.breaker ?? new CircuitBreaker(join(mkdtempSync(join(tmpdir(), "router-meter-")), "breaker.json"));
  const router = new ModeRouter(registryOf(Object.keys(behaviours)) as never, modeMap, {
    providerConfig: { type: "a", model: "m-a", retry: 1, fallback: [{ type: "b", model: "m-b", retry: 1 }] },
    createProvider: (id) => leafFor(id, behaviours[id]),
    breaker,
    meter: { ledger },
  });
  return { db, router, breaker };
}

const parents = (db: Database) => db.query("SELECT * FROM provider_calls ORDER BY started_at, call_id").all() as any[];
const details = (db: Database) => db.query("SELECT * FROM token_usage ORDER BY id").all() as any[];

describe("ModeRouter metering", () => {
  test("a failed attempt then a successful fallback is 2 calls with their own backends, statuses and models, and no aggregate row", async () => {
    const { db, router } = setup({ a: "fail", b: "ok" });
    await router.query(req(), "chatting");
    const rows = parents(db);
    expect(rows).toHaveLength(2);
    const byBackend = Object.fromEntries(rows.map((r) => [r.backend, r]));
    expect(byBackend.a).toMatchObject({ status: "error", coverage: "unknown", agent_id: "bruno", session_id: "s1" });
    expect(byBackend.b).toMatchObject({ status: "ok", coverage: "partial" });
    expect(details(db).map((d) => [d.provider, d.model]).sort()).toEqual([["a", "m-a"], ["b", "m-b"]]);
  });

  test("an open breaker skips the provider and writes no call for it", async () => {
    const breaker = new CircuitBreaker(join(mkdtempSync(join(tmpdir(), "router-meter-")), "breaker.json"));
    for (let i = 0; i < 10; i++) breaker.recordFailure("a");
    const { db, router } = setup({ a: "ok", b: "ok" }, { breaker });
    await router.query(req(), "chatting");
    expect(parents(db).map((r) => r.backend)).toEqual(["b"]);
  });

  test("a plain success is exactly 1 call", async () => {
    const { db, router } = setup({ a: "ok", b: "ok" });
    await router.query(req(), "chatting");
    expect(parents(db)).toHaveLength(1);
    expect(parents(db)[0]).toMatchObject({ backend: "a", status: "ok" });
  });
});
