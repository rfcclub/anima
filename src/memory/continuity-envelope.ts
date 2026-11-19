/**
 * Versioned continuity envelope (anima #1, Phase B).
 *
 * One shape for every captured continuity signal — session turns, tool events,
 * explicit corrections, review feedback, task outcomes and dream reflections —
 * so that canonical storage, Hindsight delivery and consolidation all agree on
 * identity, provenance and epistemic status.
 *
 * Types plus pure functions only: no I/O, no store, no network. Persistence lives
 * in `continuity-ledger.ts`, which imports this module.
 */

import { createHash } from "node:crypto";
import type { MemoryScope } from "./contract";

export const CONTINUITY_ENVELOPE_VERSION = 1;

/**
 * Who may see a record. Records are visible to their identity only unless a
 * stricter or explicitly published scope is declared; there is no implicit
 * colony-wide value, so `"colony"` and unknown strings are rejected.
 */
export const CONTINUITY_VISIBILITIES = ["identity", "private", "heartwood", "shared"] as const;
export type ContinuityVisibility = (typeof CONTINUITY_VISIBILITIES)[number];

/**
 * What a record is. Observations, claims, reflections and decisions carry
 * different authority: only `verified_outcome` asserts that something was
 * actually observed to work.
 */
export const CONTINUITY_RECORD_KINDS = [
  "observation",
  "claim",
  "correction",
  "reflection",
  "decision",
  "feedback",
  "commitment",
  "verified_outcome",
] as const;
export type ContinuityRecordKind = (typeof CONTINUITY_RECORD_KINDS)[number];

/**
 * Epistemic status, deliberately separate from record kind:
 * - `asserted`: a participant said it; nobody checked it.
 * - `derived`: produced from other records (dream prose, Hindsight reflect).
 * - `verified`: checked against an independent outcome or source.
 * - `superseded`: was asserted, later replaced by a newer valid decision.
 */
export const CONTINUITY_EPISTEMIC_STATUSES = ["asserted", "derived", "verified", "superseded"] as const;
export type ContinuityEpistemicStatus = (typeof CONTINUITY_EPISTEMIC_STATUSES)[number];

export interface ContinuitySourceRef {
  /** What produced the record, e.g. `session-turn`, `tool-event`, `dream-lucid`. */
  kind: string;
  /** Stable id inside that kind. Required: unattributed events cannot be reconciled. */
  id: string;
  /** Version of the source content; a change bumps it so retries and updates differ. */
  version: string;
}

export interface ContinuityEnvelopeV1 {
  version: typeof CONTINUITY_ENVELOPE_VERSION;
  /** Identity whose continuity this record belongs to. */
  identity: string;
  /** Speaker/actor: `operator`, `agent:<name>`, `subagent:<name>`, `tool:<name>`. */
  actor: string;
  visibility: ContinuityVisibility;
  source: ContinuitySourceRef;
  sessionId?: string;
  runId?: string;
  /** Parent run for subagent output: authority stays with the parent run. */
  parentRunId?: string;
  eventTime: string;
  ingestedAt: string;
  kind: ContinuityRecordKind;
  epistemic: ContinuityEpistemicStatus;
  /** Canonical records this one was derived from; empty for primaries. */
  parents: string[];
  scope: MemoryScope;
  content: string;
  /** Stable subject key, e.g. `deploy-window`, for supersession and contradiction checks. */
  subject?: string;
  /** ISO time after which this record no longer belongs in current context. */
  expiresAt?: string;
  /** Stable, retry-safe key derived from identity + kind + source. */
  idempotencyKey: string;
}

export class ContinuityEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuityEnvelopeError";
  }
}

const NON_EMPTY = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function requireIsoTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ContinuityEnvelopeError(`${field} must be an ISO-8601 timestamp`);
  }
  return value;
}

function requireSourceRef(value: unknown): ContinuitySourceRef {
  const ref = value as Partial<ContinuitySourceRef> | undefined;
  if (!ref || typeof ref !== "object") throw new ContinuityEnvelopeError("source is required");
  if (!NON_EMPTY(ref.kind)) throw new ContinuityEnvelopeError("source.kind is required");
  if (!NON_EMPTY(ref.id)) throw new ContinuityEnvelopeError("source.id is required");
  if (!NON_EMPTY(ref.version)) throw new ContinuityEnvelopeError("source.version is required");
  return { kind: ref.kind, id: ref.id, version: ref.version };
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ContinuityEnvelopeError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Stable hash of the fields that identify one source revision of one event. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * A retry with the same key must not create a second record, and a changed
 * source version must produce a different key so an update is not swallowed as
 * a duplicate. Falls back to no randomness at all: determinism is the point.
 */
export function deriveIdempotencyKey(input: {
  kind: ContinuityRecordKind;
  identity: string;
  source: ContinuitySourceRef;
}): string {
  return `ck:${sha256Hex([input.identity, input.kind, input.source.kind, input.source.id, input.source.version].join("\u0000"))}`;
}

/**
 * Whitespace-insensitive fingerprint of the content. Numbers, dates, negation
 * and case are preserved: two records that differ in any of those are not
 * duplicates, and no stemming or synonym folding happens here.
 */
export function contentFingerprint(content: string): string {
  return sha256Hex(content.replace(/\s+/g, " ").trim());
}

const MEMORY_SCOPES: readonly MemoryScope[] = [
  "episode", "fact", "observation", "scent", "preference", "private", "scar", "decision",
  "project", "heartwood", "growth_ring", "canopy", "identity", "narrative", "behavior",
  "skill", "relationship",
];

/**
 * Validates an untrusted envelope. Unknown versions and missing actor/provenance
 * are refused rather than guessed; the caller stores nothing on a throw.
 */
export function parseContinuityEnvelope(raw: unknown): ContinuityEnvelopeV1 {
  const input = raw as Partial<ContinuityEnvelopeV1> | undefined;
  if (!input || typeof input !== "object") throw new ContinuityEnvelopeError("envelope must be an object");
  if (input.version !== CONTINUITY_ENVELOPE_VERSION) {
    throw new ContinuityEnvelopeError(`unsupported envelope version: ${String(input.version)}`);
  }
  if (!NON_EMPTY(input.identity)) throw new ContinuityEnvelopeError("identity is required");
  if (!NON_EMPTY(input.actor)) throw new ContinuityEnvelopeError("actor is required");
  if (!NON_EMPTY(input.content)) throw new ContinuityEnvelopeError("content is required");

  const kind = requireOneOf(input.kind, CONTINUITY_RECORD_KINDS, "kind");
  const source = requireSourceRef(input.source);
  const visibility = requireOneOf(input.visibility, CONTINUITY_VISIBILITIES, "visibility");
  const epistemic = requireOneOf(input.epistemic, CONTINUITY_EPISTEMIC_STATUSES, "epistemic");
  const scope = requireOneOf(input.scope, MEMORY_SCOPES, "scope");

  const parents = input.parents ?? [];
  if (!Array.isArray(parents) || parents.some((p) => !NON_EMPTY(p))) {
    throw new ContinuityEnvelopeError("parents must be an array of non-empty ids");
  }

  const envelope: ContinuityEnvelopeV1 = {
    version: CONTINUITY_ENVELOPE_VERSION,
    identity: input.identity,
    actor: input.actor,
    visibility,
    source,
    eventTime: requireIsoTime(input.eventTime, "eventTime"),
    ingestedAt: requireIsoTime(input.ingestedAt, "ingestedAt"),
    kind,
    epistemic,
    parents: [...parents],
    scope,
    content: input.content,
    idempotencyKey: deriveIdempotencyKey({ kind, identity: input.identity, source }),
  };

  if (NON_EMPTY(input.sessionId)) envelope.sessionId = input.sessionId;
  if (NON_EMPTY(input.runId)) envelope.runId = input.runId;
  if (NON_EMPTY(input.parentRunId)) envelope.parentRunId = input.parentRunId;
  if (NON_EMPTY(input.subject)) envelope.subject = input.subject;
  if (input.expiresAt !== undefined) envelope.expiresAt = requireIsoTime(input.expiresAt, "expiresAt");

  // An expiry that is not after the event it expires is a caller bug, not advice.
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= Date.parse(envelope.eventTime)) {
    throw new ContinuityEnvelopeError("expiresAt must be after eventTime");
  }

  return envelope;
}

export interface CoalescedContinuityRecord extends ContinuityEnvelopeV1 {
  /** Identity of the canonical event this record coalesced into. */
  recordKey: string;
}

/**
 * Observable content of one record, used to decide whether two records that
 * claim the same identity are really the same event. Exported so a durable
 * ledger can make the same decision across restarts instead of re-deriving it.
 */
export function recordSignature(record: ContinuityEnvelopeV1): string {
  return JSON.stringify([
    contentFingerprint(record.content),
    record.eventTime,
    record.actor,
    record.visibility,
    record.scope,
    record.epistemic,
    record.expiresAt ?? null,
    record.parents,
  ]);
}

/** Record key for a second, distinct observation that reuses an idempotency key. */
export function collidedRecordKey(idempotencyKey: string, signature: string): string {
  return `${idempotencyKey}#${sha256Hex(signature).slice(0, 12)}`;
}

/**
 * Deterministic exact-duplicate coalescing. Two records coalesce only when they
 * share the derived key *and* carry identical content, event time, actor,
 * visibility, scope and epistemic status. Similar-looking records with changed
 * dates, numbers, negation or outcomes are always kept as distinct events; a
 * semantic merge is a consolidation candidate, never done here.
 */
export function coalesceExactDuplicates(records: ContinuityEnvelopeV1[]): CoalescedContinuityRecord[] {
  const out: CoalescedContinuityRecord[] = [];
  const seen = new Map<string, string>();

  for (const record of records) {
    const signature = recordSignature(record);
    const prior = seen.get(record.idempotencyKey);
    if (prior === signature) continue; // exact duplicate of a canonical record
    // Same derived key but different observable content: keep both, and give the
    // later one a distinct record key instead of silently overwriting.
    const recordKey =
      prior === undefined ? record.idempotencyKey : collidedRecordKey(record.idempotencyKey, signature);
    seen.set(record.idempotencyKey, signature);
    out.push({ ...record, recordKey });
  }

  return out;
}

/** `kind:id` of one source, so repeated versions of one source collapse into one root. */
export function sourceRoot(source: ContinuitySourceRef): string {
  return `${source.kind}:${source.id}`;
}

/**
 * Distinct independent roots behind a set of records.
 *
 * A derived record (dream prose, Hindsight reflect) is not evidence for itself:
 * it contributes only the roots it was derived from, and a record with no
 * parents contributes nothing. Repeating one reflection over one episode many
 * times therefore yields one root at most, never corroboration.
 */
export function independentEvidence(records: ContinuityEnvelopeV1[]): string[] {
  const roots = new Set<string>();
  for (const record of records) {
    if (record.epistemic === "derived") {
      for (const parent of record.parents) roots.add(parent);
      continue;
    }
    roots.add(sourceRoot(record.source));
  }
  return [...roots].sort();
}

export interface LessonAssessment {
  status: "provisional" | "supported";
  independentSources: number;
  /**
   * Learned guidance always needs a bounded validation path before it may act as
   * procedural advice: support is not promotion, and promotion never grants
   * tool permissions.
   */
  requiresValidation: boolean;
}

/**
 * Whether a candidate lesson is corroborated enough to be called supported.
 * Support needs independent roots *and* at least one verified outcome; asserted
 * claims and derived reflections alone stay provisional no matter how many
 * versions were generated.
 */
export function assessLesson(records: ContinuityEnvelopeV1[]): LessonAssessment {
  const independentSources = independentEvidence(records).length;
  const verified = records.some((record) => record.epistemic === "verified" && record.kind !== "reflection");
  return {
    status: verified && independentSources >= 2 ? "supported" : "provisional",
    independentSources,
    requiresValidation: true,
  };
}
