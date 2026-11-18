#!/usr/bin/env bun
/**
 * One-time migration: reads all rooms/<agent>/sessions/<date>.jsonl files,
 * inserts events into SQLite, then renames .jsonl → .jsonl.bak.
 *
 * Idempotent: UNIQUE(agent, date, idx) ON CONFLICT IGNORE means re-running
 * against existing .bak files (if restored) won't duplicate rows.
 */
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SqliteStore } from "../src/memory/sqlite-store";

const ROOMS_DIR = join(process.cwd(), "rooms");
const DB_PATH = process.env.ANIMA_SESSIONS_DB ?? join(homedir(), ".anima", "sessions.db");

function main() {
  if (!existsSync(ROOMS_DIR)) {
    console.log("No rooms/ directory found, nothing to migrate.");
    return;
  }

  const store = new SqliteStore(DB_PATH);
  console.log(`Migrating JSONL sessions to ${DB_PATH}`);

  let totalEvents = 0;
  let totalFiles = 0;

  const agents = readdirSync(ROOMS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const agent of agents) {
    const sessionsDir = join(ROOMS_DIR, agent, "sessions");
    if (!existsSync(sessionsDir)) continue;

    const files = readdirSync(sessionsDir).filter(
      (f) => f.endsWith(".jsonl") && !f.endsWith(".jsonl.bak"),
    );

    for (const file of files) {
      const filePath = join(sessionsDir, file);
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);

      let fileEvents = 0;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          store.append(agent, event);
          fileEvents++;
        } catch {
          console.warn(`  Skipping corrupt line in ${filePath}`);
        }
      }

      renameSync(filePath, filePath + ".bak");
      console.log(`  ${agent}/${file}: ${fileEvents} events → .jsonl.bak`);
      totalEvents += fileEvents;
      totalFiles++;
    }
  }

  console.log(`\nMigration complete: ${totalEvents} events from ${totalFiles} files.`);
}

main();
