#!/usr/bin/env bun
/**
 * Ingest an end-of-session wrap-up into a Hindsight bank as one `wrapup` document.
 *
 * Run: bun scripts/hindsight-wrapup.ts --bank <bank> --session <id> --file <wrapup.md>
 *   or pipe the wrap-up on stdin, which is read under a deadline (`--stdin-timeout-ms`) so an
 *   opened-and-never-written pipe cannot hold the CLI open. Exit 0 only when the server retained
 *   the document; exit 1 when the wrap-up is incomplete, the write failed, the server only queued
 *   it, or no wrap-up arrived on stdin in time.
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
  console.error(
    "usage: hindsight-wrapup.ts --bank <bank> --session <id> [--file <wrapup.md>] [--stdin-timeout-ms <n>]",
  );
  console.error(`sections, in order:\n${WRAPUP_SECTIONS.join("\n")}`);
  process.exit(2);
}

/** A stdin that is opened and never written closes only on the writer; bound the wait. */
const DEFAULT_STDIN_TIMEOUT_MS = 5_000;

function stdinTimeoutMs(): number {
  const raw = arg("stdin-timeout-ms");
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STDIN_TIMEOUT_MS;
}

/** Read stdin to the end, or reject once the deadline passes, so the CLI always terminates. */
async function readStdin(timeoutMs: number): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("stdin-timeout")), timeoutMs);
  });
  try {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf-8");
  } finally {
    if (timer) clearTimeout(timer);
    // Release the stream so a held-open pipe does not keep the process alive.
    await reader.cancel().catch(() => {});
  }
}

/** The wrap-up text, or an `error` the caller reports: stdin is bounded like the retain itself. */
async function readContent(): Promise<{ content: string } | { error: string }> {
  const file = arg("file");
  if (file) return { content: readFileSync(file, "utf-8") };
  try {
    return { content: await readStdin(stdinTimeoutMs()) };
  } catch (error) {
    return { error: error instanceof Error && error.message === "stdin-timeout" ? "stdin-timeout" : "stdin-unreadable" };
  }
}

const read = await readContent();
if ("error" in read) {
  console.log(JSON.stringify({ outcome: "error", reason: read.error }));
  console.error(`no wrap-up on stdin (${read.error}); pass --file or close stdin`);
  process.exitCode = 1;
} else {
  // retainWrapup never throws: an incomplete wrap-up or a failed write is an `error` outcome.
  const result = await retainWrapup({ bank, sessionId, content: read.content });
  console.log(JSON.stringify(result));
  if (result.outcome !== "ok") {
    // `queued` is not retained: say so, with the operation id to check, rather than claiming a write.
    console.error(result.reason ?? result.outcome);
    process.exitCode = 1;
  }
}
