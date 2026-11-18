import { describe, expect, test } from "bun:test";
import type { MeshSourceInput } from "../continuity/activation-store";
import type { MeshConversationPort } from "../continuity/mesh-session-handlers";
import { createInboxDelivery } from "./inbox-delivery";

function harness(activation: Parameters<typeof createInboxDelivery>[0]["activation"], workers: string[] = []) {
  const retained: MeshSourceInput[] = [];
  const turns: string[] = [];
  const finished: Array<{ conversationId: string; content: string }> = [];
  const conversation: MeshConversationPort = {
    answered: async () => false,
    finish: async (conversationId, content) => { finished.push({ conversationId, content }); return "replied"; },
  };
  const deliver = createInboxDelivery({
    activation,
    retain: (source) => { retained.push(source); },
    runTurn: async (_agent, message) => { turns.push(message); return "pong"; },
    conversation: () => conversation,
    now: () => 42,
    log: () => {},
    jobWorker: (agent) => workers.includes(agent),
  });
  return { deliver, retained, turns, finished };
}

describe("inbox delivery outside gate mode (Eli, review of e9488a8b)", () => {
  test("AJ-10 a forwarded reply is kept once as a reply before the cursor moves, and is never answered", async () => {
    const h = harness(null);
    await h.deliver("finn", { conversationId: "r1", sender: "mesh-service@local", body: "[mesh reply from x@m re conversation_id=c0]\npong", replyTo: "c0" });
    expect(h.retained).toEqual([{
      agentId: "finn", sourceRef: "a2a:r1", fromId: "mesh-service@local", fromPlatform: "a2a", threadId: "r1",
      subject: "", content: "[mesh reply from x@m re conversation_id=c0]\npong", role: "reply", createdAt: 42,
    }]);
    expect(h.turns).toEqual([]);
    expect(h.finished).toEqual([]);
  });

  test("a request is kept, run inline and answered on its conversation", async () => {
    const h = harness(null);
    await h.deliver("finn", { conversationId: "c1", sender: "bruno-claude-b7bccda4@m", body: "ping" });
    expect(h.retained.map((source) => [source.sourceRef, source.role])).toEqual([["a2a:c1", "request"]]);
    expect(h.turns).toEqual(["[mesh from bruno-claude-b7bccda4@m] ping"]);
    expect(h.finished).toEqual([{ conversationId: "c1", content: "pong" }]);
  });

  test("a store that cannot keep the item makes delivery throw, so the cursor holds", async () => {
    const deliver = createInboxDelivery({
      activation: null, retain: () => { throw new Error("database is locked"); },
      runTurn: async () => "unused", conversation: () => ({ answered: async () => false, finish: async () => "replied" }), now: () => 1, log: () => {},
    });
    await expect(deliver("finn", { conversationId: "r2", sender: "s", body: "b", replyTo: "c0" })).rejects.toThrow("database is locked");
  });
});

describe("inbox delivery in gate mode", () => {
  test("a request is ingested and dispatched; a refused ingress throws", async () => {
    const dispatched: string[] = [];
    let disposition: "ack" | "retry" = "ack";
    const h = harness({
      ingestA2A: () => ({ disposition, route: "candidate" }),
      dispatch: async (agent: string, sourceRef: string) => { dispatched.push(`${agent}:${sourceRef}`); return { ok: true }; },
    });
    await h.deliver("finn", { conversationId: "c1", sender: "s", body: "b" });
    await Bun.sleep(1);
    expect(dispatched).toEqual(["finn:a2a:c1"]);
    expect(h.retained).toEqual([]);
    disposition = "retry";
    await expect(h.deliver("finn", { conversationId: "c2", sender: "s", body: "b" })).rejects.toThrow();
  });
});

const notice = [
  "Review job 67ff8e36-c57a-45b2-9295-8d7f1195ee8f: rfcclub/seal-gate#18 at 3857767cf7db2a4ab31196edc003819dcb1068a7.",
  "Take it with: mesh jobs claim",
  "Then review the PR at that head and report: mesh jobs report <claim> done <review URL>",
].join("\n");

describe("mesh job notices (NT)", () => {
  test("notice-to-worker: a job notice to a consumer worker runs no turn and is answered once", async () => {
    const h = harness(null, ["cleo"]);
    await h.deliver("cleo", { conversationId: "n1", sender: "bruno-claude-b7bccda4@m", body: notice });
    expect(h.turns).toEqual([]);
    expect(h.retained.map((source) => [source.sourceRef, source.role])).toEqual([["a2a:n1", "request"]]);
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0]!.conversationId).toBe("n1");
    expect(h.finished[0]!.content).toContain("67ff8e36-c57a-45b2-9295-8d7f1195ee8f");
  });

  test("notice-in-gate-mode: a job notice to a worker is not ingested or dispatched", async () => {
    const calls: string[] = [];
    const h = harness({
      ingestA2A: () => { calls.push("ingest"); return { disposition: "ack", route: "candidate" }; },
      dispatch: async () => { calls.push("dispatch"); return { ok: true }; },
    }, ["cleo"]);
    await h.deliver("cleo", { conversationId: "n2", sender: "s", body: notice });
    await Bun.sleep(1);
    expect(calls).toEqual([]);
    expect(h.turns).toEqual([]);
    expect(h.finished.map((f) => f.conversationId)).toEqual(["n2"]);
  });

  test("notice-to-non-worker: a job notice to an agent without a worker still runs a turn", async () => {
    const h = harness(null, ["cleo"]);
    await h.deliver("jade", { conversationId: "n3", sender: "s", body: notice });
    expect(h.turns).toEqual([`[mesh from s] ${notice}`]);
  });

  test("chat-to-worker: a non-notice message to a worker still runs a turn", async () => {
    const h = harness(null, ["cleo"]);
    await h.deliver("cleo", { conversationId: "n4", sender: "s", body: "Please review job 67ff8e36 when you can" });
    expect(h.turns).toEqual(["[mesh from s] Please review job 67ff8e36 when you can"]);
  });
});

describe("mesh job notices (NT) review fixes", () => {
  test("cli-command-notice: a notice naming the real multi-token mesh command is recognized", async () => {
    const h = harness(null, ["cleo"]);
    const real = notice.replace("Take it with: mesh jobs claim", "Take it with: bun /opt/colony-mesh/bin/mesh.ts jobs claim");
    await h.deliver("cleo", { conversationId: "n5", sender: "s", body: real });
    expect(h.turns).toEqual([]);
    expect(h.finished.map((f) => f.conversationId)).toEqual(["n5"]);
  });
});
