import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMemoryStore } from "../memory/contract";

/**
 * Memory → inbox extraction (rfcclub/anima#666).
 *
 * The reflection pipeline has three stages: consolidation (the memory store
 * already fills from pulse outputs, sessions and mesh talk), extraction (this
 * file: raw memory entries distilled into proposals) and reflection (an agent
 * turn that judges each proposal and edits its own substrate for what it
 * keeps). Extraction only ever writes a proposal list; reading it decides
 * nothing, so a proposal never becomes a rule by itself.
 */

/** A memory entry as extraction sees it. Structurally a subset of AgentMemoryEntry. */
export interface MemoryCandidate {
  id: string;
  content: string;
  tags: string[];
  confidence: number;
  createdAt?: string;
}

/** A proposal waiting in the inbox for the agent to judge. */
export interface InboxProposal {
  /** One-line claim distilled from the evidence. */
  claim: string;
  /** The tag all evidence entries share; this is what the claim is about. */
  tags: string[];
  /** Memory entry ids the claim was distilled from. */
  sources: string[];
  /** How many memory entries back the claim. */
  evidenceCount: number;
  /** Mean confidence of the evidence, 0–1. */
  confidence: number;
}

/** Follows the promotion rule used elsewhere: at or above this confidence
 *  a memory may become substrate, below it stays an observation. */
export const INBOX_MIN_CONFIDENCE = 0.72;
/** One mention is not a pattern: a claim needs at least this many entries. */
export const INBOX_MIN_EVIDENCE = 3;

const NEGATION = /\b(never|not|no longer|stop|avoid)\b/i;

function clipLine(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 2) + " …" : oneLine;
}

/** Axioms the agent must not contradict, read from AXIOMS.md bullets. */
export function loadAxioms(roomDir: string): string[] {
  const path = join(roomDir, "AXIOMS.md");
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

/** True when `content` states the opposite of `axiom` (mentions it under a negation). */
function contradicts(content: string, axiom: string): boolean {
  if (!content.toLowerCase().includes(axiom.toLowerCase())) return false;
  return NEGATION.test(content);
}

/** Group by tag; newest entry of a surviving group names the claim. */
export function extractProposals(
  entries: MemoryCandidate[],
  options: { axioms?: readonly string[] } = {},
): InboxProposal[] {
  const axioms = options.axioms ?? [];
  const groups = new Map<string, MemoryCandidate[]>();
  for (const entry of entries) {
    const tag = entry.tags[0];
    if (!tag) continue;
    const group = groups.get(tag);
    if (group) group.push(entry);
    else groups.set(tag, [entry]);
  }

  const proposals: InboxProposal[] = [];
  for (const [tag, group] of groups) {
    if (group.length < INBOX_MIN_EVIDENCE) continue;
    const mean = group.reduce((sum, entry) => sum + entry.confidence, 0) / group.length;
    if (mean < INBOX_MIN_CONFIDENCE) continue;
    // Contradiction is checked against the whole group's rule, then the
    // contradicting entry is dropped from the sources rather than vetoing the
    // pattern its peers still support.
    const supported = group.filter((entry) => !axioms.some((axiom) => contradicts(entry.content, axiom)));
    if (supported.length === 0) continue;
    const confidence = supported.reduce((sum, entry) => sum + entry.confidence, 0) / supported.length;
    proposals.push({
      claim: clipLine(supported[supported.length - 1]!.content),
      tags: [tag],
      sources: supported.map((entry) => entry.id),
      evidenceCount: supported.length,
      confidence: Math.round(confidence * 1000) / 1000,
    });
  }
  return proposals;
}

export function renderInbox(agentName: string, proposals: readonly InboxProposal[]): string {
  const lines = [
    `# INBOX — ${agentName}`,
    "",
    `- Extracted: ${new Date().toISOString()}`,
    "- These are proposals. Nothing here is a rule until you judge it and write it into your own substrate.",
    "",
  ];
  if (proposals.length === 0) {
    lines.push("(no proposals this pass)", "");
    return lines.join("\n");
  }
  proposals.forEach((proposal, index) => {
    lines.push(
      `## Proposal ${index + 1}`,
      `- claim: ${clipLine(proposal.claim)}`,
      `- tags: ${proposal.tags.join(", ")}`,
      `- confidence: ${proposal.confidence}`,
      `- evidence: ${proposal.evidenceCount}`,
      `- sources: ${proposal.sources.join(", ")}`,
      "",
    );
  });
  return lines.join("\n");
}

/** Write the extraction pass's proposals to the agent's staging/INBOX.md. */
export async function writeInbox(
  roomDir: string,
  agentName: string,
  proposals: readonly InboxProposal[],
): Promise<string> {
  const stagingDir = join(roomDir, "staging");
  await mkdir(stagingDir, { recursive: true });
  const path = join(stagingDir, "INBOX.md");
  await writeFile(path, renderInbox(agentName, proposals), "utf-8");
  return path;
}

/** Read the agent's inbox. `undefined` means there is nothing to judge. */
export async function readInbox(roomDir: string): Promise<InboxProposal[] | undefined> {
  const path = join(roomDir, "staging", "INBOX.md");
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  const proposals: InboxProposal[] = [];
  let current: Partial<InboxProposal> | null = null;
  const flush = () => {
    if (current?.claim) {
      proposals.push({
        claim: current.claim,
        tags: current.tags ?? [],
        sources: current.sources ?? [],
        evidenceCount: current.evidenceCount ?? (current.sources ?? []).length,
        confidence: current.confidence ?? 0,
      });
    }
    current = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      flush();
      current = {};
      continue;
    }
    if (!current) continue;
    const match = /^- ([a-z]+):\s*(.*)$/i.exec(line);
    if (!match) continue;
    const [, field, value] = match;
    switch (field!.toLowerCase()) {
      case "claim":
        current.claim = value!;
        break;
      case "tags":
        current.tags = value!.split(",").map((tag) => tag.trim()).filter(Boolean);
        break;
      case "confidence":
        current.confidence = Number(value);
        break;
      case "evidence":
        current.evidenceCount = Number(value);
        break;
      case "sources":
        current.sources = value!.split(",").map((source) => source.trim()).filter(Boolean);
        break;
    }
  }
  flush();
  return proposals;
}

/** Read recent entries from the agent's memory store and write its inbox. */
export async function extractInboxFromMemory(
  roomDir: string,
  agentName: string,
  store: Pick<AgentMemoryStore, "bootstrap">,
  options: { limit?: number } = {},
): Promise<InboxProposal[]> {
  const entries = await store.bootstrap({ maxEntries: options.limit ?? 200 });
  const proposals = extractProposals(
    entries.map((entry) => ({
      id: entry.id,
      content: entry.content,
      tags: entry.tags ?? [],
      confidence: entry.confidence,
      createdAt: entry.createdAt,
    })),
    { axioms: loadAxioms(roomDir) },
  );
  await writeInbox(roomDir, agentName, proposals);
  return proposals;
}
