/**
 * The handoff note a work session leaves for the next one: `<work root>/tmp/AGENT_HANDOFF_<session id>.md`.
 * It is read without following worker-controlled links or special files, and the same checks tell the model
 * during the handoff task what is still wrong with its note.
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { HANDOFF_MAX_CHARS } from "./work-order";

export const handoffFileName = (sessionId: string) => `AGENT_HANDOFF_${sessionId}.md`;

/** The note's text, or why it cannot be used. */
export function inspectHandoffNote(workRoot: string, sessionId: string): { text: string } | { problem: string } {
  const where = `../tmp/${handoffFileName(sessionId)}`;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) return { problem: "the session id cannot name a note" };
  const dir = join(workRoot, "tmp");
  const maxBytes = HANDOFF_MAX_CHARS * 3;
  try {
    if (realpathSync(dir) !== dir) return { problem: "the work's tmp directory is not where it should be" };
  } catch {
    return { problem: `${where} does not exist yet` };
  }
  let fd: number;
  try {
    fd = openSync(join(dir, handoffFileName(sessionId)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { problem: `${where} does not exist yet (or is a link)` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: `${where} is not a regular file` };
    if (stat.nlink !== 1) return { problem: `${where} must not be a hard link` };
    if (stat.size === 0) return { problem: `${where} is empty` };
    if (stat.size > maxBytes) return { problem: `${where} is too long: keep it under ${HANDOFF_MAX_CHARS} characters` };
    const buffer = Buffer.alloc(stat.size + 1);
    const bytes = readSync(fd, buffer);
    if (bytes !== stat.size) return { problem: `${where} changed while it was read` };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
    } catch {
      return { problem: `${where} is not valid UTF-8` };
    }
    if (text.length > HANDOFF_MAX_CHARS) return { problem: `${where} has ${text.length} characters; the limit is ${HANDOFF_MAX_CHARS}` };
    return { text };
  } catch {
    return { problem: `${where} could not be read` };
  } finally {
    closeSync(fd);
  }
}

/** The usable note, or undefined: a missing or unreadable note leaves the existing fallback in effect. */
export function readHandoffNote(workRoot: string, sessionId: string): string | undefined {
  const note = inspectHandoffNote(workRoot, sessionId);
  return "text" in note ? note.text : undefined;
}
