import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentMemoryStore, AgentMemoryEntry } from "../../src/memory/contract";
import type { TurnRecord } from "../../src/memory/session-store";
import { parseBeamEntries } from "../../src/dream/light-nap";
import { lightNapFromTurns } from "../../src/session/cross-session-memory";

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: 1,
    sessionId: "s1",
    role: "assistant",
    content: "just chatting, nothing notable",
    ts: "2026-09-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("cross-session-memory — lightNapFromTurns (Town/Castle beam bridge)", () => {
  let roomDir: string;

  beforeEach(() => {
    roomDir = mkdtempSync(join(tmpdir(), "anima-cross-session-memory-test-"));
  });

  afterEach(() => {
    rmSync(roomDir, { recursive: true, force: true });
  });

  test("RED->GREEN: writes a beam for a turn whose content matches a beam keyword", async () => {
    const turns = [makeTurn({ content: "I realized the pacing lever and the harness are one instrument." })];

    await lightNapFromTurns(roomDir, "bruno", "s1", turns);

    const filePath = join(roomDir, "staging", "beams", "2026-09-25.md");
    expect(existsSync(filePath)).toBe(true);
    const parsed = parseBeamEntries(readFileSync(filePath, "utf-8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].agent).toBe("bruno");
    expect(parsed[0].session).toBe("s1");
  });

  test("GREEN: writes no beam file when no turn matches a beam keyword", async () => {
    const turns = [makeTurn({ content: "just chatting, nothing notable" })];

    await lightNapFromTurns(roomDir, "bruno", "s1", turns);

    const filePath = join(roomDir, "staging", "beams", "2026-09-25.md");
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("cross-session-memory — module", () => {
  test("RED: formatBootstrapContent wraps content in ## Bootstrap Memory section", async () => {
    const { formatBootstrapContent } = await import("../../src/session/cross-session-memory");
    const result = formatBootstrapContent("We were designing X");
    expect(result).toContain("## Bootstrap Memory");
    expect(result).toContain("We were designing X");
  });

  test("RED: formatBootstrapContent returns empty string for empty content", async () => {
    const { formatBootstrapContent } = await import("../../src/session/cross-session-memory");
    expect(formatBootstrapContent("")).toBe("");
    expect(formatBootstrapContent("   ")).toBe("");
  });

  test("RED: writeSessionSummary skips when turns empty", async () => {
    const { writeSessionSummary } = await import("../../src/session/cross-session-memory");
    const store: AgentMemoryStore = {
      remember: async () => { throw new Error("should not be called"); },
      recall: async () => [],
      bootstrap: async () => [],
    };
    const provider = {} as any;
    // Should not throw despite store.remember throwing, because it should not be called
    await writeSessionSummary(store, provider, "session-1", []);
  });

  test("RED: buildSessionEndHandler returns a function", async () => {
    const { buildSessionEndHandler } = await import("../../src/session/cross-session-memory");
    const store: AgentMemoryStore = {
      remember: async (e) => ({ id: "1", ...e, createdAt: new Date().toISOString() }),
      recall: async () => [],
      bootstrap: async () => [],
    };
    const provider = {} as any;
    const handler = buildSessionEndHandler(store, provider);
    expect(typeof handler).toBe("function");
  });

  test("RED: SessionManager onEnd hook fires on closeSession and newSession", async () => {
    const { SessionStore } = await import("../../src/memory/session-store");
    const { SessionManager } = await import("../../src/session/manager");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { unlinkSync } = await import("node:fs");

    const dbPath = join(tmpdir(), `test-session-${Date.now()}.db`);
    const store = new SessionStore(dbPath);

    let onEndCalled = false;
    let onEndSessionId = "";
    let onEndAgent = "";

    const mgr = new SessionManager({
      store,
      onEnd: async (sessionId, agent) => {
        onEndCalled = true;
        onEndSessionId = sessionId;
        onEndAgent = agent;
      },
    });

    const session = mgr.newSession("test-agent", "ui");
    const sessionId = session.id;

    mgr.closeSession("test-agent", "ui");

    // Give the fire-and-forget onEnd a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(onEndCalled).toBe(true);
    expect(onEndSessionId).toBe(sessionId);
    expect(onEndAgent).toBe("test-agent");

    try { unlinkSync(dbPath); } catch {}
  });
});
