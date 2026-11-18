import type { BudgetGrant } from "./activation-budget";
import type { ActivationStore } from "./activation-store";

export type ExecutionResult = { ok: true; effectRef: string; replayed: boolean } | { ok: false; reason: "missing-reason" | "invalid-grant" | "precondition-unavailable" };

export interface ExecutionInput {
  leaseId: string;
  candidateKey: string;
  reasonRef: string;
  agentId: string;
  executor: string;
  grant: BudgetGrant | undefined;
  now: number;
  requiredPlace?: string;
  currentPlace?(): string | undefined;
  moveTo?(input: { to: string; reasonRef: string; candidateKey: string; leaseId: string }): Promise<void>;
  requiredParticipants?: readonly string[];
  participantsAvailable?(): ReadonlySet<string>;
  coordinateParticipants?(participants: readonly string[], causal: { reasonRef: string; candidateKey: string; leaseId: string }): Promise<boolean>;
  run(): Promise<string>;
}

/** Enforces causal identity before a domain seam is invoked. */
export class ActivationExecutor {
  private readonly effects = new Map<string, string>();

  constructor(private readonly store?: ActivationStore) {}

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    if (!input.reasonRef.trim()) return { ok: false, reason: "missing-reason" };
    if (!input.grant || input.grant.leaseId !== input.leaseId || input.grant.agentId !== input.agentId || input.grant.executor !== input.executor || input.grant.expiresAt <= input.now) {
      return { ok: false, reason: "invalid-grant" };
    }
    const idempotencyKey = `${input.leaseId}:${input.candidateKey}`;
    const recorded = this.store?.getActivationEffect(input.leaseId, input.candidateKey) ?? this.effects.get(idempotencyKey);
    if (recorded) return { ok: true, effectRef: recorded, replayed: true };
    if (input.requiredPlace && input.currentPlace?.() !== input.requiredPlace) {
      if (!input.moveTo) return { ok: false, reason: "precondition-unavailable" };
      await input.moveTo({
        to: input.requiredPlace,
        reasonRef: input.reasonRef,
        candidateKey: input.candidateKey,
        leaseId: input.leaseId,
      });
    }
    const missingParticipants = input.requiredParticipants?.filter((id) => !input.participantsAvailable?.().has(id)) ?? [];
    if (missingParticipants.length > 0) {
      const coordinated = await input.coordinateParticipants?.(missingParticipants, {
        reasonRef: input.reasonRef,
        candidateKey: input.candidateKey,
        leaseId: input.leaseId,
      });
      if (!coordinated) return { ok: false, reason: "precondition-unavailable" };
    }
    const effectRef = await input.run();
    if (!effectRef.trim()) return { ok: false, reason: "precondition-unavailable" };
    this.effects.set(idempotencyKey, effectRef);
    this.store?.recordActivationEffect(input.leaseId, input.candidateKey, effectRef);
    return { ok: true, effectRef, replayed: false };
  }
}
