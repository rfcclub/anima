#!/usr/bin/env bun
/**
 * Ingest an end-of-session wrap-up into a Hindsight bank as one `wrapup` document.
 *
 * Run: bun scripts/hindsight-wrapup.ts --bank <bank> --session <id> --file <wrapup.md>
 *   or pipe the wrap-up on stdin. Exit 0 only when the server retained the document; exit 1 when
 *   the wrap-up is incomplete, the write failed, or the server only queued it.
 *
 * The document id comes from the session id, so running this again for the same session addresses
 * the same document instead of adding a second one.
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

// retainWrapup never throws: an incomplete wrap-up or a failed write is an `error` outcome.
const result = await retainWrapup({ bank, sessionId, content });
console.log(JSON.stringify(result));
if (result.outcome !== "ok") {
  // `queued` is not retained: say so, with the operation id to check, rather than claiming a write.
  console.error(result.reason ?? result.outcome);
  process.exitCode = 1;
}
