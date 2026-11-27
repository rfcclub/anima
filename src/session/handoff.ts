import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Handoff written before a session is reset (#669). A reset drops the session's context, so the agent
 * writes what the next session must not forget into one well-known file in its room; the previous ones
 * are kept as dated copies and the next session loads the file as boot context.
 */
export const HANDOFF_FILE = "HANDOFF.md";
/** Subdirectory of the room holding the dated copies of the previous handoffs. */
export const HANDOFF_ARCHIVE_DIR = "handoffs";
/** How many dated copies are kept. */
export const HANDOFF_ARCHIVE_KEEP = 7;
/** The handoff is boot context, not conversation: cap it when it is injected into the prompt. */
export const HANDOFF_MAX_CHARS = 8_000;

/** What the handoff turn asks of the agent. The platform fixes only where it goes, not what it says. */
export const HANDOFF_PROMPT = `[Handoff] Your conversational session is about to end, and the next session starts from this note instead of the conversation.

Write your handoff to the file ${HANDOFF_FILE} in your room (relative to your room directory). Replace the whole file; the previous version is archived automatically. Keep it short.

Cover:
- what you were doing
- what is still open
- what you promised anyone
- what the next session must not forget

Write the file with your own tools. Nothing else is required of you in this turn.`;

export function handoffPath(roomDir: string): string {
  return join(roomDir, HANDOFF_FILE);
}

export function handoffArchiveDir(roomDir: string): string {
  return join(roomDir, "staging", HANDOFF_ARCHIVE_DIR);
}

/** The current handoff, or undefined when the agent has not written one. */
export async function readHandoff(roomDir: string): Promise<string | undefined> {
  try {
    const content = await readFile(handoffPath(roomDir), "utf-8");
    return content.trim().length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replace the handoff, keeping the version it replaces as a dated copy in `staging/handoffs/` and pruning
 * the archive to the newest `HANDOFF_ARCHIVE_KEEP` copies. Returns the path written.
 */
export async function writeHandoff(roomDir: string, content: string, now: Date = new Date()): Promise<string> {
  const target = handoffPath(roomDir);
  const archiveDir = handoffArchiveDir(roomDir);
  if (existsSync(target)) {
    await mkdir(archiveDir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const previous = await readFile(target, "utf-8").catch(() => "");
    if (previous.trim().length > 0) {
      await writeFile(join(archiveDir, `HANDOFF-${stamp}.md`), previous, "utf-8");
    }
  }
  await writeFile(target, content, "utf-8");
  await pruneHandoffArchive(roomDir);
  return target;
}

async function pruneHandoffArchive(roomDir: string): Promise<void> {
  const archiveDir = handoffArchiveDir(roomDir);
  let files: string[];
  try {
    files = await readdir(archiveDir);
  } catch {
    return;
  }
  const copies = files.filter((f) => f.startsWith("HANDOFF-") && f.endsWith(".md")).sort();
  const excess = copies.length - HANDOFF_ARCHIVE_KEEP;
  for (const file of copies.slice(0, Math.max(0, excess))) {
    try {
      await unlink(join(archiveDir, file));
    } catch {
      // best-effort — a copy already removed by a concurrent run is fine
    }
  }
}

export interface HandoffContextFile {
  path: string;
  label?: string;
  content: string;
  maxChars?: number;
}

/**
 * The handoff as a boot-context file, or undefined when there is none. Appended to the agent's loaded
 * session-context files so a fresh session starts from the handoff plus the consolidated memory.
 */
export async function handoffSessionContext(roomDir: string): Promise<HandoffContextFile | undefined> {
  const content = await readHandoff(roomDir);
  if (!content) return undefined;
  return { path: HANDOFF_FILE, label: "Handoff", content, maxChars: HANDOFF_MAX_CHARS };
}

/** Insert the handoff into a loaded agent's session-context files (first, so it survives truncation). */
export async function withHandoffContext<T extends HandoffContextFile>(
  roomDir: string,
  files: T[],
): Promise<Array<T | HandoffContextFile>> {
  const handoff = await handoffSessionContext(roomDir);
  if (!handoff) return files;
  return [handoff as T, ...files];
}
