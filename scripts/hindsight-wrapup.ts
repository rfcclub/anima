#!/usr/bin/env bun
/**
 * Ingest an end-of-session wrap-up into a Hindsight bank as one `wrapup` document.
 *
 * Run: bun scripts/hindsight-wrapup.ts --bank <bank> --session <id> --file <wrapup.md>
 *   or pipe the wrap-up on stdin. Exit 1 when the wrap-up is incomplete or the write failed.
 *
 * The document id comes from the session id, so running this again for the same session
 * replaces the earlier document instead of adding a second one.
 */
import { readFileSync } from "node:fs";
import { retainWrapup, WRAPUP_SECTIONS } from "../src/memory/hindsight-wrapup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const bank = arg("bank");
const sessionId = arg("session");
if (!bank || !sessionId) {
  console.error("usage: hindsight-wrapup.ts --bank <bank> --session <id> [--file <wrapup.md>]");
  console.error(`sections, in order:\n${WRAPUP_SECTIONS.join("\n")}`);
  process.exit(2);
}

const file = arg("file");
const content = file ? readFileSync(file, "utf-8") : await Bun.stdin.text();

try {
  const result = await retainWrapup({ bank, sessionId, content });
  console.log(JSON.stringify(result));
  if (result.outcome !== "ok") process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "wrap-up failed");
  process.exitCode = 1;
}
