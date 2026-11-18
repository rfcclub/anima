import { buildCandidate, type ActivationCandidate } from "./activation-candidate";
import type { ActivationStore, StoredStewardship } from "./activation-store";

/** Exposes durable open attention as ephemeral broker candidates. */
export class AttentionCandidateSource {
  constructor(private readonly store: ActivationStore) {}

  candidates(agentId?: string): ActivationCandidate[] {
    return this.store.openAttention(agentId).map((item) => buildCandidate({
      agentId: item.agentId,
      sourceKind: item.sourceKind,
      sourceRef: item.sourceRef,
      occurrenceKey: item.occurrenceKey,
      sourceVersion: item.version,
      dueAt: item.dueAt,
      expiresAt: item.expiresAt,
      state: item.state,
      urgency: item.urgency,
      costClass: "T1",
      executor: item.sourceKind === "mesh" ? "mesh-session" : "reflection",
      summary: item.summary,
      reasonRef: item.sourceRef,
    }));
  }
}

interface Commitment {
  id: string;
  agentId: string;
  sourceRef: string;
  authorityRef: string;
  description: string;
  acceptedAt: number;
  nextReviewAt: number;
  dueAt?: number;
  resolvedAt?: number;
}

export class CommitmentCandidateSource {
  private readonly commitments = new Map<string, Commitment>();

  constructor(private readonly store?: ActivationStore) {}

  add(input: Commitment): { ok: true } | { ok: false; reason: "untrusted" } {
    if (!input.authorityRef.trim()) return { ok: false, reason: "untrusted" };
    this.commitments.set(input.id, input);
    this.store?.upsertCommitment(input);
    return { ok: true };
  }

  dueCandidates(now: number): ActivationCandidate[] {
    const commitments = this.store ? this.store.dueCommitments(now) : [...this.commitments.values()];
    return commitments
      .filter((item) => (!("resolvedAt" in item) || !item.resolvedAt) && item.nextReviewAt <= now)
      .map((item) => buildCandidate({
        agentId: item.agentId, sourceKind: "commitment", sourceRef: item.sourceRef, occurrenceKey: `review:${item.nextReviewAt}`,
        sourceVersion: 1, dueAt: item.dueAt ?? item.nextReviewAt, urgency: item.dueAt && item.dueAt <= now ? 8 : 4,
        costClass: "T1", executor: "reflection", summary: item.description, reasonRef: item.sourceRef,
      }));
  }
}

/** A scheduled responsibility only opens a review opportunity; it never invents work. */
export class StewardshipCandidateSource {
  private readonly stewardships = new Map<string, StoredStewardship>();

  constructor(private readonly store?: ActivationStore) {}

  add(input: StoredStewardship): void {
    if (!input.scopeRef.trim() || !input.responsibility.trim() || input.cadenceMs <= 0) {
      throw new Error("stewardship requires scope, responsibility, and positive cadence");
    }
    this.stewardships.set(`${input.agentId}:${input.scopeRef}`, input);
    this.store?.upsertStewardship(input);
  }

  dueCandidates(now: number): ActivationCandidate[] {
    const stewardships = this.store ? this.store.dueStewardships(now) : [...this.stewardships.values()].filter((item) => item.enabled !== false && item.nextReviewAt <= now);
    return stewardships.map((item) => buildCandidate({
      agentId: item.agentId,
      sourceKind: "stewardship",
      sourceRef: item.scopeRef,
      occurrenceKey: `review:${item.nextReviewAt}`,
      sourceVersion: item.nextReviewAt,
      dueAt: item.nextReviewAt,
      urgency: 2,
      costClass: "T0",
      executor: "stewardship-review",
      summary: item.responsibility,
      reasonRef: item.id,
    }));
  }

  recordReview(candidate: ActivationCandidate, reviewedAt: number, result: "no-action" | "action"): { ok: true } | { ok: false; reason: "not-due" } {
    if (candidate.sourceKind !== "stewardship" || result !== "no-action") return { ok: false, reason: "not-due" };
    const expectedReviewAt = Number(candidate.occurrenceKey.slice("review:".length));
    if (!Number.isFinite(expectedReviewAt)) return { ok: false, reason: "not-due" };
    if (this.store) return this.store.recordStewardshipReview(candidate.agentId, candidate.sourceRef, expectedReviewAt, reviewedAt) ? { ok: true } : { ok: false, reason: "not-due" };
    const key = `${candidate.agentId}:${candidate.sourceRef}`;
    const stewardship = this.stewardships.get(key);
    if (!stewardship || stewardship.nextReviewAt !== expectedReviewAt) return { ok: false, reason: "not-due" };
    this.stewardships.set(key, { ...stewardship, lastReviewAt: reviewedAt, nextReviewAt: stewardship.nextReviewAt + stewardship.cadenceMs });
    return { ok: true };
  }
}

export interface CanonicalWorkItem {
  id: string;
  agentId: string;
  ref: string;
  title: string;
  status: string;
  updatedAt: number;
}

/** Read-only adapter: the canonical work store remains the sole lifecycle owner. */
export class WorkCandidateSource {
  constructor(private readonly readWorkItems?: () => readonly CanonicalWorkItem[]) {}

  candidates(): ActivationCandidate[] {
    if (!this.readWorkItems) return [];
    const eligible = new Set(["claimed", "active", "open", "blocked"]);
    return this.readWorkItems()
      .filter((item) => eligible.has(item.status))
      .map((item) => buildCandidate({
        agentId: item.agentId,
        sourceKind: "work",
        sourceRef: `work:${item.id}`,
        occurrenceKey: `work:${item.id}:${item.updatedAt}`,
        sourceVersion: item.updatedAt,
        dueAt: item.updatedAt,
        urgency: item.status === "blocked" ? 7 : 5,
        costClass: "T2",
        executor: "heavy-work",
        summary: item.title,
        reasonRef: `work:${item.id}`,
        requiredPlace: "workshop",
      }));
  }
}

export interface CandidateSourceGardenEvent {
  type: string;
  payload: unknown;
}

/** Only injected, named domain adapters may translate Garden events into work. */
export class GardenEventCandidateSource {
  constructor(private readonly adapters: ReadonlyMap<string, (event: CandidateSourceGardenEvent) => readonly ActivationCandidate[]> = new Map()) {}

  candidatesFromEvents(events: readonly CandidateSourceGardenEvent[]): ActivationCandidate[] {
    return events.flatMap((event) => this.adapters.get(event.type)?.(event) ?? []);
  }
}
