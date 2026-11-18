import type { AgentMemoryStore } from "../memory/contract";
import type { RemoteRememberRequest, RemoteRememberResult } from "./contract/remote-continuity.ts";

const IDEMPOTENCY_TAG_PREFIX = "idem:";

export function idempotencyTag(idempotencyKey: string): string {
  return `${IDEMPOTENCY_TAG_PREFIX}${idempotencyKey}`;
}

/**
 * Wraps a store's remember() so a retry with the same idempotencyKey never
 * writes a second entry (M2: ANIMA's continuity-service dedupes here, before
 * the store is touched, so a client that retries after an unknown-outcome
 * failure — or a recovery tool releasing a stuck mutation row — is always
 * safe to retry with the key it already holds).
 *
 * Stores without findByTag (e.g. BrunoEntityAdapter's fire-and-forget inbox
 * write has no reliable tag lookup) cannot dedupe: the entry still carries
 * the tag for forensics, but every call writes. This is a named, accepted
 * gap, not a silent one.
 */
export function idempotentRemember(
  store: Pick<AgentMemoryStore, "remember" | "findByTag">,
): (request: RemoteRememberRequest) => Promise<RemoteRememberResult> {
  return async ({ entry, idempotencyKey }) => {
    const tag = idempotencyTag(idempotencyKey);
    const existing = await store.findByTag?.(tag);
    if (existing) return { id: existing.id, createdAt: existing.createdAt };
    const written = await store.remember({ ...entry, tags: [...(entry.tags ?? []), tag] });
    return { id: written.id, createdAt: written.createdAt };
  };
}
