import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BEAM_KEYWORDS = ["insight", "learned", "discovered", "realized", "pattern"];

export interface JsonlEvent {
  timestamp: string;
  type: string;
  sessionId: string;
  [key: string]: unknown;
}

export interface LightNapOptions {
  roomDir: string;
  agentName: string;
  sessionId: string;
  sessionEvents: JsonlEvent[];
}

export interface BeamEntry {
  timestamp: string;
  agent: string;
  session: string;
  keywords: string[];
  source: string;
  content: string;
  summary?: string;
}

/**
 * Append pre-built beam entries to `roomDir`'s staging/beams/<date>.md,
 * grouped by date, in the exact format `parseBeamEntries` below expects
 * (`## Beam — <ts>` header, `- Agent:`/`- Session:`/etc. fields). Exported
 * standalone (not just via `LightNap.run`'s keyword classifier) so a
 * caller that already knows a beam is worth recording — no keyword gate
 * needed — can write one directly. Used by pulse-anima-dispatcher.ts
 * (requirement: one beam per pulse — one beam per successful stage,
 * not gated on BEAM_KEYWORDS matching, since pulse-anima's own extraction
 * already decided the content is worth keeping).
 */
export async function appendBeamEntries(roomDir: string, beams: BeamEntry[]): Promise<void> {
  const byDate = new Map<string, BeamEntry[]>();
  for (const beam of beams) {
    const date = beam.timestamp.slice(0, 10);
    const existing = byDate.get(date) ?? [];
    existing.push(beam);
    byDate.set(date, existing);
  }
  for (const [date, dateBeams] of byDate) {
    await appendBeamsForDate(roomDir, date, dateBeams);
  }
}

async function appendBeamsForDate(
  roomDir: string,
  date: string,
  beams: BeamEntry[],
): Promise<void> {
  const beamsDir = join(roomDir, "staging", "beams");
  await mkdir(beamsDir, { recursive: true });

  const filePath = join(beamsDir, `${date}.md`);

  let existing = "";
  if (existsSync(filePath)) {
    existing = await readFile(filePath, "utf-8");
  }

  const lines: string[] = [];
  if (existing.length === 0) {
    lines.push(`# Beams — ${date}`);
    lines.push("");
  }

  for (const beam of beams) {
    lines.push(`## Beam — ${beam.timestamp}`);
    lines.push(`- Agent: ${beam.agent}`);
    lines.push(`- Session: ${beam.session}`);
    lines.push(`- Keywords: ${beam.keywords.join(", ")}`);
    lines.push(`- Source: ${beam.source}`);
    lines.push(`- Summary: ${beam.summary ?? beam.content.replace(/\n/g, " ").slice(0, 150)}`);
    lines.push(`- Content: ${beam.content.replace(/\n/g, " ")}`);
    lines.push("");
  }

  await writeFile(filePath, existing + lines.join("\n"), "utf-8");
}

export class LightNap {
  /**
   * Run the light nap — classify session events for beams and store them.
   * Never throws. Failures are logged and swallowed.
   */
  async run(options: LightNapOptions): Promise<void> {
    try {
      const { roomDir, agentName, sessionId, sessionEvents } = options;
      const beams = this.classifyEvents(sessionEvents, agentName, sessionId);
      if (beams.length === 0) return;
      await appendBeamEntries(roomDir, beams);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          ts: new Date().toISOString(),
          msg: "light nap failed",
          error: String(err),
        }),
      );
    }
  }

  private classifyEvents(
    events: JsonlEvent[],
    agentName: string,
    sessionId: string,
  ): BeamEntry[] {
    const beams: BeamEntry[] = [];
    for (const event of events) {
      const body = event.body;
      if (typeof body !== "string") continue;

      const matchedKeywords = BEAM_KEYWORDS.filter((kw) =>
        body.toLowerCase().includes(kw.toLowerCase()),
      );
      if (matchedKeywords.length === 0) continue;

      beams.push({
        timestamp: event.timestamp,
        agent: agentName,
        session: sessionId,
        keywords: matchedKeywords,
        source: event.type,
        content: body,
        summary: body.replace(/\n/g, " ").slice(0, 150),
      });
    }
    return beams;
  }
}

/**
 * Parse beam entries from a beam markdown file.
 */
export function parseBeamEntries(content: string): BeamEntry[] {
  const entries: BeamEntry[] = [];
  const lines = content.split("\n");

  let current: Partial<BeamEntry> | null = null;

  for (const line of lines) {
    const beamMatch = line.match(/^## Beam — (.+)$/);
    if (beamMatch) {
      if (current && current.timestamp) {
        entries.push(current as BeamEntry);
      }
      current = { timestamp: beamMatch[1].trim(), keywords: [] };
      continue;
    }

    if (!current) continue;

    const agentMatch = line.match(/^- Agent: (.+)$/);
    if (agentMatch) {
      current.agent = agentMatch[1].trim();
      continue;
    }

    const sessionMatch = line.match(/^- Session: (.+)$/);
    if (sessionMatch) {
      current.session = sessionMatch[1].trim();
      continue;
    }

    const kwMatch = line.match(/^- Keywords: (.+)$/);
    if (kwMatch) {
      current.keywords = kwMatch[1].split(",").map((k) => k.trim());
      continue;
    }

    const sourceMatch = line.match(/^- Source: (.+)$/);
    if (sourceMatch) {
      current.source = sourceMatch[1].trim();
      continue;
    }

    const summaryMatch = line.match(/^- Summary: (.+)$/);
    if (summaryMatch) {
      current.summary = summaryMatch[1].trim();
      continue;
    }

    const contentMatch = line.match(/^- Content: (.+)$/);
    if (contentMatch) {
      current.content = contentMatch[1].trim();
      continue;
    }
  }

  if (current && current.timestamp) {
    entries.push(current as BeamEntry);
  }

  return entries;
}
