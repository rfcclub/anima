import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type TurnRecord } from "../../src/memory/session-store";
import { COMPACTING_TURN_BUDGET, keptTailStart, startCastleCompaction, waitForCastleCompactions } from "../../src/session/castle-compaction";
import {
  TALK_LEGACY_DEFAULT_OVERRIDE,
  decideTalkCompaction,
  decideTalkCompactionWithModel,
  estimateReplyTokens,
  talkCompactThreshold,
  talkCompactionPlan,
} from "../../src/session/talk-compaction";
import type { Provider, ProviderResponse } from "../../src/providers/interface";

// the talk path's automatic compaction: T = 50% of min(window, 256,000), the arithmetic rule, the optional
// decision model with its arithmetic fallback, and one castle compaction per crossing with a bounded prompt.

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "talk-compaction-"));
  store = new SessionStore(join(dir, "sessions.db"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `count` alternating user/assistant turns of `tokensEach` estimated tokens (4 characters per token). */
function append(sessionId: string, count: number, tokensEach = 1000, from = 0): void {
  for (let i = from; i < from + count; i++) {
    const tag = `m${i}:`;
    store.appendTurn(sessionId, i % 2 === 0 ? "user" : "assistant", tag + "x".repeat(4 * tokensEach - tag.length));
  }
}

const turnsOf = (sessionId: string) => store.getTurns(sessionId);

test("T is 50% of min(window, 256,000) and a room's own compactThreshold replaces it", () => {
  expect(talkCompactThreshold({ contextWindow: 1_050_000 })).toBe(128_000);
  expect(talkCompactThreshold({ contextWindow: 256_000 })).toBe(128_000);
  expect(talkCompactThreshold({ contextWindow: 128_000 })).toBe(64_000);
  // No window configured: W is taken as 256,000.
  expect(talkCompactThreshold({})).toBe(128_000);
  // A room may override T.
  expect(talkCompactThreshold({ contextWindow: 1_050_000, override: 30_000 })).toBe(30_000);
  // The loader's own default is not an override (the plan drops it).
  expect(talkCompactionPlan({ turns: [], incomingMessage: "hi", override: TALK_LEGACY_DEFAULT_OVERRIDE }).threshold).toBe(128_000);
});

test("the arithmetic rule compacts only when the pre-turn and the predicted post-turn size both exceed T", () => {
  const session = store.createSession("jade", "ui");
  // 14 messages of 1,000 tokens: 14,000 pre-turn. T = 15,000: neither side crosses yet.
  append(session.id, 14);
  const turns = turnsOf(session.id);
  const under = decideTalkCompaction({ turns, incomingMessage: "x".repeat(4 * 500), threshold: 15_000 });
  expect(under.compact).toBe(false);
  expect(under.source).toBe("arithmetic");

  // 16 messages of 1,000 tokens: 16,000 pre-turn, plus 500 for the message and the reply estimate of 1,000.
  append(session.id, 2, 1000, 14);
  const crossing = decideTalkCompaction({ turns: turnsOf(session.id), incomingMessage: "x".repeat(4 * 500), threshold: 15_000 });
  expect(crossing.preTurnTokens).toBe(16_000);
  expect(crossing.predictedPostTurnTokens).toBe(17_500);
  expect(crossing.compact).toBe(true);

  // The pre-turn size alone is not enough: a huge reply estimate does not save a turn under T.
  const small = decideTalkCompaction({ turns: turnsOf(session.id).slice(0, 12), incomingMessage: "now", threshold: 15_000 });
  expect(small.compact).toBe(false);
});

test("the reply estimate averages the newest assistant turns and falls back to a small default", () => {
  expect(estimateReplyTokens([])).toBe(500);
  const session = store.createSession("jade", "ui");
  append(session.id, 4); // two assistant turns of 1,000 tokens
  expect(estimateReplyTokens(turnsOf(session.id))).toBe(1_000);
});

test("the decision model never writes the summary; its error or timeout leaves the arithmetic answer in place", async () => {
  const session = store.createSession("jade", "ui");
  append(session.id, 16);
  const turns = turnsOf(session.id);
  const input = { turns, incomingMessage: "x".repeat(4 * 500), threshold: 15_000 };

  const asked: number[] = [];
  const model = { decide: async (features: { predictedPostTurnTokens: number }) => { asked.push(features.predictedPostTurnTokens); return { probability: 0.9 }; } };
  const modelled = await decideTalkCompactionWithModel({ ...input, model });
  expect(asked).toEqual([17_500]);
  expect(modelled).toMatchObject({ compact: true, source: "model" });

  const declines = await decideTalkCompactionWithModel({ ...input, model: { decide: async () => ({ probability: 0.1 }) } });
  expect(declines).toMatchObject({ compact: false, source: "model" });

  // Errors, out-of-range answers and timeouts fall back to the arithmetic rule and never throw.
  const failing = [
    { decide: async () => { throw new Error("model down"); } },
    { decide: async () => ({ probability: 4 }) },
    { decide: () => new Promise<{ probability: number }>((resolve) => setTimeout(() => resolve({ probability: 0.9 }), 200)) },
  ];
  for (const candidate of failing) {
    const decided = await decideTalkCompactionWithModel({ ...input, model: candidate, timeoutMs: 20 });
    expect(decided).toEqual(decideTalkCompaction(input));
  }
});

test("a growing talk session compacts once per crossing and every turn's prompt stays within budget", async () => {
  const session = store.createSession("jade", "ui");
  const T = 15_000;
  let summaries = 0;
  const provider: Provider = {
    name: "claude",
    query: async (): Promise<ProviderResponse> => {
      summaries++;
      return { message: { role: "assistant", content: `SUMMARY#${summaries}` } };
    },
  };
  const failures = new Map<string, number>();

  const compactions: number[] = [];
  for (let turn = 1; turn <= 24; turn++) {
    append(session.id, 2, 1000, (turn - 1) * 2);
    const plan = talkCompactionPlan({ turns: turnsOf(session.id), summary: store.getSummary(session.id)?.summary, incomingMessage: "now", override: T });
    expect(plan.threshold).toBe(T);
    const history = startCastleCompaction({
      store, sessionId: session.id, agent: "jade", branching: false, provider, incomingMessage: "now",
      thresholdTokens: plan.threshold, preTurnTokens: plan.preTurnTokens,
      replyEstimateTokens: plan.replyEstimateTokens, priorHistoryBudget: plan.budget,
      failures,
    });
    // The turn always sends a bounded prompt: at most T, less while a compaction runs in the background.
    expect(history.budget).toBeLessThanOrEqual(T);
    if (history.pending) {
      compactions.push(turn);
      expect(history.budget).toBe(Math.min(COMPACTING_TURN_BUDGET, T));
      await waitForCastleCompactions();
    }
  }

  // One compaction per crossing, never a second one while the same turns are unchanged: T is 15,000, each turn
  // adds 2,000 and a compaction keeps a 10,000-token tail, so crossings fall every third turn after the first.
  expect(compactions).toEqual([8, 11, 14, 17, 20, 23]);
  expect(summaries).toBe(compactions.length);
  // After each compaction the stored summary is kept and exactly the folded turns are gone.
  expect(store.getSummary(session.id)?.summary).toBe(`SUMMARY#${compactions.length}`);
  // The 23rd-turn compaction kept m36..m45; turn 24 appended m46 and m47.
  expect(turnsOf(session.id)).toHaveLength(12);
  expect(turnsOf(session.id)[0]!.content.startsWith("m36:")).toBe(true);

  // The next turn starts from the stored summary plus the recent tail and does not compact again.
  const next = talkCompactionPlan({ turns: turnsOf(session.id), summary: store.getSummary(session.id)?.summary, incomingMessage: "now", override: T });
  const after = startCastleCompaction({
    store, sessionId: session.id, agent: "jade", branching: false, provider, incomingMessage: "now",
    thresholdTokens: next.threshold, preTurnTokens: next.preTurnTokens,
    replyEstimateTokens: next.replyEstimateTokens, priorHistoryBudget: next.budget, failures,
  });
  expect(after).toEqual({ summary: `SUMMARY#${compactions.length}`, budget: T });
  expect(summaries).toBe(compactions.length);
});

test("the kept tail of a compacted session is the same window the castle path keeps", () => {
  const session = store.createSession("jade", "ui");
  append(session.id, 20);
  const turns: TurnRecord[] = turnsOf(session.id);
  expect(keptTailStart(turns)).toBe(10);
});
