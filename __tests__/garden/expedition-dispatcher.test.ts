import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SharedNarrativeStore, __resetSharedNarrativeStore } from "../../src/narrative/shared-store";
import { JsonlGardenEventStore } from "../../src/garden/event-store";
import { ExpeditionDispatcher, EXPEDITION_MAX_MS } from "../../src/garden/expedition-dispatcher";
import { ActivationBudget } from "../../src/continuity/activation-budget";
import { ActivationStore } from "../../src/continuity/activation-store";
import type { Provider, ProviderRequest, ProviderResponse } from "../../src/providers/interface";

let dir: string;
let store: SharedNarrativeStore;
let eventStore: JsonlGardenEventStore;
const PROJECT_ROOT = join(__dirname, "..", "..");

function fakeProvider(text: string): Provider {
  return {
    name: "mock",
    async query(): Promise<ProviderResponse> {
      return {
        message: { role: "assistant", content: text },
      };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-exped-disp-"));
  __resetSharedNarrativeStore();
  store = new SharedNarrativeStore(join(dir, "memory.db"));
  store.seedPlacesFromRoster(["lena"]);
  eventStore = new JsonlGardenEventStore(join(dir, "_shared", "garden", "events.jsonl"));
});

afterEach(() => {
  __resetSharedNarrativeStore();
});

// SC-008: dispatcher picks oldest claimed expedition
test("SC-008: dispatcher activates oldest claimed expedition", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => fakeProvider("Found a dangling cron job — last run 9 days ago."),
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });
  await disp.tick();
  // expedition moved to ended, discovery ingested
  const claimed = store.claimedExpeditions();
  expect(claimed.length).toBe(0);
});

// SC-019: discovery ingested as DISCOVERY + MEMORY_PROPOSAL
test("SC-019: discovery ingested as DISCOVERY + MEMORY_PROPOSAL events", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => fakeProvider("the cron job is dangling — last run 9 days ago\nEvidence:\n- crontab -l:3"),
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });
  await disp.tick();
  const events = await eventStore.readAll({});
  const types = events.map((e) => e.type);
  expect(types).toContain("DISCOVERY");
  expect(types).toContain("MEMORY_PROPOSAL");
  expect(types).toContain("EXPEDITION_ENDED");
});

// SC-017: a completed discovery is written to the agent's outbox with at
// least one evidence ref; a reply with no evidence section is treated as
// empty-handed (no discovery file, no DISCOVERY event).
test("SC-017: discovery file is written to outbox with an evidence ref", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => fakeProvider("found a stale lockfile\nEvidence:\n- bun.lockb:1"),
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });
  await disp.tick();
  const discoveryPath = join(dir, "lena", "outbox", "discovery-e-1.md");
  expect(existsSync(discoveryPath)).toBe(true);
  const contents = readFileSync(discoveryPath, "utf-8");
  expect(contents).toContain("found a stale lockfile");
  expect(contents).toContain("bun.lockb:1");
});

test("SC-017b: a reply with no evidence section is empty-handed — no file, no DISCOVERY", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => fakeProvider("found a stale lockfile but forgot to cite it"),
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });
  await disp.tick();
  expect(existsSync(join(dir, "lena", "outbox", "discovery-e-1.md"))).toBe(false);
  const events = await eventStore.readAll({});
  expect(events.map((e) => e.type)).not.toContain("DISCOVERY");
});

// SC-018/SC-020: empty provider reply → no DISCOVERY/MEMORY_PROPOSAL, just
// ENDED, and discovery_ref stays null on the row.
test("SC-018: empty provider reply → no DISCOVERY, just ENDED", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => fakeProvider("   "),
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });
  await disp.tick();
  const events = await eventStore.readAll({});
  const types = events.map((e) => e.type);
  expect(types).toContain("EXPEDITION_ENDED");
  expect(types).not.toContain("DISCOVERY");
  expect(types).not.toContain("MEMORY_PROPOSAL");
  expect(store.getExpedition("e-1")?.discoveryRef).toBeNull();
});

// SC-014: a session completing within budget hands off to teardown and is
// not left `running` — the row transitions all the way to `ended`.
test("SC-014: a completed session is not left running — the row ends", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => fakeProvider("a stale cache file\nEvidence:\n- cache/stale.json:1"),
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });
  await disp.tick();
  expect(store.getExpedition("e-1")?.status).toBe("ended");
});

// SC-009: no claimed expeditions → no-op
test("SC-009: no claimed expeditions → dispatcher no-ops", async () => {
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => fakeProvider("x"),
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });
  await disp.tick();
  const events = await eventStore.readAll({});
  expect(events.length).toBe(0);
});

test("SC-041: enforce and gate expeditions refuse an ungranted provider session", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  let calls = 0;
  for (const mode of ["gate", "enforce"] as const) {
    const disp = new ExpeditionDispatcher({
      resolveProvider: async () => ({ name: "counting", async query() { calls += 1; return { message: { role: "assistant" as const, content: "NO_DISCOVERY" } }; } }),
      store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
      activation: { mode },
    });
    await disp.tick();
  }
  expect(calls).toBe(0);
  expect(store.getExpedition("e-1")?.status).toBe("claimed");
});

test("SC-042: a granted T2 expedition keeps its existing single-session bound", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  let resolveQuery!: (response: ProviderResponse) => void;
  let calls = 0;
  const activationDir = mkdtempSync(join(tmpdir(), "anima-expedition-budget-"));
  const activationStore = new ActivationStore(join(activationDir, "memory.db"));
  const budget = new ActivationBudget(activationStore, { colonyDailyLimit: 20, agentDailyLimit: 10 });
  const reservation = budget.reserve({
    leaseId: "t2-1", agentId: "lena", executor: "expedition", costClass: "T2", now: 2000,
  });
  expect(reservation.ok).toBe(true);
  if (!reservation.ok) throw new Error("T2 reservation unexpectedly failed");
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => ({ name: "slow", query: () => { calls += 1; return new Promise<ProviderResponse>((resolve) => { resolveQuery = resolve; }); } }),
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
    activation: {
      mode: "enforce",
      grantForExpedition: () => reservation.grant,
      settleGrant: (grant) => { budget.settle(grant.leaseId, 3000); },
    },
  });
  const first = disp.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await disp.tick();
  expect(calls).toBe(1);
  resolveQuery({ message: { role: "assistant", content: "NO_DISCOVERY" } });
  await first;
  expect(store.getExpedition("e-1")?.status).toBe("ended");
  expect(activationStore.getBudget("1970-01-01", "colony", "all")).toEqual({ spentUnits: 10, reservedUnits: 0 });
  expect(activationStore.getBudget("1970-01-01", "agent", "lena")).toEqual({ spentUnits: 10, reservedUnits: 0 });
  activationStore.close();
  rmSync(activationDir, { recursive: true, force: true });
});

// SC-009 (colony-wide): a second tick() while a session is already running no-ops.
test("SC-009: tick() no-ops while a session is already running", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  let resolveQuery!: (r: ProviderResponse) => void;
  let queryCalls = 0;
  const slowProvider: Provider = {
    name: "slow",
    query() {
      queryCalls++;
      return new Promise<ProviderResponse>((resolve) => { resolveQuery = resolve; });
    },
  };
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => slowProvider,
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });

  const firstTick = disp.tick(); // not awaited — session is now "running"
  await new Promise((r) => setTimeout(r, 10));
  await disp.tick(); // should no-op immediately, no second query

  expect(queryCalls).toBe(1);

  resolveQuery({ message: { role: "assistant", content: "NO_DISCOVERY" } });
  await firstTick;
});

// SC-010/011/012: session tool loop uses the scoped executor — a machine
// expedition can read in-scope files via a real tool call, and the final
// discovery reflects what the tool returned.
test("SC-010/011: tool-calling session reads via scoped executor then finalizes", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  let call = 0;
  const provider: Provider = {
    name: "mock",
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      call++;
      if (call === 1) {
        expect(req.tools?.map((t) => t.name).sort()).toEqual(["glob", "grep", "read"]);
        return {
          message: { role: "assistant", content: null },
          tool_calls: [{ id: "tc-1", name: "read", arguments: JSON.stringify({ path: "package.json" }) }],
        };
      }
      // second turn: the tool result should be in the transcript
      const toolMsg = req.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).not.toContain("outside machine scope");
      return { message: { role: "assistant", content: "found the project name in package.json\nEvidence:\n- package.json:1" } };
    },
  };
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => provider, store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });
  await disp.tick();
  expect(call).toBe(2);
  const events = await eventStore.readAll({});
  const discovery = events.find((e) => e.type === "DISCOVERY");
  expect((discovery?.payload as { summary: string }).summary).toContain("package.json");
});

// SC-013: budget-exceeded (wall-clock) → clean terminate, no DISCOVERY
test("SC-013: exceeding the wall-clock budget ends the session without a discovery", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  let elapsed = 0;
  const provider: Provider = {
    name: "mock",
    async query(): Promise<ProviderResponse> {
      elapsed += EXPEDITION_MAX_MS; // each call blows past the budget
      return {
        message: { role: "assistant", content: null },
        tool_calls: [{ id: `tc-${elapsed}`, name: "read", arguments: JSON.stringify({ path: "package.json" }) }],
      };
    },
  };
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => provider, store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT,
    now: () => 1000 + elapsed,
  });
  await disp.tick();
  const events = await eventStore.readAll({});
  const types = events.map((e) => e.type);
  expect(types).toContain("EXPEDITION_ENDED");
  expect(types).not.toContain("DISCOVERY");
  const claimed = store.claimedExpeditions();
  expect(claimed.length).toBe(0);
});

// SC-016: presence restored (no longer references the expedition id) after any end path
test("SC-016: presence activity no longer references the expedition id after end", async () => {
  store.claimExpedition({ id: "e-1", agentId: "lena", target: "machine", now: 1000 });
  store.setPresence({ agentId: "lena", placeId: "gate_machine", since: 1000, activity: "expedition:e-1" });
  const disp = new ExpeditionDispatcher({
    resolveProvider: async () => fakeProvider("a discovery"),
    store, eventStore, roomsDir: dir, projectRoot: PROJECT_ROOT, now: () => 2000,
  });
  await disp.tick();
  const presence = store.getPresence("lena");
  expect(presence?.activity ?? "").not.toContain("e-1");
});

// SC-015: static check — the dispatcher module imports no RuntimeAdapter,
// child_process, or Codex/Agent-SDK module.
test("SC-015: dispatcher module has no engine-spawning imports", () => {
  const source = readFileSync(join(PROJECT_ROOT, "src/garden/expedition-dispatcher.ts"), "utf-8");
  expect(source).not.toMatch(/child_process/);
  expect(source).not.toMatch(/RuntimeAdapter/);
  expect(source).not.toMatch(/codex/i);
  expect(source).not.toMatch(/agent-sdk|@anthropic-ai\/claude-agent-sdk/);
});
