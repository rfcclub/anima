import type { ActivationCandidate, SuppressionReason } from "./activation-candidate";
import type { ActivationBudget, BudgetGrant } from "./activation-budget";
import type { ActivationStore } from "./activation-store";
import type { ActivationExecutor, ExecutionResult } from "./activation-executor";

export interface ActivationBrokerOptions {
  armTimer(at: number | null): void;
  mode?: "off" | "shadow" | "gate" | "enforce";
  onSuppressed?(event: { candidate: ActivationCandidate; reason: SuppressionReason; now: number }): void | Promise<void>;
  onLeased?(claim: Extract<ClaimedActivation, { ok: true }>): void | Promise<void>;
  onCompleted?(claim: Extract<ClaimedActivation, { ok: true }>, effectRef: string): void | Promise<void>;
  onReleased?(input: { candidate: ActivationCandidate; leaseId: string; reason: "agent-budget" | "colony-budget"; now: number }): void | Promise<void>;
  sources?: readonly ActivationCandidateSource[];
  quietUntil?(now: number): number | null;
  criticalUrgency?: number;
  store?: ActivationStore;
  budget?: ActivationBudget;
  executor?: ActivationExecutor;
}

export interface ActivationCandidateSource {
  candidates(agentId?: string): readonly ActivationCandidate[];
}

export type ClaimedActivation = { ok: true; candidate: ActivationCandidate; leaseId: string; grant: BudgetGrant } | { ok: false; reason: "empty" | "already-leased" | "agent-budget" | "colony-budget" | "not-configured" };
export type ActivationRun = (claim: Extract<ClaimedActivation, { ok: true }>) => Promise<string>;

/** Provider-free due queue; lease/budget execution is added by the composition root. */
export class ActivationBroker {
  private readonly candidates = new Map<string, ActivationCandidate>();
  private readonly suppressionExpiry = new Map<string, number>();
  private readonly pendingWakes = new Set<string>();
  private readonly serviceCount = new Map<string, number>();
  private armedAt: number | null = null;

  constructor(private readonly options: ActivationBrokerOptions) {}

  enqueue(candidate: ActivationCandidate): void {
    const key = candidate.key;
    if (!key) throw new Error("candidate key is required");
    const previous = this.candidates.get(key);
    if (!previous || candidate.sourceVersion >= previous.sourceVersion) this.candidates.set(key, candidate);
    this.rearm();
    this.persistStatus();
  }

  wakeAgent(agentId: string): void {
    this.pendingWakes.add(agentId);
  }

  /** Batches same-agent source notifications into one provider-free evaluation. */
  flushWakes(): number {
    const agents = [...this.pendingWakes];
    this.pendingWakes.clear();
    for (const agentId of agents) {
      for (const [key, candidate] of this.candidates) {
        if (candidate.agentId === agentId) this.candidates.delete(key);
      }
      for (const source of this.options.sources ?? []) {
        for (const candidate of source.candidates(agentId)) {
          const key = candidate.key;
          if (!key) throw new Error("candidate key is required");
          const previous = this.candidates.get(key);
          if (!previous || candidate.sourceVersion >= previous.sourceVersion) this.candidates.set(key, candidate);
        }
      }
    }
    if (agents.length > 0) this.rearm();
    return agents.length;
  }
  nextDueAt(): number | null { return this.earliest()?.dueAt ?? null; }
  pendingCount(): number { return this.candidates.size; }

  /** Bounded operator view; deliberately excludes candidate summaries/content. */
  status(now: number): { nextDueAt: number | null; pendingCount: number; dueCount: number; suppressedByReason: Record<string, number> } {
    const suppressedByReason: Record<string, number> = {};
    for (const [key, expiresAt] of this.suppressionExpiry) {
      if (expiresAt <= now) continue;
      const reason = key.slice(key.lastIndexOf(":") + 1);
      suppressedByReason[reason] = (suppressedByReason[reason] ?? 0) + 1;
    }
    return {
      nextDueAt: this.nextDueAt(),
      pendingCount: this.pendingCount(),
      dueCount: [...this.candidates.values()].filter((candidate) => candidate.dueAt <= now).length,
      suppressedByReason,
    };
  }

  /** Emits at most one matching suppression audit record per bounded window. */
  async recordSuppression(candidate: ActivationCandidate, reason: SuppressionReason, now: number, windowMs: number): Promise<boolean> {
    if (!candidate.key) throw new Error("candidate key is required");
    if (windowMs <= 0) throw new Error("suppression window must be positive");
    const dedupeKey = `${candidate.key}:${reason}`;
    const expiresAt = this.suppressionExpiry.get(dedupeKey) ?? 0;
    if (expiresAt > now) return false;
    this.suppressionExpiry.set(dedupeKey, now + windowMs);
    this.persistStatus(now);
    await this.options.onSuppressed?.({ candidate, reason, now });
    return true;
  }

  /** Reconstructs the ephemeral queue from the authoritative source adapters. */
  rebuildFromSources(sources: readonly ActivationCandidateSource[]): number {
    this.candidates.clear();
    for (const source of sources) {
      for (const candidate of source.candidates()) {
        const key = candidate.key;
        if (!key) throw new Error("candidate key is required");
        const previous = this.candidates.get(key);
        if (!previous || candidate.sourceVersion >= previous.sourceVersion) this.candidates.set(key, candidate);
      }
    }
    this.rearm();
    return this.candidates.size;
  }

  /**
   * Removes a candidate from the queue without claiming it, for a caller
   * that claims out-of-band (TickRunner's own enqueue+claimCandidate,
   * outside the central dispatch loop). A failed claim otherwise leaves the
   * candidate queued for retry (correct for mesh's own dispatchNext() flow)
   * — but an out-of-band caller that gives up must discard it itself, or the
   * central timer will eventually hand it to a dispatcher that doesn't know
   * how to execute it. An unknown key means it was already claimed or never
   * existed — both are no-ops with no state to change, not an error case.
   */
  discard(candidateKey: string): void {
    if (!this.candidates.delete(candidateKey)) return;
    this.rearm();
  }

  claimNext(now: number): ClaimedActivation {
    if (!this.options.store || !this.options.budget) return { ok: false, reason: "not-configured" };
    const candidate = this.nextEligible(now);
    if (!candidate) return { ok: false, reason: "empty" };
    return this.claim(candidate, now);
  }

  /** Claims one known durable occurrence, never an unrelated queue entry. */
  claimCandidate(candidateKey: string, now: number): ClaimedActivation {
    if (!this.options.store || !this.options.budget) return { ok: false, reason: "not-configured" };
    const candidate = this.candidates.get(candidateKey);
    if (!candidate || candidate.dueAt > now) return { ok: false, reason: "empty" };
    return this.claim(candidate, now);
  }

  private claim(candidate: ActivationCandidate, now: number): ClaimedActivation {
    const store = this.options.store;
    const budget = this.options.budget;
    if (!store || !budget) return { ok: false, reason: "not-configured" };
    const quietUntil = this.options.quietUntil?.(now);
    if (quietUntil && quietUntil > now && candidate.urgency < (this.options.criticalUrgency ?? 8)) {
      this.candidates.set(candidate.key!, { ...candidate, dueAt: quietUntil });
      this.rearm();
      return { ok: false, reason: "empty" };
    }
    const leaseId = crypto.randomUUID();
    const lease = store.acquireLease({
      id: leaseId, candidateKey: candidate.key!, agentId: candidate.agentId, executor: candidate.executor,
      costClass: candidate.costClass, now, expiresAt: now + 5 * 60_000,
    });
    if (!lease.ok) return lease;
    const reservation = budget.reserve({ leaseId, agentId: candidate.agentId, executor: candidate.executor, costClass: candidate.costClass, now });
    if (!reservation.ok) {
      store.releaseLease(leaseId, now);
      void this.options.onReleased?.({ candidate, leaseId, reason: reservation.reason, now });
      return reservation;
    }
    this.candidates.delete(candidate.key!);
    const count = this.options.store
      ? this.options.store.recordService(candidate.agentId, now)
      : this.serviceCountFor(candidate.agentId) + 1;
    this.serviceCount.set(candidate.agentId, count);
    this.rearm();
    const claimed = { ok: true as const, candidate, leaseId, grant: reservation.grant };
    void this.options.onLeased?.(claimed);
    return claimed;
  }

  async dispatchNext(now: number, run: ActivationRun): Promise<ExecutionResult | { ok: false; reason: Exclude<ClaimedActivation, { ok: true }> extends never ? never : string }> {
    const claimed = this.claimNext(now);
    return this.dispatchClaimed(claimed, now, run);
  }

  async dispatchCandidate(candidateKey: string, now: number, run: ActivationRun): Promise<ExecutionResult | { ok: false; reason: Exclude<ClaimedActivation, { ok: true }> extends never ? never : string }> {
    const claimed = this.claimCandidate(candidateKey, now);
    return this.dispatchClaimed(claimed, now, run);
  }

  private async dispatchClaimed(claimed: ClaimedActivation, now: number, run: ActivationRun): Promise<ExecutionResult | { ok: false; reason: Exclude<ClaimedActivation, { ok: true }> extends never ? never : string }> {
    if (!claimed.ok) return claimed;
    if (!this.options.executor) {
      this.options.store?.releaseLease(claimed.leaseId, now);
      return { ok: false, reason: "not-configured" };
    }
    let result: ExecutionResult;
    try {
      result = await this.options.executor.execute({
        leaseId: claimed.leaseId, candidateKey: claimed.candidate.key!, reasonRef: claimed.candidate.reasonRef,
        agentId: claimed.candidate.agentId, executor: claimed.candidate.executor, grant: claimed.grant, now,
        run: () => run(claimed),
      });
    } catch (error) {
      // A throwing run must not strand its lease until the expiry sweep.
      this.options.store?.releaseLease(claimed.leaseId, now);
      throw error;
    }
    if (result.ok) {
      this.options.store?.completeLease(claimed.leaseId, now);
      this.persistStatus(now);
      void this.options.onCompleted?.(claimed, result.effectRef);
    } else {
      // A failed pre-effect execution must not strand the lease or its
      // reservation until the five-minute expiry sweep.
      this.options.store?.releaseLease(claimed.leaseId, now);
    }
    return result;
  }

  private earliest(): ActivationCandidate | undefined {
    return [...this.candidates.values()].sort((a, b) => a.dueAt - b.dueAt || a.key!.localeCompare(b.key!))[0];
  }

  /** Priority bands lead; least-served agent wins deterministically inside a band. */
  private nextEligible(now: number): ActivationCandidate | undefined {
    const due = [...this.candidates.values()].filter((candidate) => candidate.dueAt <= now);
    if (due.length === 0) return undefined;
    const highestUrgency = Math.max(...due.map((candidate) => candidate.urgency));
    const band = due.filter((candidate) => candidate.urgency === highestUrgency);
    const leastService = Math.min(...band.map((candidate) => this.serviceCountFor(candidate.agentId)));
    return band
      .filter((candidate) => this.serviceCountFor(candidate.agentId) === leastService)
      .sort((a, b) => a.dueAt - b.dueAt || a.key!.localeCompare(b.key!))[0];
  }

  private serviceCountFor(agentId: string): number {
    const cached = this.serviceCount.get(agentId);
    if (cached !== undefined) return cached;
    const stored = this.options.store?.getServiceCount(agentId) ?? 0;
    this.serviceCount.set(agentId, stored);
    return stored;
  }

  private rearm(): void {
    const next = this.nextDueAt();
    if (next === this.armedAt) return;
    this.armedAt = next;
    this.options.armTimer(next);
  }

  private persistStatus(now = Date.now()): void {
    this.options.store?.setBrokerStatus({ mode: this.options.mode ?? "off", ...this.status(now), now });
  }
}
