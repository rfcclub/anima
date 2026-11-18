#!/usr/bin/env node
/**
 * read-daily-memory.mjs
 * Reads today's and yesterday's memory_YYYYMMdd.jsonl from $ANIMA_ROOM_DIR/memory/
 * Outputs formatted text for injection into agent context via extraActions.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const roomDir = process.env.ANIMA_ROOM_DIR;
if (!roomDir) {
  process.stderr.write("ANIMA_ROOM_DIR not set\n");
  process.exit(0); // soft fail — don't block boot
}

const memoryDir = join(roomDir, "memory");

function dateTag(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function readMemoryFile(tag) {
  const path = join(memoryDir, `memory_${tag}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function formatEntry(entry) {
  const parts = [];
  if (entry.topic) parts.push(`[${entry.type ?? "note"}:${entry.topic}]`);
  else parts.push(`[${entry.type ?? "note"}]`);
  parts.push(entry.content ?? "");
  return parts.join(" ");
}

const days = [0, 1, 2]; // today, yesterday, day before
const sections = [];

for (const offset of days) {
  const tag = dateTag(offset);
  const entries = readMemoryFile(tag);
  if (entries.length === 0) continue;
  const label = offset === 0 ? "Today" : offset === 1 ? "Yesterday" : "2 days ago";
  sections.push(`## ${label} (${tag})\n` + entries.map(formatEntry).join("\n"));
}

if (sections.length === 0) {
  process.exit(0); // nothing to inject
}

process.stdout.write(sections.join("\n\n") + "\n");
