#!/usr/bin/env bun
/**
 * Monthly session log rotation for ANIMA.
 *
 * Moves `rooms/<agent>/sessions/*.jsonl` files older than the current month
 * to `backup/archive/YYYY-MM/<agent>/`, then generates a compact summary
 * (`< 10 KB`) as `rooms/<agent>/sessions/summaries/YYYY-MM.md`.
 *
 * Designed to be run via `anima-rotate.service` / `anima-rotate.timer`.
 * Logs a structured rotation event back into each agent's current session file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const ROOMS_DIR = Bun.env.ANIMA_ROOMS_DIR ?? join(process.cwd(), "rooms");
const BACKUP_DIR = join(dirname(ROOMS_DIR), "backup");
const SUMMARY_SIZE_LIMIT = 10 * 1024; // 10 KB

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface JsonlEvent {
  timestamp: string;
  type: string;
  sessionId: string;
  [key: string]: unknown;
}

/** Return `YYYY-MM-DD` date string from a Date. */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Return `YYYY-MM` (year-month prefix) from a Date. */
function fmtMonth(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Return `YYYY-MM` from a filename like `2026-05-17.jsonl`. */
function monthFromFilename(name: string): string | null {
  const match = name.match(/^(\d{4}-\d{2})-\d{2}\.jsonl$/);
  return match ? match[1] : null;
}

/** Parse all events from a JSONL file, skipping corrupt lines. */
function parseJsonl(filePath: string): JsonlEvent[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const events: JsonlEvent[] = [];
  for (const line of content.split("\n").filter(Boolean)) {
    try {
      events.push(JSON.parse(line) as JsonlEvent);
    } catch {
      // skip corrupt line
    }
  }
  return events;
}

/** Structured JSON log output (same format as server.ts). */
function logInfo(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    level: "info",
    ts: new Date().toISOString(),
    msg,
    ...fields,
  }));
}

function logError(msg: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    level: "error",
    ts: new Date().toISOString(),
    msg,
    ...fields,
  }));
}

/* ------------------------------------------------------------------ */
/*  Core logic                                                         */
/* ------------------------------------------------------------------ */

function listAgents(): string[] {
  try {
    const entries = readdirSync(ROOMS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith("_"))
      .sort();
  } catch {
    return [];
  }
}

function rotateAgent(agent: string, currentMonth: string): { rotated: number; skipped: number } {
  const sessionsDir = join(ROOMS_DIR, agent, "sessions");
  if (!existsSync(sessionsDir)) return { rotated: 0, skipped: 0 };

  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  let rotated = 0;
  let skipped = 0;

  for (const file of files) {
    const fileMonth = monthFromFilename(file);
    if (!fileMonth) {
      skipped++;
      continue;
    }

    // Keep files from the current month
    if (fileMonth === currentMonth) {
      skipped++;
      continue;
    }

    // Move to backup/archive/YYYY-MM/<agent>/
    const archiveDir = join(BACKUP_DIR, "archive", fileMonth, agent);
    mkdirSync(archiveDir, { recursive: true });

    const src = join(sessionsDir, file);
    const dst = join(archiveDir, file);
    renameSync(src, dst);
    rotated++;
  }

  return { rotated, skipped };
}

function generateSummary(agent: string, month: string): void {
  const archiveDir = join(BACKUP_DIR, "archive", month, agent);
  if (!existsSync(archiveDir)) return;

  const files = readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).sort();
  if (files.length === 0) return;

  const allEvents: JsonlEvent[] = [];
  for (const file of files) {
    const events = parseJsonl(join(archiveDir, file));
    allEvents.push(...events);
  }

  if (allEvents.length === 0) return;

  // Compute summary stats
  const byType = new Map<string, number>();
  const sessions = new Set<string>();
  let firstTs = allEvents[0].timestamp;
  let lastTs = allEvents[0].timestamp;

  for (const ev of allEvents) {
    byType.set(ev.type, (byType.get(ev.type) ?? 0) + 1);
    if (ev.sessionId) sessions.add(ev.sessionId);
    if (ev.timestamp < firstTs) firstTs = ev.timestamp;
    if (ev.timestamp > lastTs) lastTs = ev.timestamp;
  }

  // Sort types by count descending
  const sortedTypes = [...byType.entries()].sort((a, b) => b[1] - a[1]);

  // Build the summary, keeping it under 10 KB
  const lines: string[] = [];
  lines.push(`# ${agent} — ${month}`);
  lines.push("");
  lines.push(`**Total events:** ${allEvents.length}`);
  lines.push(`**Unique sessions:** ${sessions.size}`);
  lines.push(`**Date range:** ${firstTs.slice(0, 10)} → ${lastTs.slice(0, 10)}`);
  lines.push("");
  lines.push("## Events by type");
  lines.push("");
  lines.push("| Type | Count |");
  lines.push("|------|-------|");
  for (const [type, count] of sortedTypes) {
    lines.push(`| ${type} | ${count} |`);
  }
  lines.push("");
  lines.push("## Session summary");
  lines.push("");

  // Group events by session for a compact per-session breakdown
  const bySession = new Map<string, JsonlEvent[]>();
  for (const ev of allEvents) {
    const sid = ev.sessionId ?? "unknown";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid)!.push(ev);
  }

  for (const [sid, sessionEvents] of bySession) {
    const sessionTypes = new Map<string, number>();
    let sessionFirst = sessionEvents[0].timestamp;
    let sessionLast = sessionEvents[0].timestamp;
    for (const ev of sessionEvents) {
      sessionTypes.set(ev.type, (sessionTypes.get(ev.type) ?? 0) + 1);
      if (ev.timestamp < sessionFirst) sessionFirst = ev.timestamp;
      if (ev.timestamp > sessionLast) sessionLast = ev.timestamp;
    }
    const typeSummary = [...sessionTypes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}:${c}`)
      .join(" ");
    const datePart = sessionFirst.slice(0, 10);
    lines.push(`- **${datePart}** session \`${sid.slice(0, 12)}\` — ${sessionEvents.length} events (${typeSummary})`);
  }

  let summary = lines.join("\n") + "\n";

  // Trim if over limit — remove oldest sessions first
  if (summary.length > SUMMARY_SIZE_LIMIT) {
    // Keep header + stats, trim session details
    const headerEnd = summary.indexOf("## Session summary");
    const header = summary.slice(0, headerEnd);
    // Add a note that details were trimmed
    summary = header + "## Session summary\n\n_(truncated — see archive for full data)_\n";
  }

  // Write summary
  const summariesDir = join(ROOMS_DIR, agent, "sessions", "summaries");
  mkdirSync(summariesDir, { recursive: true });
  writeFileSync(join(summariesDir, `${month}.md`), summary, "utf-8");
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const now = new Date();
  const currentMonth = fmtMonth(now);
  const agents = listAgents();

  if (agents.length === 0) {
    logInfo("rotate-sessions: no agents found", { roomsDir: ROOMS_DIR });
    return;
  }

  let totalRotated = 0;
  let totalSkipped = 0;
  const rotatedAgents: string[] = [];

  for (const agent of agents) {
    const { rotated, skipped } = rotateAgent(agent, currentMonth);
    totalRotated += rotated;
    totalSkipped += skipped;

    if (rotated > 0) {
      rotatedAgents.push(agent);

      // Determine which months were archived for this agent
      const archiveDir = join(BACKUP_DIR, "archive");
      if (existsSync(archiveDir)) {
        const months = readdirSync(archiveDir).filter((m) =>
          existsSync(join(archiveDir, m, agent)),
        );
        for (const month of months) {
          generateSummary(agent, month);
        }
      }

      // Log rotation event into the agent's current session file
      // Use the JSONL store format: { timestamp, type, sessionId, ... }
      const rotationEvent: JsonlEvent = {
        timestamp: now.toISOString(),
        type: "session_rotation",
        sessionId: "system",
        filesRotated: rotated,
        filesSkipped: skipped,
      };

      // Append directly to today's JSONL file
      const todayFile = join(ROOMS_DIR, agent, "sessions", `${fmtDate(now)}.jsonl`);
      mkdirSync(dirname(todayFile), { recursive: true });
      writeFileSync(todayFile, JSON.stringify(rotationEvent) + "\n", { flag: "a" });

      logInfo("rotate-sessions: agent done", { agent, rotated, skipped });
    }
  }

  logInfo("rotate-sessions: complete", {
    agents: agents.length,
    rotated: totalRotated,
    skipped: totalSkipped,
    rotatedAgents,
  });
}

if (import.meta.main) {
  main().catch((error) => {
    logError("rotate-sessions: failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
