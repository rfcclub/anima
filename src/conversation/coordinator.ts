import type { SharedUtteranceRecord, SharedUtteranceSource } from "./types";
import { SessionStore } from "../memory/session-store";

export interface SubmitSharedTurnInput {
  conversationId: string;
  requestKey: string;
  inputHash: string;
  userId: string;
  speakerId: string;
  userText: string;
  source?: SharedUtteranceSource;
  sourceId?: string;
  meetingId?: string;
  /** A disconnected/cancelled caller must never commit a result produced
   * after its cancellation fence. The already-durable user row remains the
   * canonical record of what was submitted. */
  signal?: AbortSignal;
  /** Autonomous speech has an event trigger, not a human utterance. Never
   * manufacture a user row solely to fit the UI turn shape. */
  omitInputUtterance?: boolean;
  /** Synchronous authority fence inside the FIFO and immediately before writes. */
  authorize?: () => void;
}

export interface SubmitOrderedSharedTurnInput extends Omit<SubmitSharedTurnInput, "speakerId"> {
  speakerIds: string[];
}

export class SharedTurnCoordinator {
  // Route handlers are intentionally short-lived. This queue therefore belongs to the
  // process, not one handler instance, so two HTTP requests cannot overtake each other.
  private static readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly store: SessionStore) {}

  recoverInterruptedRequests(): number {
    return this.store.interruptRunningSharedRequests();
  }

  submit(input: SubmitSharedTurnInput, generate: () => Promise<string | null>): Promise<SharedUtteranceRecord[]> {
    return this.submitOrdered({ ...input, speakerIds: [input.speakerId] }, async () => generate());
  }

  submitOrdered(input: SubmitOrderedSharedTurnInput, generate: (speakerId: string, beatIndex: number) => Promise<string | null>): Promise<SharedUtteranceRecord[]> {
    if (input.speakerIds.length === 0 || input.speakerIds.length > 3 || new Set(input.speakerIds).size !== input.speakerIds.length) {
      return Promise.reject(new Error("shared turn requires one to three unique ordered speakers"));
    }
    const previous = SharedTurnCoordinator.tails.get(input.conversationId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => held);
    SharedTurnCoordinator.tails.set(input.conversationId, queued);
    return previous.then(async () => {
      let admitted = false;
      try {
        this.throwIfCancelled(input.signal);
        input.authorize?.();
        const prior = this.store.getSharedRequest(input.requestKey);
        if (prior) {
          if (prior.conversationId !== input.conversationId || prior.inputHash !== input.inputHash) {
            throw new Error("shared request key conflicts with existing request");
          }
          if (prior.status !== "running") return this.forRequest(input.conversationId, input.requestKey);
        }
        this.store.beginSharedRequest({ requestKey: input.requestKey, conversationId: input.conversationId, inputHash: input.inputHash });
        admitted = true;
        const source = input.source ?? "ui";
        if (!input.omitInputUtterance) {
          this.store.appendSharedUtterance({ conversationId: input.conversationId, role: "user", speakerId: input.userId, content: input.userText, utteranceKey: `${input.requestKey}:user`, requestId: input.requestKey, source, sourceId: input.sourceId, meetingId: input.meetingId });
        }
        const completedSpeakers: string[] = [];
        for (const [beatIndex, speakerId] of input.speakerIds.entries()) {
          this.throwIfCancelled(input.signal);
          const text = await generate(speakerId, beatIndex);
          this.throwIfCancelled(input.signal);
          input.authorize?.();
          if (text !== null) {
            this.store.appendSharedUtterance({ conversationId: input.conversationId, role: "assistant", speakerId, content: text, utteranceKey: `${input.requestKey}:${speakerId}`, requestId: input.requestKey, source, sourceId: input.sourceId, meetingId: input.meetingId });
          }
          completedSpeakers.push(speakerId);
          this.store.updateSharedRequest(input.requestKey, { status: "running", completedSpeakers });
        }
        this.store.updateSharedRequest(input.requestKey, { status: "complete", completedSpeakers });
        return this.forRequest(input.conversationId, input.requestKey);
      } catch (error) {
        const request = this.store.getSharedRequest(input.requestKey);
        if (admitted && request?.status === "running") {
          const cancelled = error instanceof SharedTurnCancelledError;
          this.store.updateSharedRequest(input.requestKey, {
            status: cancelled ? "interrupted" : "failed",
            completedSpeakers: request.completedSpeakers,
            errorCode: cancelled ? "cancelled" : "generation_failed",
          });
        }
        throw error;
      } finally {
        release();
        if (SharedTurnCoordinator.tails.get(input.conversationId) === queued) {
          SharedTurnCoordinator.tails.delete(input.conversationId);
        }
      }
    });
  }

  private forRequest(conversationId: string, requestId: string): SharedUtteranceRecord[] {
    return this.store.getSharedUtterancesForRequest(conversationId, requestId);
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new SharedTurnCancelledError();
  }
}

export class SharedTurnCancelledError extends Error {
  constructor() {
    super("shared turn cancelled before commit");
    this.name = "SharedTurnCancelledError";
  }
}
