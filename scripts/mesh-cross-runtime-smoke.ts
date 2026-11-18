import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MeshBus } from "colony-mesh";
import { SqliteMeshNotifier } from "colony-mesh/notifier";

export type RuntimeName = "codex" | "openclaw" | "anima" | "claudecode" | "qwen" | "gemini" | "antigravity";

export interface RuntimeMatrixRow {
  runtime: RuntimeName;
  recipientId: string;
  recipientPlatform: string;
  transport: "mcp" | "openclaw-plugin" | "anima-adapter";
  receiveMode: "sender" | "auto-inject" | "auto-listen" | "mcp-tool";
  expectedProof: string[];
}

export const RUNTIME_MATRIX: RuntimeMatrixRow[] = [
  {
    runtime: "codex",
    recipientId: "eli",
    recipientPlatform: "codex",
    transport: "mcp",
    receiveMode: "sender",
    expectedProof: ["outgoing message", "incoming reply"],
  },
  {
    runtime: "openclaw",
    recipientId: "bruno",
    recipientPlatform: "oc",
    transport: "openclaw-plugin",
    receiveMode: "auto-inject",
    expectedProof: ["claimed delivery", "acked delivery", "same-thread reply"],
  },
  {
    runtime: "anima",
    recipientId: "bruno",
    recipientPlatform: "anima",
    transport: "anima-adapter",
    receiveMode: "auto-listen",
    expectedProof: ["claimed delivery", "acked delivery", "same-thread reply"],
  },
  {
    runtime: "claudecode",
    recipientId: "bruno",
    recipientPlatform: "cc",
    transport: "mcp",
    receiveMode: "mcp-tool",
    expectedProof: ["claimed delivery", "acked delivery", "same-thread reply"],
  },
  {
    runtime: "qwen",
    recipientId: "bruno",
    recipientPlatform: "qwen",
    transport: "mcp",
    receiveMode: "mcp-tool",
    expectedProof: ["claimed delivery", "acked delivery", "same-thread reply"],
  },
  {
    runtime: "gemini",
    recipientId: "bruno",
    recipientPlatform: "gemini",
    transport: "mcp",
    receiveMode: "mcp-tool",
    expectedProof: ["claimed delivery", "acked delivery", "same-thread reply"],
  },
  {
    runtime: "antigravity",
    recipientId: "bruno",
    recipientPlatform: "agy",
    transport: "mcp",
    receiveMode: "mcp-tool",
    expectedProof: ["claimed delivery", "acked delivery", "same-thread reply"],
  },
];

export interface SmokeEvidence {
  runtime: string;
  recipient_id: string;
  recipient_platform: string | null;
  transport: string;
  thread_id: string;
  request_message_id: number;
  request_delivery_id: number | null;
  request_claimed_at: string | null;
  request_acked_at: string | null;
  reply_message_id: number | null;
  reply_from_id: string | null;
  reply_delivery_id: number | null;
  reply_content_excerpt: string | null;
  started_at: string;
  completed_at: string;
  status: "pass" | "fail";
  failure_reason?: string;
}

export function validateRuntimeMatrix(rows: RuntimeMatrixRow[] = RUNTIME_MATRIX): string[] {
  const errors: string[] = [];
  const required: RuntimeName[] = ["codex", "openclaw", "anima", "claudecode", "qwen", "gemini", "antigravity"];
  const runtimes = new Set(rows.map((row) => row.runtime));
  for (const runtime of required) {
    if (!runtimes.has(runtime)) errors.push(`missing runtime: ${runtime}`);
  }

  // Same bare name across different platforms is intentional (one agent, many platforms).
  return errors;
}

export function canClaimRuntimeDelivery(ownerRecipientId: string, claimingRecipientId: string): boolean {
  return ownerRecipientId === claimingRecipientId;
}

export function evaluateSmokeEvidence(params: {
  dbPath: string;
  runtime: string;
  recipientId: string;
  recipientPlatform?: string;
  transport: string;
  threadId: string;
  requestMessageId: number;
  startedAt?: string;
}): SmokeEvidence {
  const db = new Database(params.dbPath);
  try {
    const delivery = db.prepare(`
      SELECT id, claimed_at, acked_at
      FROM deliveries
      WHERE message_id = ? AND recipient_id = ?
        AND (? IS NULL OR to_platform IS NULL OR to_platform = ?)
      ORDER BY id
      LIMIT 1
    `).get(params.requestMessageId, params.recipientId, params.recipientPlatform ?? null, params.recipientPlatform ?? null) as { id: number; claimed_at: string | null; acked_at: string | null } | null;

    const reply = db.prepare(`
      SELECT m.id, m.from_id, m.content, d.id AS delivery_id
      FROM messages m
      LEFT JOIN deliveries d ON d.message_id = m.id
      WHERE m.thread_id = ? AND m.id != ? AND m.from_id = ?
      ORDER BY m.id
      LIMIT 1
    `).get(params.threadId, params.requestMessageId, params.recipientId) as {
      id: number;
      from_id: string;
      content: string;
      delivery_id: number | null;
    } | null;

    let failure: string | undefined;
    if (!delivery) failure = "request delivery missing";
    else if (!delivery.claimed_at) failure = "request delivery was not claimed";
    else if (!delivery.acked_at) failure = "request delivery was not acked";
    else if (!reply) failure = "live reply proof was missing";

    return {
      runtime: params.runtime,
      recipient_id: params.recipientId,
      recipient_platform: params.recipientPlatform ?? null,
      transport: params.transport,
      thread_id: params.threadId,
      request_message_id: params.requestMessageId,
      request_delivery_id: delivery?.id ?? null,
      request_claimed_at: delivery?.claimed_at ?? null,
      request_acked_at: delivery?.acked_at ?? null,
      reply_message_id: reply?.id ?? null,
      reply_from_id: reply?.from_id ?? null,
      reply_delivery_id: reply?.delivery_id ?? null,
      reply_content_excerpt: reply?.content.slice(0, 240) ?? null,
      started_at: params.startedAt ?? new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: failure ? "fail" : "pass",
      ...(failure ? { failure_reason: failure } : {}),
    };
  } finally {
    db.close();
  }
}

export function assertEvidenceFields(evidence: SmokeEvidence): string[] {
  const required: (keyof SmokeEvidence)[] = [
    "runtime",
    "recipient_id",
    "recipient_platform",
    "transport",
    "thread_id",
    "request_message_id",
    "request_delivery_id",
    "request_claimed_at",
    "request_acked_at",
    "reply_message_id",
    "reply_from_id",
    "status",
    "started_at",
    "completed_at",
  ];
  return required.filter((key) => evidence[key] === undefined).map(String);
}

export async function runCrossRuntimeSmoke(options: {
  runtime: string;
  recipientId: string;
  recipientPlatform?: string;
  transport?: string;
  dbPath?: string;
  evidenceDir?: string;
  timeoutMs?: number;
  dryRun?: boolean;
}): Promise<SmokeEvidence> {
  const dbPath = options.dbPath ?? process.env.MESH_DB_PATH;
  if (!dbPath) throw new Error("runCrossRuntimeSmoke needs dbPath (or MESH_DB_PATH) pointing at the mesh database");
  const evidenceDir = options.evidenceDir ?? "state/mesh-smoke";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const threadId = `cross-runtime-smoke-${options.runtime}-${stamp}`;
  const notifier = new SqliteMeshNotifier(dbPath);
  const bus = new MeshBus(dbPath, { notifier });
  let requestMessageId = 0;
  try {
    const result = bus.publish({
      from_id: "eli",
      from_platform: "codex",
      to_id: options.recipientId,
      to_platform: options.recipientPlatform,
      client_msg_id: `cross-runtime-smoke-${options.runtime}-${stamp}`,
      thread_id: threadId,
      pattern: "direct",
      role: "request",
      subject: `[cross-runtime-smoke] ${options.runtime}`,
      content: `[cross-runtime-smoke] Reply on this exact thread_id: ${threadId}`,
    }, "codex");
    requestMessageId = result.message.id;
  } finally {
    bus.close();
  }

  if (!options.dryRun) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const evidence = evaluateSmokeEvidence({
        dbPath,
        runtime: options.runtime,
        recipientId: options.recipientId,
        recipientPlatform: options.recipientPlatform,
        transport: options.transport ?? "mcp",
        threadId,
        requestMessageId,
        startedAt,
      });
      if (evidence.status === "pass") {
        writeEvidence(evidenceDir, evidence);
        return evidence;
      }
      await Bun.sleep(1_000);
    }
  }

  const evidence = evaluateSmokeEvidence({
    dbPath,
    runtime: options.runtime,
    recipientId: options.recipientId,
    recipientPlatform: options.recipientPlatform,
    transport: options.transport ?? "mcp",
    threadId,
    requestMessageId,
    startedAt,
  });
  writeEvidence(evidenceDir, evidence);
  return evidence;
}

function writeEvidence(dir: string, evidence: SmokeEvidence): void {
  mkdirSync(dir, { recursive: true });
  const stamp = evidence.started_at.replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${stamp}-${evidence.runtime}.json`), JSON.stringify(evidence, null, 2) + "\n");
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const runtime = argValue("--runtime") ?? "openclaw";
  const matrixRow = RUNTIME_MATRIX.find((row) => row.runtime === runtime);
  const recipientId = argValue("--recipient") ?? matrixRow?.recipientId;
  const recipientPlatform = argValue("--platform") ?? matrixRow?.recipientPlatform;
  if (!recipientId) {
    console.error(`Missing --recipient for runtime ${runtime}`);
    process.exit(2);
  }
  const evidence = await runCrossRuntimeSmoke({
    runtime,
    recipientId,
    recipientPlatform,
    transport: matrixRow?.transport,
    dbPath: argValue("--db"),
    evidenceDir: argValue("--evidence-dir"),
    timeoutMs: Number(argValue("--timeout-ms") ?? 120_000),
    dryRun: process.argv.includes("--dry-run"),
  });
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(evidence.status === "pass" ? 0 : 1);
}
