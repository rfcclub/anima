import { mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { JsonlEvent, RecoveryInfo, Store } from "./jsonl-store";

/**
 * DualStore writes events to both SQLite (via SqliteStore) AND JSONL files
 * (via JsonlStore). SQLite is used for query-ability (UI history), JSONL
 * for human readability and git tracking.
 */
export class DualStore implements Store {
  constructor(
    private readonly sqlite: Store,
    private readonly jsonlBaseDir: string,
  ) {}

  append(agent: string, event: JsonlEvent): void {
    // Write to SQLite
    this.sqlite.append(agent, event);

    // Write to JSONL file
    const date = event.timestamp.slice(0, 10);
    const dir = join(this.jsonlBaseDir, "rooms", agent, "sessions");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(event) + "\n";
    appendFileSync(join(dir, `${date}.jsonl`), line, "utf-8");
  }

  readDate(agent: string, date: string): JsonlEvent[] {
    return this.sqlite.readDate(agent, date);
  }

  readRecent(agent: string, count: number): JsonlEvent[] {
    return this.sqlite.readRecent(agent, count);
  }

  recover(_agent: string, _date: string): RecoveryInfo | null {
    return null; // SQLite doesn't need recovery
  }
}
