import { describe, expect, test } from "bun:test";
import {
  CONTINUITY_ENVELOPE_VERSION,
  ContinuityEnvelopeError,
  assessLesson,
  coalesceExactDuplicates,
  contentFingerprint,
  deriveIdempotencyKey,
  independentEvidence,
  parseContinuityEnvelope,
  type ContinuityEnvelopeV1,
} from "../../src/memory/continuity-envelope";

function envelope(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    version: CONTINUITY_ENVELOPE_VERSION,
    identity: "pilot",
    actor: "operator",
    visibility: "identity",
    source: { kind: "session-turn", id: "sess-1:turn-7", version: "1" },
    sessionId: "sess-1",
    runId: "run-1",
    eventTime: "2026-07-01T10:00:00.000Z",
    ingestedAt: "2026-07-01T10:00:05.000Z",
    kind: "correction",
    epistemic: "asserted",
    parents: [],
    scope: "decision",
    content: "Deploy window moved to Thursday; Friday is frozen.",
    ...overrides,
  };
}

describe("continuity envelope", () => {
  test("parses a complete v1 envelope and keeps actor, scope and provenance", () => {
    const parsed = parseContinuityEnvelope(
      envelope({ parents: ["hindsight:abc"], subject: "deploy-window", expiresAt: "2026-12-31T00:00:00.000Z" }),
    );
    expect(parsed.version).toBe(1);
    expect(parsed.actor).toBe("operator");
    expect(parsed.scope).toBe("decision");
    expect(parsed.parents).toEqual(["hindsight:abc"]);
    expect(parsed.subject).toBe("deploy-window");
    expect(parsed.idempotencyKey).toBe(
      deriveIdempotencyKey({ kind: "correction", source: { kind: "session-turn", id: "sess-1:turn-7", version: "1" }, identity: "pilot" }),
    );
  });

  test("rejects an unknown envelope version instead of guessing", () => {
    expect(() => parseContinuityEnvelope(envelope({ version: 2 }))).toThrow(ContinuityEnvelopeError);
  });

  test("rejects a record with no speaker/actor or an unparsable event time", () => {
    expect(() => parseContinuityEnvelope(envelope({ actor: "  " }))).toThrow(ContinuityEnvelopeError);
    expect(() => parseContinuityEnvelope(envelope({ eventTime: "yesterday" }))).toThrow(ContinuityEnvelopeError);
    expect(() => parseContinuityEnvelope(envelope({ visibility: "colony" }))).toThrow(ContinuityEnvelopeError);
  });

  test("accepts non-English content without any English trigger keyword", () => {
    const parsed = parseContinuityEnvelope(
      envelope({ content: "打版时间改到下周四。", actor: "operator", kind: "correction" }),
    );
    expect(parsed.content).toBe("打版时间改到下周四。");
  });

  test("idempotency key is stable across retries and changes with the source version", () => {
    const base = { kind: "observation" as const, identity: "pilot" };
    const a = deriveIdempotencyKey({ ...base, source: { kind: "tool-event", id: "evt-9", version: "1" } });
    const retry = deriveIdempotencyKey({ ...base, source: { kind: "tool-event", id: "evt-9", version: "1" } });
    const updated = deriveIdempotencyKey({ ...base, source: { kind: "tool-event", id: "evt-9", version: "2" } });
    expect(a).toBe(retry);
    expect(updated).not.toBe(a);
  });

  test("content fingerprint keeps changed numbers, dates and negation distinct", () => {
    const fp = contentFingerprint;
    expect(fp("budget is 10 tokens")).not.toBe(fp("budget is 12 tokens"));
    expect(fp("freeze starts 2026-07-01")).not.toBe(fp("freeze starts 2026-07-02"));
    expect(fp("do not deploy on Friday")).not.toBe(fp("do deploy on Friday"));
    expect(fp("review   the\tplan")).toBe(fp("review the plan"));
  });

  test("exact duplicates coalesce, but a changed event time or content stays a distinct event", () => {
    const first = parseContinuityEnvelope(envelope({ kind: "observation", source: { kind: "tool-event", id: "e1", version: "1" } }));
    const sameEvent = parseContinuityEnvelope(envelope({ kind: "observation", source: { kind: "tool-event", id: "e1", version: "1" } }));
    const changedDate = parseContinuityEnvelope(
      envelope({ kind: "observation", eventTime: "2026-07-02T10:00:00.000Z", source: { kind: "tool-event", id: "e2", version: "1" } }),
    );
    const changedText = parseContinuityEnvelope(
      envelope({ kind: "observation", content: "Deploy window moved to Friday; Thursday is frozen.", source: { kind: "tool-event", id: "e3", version: "1" } }),
    );

    const coalesced = coalesceExactDuplicates([first, sameEvent, changedDate, changedText]);
    expect(coalesced).toHaveLength(3);
    expect(coalesced[0]!.recordKey).toBe(first.idempotencyKey);
  });

  test("a misleading reflection repeated many times is one source, not corroboration", () => {
    const reflections = Array.from({ length: 6 }, (_, i) =>
      parseContinuityEnvelope(
        envelope({
          kind: "reflection",
          epistemic: "derived",
          source: { kind: "dream-lucid", id: "episode-42", version: String(i + 1) },
          content: "The operator always wants Friday deploys.",
        }),
      ),
    );
    const roots = independentEvidence(reflections);
    expect(roots).toHaveLength(0);

    const assessment = assessLesson(reflections);
    expect(assessment.status).toBe("provisional");
    expect(assessment.independentSources).toBe(0);
    expect(assessment.requiresValidation).toBe(true);
  });

  test("an unsupported lesson stays provisional until independent verified evidence exists", () => {
    const onlyClaims = [
      parseContinuityEnvelope(envelope({ kind: "claim", epistemic: "asserted", source: { kind: "session-turn", id: "t1", version: "1" } })),
      parseContinuityEnvelope(envelope({ kind: "claim", epistemic: "asserted", source: { kind: "session-turn", id: "t2", version: "1" } })),
    ];
    expect(assessLesson(onlyClaims).status).toBe("provisional");

    const withOutcome = [
      ...onlyClaims,
      parseContinuityEnvelope(
        envelope({ kind: "verified_outcome", epistemic: "verified", source: { kind: "task-run", id: "run-8", version: "1" } }),
      ),
    ];
    const supported = assessLesson(withOutcome);
    expect(supported.status).toBe("supported");
    expect(supported.independentSources).toBe(3);
    expect(supported.requiresValidation).toBe(true);
  });

  test("a subagent record keeps the parent run so authority stays with the parent", () => {
    const parsed: ContinuityEnvelopeV1 = parseContinuityEnvelope(
      envelope({ actor: "subagent:researcher", parentRunId: "run-1", runId: "run-1.sub.1" }),
    );
    expect(parsed.parentRunId).toBe("run-1");
    expect(parsed.actor).toBe("subagent:researcher");
  });
});
