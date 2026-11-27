import { describe, expect, test } from "bun:test";
import type { AgentMemoryEntry } from "../memory/contract";
import { ProposalInbox } from "../memory/proposal-inbox.ts";
import { remoteBatchTag, remoteConsolidate } from "./remote-consolidation";

/** A minimal canonical store that remembers entries and answers findByTag. */
function memoryStore() {
  const entries: Array<AgentMemoryEntry> = [];
  const store = {
    entries,
    async remember(entry: Omit<AgentMemoryEntry, "id" | "createdAt">): Promise<AgentMemoryEntry> {
      const written = { ...entry, id: `entry-${entries.length + 1}`, createdAt: "2026-11-27T00:00:00.000Z" };
      entries.push(written);
      return written;
    },
    async findByTag(tag: string): Promise<AgentMemoryEntry | undefined> {
      return entries.find((entry) => entry.tags.includes(tag));
    },
  };
  return store;
}

function subject() {
  const store = memoryStore();
  const inbox = new ProposalInbox(":memory:", () => 1_000);
  const consolidate = remoteConsolidate({ agentId: "eli", store, inbox });
  return { store, inbox, consolidate };
}

const batch = (overrides: Partial<Parameters<ReturnType<typeof subject>["consolidate"]>[0]["batch"]> = {}) => ({
  sessionId: "session-1",
  sequence: 0,
  summary: "Refactored the ingestion path and fixed a flaky test.",
  candidates: [{ claim: "the ingestion path is now streaming", evidence: "one test went green", confidence: 0.7 }],
  ...overrides,
});

describe("remote session-end consolidation", () => {
  test("the summary becomes one untrusted episode that records the remote surface", async () => {
    const { store, consolidate } = subject();

    const result = await consolidate({ grantId: "g", stateHash: "s", idempotencyKey: "session-1:0", batch: batch() }, { surfaceId: "codex" });

    expect(result).toEqual({ episodeId: "entry-1", proposals: 1, duplicates: 0 });
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      scope: "episode",
      source: "remote:codex",
      tags: [remoteBatchTag("session-1", 0), "remote-session", "untrusted"],
      metadata: { remote_surface: "codex", remote_session_id: "session-1", remote_sequence: 0, untrusted: true },
    });
  });

  test("candidate learnings land in the inbox, never in the substrate", async () => {
    const { store, inbox, consolidate } = subject();

    await consolidate({ grantId: "g", stateHash: "s", idempotencyKey: "k", batch: batch() }, { surfaceId: "codex" });

    // Only the summary reached the store; the claim did not.
    expect(store.entries.map((entry) => entry.content)).not.toContain("the ingestion path is now streaming");
    const [proposal] = inbox.list("eli");
    expect(proposal).toMatchObject({
      claim: "the ingestion path is now streaming",
      trust: "untrusted",
      provenance: {
        kind: "remote-session",
        source: "codex",
        sessionId: "session-1",
        sequence: 0,
        evidence: "one test went green",
        confidence: 0.7,
      },
    });
    inbox.close();
  });

  test("a batch replayed by a retry is stored once, not twice", async () => {
    const { store, inbox, consolidate } = subject();
    const request = { grantId: "g", stateHash: "s", idempotencyKey: "session-1:0", batch: batch() };

    await consolidate(request, { surfaceId: "codex" });
    const replay = await consolidate(request, { surfaceId: "codex" });

    expect(store.entries).toHaveLength(1);
    expect(replay).toEqual({ episodeId: "entry-1", proposals: 0, duplicates: 1 });
    expect(inbox.list("eli")).toHaveLength(1);
    inbox.close();
  });
});
