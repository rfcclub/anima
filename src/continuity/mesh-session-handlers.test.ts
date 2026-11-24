import { expect, test } from "bun:test";
import type { ActivationCandidate } from "./activation-candidate";
import type { BudgetGrant } from "./activation-budget";
import type { MeshSource } from "./activation-store";
import { createMeshSessionHandlers, type MeshConversationPort } from "./mesh-session-handlers";

const candidate = { agentId: "finn", sourceRef: "a2a:conv-9", summary: "review PR example/repo#1" } as ActivationCandidate;
const grant = { leaseId: "lease-1" } as BudgetGrant;

function source(overrides: Partial<MeshSource> = {}): MeshSource {
  return {
    agentId: "finn", sourceRef: "a2a:conv-9", fromId: "agent-claude-00000001@host-1", fromPlatform: "a2a", threadId: "conv-9",
    subject: "", content: "Review PR example/repo#1, then post with anima_github.", role: "request",
    createdAt: 0, attempts: 1, repliedAt: null, ...overrides,
  };
}

/** A conversation port that records what was finished; `answered` and `finish` outcomes are scriptable. */
function harness(runTurn: (agentId: string, message: string, channelId: string) => Promise<string>, port: Partial<MeshConversationPort> = {}) {
  const finished: Array<{ conversationId: string; content: string }> = [];
  const replied: string[] = [];
  const turns: string[] = [];
  const conversation: MeshConversationPort = {
    answered: port.answered ?? (async () => false),
    finish: port.finish ?? (async (conversationId, content, fence) => {
      if (fence.aborted) return "fenced";
      finished.push({ conversationId, content });
      return "replied";
    }),
  };
  const handlers = createMeshSessionHandlers({
    runTurn: async (agentId, message, channelId) => { turns.push(message); return runTurn(agentId, message, channelId); },
    conversation: () => conversation,
    markReplied: (agentId, sourceRef) => replied.push(`${agentId}:${sourceRef}`),
  });
  return { handlers, finished, replied, turns };
}

const live = () => new AbortController().signal;

test("AJ-7 an answered request finishes its own conversation with the answer and is marked replied", async () => {
  const t = harness(async () => "LGTM, approved.");
  const effect = await t.handlers.executeSession({ candidate, grant, source: source(), signal: live() });
  expect(effect).toBe("mesh-session:a2a:conv-9:15");
  expect(t.turns).toEqual(["[mesh from agent-claude-00000001@host-1] Review PR example/repo#1, then post with anima_github."]);
  expect(t.finished).toEqual([{ conversationId: "conv-9", content: "LGTM, approved." }]);
  expect(t.replied).toEqual(["finn:a2a:conv-9"]);
});

test("AJ-7 an empty answer still finishes the conversation", async () => {
  const t = harness(async () => "");
  await t.handlers.executeSession({ candidate, grant, source: source(), signal: live() });
  expect(t.finished).toEqual([{ conversationId: "conv-9", content: "(the agent finished without an answer)" }]);
});

test("AJ-8 a locally replied request is not run again and finishes nothing", async () => {
  const t = harness(async () => { throw new Error("must not run"); });
  expect(await t.handlers.executeSession({ candidate, grant, source: source({ repliedAt: 5 }), signal: live() })).toBe("mesh-session:a2a:conv-9:replayed");
  expect(t.turns).toEqual([]);
  expect(t.finished).toEqual([]);
});

test("AJ-8 a conversation Mesh already shows as answered is not run again, and is marked replied locally", async () => {
  const t = harness(async () => { throw new Error("must not run"); }, { answered: async () => true });
  expect(await t.handlers.executeSession({ candidate, grant, source: source(), signal: live() })).toBe("mesh-session:a2a:conv-9:replayed");
  expect(t.turns).toEqual([]);
  expect(t.finished).toEqual([]);
  expect(t.replied).toEqual(["finn:a2a:conv-9"]);
});

test("AJ-9 the final failure finishes the conversation once with the failure text; an intermediate one sends nothing", async () => {
  const t = harness(async () => "unused");
  await t.handlers.onFailed({ candidate, source: source(), error: new Error("Endpoint is unavailable."), attempts: 1, final: false, timedOut: false });
  expect(t.finished).toEqual([]);
  await t.handlers.onFailed({ candidate, source: source(), error: new Error("Endpoint is unavailable."), attempts: 3, final: true, timedOut: false });
  expect(t.finished).toHaveLength(1);
  expect(t.finished[0]!.conversationId).toBe("conv-9");
  expect(t.finished[0]!.content).toContain("Review PR example/repo#1");
  expect(t.finished[0]!.content).toContain("3 attempts");
  expect(t.finished[0]!.content).toContain("Endpoint is unavailable.");
  expect(t.replied).toEqual(["finn:a2a:conv-9"]);
});

test("AJ-9 a timed-out turn's late result does not finish the conversation; the failure notice does", async () => {
  let release: (text: string) => void = () => {};
  const t = harness(() => new Promise<string>((resolve) => { release = resolve; }));
  const fence = new AbortController();
  const pending = t.handlers.executeSession({ candidate, grant, source: source(), signal: fence.signal });
  fence.abort();
  await t.handlers.onFailed({ candidate, source: source(), error: new Error("timed out"), attempts: 1, final: true, timedOut: true });
  release("late answer");
  await pending;
  expect(t.finished).toHaveLength(1);
  expect(t.finished[0]!.content).toContain("timed out");
});

test("SC-1 a mesh timeout reaches the running turn and fences its late result", async () => {
  const controller = new AbortController();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let received: AbortSignal | undefined;
  let finished = 0;
  const handlers = createMeshSessionHandlers({
    runTurn: async (...args: unknown[]) => {
      received = args[3] as AbortSignal | undefined;
      started();
      await gate;
      return "late answer";
    },
    conversation: () => ({
      answered: async () => false,
      finish: async () => { finished += 1; return "replied"; },
    }),
    markReplied: () => {},
  });
  const pending = handlers.executeSession({ candidate, grant, source: source(), signal: controller.signal });
  await running;
  controller.abort();
  release();
  const effect = await pending;
  expect(received).toBe(controller.signal);
  expect(received?.aborted).toBe(true);
  expect(effect).toBe("mesh-session:a2a:conv-9:late");
  expect(finished).toBe(0);
});

test("SC-2 aborting during conversation lookup never starts the turn", async () => {
  const controller = new AbortController();
  let release: (answered: boolean) => void = () => {};
  let entered: () => void = () => {};
  const lookupStarted = new Promise<void>((resolve) => { entered = resolve; });
  let turns = 0;
  const handlers = createMeshSessionHandlers({
    runTurn: async () => { turns += 1; return "late answer"; },
    conversation: () => ({
      answered: () => { entered(); return new Promise<boolean>((resolve) => { release = resolve; }); },
      finish: async () => "replied",
    }),
    markReplied: () => {},
  });
  const pending = handlers.executeSession({ candidate, grant, source: source(), signal: controller.signal });
  await lookupStarted;
  controller.abort();
  release(false);
  const effect = await pending;
  expect(effect).toBe("mesh-session:a2a:conv-9:late");
  expect(turns).toBe(0);
});

test("AJ-9 the failure notice waits for an in-flight answer, and is not sent when that answer committed", async () => {
  const order: string[] = [];
  let commit: () => void = () => {};
  let committed = false;
  const t = harness(async () => "the answer", {
    finish: async (_conversationId, content, _fence) => {
      if (content === "the answer") {
        order.push("answer:start");
        await new Promise<void>((resolve) => { commit = resolve; });
        committed = true;
        order.push("answer:committed");
        return "replied";
      }
      order.push(committed ? "failure:saw-answer" : "failure:sent");
      return committed ? "already" : "replied";
    },
  });
  const success = t.handlers.executeSession({ candidate, grant, source: source(), signal: new AbortController().signal });
  await Bun.sleep(5);
  const failure = t.handlers.onFailed({ candidate, source: source(), error: new Error("timed out"), attempts: 1, final: true, timedOut: true });
  await Bun.sleep(5);
  expect(order).toEqual(["answer:start"]);
  commit();
  await Promise.all([success, failure]);
  expect(order).toEqual(["answer:start", "answer:committed", "failure:saw-answer"]);
});

test("a legacy mesh: source has no reply transport any more: it runs and nothing is finished", async () => {
  const legacy = source({ sourceRef: "mesh:77", fromId: "bruno", fromPlatform: "claude", threadId: "thread-9" });
  const t = harness(async () => "ok");
  await t.handlers.executeSession({ candidate: { ...candidate, sourceRef: "mesh:77" }, grant, source: legacy, signal: live() });
  await t.handlers.onFailed({ candidate: { ...candidate, sourceRef: "mesh:77" }, source: legacy, error: new Error("x"), attempts: 3, final: true, timedOut: false });
  expect(t.finished).toEqual([]);
});
