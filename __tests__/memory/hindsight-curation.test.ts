import { describe, expect, test } from "bun:test";
import { ProposalInbox, proposalContentHash } from "../../src/memory/proposal-inbox";
import {
  curateHindsightPages,
  findContradiction,
  type CuratedPage,
} from "../../src/memory/hindsight-curation";

function curation(neurons: string[] = []) {
  const inbox = new ProposalInbox(":memory:", () => 1_000);
  return {
    inbox,
    run: (pages: CuratedPage[]) => curateHindsightPages(pages, {
      agentId: "eli",
      bank: "eli-bank",
      inbox,
      neuronContents: () => neurons,
    }),
  };
}

const page = (overrides: Partial<CuratedPage> = {}): CuratedPage => ({
  id: "page-1",
  title: "Ingestion",
  claims: ["the ingestion path is streaming"],
  ...overrides,
});

describe("hindsight curation", () => {
  test("a curated page becomes at most one proposal per claim", () => {
    const { inbox, run } = curation();
    const report = run([
      page({ claims: ["the ingestion path is streaming", "the ingestion path is streaming"] }),
      page({ id: "page-2", claims: ["  The ingestion path IS streaming "] }),
    ]);

    expect(report).toEqual({ scanned: 3, proposed: 1, duplicates: 2, skipped: 0, conflicts: 0 });
    const [proposal] = inbox.list("eli");
    expect(proposal).toMatchObject({
      claim: "the ingestion path is streaming",
      trust: "untrusted",
      provenance: { kind: "hindsight-curation", source: "eli-bank", pageId: "page-1", evidence: "Ingestion" },
    });
    inbox.close();
  });

  test("a claim already present as a neuron is skipped, not proposed again", () => {
    const { inbox, run } = curation(["The ingestion path is  streaming."]);
    const report = run([page()]);

    expect(report).toMatchObject({ scanned: 1, proposed: 0, skipped: 1 });
    expect(inbox.list("eli")).toEqual([]);
    inbox.close();
  });

  test("a claim that contradicts a neuron is still proposed, flagged for reflection", () => {
    const { inbox, run } = curation(["the ingestion path is not streaming"]);
    const report = run([page()]);

    expect(report).toMatchObject({ proposed: 1, conflicts: 1 });
    expect(inbox.list("eli")[0]!.provenance.conflictsWith).toBe(
      proposalContentHash("the ingestion path is not streaming"),
    );
    inbox.close();
  });

  test("a claim about another subject is not called a contradiction", () => {
    expect(findContradiction("the ingestion path is streaming", [
      "the deploy pipeline is not streaming",
    ])).toBeUndefined();
  });
});
