import { createGardenEvent, type GardenRuntime } from "../garden/events";
import type { JsonlGardenEventStore } from "../garden/event-store";
import type { ActivationCandidate, SuppressionReason } from "./activation-candidate";

export interface GardenActivationAuditOptions {
  instanceId: string;
  runtime: GardenRuntime;
  project: string;
}

/** Appends bounded, causal broker audit records to the shared Garden stream. */
export class GardenActivationAudit {
  constructor(private readonly store: JsonlGardenEventStore, private readonly options: GardenActivationAuditOptions) {}

  async appendSuppressed(input: { candidate: ActivationCandidate; reason: SuppressionReason; now: number }): Promise<void> {
    const candidate = input.candidate;
    await this.store.append(createGardenEvent({
      id: `activation-suppressed:${candidate.key}:${input.reason}:${input.now}`,
      type: "ACTIVATION_SUPPRESSED",
      timestamp: new Date(input.now).toISOString(),
      agentId: candidate.agentId,
      instanceId: this.options.instanceId,
      runtime: this.options.runtime,
      project: this.options.project,
      payload: {
        candidateKey: candidate.key!,
        sourceRef: candidate.sourceRef,
        reasonRef: candidate.reasonRef,
        occurrenceKey: candidate.occurrenceKey,
        reason: input.reason,
      },
    }));
  }
}
