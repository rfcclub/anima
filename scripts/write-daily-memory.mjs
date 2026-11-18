#!/usr/bin/env node
/**
 * write-daily-memory.mjs
 * Appends a memory entry to today's memory_YYYYMMdd.jsonl in $ANIMA_ROOM_DIR/memory/
 * Usage: node write-daily-memory.mjs --type <type> --topic <topic> --content <text>
 *        or pipe JSON: echo '{"type":"lesson","topic":"...","content":"..."}' | node write-daily-memory.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const roomDir = process.env.ANIMA_ROOM_DIR;
if (!roomDir) {
  process.stderr.write("ANIMA_ROOM_DIR not set\n");
  process.exit(0);
}

const memoryDir = join(roomDir, "memory");
if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

function dateTag() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

async function getEntry() {
  // pipe mode
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw) return JSON.parse(raw);
  }

  // arg mode: --type lesson --topic X --content Y
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const type = get("--type") ?? "note";
  const topic = get("--topic");
  const content = get("--content");

  if (!content) {
    process.stderr.write("--content required\n");
    process.exit(1);
  }

  return { type, ...(topic ? { topic } : {}), content };
}

const entry = await getEntry();
const record = { ts: new Date().toISOString(), ...entry };
const path = join(memoryDir, `memory_${dateTag()}.jsonl`);
writeFileSync(path, JSON.stringify(record) + "\n", { flag: "a" });
process.stdout.write(`wrote: ${path}\n`);
