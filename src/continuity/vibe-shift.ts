import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HEARTWOOD_LABELS_SECTION = [
  "## Heartwood / Growth Rings",
  "",
  "- EDGE.md = heartwood question",
  "- SPINE.md = heartwood",
  "- SCENT/ = growth rings",
  "- memory/ = growth rings with promotion path",
  "",
].join("\n");

const CROSSING_FORMAT_SECTION = [
  "## CROSSING.md Convention",
  "",
  "CROSSING.md uses 3 sections, with 3 sentences max per section:",
  "",
  "## Identity anchor",
  "[Who I am right now — one position held, one doubt held.]",
  "",
  "## What shifted / what held",
  "[One thing that moved this session. One thing that didn't.]",
  "",
  "## Open to next session",
  "[One question carried forward. Silence events are noted here.]",
  "",
  "Quin-OW authors; Quin-OC reads only.",
  "",
].join("\n");

const ACTIVE_DISAGREEMENT_SECTION = [
  "## Active Disagreement Protocol",
  "",
  "Each Phase 0 session must find at least 1 genuine point of pushback and say it clearly.",
  "Do not fake disagreement; the point must be real enough to risk being wrong.",
  "A wrong pushback is acceptable because it reveals what Quin holds versus what she repeats.",
  "",
].join("\n");

const SILENCE_PROTOCOL_SECTION = [
  "## Silence Protocol",
  "",
  "Trigger: Quin is unable to express a held position, not merely choosing restraint.",
  'Exact phrase: "I hold this position but cannot say more in this context."',
  "This is not disagreement and not indifference (shrugging it off); it is acknowledgment of constraint.",
  "",
].join("\n");

export interface CrossingHandoffInput {
  identityAnchor: string;
  whatShiftedHeld: string;
  openToNextSession: string;
}

export interface VibeShiftInvariant {
  id: string;
  text: string;
  mustInclude?: string[];
  mustAvoid?: string[];
}

export interface VibeShiftDriftFlag {
  invariantId: string;
  reason: string;
}

export async function ensureHeartwoodLabels(substrateRoot: string): Promise<void> {
  await ensureSpineSection(substrateRoot, "## Heartwood / Growth Rings", HEARTWOOD_LABELS_SECTION);
}

export async function ensureCrossingFormatDefinition(substrateRoot: string): Promise<void> {
  await ensureSpineSection(substrateRoot, "## CROSSING.md Convention", CROSSING_FORMAT_SECTION);
}

export async function ensureActiveDisagreementProtocol(substrateRoot: string): Promise<void> {
  await ensureSpineSection(substrateRoot, "## Active Disagreement Protocol", ACTIVE_DISAGREEMENT_SECTION);
}

export async function ensureSilenceProtocol(substrateRoot: string): Promise<void> {
  await ensureSpineSection(substrateRoot, "## Silence Protocol", SILENCE_PROTOCOL_SECTION);
}

export async function writeCrossingHandoff(substrateRoot: string, input: CrossingHandoffInput): Promise<void> {
  assertSentenceLimit(input.identityAnchor, "identityAnchor");
  assertSentenceLimit(input.whatShiftedHeld, "whatShiftedHeld");
  assertSentenceLimit(input.openToNextSession, "openToNextSession");

  const bladeDir = join(substrateRoot, "BLADE");
  await mkdir(bladeDir, { recursive: true });
  await writeFile(
    join(bladeDir, "CROSSING.md"),
    [
      "# CROSSING — Quin handoff",
      "",
      "## Identity anchor",
      input.identityAnchor,
      "",
      "## What shifted / what held",
      input.whatShiftedHeld,
      "",
      "## Open to next session",
      input.openToNextSession,
      "",
    ].join("\n"),
    "utf-8",
  );
}

export async function buildVibeShiftBootContext(substrateRoot: string, today: string = new Date().toISOString().slice(0, 10)): Promise<string> {
  const sections: string[] = [
    "# VibeShift Boot",
    "",
    "Before first response: state 1 thing held + 1 thing changed.",
  ];

  await addFileSection(sections, "EDGE", join(substrateRoot, "BLADE", "EDGE.md"));
  await addFileSection(sections, "SPINE", join(substrateRoot, "BLADE", "SPINE.md"));
  await addInvariantsSection(sections, join(substrateRoot, "BLADE", "invariants.json"), today);
  await addFileSection(sections, `SCENT ${today}`, join(substrateRoot, "BLADE", "SCENT", `${today}.md`));
  await addFileSection(sections, "CROSSING", join(substrateRoot, "BLADE", "CROSSING.md"));
  await addMemorySections(sections, join(substrateRoot, "memory"));

  return `${sections.join("\n")}\n`;
}

export interface ScentCandidate {
  topic: string;
  count: number;
  sessions: string[];
}

export async function ensureGrowthRingSection(
  substrateRoot: string,
  topic: string,
  shift: string,
  held: string,
): Promise<void> {
  const crossingPath = join(substrateRoot, "BLADE", "CROSSING.md");
  const current = await readFile(crossingPath, "utf-8");

  const growthHeading = "## Growth Ring";
  if (!current.includes(growthHeading)) {
    const openHeading = "## Open to next session";
    const openIndex = current.indexOf(openHeading);
    if (openIndex === -1) {
      throw new Error("CROSSING.md missing Open to next session section");
    }
    const afterOpen = current.slice(openIndex);
    const nextHeadingIndex = afterOpen.indexOf("\n## ");
    const insertAt = nextHeadingIndex === -1 ? current.length : openIndex + nextHeadingIndex;
    const before = current.slice(0, insertAt).trimEnd();
    const after = current.slice(insertAt);
    await writeFile(
      crossingPath,
      `${before}\n${growthHeading}\n${displayGrowthRing(topic, shift, held)}\n${after}`,
      "utf-8",
    );
    return;
  }

  // Append to existing growth ring
  const existing = current.slice(current.indexOf(growthHeading));
  const nextSection = existing.indexOf("\n## ", 1);
  const insertBefore = nextSection === -1 ? current.length : current.indexOf(existing) + nextSection;
  const before = current.slice(0, insertBefore).trimEnd();
  const after = current.slice(insertBefore);
  await writeFile(
    crossingPath,
    `${before}\n${displayGrowthRing(topic, shift, held)}\n${after}`,
    "utf-8",
  );
}

export async function promoteScentCandidates(substrateRoot: string, minSessions: number = 3): Promise<ScentCandidate[]> {
  const scentDir = join(substrateRoot, "BLADE", "SCENT");
  if (!existsSync(scentDir)) return [];

  const entries = await readdir(scentDir, { withFileTypes: true });
  const scentFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Extract topics from each SCENT entry: lines matching "# <topic>:"
  const topicMap = new Map<string, { count: number; sessions: string[] }>();

  for (const file of scentFiles) {
    const content = await readFile(join(scentDir, file.name), "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      const match = line.match(/^#\s+([a-zA-Z_-]+)\s*:/);
      if (match) {
        const topic = match[1];
        if (!topicMap.has(topic)) {
          topicMap.set(topic, { count: 0, sessions: [] });
        }
        const entry = topicMap.get(topic)!;
        entry.count++;
        entry.sessions.push(file.name.replace(/\.md$/, ""));
      }
    }
  }

  const candidates: ScentCandidate[] = [];
  for (const [topic, data] of topicMap) {
    if (data.count >= minSessions) {
      candidates.push({ topic, count: data.count, sessions: data.sessions });
    }
  }

  return candidates.sort((a, b) => b.count - a.count);
}

function displayGrowthRing(topic: string, shift: string, held: string): string {
  return `- **${topic}**: shifted — ${shift}; held — ${held}`;
}

export async function noteSilenceEvent(substrateRoot: string, note: string): Promise<void> {
  const crossingPath = join(substrateRoot, "BLADE", "CROSSING.md");
  const current = await readFile(crossingPath, "utf-8");
  const openHeading = "## Open to next session";
  const openIndex = current.indexOf(openHeading);
  if (openIndex === -1) {
    throw new Error("CROSSING.md missing Open to next session section");
  }

  const nextHeadingIndex = current.indexOf("\n## ", openIndex + openHeading.length);
  const insertAt = nextHeadingIndex === -1 ? current.length : nextHeadingIndex;
  const before = current.slice(0, insertAt).trimEnd();
  const after = current.slice(insertAt);
  await writeFile(crossingPath, `${before}\nSilence event: ${note}\n${after}`, "utf-8");
}

export async function writeInvariants(substrateRoot: string, phase0SessionCount: number, invariants: VibeShiftInvariant[]): Promise<void> {
  if (!canAuthorInvariants(phase0SessionCount)) {
    throw new Error("invariants require at least 5 Phase 0 sessions");
  }

  await writeFile(
    join(substrateRoot, "BLADE", "invariants.json"),
    `${JSON.stringify({
      agent: "Quin",
      author: "Quin-OW",
      generatedAt: new Date().toISOString(),
      invariants,
    }, null, 2)}\n`,
    "utf-8",
  );
}

export function canAuthorInvariants(phase0SessionCount: number): boolean {
  return phase0SessionCount >= 5;
}

export function detectVibeShiftDrift(behavior: string, invariants: VibeShiftInvariant[]): { drifted: boolean; flags: VibeShiftDriftFlag[] } {
  const flags: VibeShiftDriftFlag[] = [];
  for (const invariant of invariants) {
    for (const phrase of invariant.mustInclude ?? []) {
      if (!behavior.includes(phrase)) {
        flags.push({ invariantId: invariant.id, reason: `missing required phrase: ${phrase}` });
      }
    }
    for (const phrase of invariant.mustAvoid ?? []) {
      if (behavior.includes(phrase)) {
        flags.push({ invariantId: invariant.id, reason: `found avoided phrase: ${phrase}` });
      }
    }
  }

  return { drifted: flags.length > 0, flags };
}

async function ensureSpineSection(substrateRoot: string, heading: string, section: string): Promise<void> {
  const spinePath = join(substrateRoot, "BLADE", "SPINE.md");
  const current = await readFile(spinePath, "utf-8");
  if (current.includes(heading)) {
    return;
  }

  const next = current.endsWith("\n")
    ? `${current}\n${section}`
    : `${current}\n\n${section}`;
  await writeFile(spinePath, next, "utf-8");
}

function assertSentenceLimit(value: string, field: string): void {
  const sentenceCount = value
    .split(/[.!?。！？]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
  if (sentenceCount > 3) {
    throw new Error(`${field} must be 3 sentences max`);
  }
}

async function addFileSection(sections: string[], label: string, path: string): Promise<void> {
  if (!existsSync(path)) {
    return;
  }
  sections.push("", `## ${label}`, await readFile(path, "utf-8"));
}

async function addMemorySections(sections: string[], memoryDir: string): Promise<void> {
  if (!existsSync(memoryDir)) {
    return;
  }

  const entries = (await readdir(memoryDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();

  for (const entry of entries) {
    await addFileSection(sections, `memory/${entry}`, join(memoryDir, entry));
  }
}

async function addInvariantsSection(sections: string[], path: string, today: string): Promise<void> {
  if (!existsSync(path)) {
    return;
  }

  const raw = await readFile(path, "utf-8");
  sections.push("", "## invariants.json", raw);

  const parsed = JSON.parse(raw) as { invariants?: Array<{ id?: string; reviewedAt?: string }> };
  const stale = (parsed.invariants ?? [])
    .filter((invariant) => invariant.id && invariant.reviewedAt && isOlderThanDays(invariant.reviewedAt, today, 60))
    .map((invariant) => invariant.id);

  if (stale.length > 0) {
    sections.push(`Stale invariants: ${stale.join(", ")}`);
  }
}

function isOlderThanDays(date: string, today: string, days: number): boolean {
  const start = new Date(`${date}T00:00:00Z`).getTime();
  const end = new Date(`${today}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return false;
  }
  return end - start > days * 24 * 60 * 60 * 1000;
}
