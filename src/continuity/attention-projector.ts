import { ActivationStore, type AttentionInput, type AttentionItem } from "./activation-store";
import type { GardenEvent } from "../garden/events";

export type AttentionProjectionEvent =
  | { type: "ATTENTION_OPENED"; payload: AttentionInput }
  | { type: "ATTENTION_STATE_CHANGED"; payload: { id: string; state: AttentionItem["state"]; version: number; occurredAt: number } };

/** Projects durable source occurrences; it never invokes a provider. */
export class AttentionProjector {
  constructor(private readonly store: ActivationStore) {}

  projectAttentionSource(input: AttentionInput): AttentionItem {
    return this.store.projectAttention(input);
  }

  reconcileAttention(now: number): string[] {
    return [...this.store.expireOpenAttention(now), ...this.store.recoverClaimedAttention(now)];
  }

  rebuildAttentionFromEvents(events: readonly AttentionProjectionEvent[], target: ActivationStore = this.store): void {
    for (const event of events) {
      if (event.type === "ATTENTION_OPENED") {
        target.projectAttention(event.payload);
        continue;
      }
      const item = target.getAttention(event.payload.id);
      if (!item) throw new Error(`attention state event has no occurrence: ${event.payload.id}`);
      const transition = target.transitionAttention(item.id, item.version, event.payload.state, event.payload.occurredAt);
      if (!transition.ok && transition.reason !== "illegal-transition") {
        throw new Error(`could not rebuild attention transition: ${transition.reason}`);
      }
    }
  }
}

type AttentionEventPayload = AttentionInput & {
  state: AttentionItem["state"];
  version: number;
  occurredAt: number;
};

export interface AttentionRebuildResult {
  projected: number;
  transitioned: number;
  ignored: number;
}

/**
 * Replay the Garden audit stream using occurrence identity, never a
 * process-local SQLite row id. Replaying an already-applied event is harmless.
 */
export function rebuildAttentionFromEvents(store: ActivationStore, events: readonly GardenEvent[]): AttentionRebuildResult {
  const result: AttentionRebuildResult = { projected: 0, transitioned: 0, ignored: 0 };
  for (const event of events) {
    if (event.type !== "ATTENTION_OPENED" && event.type !== "ATTENTION_STATE_CHANGED") continue;
    const payload = event.payload as Partial<AttentionEventPayload>;
    if (!hasOccurrenceIdentity(payload)) {
      result.ignored += 1;
      continue;
    }
    if (event.type === "ATTENTION_OPENED") {
      if (!hasAttentionSource(payload)) {
        result.ignored += 1;
        continue;
      }
      store.projectAttention({
        agentId: event.agentId, sourceKind: payload.sourceKind, sourceRef: payload.sourceRef,
        occurrenceKey: payload.occurrenceKey, kind: payload.kind, urgency: payload.urgency,
        summary: payload.summary, openedAt: payload.openedAt, dueAt: payload.dueAt,
        expiresAt: payload.expiresAt, lastEventId: event.id,
      });
      result.projected += 1;
      continue;
    }
    const item = store.getAttentionByOccurrence(event.agentId, payload.sourceKind!, payload.sourceRef!, payload.occurrenceKey!);
    if (!item || typeof payload.version !== "number" || typeof payload.occurredAt !== "number" || !payload.state) {
      result.ignored += 1;
      continue;
    }
    if (item.version >= payload.version) continue;
    const transition = store.transitionAttention(item.id, item.version, payload.state, payload.occurredAt);
    if (transition.ok) result.transitioned += 1;
    else result.ignored += 1;
  }
  return result;
}

function hasOccurrenceIdentity(payload: Partial<AttentionEventPayload>): payload is Partial<AttentionEventPayload> & Pick<AttentionEventPayload, "sourceKind" | "sourceRef" | "occurrenceKey"> {
  return typeof payload.sourceKind === "string" && typeof payload.sourceRef === "string" && typeof payload.occurrenceKey === "string";
}

function hasAttentionSource(payload: Partial<AttentionEventPayload>): payload is AttentionEventPayload {
  return typeof payload.kind === "string" && typeof payload.urgency === "number" && typeof payload.summary === "string"
    && typeof payload.openedAt === "number" && typeof payload.dueAt === "number";
}
