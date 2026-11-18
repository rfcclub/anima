import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoopMode, type LoopHostTools } from "../../src/agents/loop";
import type { LoadedAgent } from "../../src/agents/loader";
import { NullMemoryAdapter } from "../../src/memory/null-adapter";
import { SessionStore } from "../../src/memory/session-store";
import type { Provider, ProviderToolCall } from "../../src/providers/interface";
import { SessionManager } from "../../src/session/manager";
import { loadWorkConfig } from "../../src/work/config";
import { createLoopHost } from "../../src/work/runner";
import { WorkStore } from "../../src/work/store";

let dir: string;
let workStore: WorkStore;
let sessions: SessionStore;
let manager: SessionManager;
let workId: string;
let workSessionId: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "work-observe-"));
  dbPath = join(dir, "work.db");
  workStore = WorkStore.open(dbPath, { rootBase: join(dir, "roots") });
  const work = workStore.createWork({ repo: "test/repo", issue: 1, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
  workId = work.workId;
  const reservation = workStore.reserveSession(workId, { jobId: "job-1", claimId: "claim-1" });
  if (!reservation.ok) throw new Error("failed to reserve work session");
  workSessionId = reservation.session.sessionId;
  sessions = new SessionStore(join(dir, "sessions.db"));
  manager = new SessionManager({ store: sessions, maxTokens: 100_000 });
});
afterEach(() => { sessions.close(); workStore.close(); rmSync(dir, { recursive: true, force: true }); });

function agent(): LoadedAgent {
  return {
    name: "finn", label: "Finn", roomDir: dir, geneContent: "core", soulContent: "soul", soulPath: join(dir, "soul"),
    sessionContextFiles: [], additionalContent: [], memoryAdapter: new NullMemoryAdapter(),
    config: { provider: { type: "fake", model: "fake", modeMap: {} }, policy: { allowedRoots: [], readOnlyRoots: [], allowedTools: [] }, session: { defaultMode: "auto", compactThreshold: 60000 } },
  } as unknown as LoadedAgent;
}
function provider(calls: ProviderToolCall[]): Provider {
  let n = 0;
  return { name: "fake", async query() {
    return n++ === 0
      ? { message: { role: "assistant", content: "work" }, tool_calls: calls }
      : { message: { role: "assistant", content: '<DONE reason="finished" />' } };
  } } as Provider;
}
function call(name: string): ProviderToolCall {
  return { id: "sensitive-call-id", name, arguments: '{"content":"secret-argument-sentinel"}' };
}
function toolEvents() { return workStore.listEvents(workId).filter((e) => e.kind === "tool-started"); }
function host(tools: LoopHostTools) {
  return { ...createLoopHost(workStore, workId, async () => "checked", { workSessionId }), tools };
}

describe("work tool observability", () => {
  test("each call is recorded before execution with distinct step and work session IDs", async () => {
    const snapshots: number[] = [];
    const observer = new Database(dbPath, { readonly: true });
    const tools: LoopHostTools = { definitions: [], async execute() {
      const row = observer.query("SELECT count(*) AS count FROM work_events WHERE work_id = ? AND kind = 'tool-started'").get(workId) as { count: number };
      snapshots.push(row.count);
      return "ok";
    } };
    try {
      await runLoopMode(agent(), "goal", provider([call("bash"), call("read"), call("write"), call("edit"), call("publish")]), manager, sessions, { host: host(tools), maxIterations: 2 });
    } finally { observer.close(); }
    const details = toolEvents().map(e => e.detail as { stepId: string; conversationSessionId: string; workSessionId: string; iteration: number; tool: string });
    expect(snapshots).toEqual([1, 2, 3, 4, 5]);
    expect(details.map(d => d.tool)).toEqual(["bash", "read", "write", "edit", "publish"]);
    expect(details.map(d => d.workSessionId)).toEqual(Array(5).fill(workSessionId));
    expect(details.map(d => d.iteration)).toEqual([1, 1, 1, 1, 1]);
    expect(new Set(details.map(d => d.stepId)).size).toBe(5);
    expect(new Set(details.map(d => d.conversationSessionId)).size).toBe(1);
  });

  test("untrusted names, arguments and tool output are not copied into events", async () => {
    const tools: LoopHostTools = { definitions: [], async execute() { return "secret-result-sentinel"; } };
    await runLoopMode(agent(), "goal", provider([call("secret-name-sentinel"), call(null as unknown as string)]), manager, sessions, { host: host(tools), maxIterations: 2 });
    const events = toolEvents();
    expect(events).toHaveLength(2);
    expect(events.map(e => (e.detail as { tool: string }).tool)).toEqual(["unknown", "unknown"]);
    const serialized = JSON.stringify(events);
    for (const secret of ["secret-argument-sentinel", "secret-result-sentinel", "secret-name-sentinel", "sensitive-call-id"]) expect(serialized).not.toContain(secret);
  });

  test("a throwing tool retains its event and its unknown marker", async () => {
    const tools: LoopHostTools = { definitions: [], async execute() { throw new Error("secret-result-sentinel"); } };
    await runLoopMode(agent(), "goal", provider([call("write")]), manager, sessions, { host: host(tools), maxIterations: 2 });
    const events = toolEvents();
    expect(events).toHaveLength(1);
    const detail = events[0]!.detail as { stepId: string; tool: string };
    expect(detail.tool).toBe("write");
    expect(workStore.openSteps(workId).map(s => s.id)).toEqual([detail.stepId]);
    expect(JSON.stringify(events)).not.toContain("secret-result-sentinel");
  });

  test("an event write failure rolls back its marker and does not invoke the tool", async () => {
    const db = new Database(dbPath);
    db.run("CREATE TRIGGER fail_tool_event BEFORE INSERT ON work_events WHEN NEW.kind = 'tool-started' BEGIN SELECT RAISE(ABORT, 'event unavailable'); END");
    let invoked = 0;
    const tools: LoopHostTools = { definitions: [], async execute() { invoked++; return "ok"; } };
    try {
      await runLoopMode(agent(), "goal", provider([call("bash")]), manager, sessions, { host: host(tools), maxIterations: 2 });
      const row = db.query("SELECT count(*) AS count FROM work_steps WHERE work_id = ? AND kind = 'tool'").get(workId) as { count: number };
      expect(invoked).toBe(0);
      expect(row.count).toBe(0);
      expect(toolEvents()).toEqual([]);
    } finally { db.close(); }
  });
});
