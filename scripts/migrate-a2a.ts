#!/usr/bin/env bun
/**
 * Migration script: converts existing JSONL-based A2A messages from
 * rooms/_meeting/{topic}/{date}.md into the a2a_messages SQLite table.
 *
 * Usage:
 *   bun scripts/migrate-a2a.ts
 *   ANIMA_ROOMS_DIR=/custom/rooms bun scripts/migrate-a2a.ts
 *
 * What it does:
 *   1. Scans `rooms/_meeting/<topic>/YYYY-MM-DD.md` files
 *   2. Parses YAML frontmatter to extract A2A messages
 *   3. Inserts each message into the `a2a_messages` table in sessions.db
 *   4. Archives processed files to `rooms/_meeting/archive/`
 *
 * Idempotent: skips files already in archive/.
 * Safe: will not delete or modify original files until archived.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { A2AStore } from "../src/memory/a2a-store";

interface FrontMatterMessage {
  from?: string;
  to?: string;
  timestamp?: string | Date;
  topic?: string;
  turn?: number;
}

function roomsDir(): string {
  return resolve(
    process.env.ANIMA_ROOMS_DIR ?? join(process.cwd(), "rooms"),
  );
}

function dbPath(): string {
  return process.env.ANIMA_SESSIONS_DB ?? join(homedir(), ".anima", "sessions.db");
}

async function migrate(): Promise<{ migrated: number; archived: number; errors: number }> {
  const meetingDir = join(roomsDir(), "_meeting");
  const archiveDir = join(meetingDir, "archive");

  if (!existsSync(meetingDir)) {
    console.log("No _meeting/ directory found — nothing to migrate.");
    return { migrated: 0, archived: 0, errors: 0 };
  }

  const store = new A2AStore(dbPath());
  let migrated = 0;
  let errors = 0;

  try {
    const topics = await readdir(meetingDir, { withFileTypes: true });

    for (const topicEntry of topics) {
      if (!topicEntry.isDirectory() || topicEntry.name === "archive") continue;

      const topicDir = join(meetingDir, topicEntry.name);
      const files = await readdir(topicDir, { withFileTypes: true });

      for (const fileEntry of files) {
        if (!fileEntry.isFile() || !/^\d{4}-\d{2}-\d{2}\.md$/.test(fileEntry.name)) continue;

        const filePath = join(topicDir, fileEntry.name);
        const content = await readFile(filePath, "utf-8");

        try {
          const message = parseFrontMatter(content, topicEntry.name);
          if (!message) continue;

          // For each message, the body is the content after frontmatter
          const body = extractBody(content);

          // Determine subject from topic + turn
          const subject = `[${message.topic}] turn ${message.turn}`;

          // Check if this message was already migrated (deduplicate by subject and body)
          const existing = store.readInbox(message.to ?? "unknown");
          const alreadyExists = existing.some(
            (m) => m.subject === subject && m.body.trim() === body.trim(),
          );

          if (!alreadyExists) {
            store.send({
              from: message.from ?? "unknown",
              to: message.to ?? "unknown",
              subject,
              body,
              thread_id: undefined,
            });
          }

          migrated++;

          // Move file to archive
          await mkdir(archiveDir, { recursive: true });
          const archivePath = join(archiveDir, `${topicEntry.name}_${fileEntry.name}`);
          await rename(filePath, archivePath);
        } catch (err) {
          console.error(`Error migrating ${filePath}:`, err);
          errors++;
        }
      }
    }
  } finally {
    store.close();
  }

  return { migrated, archived: migrated, errors };
}

function parseFrontMatter(content: string, topicName: string): FrontMatterMessage | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const endOfFirst = trimmed.indexOf("\n", 3);
  if (endOfFirst === -1) return null;

  const closing = trimmed.indexOf("\n---", endOfFirst + 1);
  if (closing === -1) return null;

  const yamlBlock = trimmed.slice(endOfFirst + 1, closing);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlBlock, { schema: yaml.FAILSAFE_SCHEMA });
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const front = parsed as Record<string, unknown>;

  return {
    from: typeof front.from === "string" ? front.from : undefined,
    to: typeof front.to === "string" ? front.to : undefined,
    timestamp: front.timestamp instanceof Date ? front.timestamp.toISOString() : typeof front.timestamp === "string" ? front.timestamp : undefined,
    topic: typeof front.topic === "string" ? front.topic : topicName,
    turn: typeof front.turn === "number" ? front.turn : 1,
  };
}

function extractBody(content: string): string {
  const trimmed = content.trimStart();
  const endOfFirst = trimmed.indexOf("\n", 3);
  if (endOfFirst === -1) return trimmed;

  const closing = trimmed.indexOf("\n---", endOfFirst + 1);
  if (closing === -1) return trimmed;

  return trimmed.slice(closing + 4).trim();
}

// Allow running directly OR importing for testing
if (import.meta.main) {
  migrate()
    .then((result) => {
      console.log(`Migration complete: ${result.migrated} migrated, ${result.errors} errors`);
      process.exit(result.errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export { migrate };
