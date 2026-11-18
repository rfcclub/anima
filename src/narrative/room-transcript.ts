import { join, resolve, sep } from "node:path";
import { mkdirSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface TranscriptTurn {
  speaker: string; // agent id, "user", or "narrator"
  role: "user" | "assistant" | "narrator";
  content: string;
  ts: number;
}

const DEFAULT_TRANSCRIPTS_DIR = () =>
  process.env.ANIMA_TRANSCRIPTS_DIR ?? join(homedir(), ".anima", "rooms", "_shared", "transcripts");

function transcriptPath(roomId: string, dir?: string): string {
  // roomId keys a transcript file (owner id / topic). Reject anything outside
  // [a-zA-Z0-9_-] so a caller can never pass `../` or an absolute path and
  // escape the transcripts directory. Defense-in-depth: existing callers
  // (talk.ts ownerId from the roster, castle/routes.ts URL regex) already
  // constrain this, but the function's own contract must not be traversable.
  if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
    throw new Error(`Invalid roomId: ${JSON.stringify(roomId)}`);
  }
  const base = resolve(dir ?? DEFAULT_TRANSCRIPTS_DIR());
  const target = resolve(join(base, `${roomId}.jsonl`));
  if (!target.startsWith(base + sep)) {
    throw new Error(`Transcript path escapes base directory: ${target}`);
  }
  return target;
}

/** Append a turn to a room's transcript (JSONL, one turn per line).
 *  Creates the directory + file if missing. The room id is the owner id
 *  (transcript keyed by chamber owner, not per-agent session). */
export function appendTurn(
  roomId: string,
  turn: Omit<TranscriptTurn, "ts"> & { ts?: number },
  dir?: string,
): TranscriptTurn {
  const path = transcriptPath(roomId, dir);
  mkdirSync(join(path, ".."), { recursive: true });
  const full: TranscriptTurn = { ...turn, ts: turn.ts ?? Date.now() };
  appendFileSync(path, JSON.stringify(full) + "\n", "utf8");
  return full;
}

/** Read the full transcript for a room. Returns [] if none exists. */
export function readTranscript(roomId: string, dir?: string): TranscriptTurn[] {
  const path = transcriptPath(roomId, dir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l) as TranscriptTurn);
}
