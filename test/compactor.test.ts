import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/memory/session-store";
import { Compactor } from "../src/session/compactor";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/providers/interface";

let tempDir: string;
let dbPath: string;
let store: SessionStore;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-compactor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbPath = join(tempDir, "sessions.db");
  store = new SessionStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("summarize calls the provider with turns and returns a compact event", async () => {
  const requests: ProviderRequest[] = [];
  const compactor = new Compactor({
    provider: provider(async (req) => {
      requests.push(req);
      return response("Compact summary");
    }),
    store,
    sessionId: "test-session",
    model: "test-model",
  });

  const event = await compactor.summarize(turns());

  expect(requests).toHaveLength(1);
  expect(requests[0].system).toContain("Summarize");
  expect(requests[0].messages[0].content).toContain("USER:");
  expect(event?.summary).toBe("Compact summary");
  expect(event?.turnCount).toBe(2);
  expect(event?.model).toBe("test-model");
});

test("summarize is a no-op when there are no turns", async () => {
  let callCount = 0;
  const compactor = new Compactor({
    provider: provider(async () => {
      callCount++;
      return response("should not happen");
    }),
    store,
    sessionId: "test-session",
  });

  const event = await compactor.summarize([]);

  expect(event).toBeUndefined();
  expect(callCount).toBe(0);
});

test("Compactor can be created without store (store is optional)", async () => {
  let callCount = 0;
  const compactor = new Compactor({
    provider: provider(async (req) => {
      callCount++;
      return response("Compact summary without store");
    }),
    sessionId: "no-store-session",
  });

  const event = await compactor.summarize(turns());

  expect(event).toBeDefined();
  expect(event?.summary).toBe("Compact summary without store");
  expect(event?.turnCount).toBe(2);
  expect(callCount).toBe(1);
});

function provider(query: (req: ProviderRequest) => Promise<ProviderResponse>): Provider {
  return {
    name: "claude",
    query,
  };
}

function response(content: string): ProviderResponse {
  return {
    message: { role: "assistant", content },
  };
}

function turns() {
  return [
    {
      timestamp: "2026-05-17T00:00:00.000Z",
      type: "turn" as const,
      sessionId: "test-session",
      role: "user" as const,
      content: "hello",
    },
    {
      timestamp: "2026-05-17T00:01:00.000Z",
      type: "turn" as const,
      sessionId: "test-session",
      role: "assistant" as const,
      content: "hello back",
    },
  ];
}
