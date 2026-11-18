import type { MeshDelivery } from "colony-mesh";
import type { ActivationCandidate } from "./activation-candidate";
import type { ActivationBroker, ClaimedActivation } from "./activation-broker";
import type { BudgetGrant } from "./activation-budget";
import type { ExecutionResult } from "./activation-executor";
import type { ActivationStore, AttentionItem, MeshSource } from "./activation-store";
import { AttentionCandidateSource } from "./candidate-sources";
import { MeshIngress, type A2AInboxRequest, type MeshIngressOutcome } from "./mesh-ingress";

type DispatchResult = ExecutionResult | { ok: false; reason: string };

const MESH_EXECUTOR = "mesh-session";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * 60_000;

export interface MeshSessionInput {
  candidate: ActivationCandidate;
  grant: BudgetGrant;
  /** The whole original request; absent for items projected before request sources were kept. */
  source?: MeshSource;
  /** Aborted when the attempt times out; a late result must not reply. */
  signal: AbortSignal;
}

export interface MeshFailureInput {
  candidate: ActivationCandidate;
  source?: MeshSource;
  error: unknown;
  attempts: number;
  /** True when no retry follows: the last attempt failed, or the attempt timed out. */
  final: boolean;
  timedOut: boolean;
}

export interface MeshActivationRuntimeOptions {
  store: ActivationStore;
  broker: ActivationBroker;
  now(): number;
  executeSession(input: MeshSessionInput): Promise<string>;
  onFailed?(input: MeshFailureInput): void | Promise<void>;
  onAttentionProjected?(item: AttentionItem): void;
  onAttentionStateChanged?(item: AttentionItem): void;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** A timed-out attempt is final, so a hung turn and its retry never run together. */
  attemptTimeoutMs?: number;
}

class AttentionMissingError extends Error {}
class MeshAttemptTimeout extends Error {}

/**
 * The Castle-only mesh composition boundary. Raw delivery ingestion is
 * provider-free; a session is reachable only through a broker lease/grant.
 */
export class MeshActivationRuntime {
  private readonly source: AttentionCandidateSource;
  private readonly ingress: MeshIngress;
  /** Attempt counts for items with no kept source (projected before request sources were kept). */
  private readonly sourcelessAttempts = new Map<string, number>();

  constructor(private readonly options: MeshActivationRuntimeOptions) {
    this.source = new AttentionCandidateSource(options.store);
    this.ingress = new MeshIngress({
      retain: (source) => options.store.retainMeshSource(source),
      project: (input) => options.store.projectAttention(input),
      projected: (item) => options.onAttentionProjected?.(item),
      wake: (agentId, sourceRef) => {
        const candidate = this.source.candidates(agentId).find((item) => item.sourceRef === sourceRef);
        if (candidate) options.broker.enqueue(candidate);
      },
    });
  }

  ingest(agentId: string, delivery: MeshDelivery): MeshIngressOutcome {
    return this.ingress.ingest(agentId, delivery);
  }

  /** An item from the agent's A2A inbox. */
  ingestA2A(agentId: string, request: A2AInboxRequest): MeshIngressOutcome {
    return this.ingress.ingestA2A(agentId, request, this.options.now());
  }

  /** Provider-free restart sweep: recover lifecycle first, then rebuild the queue. */
  recover(): number {
    const now = this.options.now();
    // Only the server process opens this store, so an active session lease at boot is an orphan.
    this.options.store.releaseActiveLeases(MESH_EXECUTOR, now);
    this.options.store.releaseExpiredLeases(now);
    this.options.store.recoverClaimedAttention(now);
    const candidates = this.source.candidates();
    for (const candidate of candidates) this.options.broker.enqueue(candidate);
    return candidates.length;
  }

  async dispatch(agentId: string, sourceRef: string): Promise<DispatchResult> {
    const candidate = this.source.candidates(agentId).find((item) => item.sourceRef === sourceRef && item.executor === MESH_EXECUTOR);
    if (!candidate?.key || !this.attentionFor(agentId, sourceRef)) return { ok: false, reason: "empty" };
    let result: DispatchResult;
    try {
      result = await this.options.broker.dispatchCandidate(candidate.key, this.options.now(), (claim) => this.executeClaim(claim));
    } catch (error) {
      return this.handleFailure(candidate, error);
    }
    if (result.ok) this.resolveAttention(agentId, sourceRef);
    return result;
  }

  /** Runs the earliest due mesh candidate after a broker timer wake. */
  async dispatchNext(): Promise<DispatchResult> {
    let claimedCandidate: ActivationCandidate | undefined;
    let result: DispatchResult;
    try {
      result = await this.options.broker.dispatchNext(this.options.now(), async (claim) => {
        claimedCandidate = claim.candidate;
        return this.executeClaim(claim);
      });
    } catch (error) {
      if (!claimedCandidate || claimedCandidate.executor !== MESH_EXECUTOR) throw error;
      return this.handleFailure(claimedCandidate, error);
    }
    if (result.ok && claimedCandidate) this.resolveAttention(claimedCandidate.agentId, claimedCandidate.sourceRef);
    return result;
  }

  private attentionFor(agentId: string, sourceRef: string): AttentionItem | undefined {
    return this.options.store.openAttention(agentId).find((item) => item.sourceRef === sourceRef);
  }

  private async executeClaim(claim: Extract<ClaimedActivation, { ok: true }>): Promise<string> {
    const attention = this.attentionFor(claim.candidate.agentId, claim.candidate.sourceRef);
    if (!attention) throw new AttentionMissingError("attention disappeared before broker execution");
    const transitioned = this.options.store.transitionAttention(attention.id, attention.version, "claimed", this.options.now());
    if (!transitioned.ok) throw new AttentionMissingError(`attention claim failed: ${transitioned.reason}`);
    this.options.onAttentionStateChanged?.(transitioned.item);
    const { agentId, sourceRef } = claim.candidate;
    if (this.options.store.recordMeshAttempt(agentId, sourceRef) === 0) {
      this.sourcelessAttempts.set(claim.candidate.key!, (this.sourcelessAttempts.get(claim.candidate.key!) ?? 0) + 1);
    }
    const source = this.options.store.getMeshSource(agentId, sourceRef) ?? undefined;
    const controller = new AbortController();
    const timeoutMs = this.options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new MeshAttemptTimeout(`mesh session timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.options.executeSession({ candidate: claim.candidate, grant: claim.grant, source, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Re-queues a failed attempt through the broker, or closes the item and reports the last failure. */
  private async handleFailure(candidate: ActivationCandidate, error: unknown): Promise<DispatchResult> {
    if (error instanceof AttentionMissingError) throw error;
    const now = this.options.now();
    const { agentId, sourceRef } = candidate;
    const source = this.options.store.getMeshSource(agentId, sourceRef) ?? undefined;
    const attempts = source?.attempts ?? this.sourcelessAttempts.get(candidate.key!) ?? 1;
    const timedOut = error instanceof MeshAttemptTimeout;
    const final = timedOut || attempts >= (this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const claimed = this.options.store.getAttentionByOccurrence(agentId, candidate.sourceKind, sourceRef, candidate.occurrenceKey);
    if (claimed?.state === "claimed") {
      if (final) {
        const acted = this.options.store.transitionAttention(claimed.id, claimed.version, "acted", now);
        if (acted.ok) {
          this.options.onAttentionStateChanged?.(acted.item);
          const blocked = this.options.store.transitionAttention(acted.item.id, acted.item.version, "blocked", now);
          if (blocked.ok) this.options.onAttentionStateChanged?.(blocked.item);
        }
        this.sourcelessAttempts.delete(candidate.key!);
      } else {
        const reopened = this.options.store.transitionAttention(claimed.id, claimed.version, "open", now);
        if (reopened.ok) {
          this.options.onAttentionStateChanged?.(reopened.item);
          this.options.broker.enqueue({ ...candidate, dueAt: now + (this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) });
        }
      }
    }
    try {
      await this.options.onFailed?.({ candidate, source, error, attempts, final, timedOut });
    } catch {
      // Reporting a failure must not turn into a second failure of the same attempt.
    }
    return { ok: false, reason: final ? "failed" : "retrying" };
  }

  private resolveAttention(agentId: string, sourceRef: string): void {
    const claimed = this.attentionFor(agentId, sourceRef) ?? this.options.store.getAttentionByOccurrence(agentId, "mesh", sourceRef, sourceRef);
    if (claimed?.state !== "claimed") return;
    const acted = this.options.store.transitionAttention(claimed.id, claimed.version, "acted", this.options.now());
    if (!acted.ok) return;
    this.options.onAttentionStateChanged?.(acted.item);
    const resolved = this.options.store.transitionAttention(acted.item.id, acted.item.version, "resolved", this.options.now());
    if (resolved.ok) this.options.onAttentionStateChanged?.(resolved.item);
  }
}
