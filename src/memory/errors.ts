/**
 * Thrown by an AgentMemoryStore.remember() implementation when it reached
 * the underlying store but the write did not actually persist. The caller
 * must treat this as an unknown outcome (the store was touched), not a
 * pre-write rejection — see AnimaContinuityService.remember, which rolls
 * back the reservation and rethrows rather than swallowing it.
 */
export class MemoryWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MemoryWriteError";
  }
}
