import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTINUITY_ENVELOPE_VERSION,
  type ContinuityEnvelopeV1,
} from "../../src/memory/continuity-envelope";
import { ContinuityLedger } from "../../src/memory/continuity-ledger";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "continuity-ledger-")), "continuity.db");

const ALL_VISIBILITIES = ["identity", "private", "heartwood", "shared"] as const;

/**
 * Reads are always made by one identity with an explicit visibility allowlist.
 * The ledger has no "read everything" mode: omitting either is a compile error.
 */
const reader = (identity = "pilot") => ({ identity, visibility: ALL_VISIBILITIES });

function envelope(overrides: Partial<ContinuityEnvelopeV1> = {}): ContinuityEnvelopeV1 {
  const base = {
    version: CONTINUITY_ENVELOPE_VERSION,
    identity: "pilot",
    actor: "operator",
    visibility: "identity",
    source: { kind: "session-turn", id: "sess-1:turn-1", version: "1" },
    eventTime: "2026-07-01T10:00:00.000Z",
    ingestedAt: "2026-07-01T10:00:05.000Z",
    kind: "decision",
    epistemic: "asserted",
    parents: [],
    scope: "decision",
    content: "Deploy window is Thursday.",
    subject: "deploy-window",
  } as unknown as ContinuityEnvelopeV1;
  const merged = { ...base, ...overrides } as ContinuityEnvelopeV1;
  return {
    ...merged,
    idempotencyKey:
      overrides.idempotencyKey ??
      `ck:${merged.identity}:${merged.kind}:${merged.source.kind}:${merged.source.id}:${merged.source.version}`,
  };
}

describe("continuity ledger", () => {
  test("commits the canonical record and its outbound delivery work atomically", () => {
    const ledger = new ContinuityLedger(dbPath());
    const result = ledger.commit(envelope());
    expect(result.created).toBe(true);
    expect(result.record.recordKey).toBe(result.record.idempotencyKey);
    expect(ledger.dueDeliveries()).toHaveLength(1);
    ledger.close();
  });

  test("two concurrent retries of one event yield one canonical record and one work item", () => {
    const ledger = new ContinuityLedger(dbPath());
    const first = ledger.commit(envelope());
    const retry = ledger.commit(envelope());
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.record.recordKey).toBe(first.record.recordKey);
    expect(ledger.records()).toHaveLength(1);
    expect(ledger.dueDeliveries()).toHaveLength(1);
    ledger.close();
  });

  test("delivery records the backend id and version, and retrying an unknown outcome reconciles by stable id", () => {
    const ledger = new ContinuityLedger(dbPath());
    const { record } = ledger.commit(envelope());
    const [work] = ledger.dueDeliveries();
    ledger.deliverUnknown(work!.outboxId, "timeout");
    // The same stable document id is retried, and the backend answers with its own id.
    const retried = ledger.dueDeliveries();
    expect(retried.map((w) => w.documentId)).toEqual([record.idempotencyKey]);
    ledger.delivered(retried[0]!.outboxId, { backendId: "hs-doc-9", version: "3" });
    expect(ledger.delivery(record.idempotencyKey)).toMatchObject({
      status: "delivered",
      backendId: "hs-doc-9",
      version: "3",
    });
    expect(ledger.dueDeliveries()).toHaveLength(0);
    ledger.close();
  });

  test("imported Hindsight records are not re-exported, so there is no echo loop", () => {
    const ledger = new ContinuityLedger(dbPath());
    const imported = ledger.commit(
      envelope({
        source: { kind: "hindsight:import", id: "hs-abc", version: "1" },
        parents: ["hs-abc"],
      }),
    );
    expect(imported.record.origin).toBe("hindsight-import");
    expect(imported.delivery).toBeUndefined();
    expect(ledger.dueDeliveries()).toHaveLength(0);
    ledger.close();
  });

  test("a late-arriving old fact does not supersede a newer decision, and the conflict stays visible", () => {
    const ledger = new ContinuityLedger(dbPath());
    ledger.commit(envelope({ content: "Deploy window is Thursday.", eventTime: "2026-07-05T10:00:00.000Z" }));
    ledger.commit(
      envelope({
        content: "Deploy window is Friday.",
        source: { kind: "session-turn", id: "sess-1:turn-4", version: "1" },
        eventTime: "2026-07-02T10:00:00.000Z",
        ingestedAt: "2026-07-06T10:00:00.000Z",
      }),
    );

    const current = ledger.currentForSubject("deploy-window", reader());
    expect(current.map((r) => r.content)).toEqual(["Deploy window is Thursday."]);
    const conflict = ledger.conflicts("deploy-window", reader());
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.unresolved).toBe(true);
    expect(conflict[0]!.recordKeys).toHaveLength(2);
    ledger.close();
  });

  test("explicit supersession hides stale advice but keeps it for an authorized historical query", () => {
    const ledger = new ContinuityLedger(dbPath());
    const old = ledger.commit(envelope({ content: "Use the staging bucket." }));
    const newer = ledger.commit(
      envelope({
        content: "Use the production bucket.",
        source: { kind: "session-turn", id: "sess-1:turn-2", version: "1" },
        eventTime: "2026-07-02T10:00:00.000Z",
        ingestedAt: "2026-07-02T10:00:05.000Z",
      }),
    );
    ledger.supersede(old.record.recordKey, newer.record.recordKey, "operator replaced the decision");

    expect(ledger.currentForSubject("deploy-window", reader()).map((r) => r.content)).toEqual(["Use the production bucket."]);
    expect(ledger.history("deploy-window", reader()).map((r) => r.content)).toEqual([
      "Use the staging bucket.",
      "Use the production bucket.",
    ]);
    ledger.close();
  });

  test("expired guidance leaves current context but stays historically queryable", () => {
    const ledger = new ContinuityLedger(dbPath());
    ledger.commit(
      envelope({
        content: "Freeze deploys during the audit.",
        expiresAt: "2026-07-03T00:00:00.000Z",
      }),
    );
    expect(ledger.currentForSubject("deploy-window", { ...reader(), at: "2026-07-09T00:00:00.000Z" })).toHaveLength(0);
    expect(ledger.history("deploy-window", reader())).toHaveLength(1);
    ledger.close();
  });

  test("another identity's records never appear in a subject read", () => {
    const ledger = new ContinuityLedger(dbPath());
    ledger.commit(envelope({ content: "Pilot's deploy window is Thursday." }));
    ledger.commit(
      envelope({
        identity: "other-agent",
        source: { kind: "session-turn", id: "sess-2:turn-1", version: "1" },
        content: "Other agent's deploy window is Monday.",
      }),
    );

    const pilotView = ledger.currentForSubject("deploy-window", reader("pilot"));
    expect(pilotView.map((r) => r.content)).toEqual(["Pilot's deploy window is Thursday."]);
    expect(ledger.history("deploy-window", reader("pilot")).map((r) => r.identity)).toEqual(["pilot"]);
    expect(
      ledger.conflicts("deploy-window", reader("pilot")).flatMap((c) => c.recordKeys).length,
    ).toBe(0);
    ledger.close();
  });

  test("an empty visibility allowlist returns nothing instead of every row", () => {
    const ledger = new ContinuityLedger(dbPath());
    ledger.commit(envelope({ content: "Pilot's deploy window is Thursday." }));
    expect(ledger.currentForSubject("deploy-window", { identity: "pilot", visibility: [] })).toHaveLength(0);
    expect(ledger.history("deploy-window", { identity: "pilot", visibility: [] })).toHaveLength(0);
    expect(ledger.conflicts("deploy-window", { identity: "pilot", visibility: [] })).toHaveLength(0);
    ledger.close();
  });

  test("a private record never appears in another visibility's read", () => {
    const ledger = new ContinuityLedger(dbPath());
    ledger.commit(
      envelope({ content: "The operator is leaving the project.", visibility: "private", scope: "private" }),
    );
    expect(ledger.currentForSubject("deploy-window", { identity: "pilot", visibility: ["identity"] })).toHaveLength(0);
    expect(ledger.currentForSubject("deploy-window", { identity: "pilot", visibility: ["private"] })).toHaveLength(1);
    ledger.close();
  });

  test("an unacknowledged canonical event survives a crash and is replayed exactly once", () => {
    const path = dbPath();
    const ledger = new ContinuityLedger(path);
    const { record } = ledger.commit(envelope());
    ledger.close();

    const reopened = new ContinuityLedger(path);
    expect(reopened.records().map((r) => r.recordKey)).toEqual([record.recordKey]);
    expect(reopened.dueDeliveries()).toHaveLength(1);
    const replay = reopened.commit(envelope());
    expect(replay.created).toBe(false);
    expect(reopened.records()).toHaveLength(1);
    reopened.close();
  });
});

describe("continuity ledger supersession audit", () => {
  test("the supersession audit row carries no subject, so it never surfaces as current advice", () => {
    const ledger = new ContinuityLedger(dbPath());
    const old = ledger.commit(envelope({ content: "Use the staging bucket." }));
    const newer = ledger.commit(
      envelope({
        content: "Use the production bucket.",
        source: { kind: "session-turn", id: "sess-1:turn-2", version: "1" },
        eventTime: "2026-07-02T10:00:00.000Z",
      }),
    );
    ledger.supersede(old.record.recordKey, newer.record.recordKey, "operator replaced the decision");

    const audit = ledger.recordByKey(`${newer.record.recordKey}:supersedes:${old.record.recordKey}`);
    expect(audit?.subject).toBeUndefined();
    expect(audit?.parents).toEqual([old.record.recordKey, newer.record.recordKey]);
    expect(ledger.currentForSubject("deploy-window", reader()).map((r) => r.content)).toEqual(["Use the production bucket."]);
    ledger.close();
  });

  test("replaying the same supersession after restart is a no-op, not a primary-key crash", () => {
    const path = dbPath();
    const first = new ContinuityLedger(path);
    const old = first.commit(envelope({ content: "Use the staging bucket." }));
    const newer = first.commit(
      envelope({
        content: "Use the production bucket.",
        source: { kind: "session-turn", id: "sess-1:turn-2", version: "1" },
        eventTime: "2026-07-02T10:00:00.000Z",
      }),
    );
    first.supersede(old.record.recordKey, newer.record.recordKey, "operator replaced the decision");
    first.close();

    const reopened = new ContinuityLedger(path);
    expect(() =>
      reopened.supersede(old.record.recordKey, newer.record.recordKey, "operator replaced the decision"),
    ).not.toThrow();
    expect(reopened.history("deploy-window", reader()).map((r) => r.content)).toEqual([
      "Use the staging bucket.",
      "Use the production bucket.",
    ]);
    reopened.close();
  });
});

describe("continuity ledger idempotency collisions", () => {
  test("a changed source version is a new record; a reuse of one key with different content is kept, not lost", () => {
    const ledger = new ContinuityLedger(dbPath());
    const first = ledger.commit(
      envelope({ content: "Freeze starts 2026-07-01.", kind: "feedback", source: { kind: "review", id: "r-1", version: "1" } }),
    );
    const newerVersion = ledger.commit(
      envelope({
        content: "Freeze starts 2026-07-02.",
        kind: "feedback",
        source: { kind: "review", id: "r-1", version: "2" },
      }),
    );
    expect(newerVersion.created).toBe(true);
    expect(newerVersion.record.recordKey).not.toBe(first.record.recordKey);

    // Same derived key, different content: a caller bug must not silently drop the
    // new observation, and it must not crash the commit either.
    const conflicting = ledger.commit(
      envelope({ content: "Freeze starts 2026-07-03.", kind: "feedback", source: { kind: "review", id: "r-1", version: "1" } }),
    );
    expect(conflicting.created).toBe(true);
    expect(conflicting.record.recordKey).not.toBe(first.record.recordKey);
    expect(conflicting.record.content).toBe("Freeze starts 2026-07-03.");
    expect(ledger.records()).toHaveLength(3);
    // The original stays intact and still owns its key.
    expect(ledger.recordByKey(first.record.recordKey)?.content).toBe("Freeze starts 2026-07-01.");
    // Each canonical record gets its own stable backend document id, so the second
    // event is not delivered as an update of the first.
    const documents = ledger.dueDeliveries().map((w) => w.documentId);
    expect(documents).toHaveLength(3);
    expect(new Set(documents).size).toBe(3);
    ledger.close();
  });
});
