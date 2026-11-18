#!/usr/bin/env bun
/**
 * Import last 3 days of sessions from Claude Code, Hermes, and ANIMA CLI
 * into ~/.anima/memory.db as cross-platform context for agents.
 *
 * Run: bun scripts/import-cross-platform.ts [--days N] [--dry-run]
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const DAYS = parseInt(args.find(a => a.startsWith("--days="))?.split("=")[1] ?? "3");
const CUTOFF = new Date(Date.now() - DAYS * 86400_000);
const DB_PATH = process.env.ANIMA_MEMORY_DB ?? join(homedir(), ".anima", "memory.db");

// --- DB setup ---
function openDb(): Database {
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode=WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id        INTEGER PRIMARY KEY,
      namespace TEXT    NOT NULL,
      content   TEXT    NOT NULL,
      type      TEXT    NOT NULL DEFAULT 'observation',
      timestamp TEXT    NOT NULL,
      metadata  TEXT,
      hash      TEXT    UNIQUE
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_mem_ns ON memories(namespace)");
  // Add hash column for dedup if not already present
  try { db.run("ALTER TABLE memories ADD COLUMN hash TEXT"); } catch {}
  try { db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_hash ON memories(hash)"); } catch {}
  return db;
}

function insertMemory(db: Database, entry: {
  namespace: string; type: string; content: string;
  metadata: Record<string, unknown>; ts: string;
}): boolean {
  const hash = createHash("sha256")
    .update(entry.namespace + entry.content)
    .digest("hex").slice(0, 16);
  const result = db.run(
    `INSERT OR IGNORE INTO memories (namespace, type, content, metadata, timestamp, hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.namespace, entry.type, entry.content,
     JSON.stringify(entry.metadata), entry.ts, hash],
  );
  return (result.changes ?? 0) > 0;
}

// --- Claude Code ---
function importClaudeCode(db: Database): number {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return 0;

  let count = 0;
  for (const project of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, project);
    let files: string[];
    try {
      files = readdirSync(projectDir)
        .filter(f => f.endsWith(".jsonl") && !f.includes("subagents"))
        .map(f => join(projectDir, f))
        .filter(f => statSync(f).mtime >= CUTOFF);
    } catch { continue; }

    for (const file of files) {
      try {
        const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
        const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

        // Extract title and first user message
        const title = events.find(e => e.type === "ai-title")?.aiTitle ?? "";
        const firstUser = events.find(e => e.type === "user")?.message?.content;
        const userText = typeof firstUser === "string"
          ? firstUser.slice(0, 200)
          : Array.isArray(firstUser)
          ? (firstUser.find((b: {type:string;text?:string}) => b.type === "text")?.text ?? "").slice(0, 200)
          : "";

        if (!userText && !title) continue;

        const ts = events.find(e => e.timestamp)?.timestamp ?? new Date().toISOString();
        if (new Date(ts) < CUTOFF) continue;

        const projectName = project.replace(/^-home-owner-/, "~/").replace(/-/g, "/");
        const content = [
          `[Claude Code] ${projectName}`,
          title ? `Title: ${title}` : "",
          userText ? `First message: ${userText}` : "",
        ].filter(Boolean).join("\n");

        if (!DRY_RUN) {
          const inserted = insertMemory(db, {
            namespace: "cross-platform",
            type: "session",
            content,
            metadata: { platform: "claude-code", project: projectName, file: basename(file) },
            ts,
          });
          if (inserted) count++;
        } else {
          console.log("[dry-run] claude-code:", content.slice(0, 100));
          count++;
        }
      } catch { continue; }
    }
  }
  return count;
}

// --- Hermes ---
function importHermes(db: Database): number {
  const sessionsDir = join(homedir(), ".hermes", "sessions");
  if (!existsSync(sessionsDir)) return 0;

  let count = 0;
  const files = readdirSync(sessionsDir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => join(sessionsDir, f))
    .filter(f => statSync(f).mtime >= CUTOFF);

  for (const file of files) {
    try {
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      const turns = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter((l): l is {role:string;content:string;timestamp:string} => !!l?.role);

      if (turns.length === 0) continue;

      const firstUser = turns.find(t => t.role === "user");
      if (!firstUser) continue;

      const ts = firstUser.timestamp ?? new Date().toISOString();
      if (new Date(ts) < CUTOFF) continue;

      // Get agent from filename pattern YYYYMMDD_HHMMSS_hash.jsonl
      const sessionId = basename(file, ".jsonl");
      const content = [
        `[Hermes] session ${sessionId}`,
        `First message: ${firstUser.content.slice(0, 200)}`,
      ].join("\n");

      if (!DRY_RUN) {
        const inserted = insertMemory(db, {
          namespace: "cross-platform",
          type: "session",
          content,
          metadata: { platform: "hermes", sessionId, file: basename(file) },
          ts,
        });
        if (inserted) count++;
      } else {
        console.log("[dry-run] hermes:", content.slice(0, 100));
        count++;
      }
    } catch { continue; }
  }
  return count;
}

// --- ANIMA CLI sessions (already in sessions.db — extract recent summaries) ---
function importAnimaSessions(db: Database): number {
  const sessionsDb = process.env.ANIMA_SESSIONS_DB ?? join(homedir(), ".anima", "sessions.db");
  if (!existsSync(sessionsDb)) return 0;

  const src = new Database(sessionsDb, { readonly: true });
  const cutoffStr = CUTOFF.toISOString();
  const rows = src.query<{agent:string;date:string;count:number}, []>(
    `SELECT agent, date, COUNT(*) as count FROM events
     WHERE ts >= ? GROUP BY agent, date ORDER BY date DESC`,
  ).all(cutoffStr);

  let count = 0;
  for (const row of rows) {
    const content = `[ANIMA] agent=${row.agent} date=${row.date} turns=${row.count}`;
    if (!DRY_RUN) {
      const inserted = insertMemory(db, {
        namespace: "cross-platform",
        type: "session",
        content,
        metadata: { platform: "anima", agent: row.agent, date: row.date },
        ts: `${row.date}T12:00:00Z`,
      });
      if (inserted) count++;
    } else {
      console.log("[dry-run] anima:", content);
      count++;
    }
  }
  src.close();
  return count;
}

// --- Main ---
function main() {
  console.log(`Importing last ${DAYS} days from Claude Code, Hermes, ANIMA...`);
  console.log(`Target: ${DB_PATH}${DRY_RUN ? " (DRY RUN)" : ""}`);

  const db = DRY_RUN ? null : openDb();

  const cc = importClaudeCode(db!);
  const h = importHermes(db!);
  const a = importAnimaSessions(db!);

  db?.close();

  console.log(`\nInserted: ${cc} Claude Code, ${h} Hermes, ${a} ANIMA sessions`);
  console.log(`Total: ${cc + h + a} new memories in cross-platform namespace`);
}

main();
