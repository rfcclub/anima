import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MeshBus } from "colony-mesh";
import {
  RUNTIME_MATRIX,
  assertEvidenceFields,
  canClaimRuntimeDelivery,
  evaluateSmokeEvidence,
  validateRuntimeMatrix,
} from "./mesh-cross-runtime-smoke";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "mesh-cross-smoke-"));
  tempDirs.push(dir);
  return join(dir, "mesh.db");
}

describe("cross-runtime smoke matrix", () => {
  test("declares all target runtimes with distinct concrete recipients", () => {
    expect(validateRuntimeMatrix(RUNTIME_MATRIX)).toEqual([]);
  });

  test("rejects shared bare alias as concrete identity", () => {
    expect(validateRuntimeMatrix([
      ...RUNTIME_MATRIX,
      { runtime: "qwen", recipientId: "bruno", recipientPlatform: "qwen", transport: "mcp", receiveMode: "mcp-tool", expectedProof: [] },
    ])).toHaveLength(0);
  });

  test("wrong runtime identity cannot claim another runtime recipient", () => {
    expect(canClaimRuntimeDelivery("claude", "qwen")).toBe(false);
    expect(canClaimRuntimeDelivery("claude", "claude")).toBe(true);
  });
});

describe("cross-runtime smoke evidence", () => {
  test("DB-only delivery without same-thread reply fails", () => {
    const dbPath = tempDb();
    const bus = new MeshBus(dbPath);
    const { message } = bus.publish({
      from_id: "eli",
      from_platform: "codex",
      to_id: "claude",
      to_platform: "cc",
      client_msg_id: "db-only",
      thread_id: "thread-db-only",
      content: "prove live reply",
    });
    bus.close();

    const evidence = evaluateSmokeEvidence({
      dbPath,
      runtime: "claudecode",
      recipientId: "claude",
      recipientPlatform: "cc",
      transport: "mcp",
      threadId: "thread-db-only",
      requestMessageId: message.id,
    });
    expect(evidence.status).toBe("fail");
    expect(evidence.failure_reason).toBe("request delivery was not claimed");
  });

  test("claimed and acked delivery with same-thread reply passes", () => {
    const dbPath = tempDb();
    const bus = new MeshBus(dbPath);
    const { message } = bus.publish({
      from_id: "eli",
      from_platform: "codex",
      to_id: "claude",
      to_platform: "cc",
      client_msg_id: "pass",
      thread_id: "thread-pass",
      content: "reply same thread",
    });
    const [delivery] = bus.pull("claude");
    expect(bus.ack("claude", delivery.delivery_id, delivery.claim_token!)).toBe(true);
    bus.publish({
      from_id: "claude",
      from_platform: "cc",
      to_id: "eli",
      to_platform: "codex",
      thread_id: "thread-pass",
      content: "same-thread reply",
    });
    bus.close();

    const evidence = evaluateSmokeEvidence({
      dbPath,
      runtime: "claudecode",
      recipientId: "claude",
      recipientPlatform: "cc",
      transport: "mcp",
      threadId: "thread-pass",
      requestMessageId: message.id,
    });
    expect(evidence.status).toBe("pass");
    expect(assertEvidenceFields(evidence)).toEqual([]);
  });

  test("reply on wrong thread fails", () => {
    const dbPath = tempDb();
    const bus = new MeshBus(dbPath);
    const { message } = bus.publish({
      from_id: "eli",
      from_platform: "codex",
      to_id: "claude",
      to_platform: "cc",
      client_msg_id: "wrong-thread",
      thread_id: "thread-right",
      content: "reply wrong thread",
    });
    const [delivery] = bus.pull("claude");
    bus.ack("claude", delivery.delivery_id, delivery.claim_token!);
    bus.publish({
      from_id: "claude",
      from_platform: "cc",
      to_id: "eli",
      to_platform: "codex",
      thread_id: "thread-wrong",
      content: "wrong-thread reply",
    });
    bus.close();

    const evidence = evaluateSmokeEvidence({
      dbPath,
      runtime: "claudecode",
      recipientId: "claude",
      recipientPlatform: "cc",
      transport: "mcp",
      threadId: "thread-right",
      requestMessageId: message.id,
    });
    expect(evidence.status).toBe("fail");
    expect(evidence.failure_reason).toBe("live reply proof was missing");
  });

  test("duplicate client_msg_id is idempotent", () => {
    const dbPath = tempDb();
    const bus = new MeshBus(dbPath);
    const first = bus.publish({
      from_id: "eli",
      to_id: "claude",
      client_msg_id: "dup",
      thread_id: "thread-dup",
      content: "first",
    });
    const second = bus.publish({
      from_id: "eli",
      to_id: "claude",
      client_msg_id: "dup",
      thread_id: "thread-dup",
      content: "second ignored",
    });
    bus.close();

    expect(second.message.id).toBe(first.message.id);
    expect(second.deliveryIds).toEqual(first.deliveryIds);
  });
});
