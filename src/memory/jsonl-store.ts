import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export interface JsonlEvent {
  timestamp: string;
  type: string;
  sessionId: string;
  [key: string]: unknown;
}

export interface RecoveryInfo {
  linesDiscarded: number;
  date: string;
  agent: string;
}

export interface Store {
  append(agent: string, event: JsonlEvent): void;
  readDate(agent: string, date: string): JsonlEvent[];
  readRecent(agent: string, count: number): JsonlEvent[];
  recover?(agent: string, date: string): RecoveryInfo | null;
}

/**
 * Append-only JSONL store with atomic writes and tail-corruption recovery.
 *
 * Files are stored at `rooms/{agent}/sessions/{YYYY-MM-DD}.jsonl`.
 * Writes are atomic: content is written to a `.tmp` file, then atomically
 * renamed over the target file via `renameSync` (atomic on Linux within
 * the same filesystem).
 */
export class JsonlStore implements Store {
  constructor(private readonly baseDir: string = process.cwd()) {}

  /* ------------------------------------------------------------------ */
  /*  Public API                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Append an event to the agent's session file for the event's date.
   * Creates the sessions directory and file if they don't exist.
   * Write is atomic via temp file + rename.
   */
  append(agent: string, event: JsonlEvent): void {
    const date = extractDate(event.timestamp);
    const filePath = this.sessionPath(agent, date);
    const dir = this.sessionsDir(agent);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const tmpPath = filePath + ".tmp";
    const line = JSON.stringify(event) + "\n";

    // Read existing content (empty string if file doesn't exist yet)
    let existing = "";
    if (existsSync(filePath)) {
      existing = readFileSync(filePath, "utf-8");
    }

    writeFileSync(tmpPath, existing + line, "utf-8");
    renameSync(tmpPath, filePath);
  }

  /**
   * Read the `count` most recent events across all session files
   * for an agent. Files are scanned newest-first by filename (date).
   */
  readRecent(agent: string, count: number): JsonlEvent[] {
    const dir = this.sessionsDir(agent);
    if (!existsSync(dir)) return [];

    const files = this.listSessionFiles(dir);
    // Most recent files first (descending date)
    files.sort().reverse();

    const events: JsonlEvent[] = [];
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      const lines = content.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          events.push(JSON.parse(lines[i]) as JsonlEvent);
        } catch {
          continue; // skip corrupt lines in read path
        }
        if (events.length >= count) {
          return events.slice(0, count);
        }
      }
    }

    return events;
  }

  /**
   * Read all events for a specific agent on a specific date.
   * Date is in `YYYY-MM-DD` format.
   */
  readDate(agent: string, date: string): JsonlEvent[] {
    const filePath = this.sessionPath(agent, date);
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, "utf-8");
    const events: JsonlEvent[] = [];

    for (const line of content.split("\n").filter(Boolean)) {
      try {
        events.push(JSON.parse(line) as JsonlEvent);
      } catch {
        continue;
      }
    }

    return events;
  }

  /**
   * Detect and repair tail corruption in a session file.
   *
   * Scans the file line by line. If the last line fails to parse as JSON,
   * it is discarded and a `recovery` event is appended. Returns
   * `RecoveryInfo` if recovery was performed, or `null` if the file was
   * clean or didn't exist.
   */
  recover(agent: string, date: string): RecoveryInfo | null {
    const filePath = this.sessionPath(agent, date);
    if (!existsSync(filePath)) return null;

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    // Remove trailing empty line from split
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    if (lines.length === 0) return null;

    // Check if the last line is valid JSON
    const lastLine = lines[lines.length - 1];
    try {
      JSON.parse(lastLine);
      return null; // clean
    } catch {
      // Corrupted — discard the last line
      const cleanContent = lines.slice(0, -1).join("\n") + "\n";
      writeFileSync(filePath + ".tmp", cleanContent, "utf-8");
      renameSync(filePath + ".tmp", filePath);

      // Append recovery event
      const recoveryEvent: JsonlEvent = {
        timestamp: `${date}T00:00:00.000Z`,
        type: "recovery",
        sessionId: "system",
        reason: "truncated_tail",
        linesDiscarded: 1,
      };
      this.append(agent, recoveryEvent);

      return {
        linesDiscarded: 1,
        date,
        agent,
      };
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internal helpers                                                  */
  /* ------------------------------------------------------------------ */

  private sessionPath(agent: string, date: string): string {
    return join(this.baseDir, "rooms", agent, "sessions", `${date}.jsonl`);
  }

  private sessionsDir(agent: string): string {
    return join(this.baseDir, "rooms", agent, "sessions");
  }

  private listSessionFiles(dir: string): string[] {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  }
}

/** Extract the YYYY-MM-DD date portion from an ISO 8601 timestamp string. */
export function extractDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}
