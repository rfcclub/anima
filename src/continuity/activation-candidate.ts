export type ActivationCostClass = "T0" | "T1" | "T2";
export type CandidateState = "open" | "claimed" | "acted" | "resolved" | "blocked" | "expired";
export type SuppressionReason = "terminal" | "expired" | "not-due" | "cooldown" | "dependency" | "already-leased" | "budget";

export interface ActivationCandidate {
  key?: string;
  agentId: string;
  sourceKind: string;
  sourceRef: string;
  occurrenceKey: string;
  sourceVersion: number;
  dueAt: number;
  expiresAt?: number;
  state?: CandidateState;
  urgency: number;
  costClass: ActivationCostClass;
  executor: string;
  summary: string;
  reasonRef: string;
  requiredPlace?: string;
  requiredParticipants?: string[];
}

export interface CandidateGateContext {
  now: number;
  cooldownUntil?: number;
  knownPlaces?: ReadonlySet<string>;
  knownParticipants?: ReadonlySet<string>;
  alreadyLeased?: boolean;
  affordable?: boolean;
}

export function buildCandidate(input: ActivationCandidate): ActivationCandidate {
  return {
    ...input,
    key: input.key ?? `${input.agentId}:${input.sourceKind}:${input.sourceRef}:${input.occurrenceKey}`,
    summary: input.summary.slice(0, 400),
  };
}

export function evaluateCandidate(candidate: ActivationCandidate, context: CandidateGateContext): { eligible: boolean; reason?: SuppressionReason } {
  if (candidate.state === "resolved" || candidate.state === "blocked" || candidate.state === "expired") return { eligible: false, reason: "terminal" };
  if (candidate.expiresAt !== undefined && candidate.expiresAt <= context.now) return { eligible: false, reason: "expired" };
  if (candidate.dueAt > context.now) return { eligible: false, reason: "not-due" };
  if (context.cooldownUntil !== undefined && context.cooldownUntil > context.now) return { eligible: false, reason: "cooldown" };
  if (candidate.requiredPlace && context.knownPlaces && !context.knownPlaces.has(candidate.requiredPlace)) return { eligible: false, reason: "dependency" };
  if (candidate.requiredParticipants && context.knownParticipants && candidate.requiredParticipants.some((id) => !context.knownParticipants!.has(id))) return { eligible: false, reason: "dependency" };
  if (context.alreadyLeased) return { eligible: false, reason: "already-leased" };
  if (context.affordable === false) return { eligible: false, reason: "budget" };
  return { eligible: true };
}

export interface ScoredCandidate { candidate: ActivationCandidate; score: number; breakdown: { urgency: number; deadline: number } }

export function scoreCandidates(candidates: readonly ActivationCandidate[], context: Pick<CandidateGateContext, "now">): ScoredCandidate[] {
  return candidates.map((candidate) => {
    const deadline = Math.max(0, Math.min(100, Math.floor((context.now - candidate.dueAt) / 60_000)));
    return { candidate, score: candidate.urgency * 100 + deadline, breakdown: { urgency: candidate.urgency * 100, deadline } };
  }).sort((a, b) => b.score - a.score || a.candidate.key!.localeCompare(b.candidate.key!));
}
