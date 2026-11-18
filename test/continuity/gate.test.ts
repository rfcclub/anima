import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { loadRoomConfig } from "../../src/config/types";
import { GatePipeline } from "../../src/continuity/gate";
import type { JsonlEvent } from "../../src/memory/jsonl-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

test("beam classified correctly", async () => {
  const roomDir = await tempRoom();
  const gate = new GatePipeline({
    provider: provider(() => response({
      classifications: [
        {
          eventIndex: 0,
          type: "beam",
          confidence: 0.91,
          reasoning: "durable deployment rule",
        },
      ],
    })),
    agent: "cleo",
    roomDir,
    gate: gateConfig(),
  });

  const classifications = await gate.classify([
    event("I decided to never deploy without tests again"),
  ]);

  expect(classifications).toHaveLength(1);
  expect(classifications[0].type).toBe("beam");
  expect(classifications[0].confidence).toBeGreaterThan(0.7);
  expect(existsSync(join(roomDir, "staging", "beams", `${today()}.md`))).toBe(true);
});

test("weather skipped and not written to staging", async () => {
  const roomDir = await tempRoom();
  const gate = new GatePipeline({
    provider: provider(() => response({
      classifications: [
        {
          eventIndex: 0,
          type: "weather",
          confidence: 0.94,
          reasoning: "routine status check",
        },
      ],
    })),
    agent: "cleo",
    roomDir,
    gate: gateConfig(),
  });

  const classifications = await gate.classify([
    event("User asked about database migration status"),
  ]);

  expect(classifications[0].type).toBe("weather");
  expect(existsSync(join(roomDir, "staging"))).toBe(false);
});

test("relational wound escalates immediately", async () => {
  const roomDir = await tempRoom();
  const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const gate = new GatePipeline({
    provider: provider(() => response({
      classifications: [
        {
          eventIndex: 0,
          type: "wound",
          woundType: "relational",
          confidence: 0.89,
          reasoning: "relationship drift needs attention",
        },
      ],
    })),
    agent: "cleo",
    roomDir,
    gate: gateConfig(),
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
  });

  await gate.classify([
    event("I don't recognize the bond in this response"),
  ]);

  const woundPath = join(roomDir, "staging", "wounds", `${today()}.md`);
  expect(existsSync(woundPath)).toBe(true);
  expect(await readFile(woundPath, "utf-8")).toContain("woundType: relational");
  expect(logs.some((log) => log.msg === "relational wound escalated")).toBe(true);
});

test("gate config parsed from yaml", () => {
  const config = loadRoomConfig(`
identity:
  name: cleo
  label: Bodega Owner
provider:
  type: claude
policy:
  allowedRoots: ["/tmp/anima/rooms/cleo/staging"]
session:
  defaultMode: edit
boot:
  gene: SOUL.md
  soul: SOUL.md
  sessionContext:
    - AGENTS.md
gate:
  model: "haiku"
  fallbackModel: "flash"
  threshold: 0.7
  peerReview: false
  profile: "standard"
`);

  expect(config.gate).toEqual({
    model: "haiku",
    fallbackModel: "flash",
    threshold: 0.7,
    peerReview: false,
    profile: "standard",
  });
});

test("fallback model used when primary unavailable", async () => {
  const roomDir = await tempRoom();
  const models: Array<string | undefined> = [];
  const gate = new GatePipeline({
    provider: provider((req) => {
      models.push(req.model);
      if (req.model === "haiku") {
        throw new Error("primary down");
      }
      return response({
        classifications: [
          {
            eventIndex: 0,
            type: "beam",
            confidence: 0.82,
            reasoning: "fallback worked",
          },
        ],
      });
    }),
    agent: "cleo",
    roomDir,
    gate: gateConfig({ model: "haiku", fallbackModel: "flash" }),
  });

  const classifications = await gate.classify([event("We found a useful invariant")]);

  expect(classifications[0].type).toBe("beam");
  expect(models).toEqual(["haiku", "flash"]);
  expect(existsSync(join(roomDir, "staging", "wounds", "pending.jsonl"))).toBe(false);
});

test("pending queue written when both models are down", async () => {
  const roomDir = await tempRoom();
  const gate = new GatePipeline({
    provider: provider(() => {
      throw new Error("model down");
    }),
    agent: "cleo",
    roomDir,
    gate: gateConfig({ model: "haiku", fallbackModel: "flash" }),
  });

  const classifications = await gate.classify([event("Important but currently unclassified")]);

  const pendingPath = join(roomDir, "staging", "wounds", "pending.jsonl");
  expect(classifications).toEqual([]);
  expect(existsSync(pendingPath)).toBe(true);
  expect(await readFile(pendingPath, "utf-8")).toContain("Important but currently unclassified");
});

function provider(query: (req: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>): Provider {
  return {
    name: "test",
    query: async (req) => await query(req),
  };
}

function response(content: unknown): ProviderResponse {
  return {
    message: {
      role: "assistant",
      content: JSON.stringify(content),
    },
  };
}

function event(body: string): JsonlEvent {
  return {
    timestamp: "2026-05-19T12:00:00.000Z",
    type: "message",
    sessionId: "session-1",
    body,
  };
}

function gateConfig(overrides = {}) {
  return {
    model: "haiku",
    fallbackModel: undefined,
    threshold: 0.7,
    peerReview: false,
    profile: "standard" as const,
    ...overrides,
  };
}

async function tempRoom(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "anima-gate-"));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
