/**
 * cost-ledger-accuracy, CL-1: a streamed runStream turn with one tool
 * round is two provider queries and leaves two call records, with the old
 * call-site logger gone. Fake provider, in-memory ledger, temp directories.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../../src/agents/session";
import type { LoadedAgent } from "../../src/agents/loader";
import { JsonlStore } from "../../src/memory/jsonl-store";
import { TokenLedger } from "../../src/cost/ledger";
import { meterProvider } from "../../src/cost/meter";
import type { Provider, ProviderChunk, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

let tempDir: string;
let roomDir: string;
let store: JsonlStore;
let originalHome: string | undefined;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-cost-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roomDir = join(tempDir, "rooms", "jade");
  mkdirSync(join(roomDir, "staging"), { recursive: true });
  store = new JsonlStore(tempDir);
  originalHome = process.env.HOME;
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function agent(): LoadedAgent {
  return {
    name: "jade",
    label: "Jade",
    roomDir,
    soulPath: "SOUL.md",
    geneContent: "Core instructions.",
    soulContent: "You are Jade.",
    sessionContextFiles: [],
    additionalContent: [],
    config: {
      identity: { name: "jade", label: "Jade" },
      provider: { type: "claude" },
      policy: { allowedRoots: [roomDir], readOnlyRoots: [], allowedTools: ["bash", "write"] },
      session: { defaultMode: "plan", autoModeOptIn: false, compactThreshold: 0 },
      boot: { gene: "SOUL.md", soul: "SOUL.md", sessionContext: [] },
    },
  } as unknown as LoadedAgent;
}

async function drain(gen: AsyncGenerator<ProviderChunk>): Promise<string> {
  let text = "";
  for await (const chunk of gen) if (chunk.type === "text" && chunk.content) text += chunk.content;
  return text;
}

test("a streamed turn with one tool round leaves two call records, each with its usage", async () => {
  const db = new Database(":memory:");
  const ledger = new TokenLedger(db);
  let n = 0;
  const leaf: Provider = {
    name: "claude",
    query: async (_req: ProviderRequest): Promise<ProviderResponse> => {
      n++;
      if (n === 1) {
        return {
          message: { role: "assistant", content: "before tool" },
          tool_calls: [{ id: "call_1", name: "write", arguments: JSON.stringify({ path: join(roomDir, "staging", "x.txt"), content: "x" }) }],
          usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cache_categories_reported: true, model: "claude-sonnet-4-6" },
        };
      }
      return {
        message: { role: "assistant", content: "after tool" },
        usage: { input_tokens: 120, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cache_categories_reported: true, model: "claude-sonnet-4-6" },
      };
    },
  };
  const session = new AgentSession({ store, provider: meterProvider(leaf, { ledger }) });
  const text = await drain(session.runStream({ agent: agent(), message: "hi" }));
  expect(text).toContain("after tool");
  expect(n).toBe(2);

  const parents = db.query("SELECT * FROM provider_calls ORDER BY started_at, call_id").all() as any[];
  expect(parents).toHaveLength(2);
  expect(parents.every((p) => p.agent_id === "jade" && p.backend === "claude" && p.status === "ok" && p.coverage === "complete")).toBe(true);
  const details = db.query("SELECT input_tokens, output_tokens FROM token_usage ORDER BY id").all();
  expect(details).toEqual([{ input_tokens: 100, output_tokens: 10 }, { input_tokens: 120, output_tokens: 20 }]);
});
