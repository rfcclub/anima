import type { ProposalInbox } from "./proposal-inbox.ts";
import { proposalContentHash } from "./proposal-inbox.ts";

/**
 * Hindsight curation (#673): a server-side job reads the agent's curated
 * Hindsight pages (not raw memory units) and turns each claim into an inbox
 * proposal with provenance. Nothing lands in the substrate here: the agent's
 * own reflection decides what, if anything, is promoted from the inbox.
 *
 * Remote hosts never hold Hindsight credentials; this runs on the server with
 * the rest of the nightly consolidation.
 */
export interface CuratedPage {
  /** Hindsight page id, kept as provenance so a proposal can be traced back. */
  id: string;
  /** Page title, used as the evidence excerpt on every proposal from the page. */
  title: string;
  claims: string[];
}

export interface HindsightCurationOptions {
  agentId: string;
  /** The agent's own Hindsight bank; recorded as the proposal source. */
  bank: string;
  inbox: Pick<ProposalInbox, "append">;
  /** Contents of the neurons already in the agent's substrate, for dedupe and contradiction checks. */
  neuronContents: () => string[];
}

export interface CurationReport {
  /** Claims read from the curated pages. */
  scanned: number;
  /** Claims appended to the inbox as proposals. */
  proposed: number;
  /** Claims already proposed (this run or an earlier one). */
  duplicates: number;
  /** Claims already present as a neuron. */
  skipped: number;
  /** Proposals that contradict a neuron; still proposed, flagged for reflection. */
  conflicts: number;
}

const NEGATIONS = new Set(["not", "never", "no", "none", "cannot", "isnt", "arent", "doesnt", "dont", "wont"]);

/** Lowercase, collapse whitespace and drop surrounding punctuation, so two phrasings of a claim compare equal. */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .trim();
}

function tokens(claim: string): string[] {
  return normalizeClaim(claim)
    .replace(/[^\p{L}\p{N}\s']+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** The words of a claim with its negations removed, so two polarities can be compared by subject and predicate. */
function affirm(words: string[]): string[] {
  return words.filter((word) => !NEGATIONS.has(word.replace(/'/g, "")));
}

/**
 * The neuron that a claim contradicts, if any: same subject and predicate, but
 * one side negated. A claim about a different subject is never a contradiction.
 */
export function findContradiction(claim: string, neurons: string[]): string | undefined {
  const claimWords = tokens(claim);
  const claimAffirmative = affirm(claimWords);
  if (claimAffirmative.length === 0) return undefined;
  const claimNegated = claimAffirmative.length !== claimWords.length;
  for (const neuron of neurons) {
    const neuronWords = tokens(neuron);
    const neuronAffirmative = affirm(neuronWords);
    if (neuronAffirmative.length === 0) continue;
    // Same polarity, or a different subject and predicate: not a contradiction.
    if ((neuronAffirmative.length !== neuronWords.length) === claimNegated) continue;
    if (neuronAffirmative.length !== claimAffirmative.length) continue;
    if (neuronAffirmative.every((w, i) => w === claimAffirmative[i])) return neuron;
  }
  return undefined;
}

/**
 * Turns curated Hindsight pages into at-most-one inbox proposal per claim.
 * A claim already known as a neuron is skipped; a claim that contradicts one
 * is proposed anyway and flagged, because only reflection may resolve it.
 */
export function curateHindsightPages(pages: CuratedPage[], options: HindsightCurationOptions): CurationReport {
  const known = new Map<string, string>();
  for (const content of options.neuronContents()) {
    const key = normalizeClaim(content);
    if (key && !known.has(key)) known.set(key, content);
  }

  const report: CurationReport = { scanned: 0, proposed: 0, duplicates: 0, skipped: 0, conflicts: 0 };
  for (const page of pages) {
    for (const raw of page.claims ?? []) {
      report.scanned++;
      const claim = String(raw ?? "").trim().replace(/\s+/g, " ");
      if (!claim) {
        report.skipped++;
        continue;
      }
      const key = normalizeClaim(claim);
      if (known.has(key)) {
        report.skipped++;
        continue;
      }
      const contradiction = findContradiction(claim, [...known.values()]);
      const outcome = options.inbox.append(options.agentId, claim, {
        kind: "hindsight-curation",
        source: options.bank,
        pageId: page.id,
        evidence: page.title,
        ...(contradiction === undefined ? {} : { conflictsWith: proposalContentHash(contradiction) }),
      });
      if (outcome.status === "duplicate") {
        report.duplicates++;
        continue;
      }
      report.proposed++;
      if (contradiction !== undefined) report.conflicts++;
      // One proposal per claim per run, however many pages restate it: the inbox
      // owns that dedupe, so a restatement is reported as a duplicate below.
    }
  }
  return report;
}
