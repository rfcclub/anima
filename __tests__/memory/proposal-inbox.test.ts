import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalInbox, proposalContentHash } from "../../src/memory/proposal-inbox";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function inbox(): ProposalInbox {
  root = mkdtempSync(join(tmpdir(), "proposal-inbox-"));
  return new ProposalInbox(join(root, "memory.db"), () => 1_000);
}

describe("ProposalInbox", () => {
  test("a claim becomes at most one proposal per agent, however often it is proposed", () => {
    const box = inbox();
    const first = box.append("eli", "the ingestion path is streaming", { kind: "remote-session", source: "codex" });
    const second = box.append("eli", "  The   ingestion path is  streaming ", { kind: "hindsight-curation", source: "eli-bank" });

    expect(first.status).toBe("appended");
    expect(second).toEqual({ status: "duplicate", proposalId: first.proposalId });
    expect(box.list("eli")).toHaveLength(1);
    box.close();
  });

  test("a proposal is untrusted and pending with its provenance, never a substrate entry", () => {
    const box = inbox();
    box.append("eli", "a claim", { kind: "remote-session", source: "codex", sessionId: "s1", sequence: 2, confidence: 0.6 });
    const [proposal] = box.list("eli");

    expect(proposal).toMatchObject({
      agentId: "eli",
      claim: "a claim",
      trust: "untrusted",
      status: "pending",
      createdAt: 1_000,
      provenance: { kind: "remote-session", source: "codex", sessionId: "s1", sequence: 2, confidence: 0.6 },
    });
    expect(proposal!.contentHash).toBe(proposalContentHash("a claim"));
    box.close();
  });

  test("one agent's claims never leak into another agent's inbox", () => {
    const box = inbox();
    box.append("eli", "shared claim", { kind: "remote-session", source: "codex" });
    expect(box.append("bruno", "shared claim", { kind: "remote-session", source: "codex" }).status).toBe("appended");
    expect(box.list("bruno")).toHaveLength(1);
    expect(box.hasContentHash("bruno", proposalContentHash("a different claim"))).toBe(false);
    box.close();
  });
});
