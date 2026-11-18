import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface CrossingEntry {
  sessionId: string;
  timestamp: string;
  carriesForward: string[];
  unresolved: string[];
  notes: string;
  status: "complete" | "partial" | "missing" | "not_applicable";
  /** Growth-ring entries: "Held: X" / "Shifted: Y" documenting what persisted and what changed */
  growthRings?: string[];
  /** Pre-compaction identity snapshot: free-text anchor block preserving identity across context resets */
  compactionAnchor?: string;
}

export interface CrossingStreak {
  current: number;
  lastCrossed: string | null;
  alert: boolean;
}

export interface CrossingStatus {
  entry: CrossingEntry | null;
  streak: CrossingStreak;
}

export interface CrossingManagerOptions {
  minSessionEvents?: number;
  streakAlertThreshold?: number;
}

const DEFAULT_MIN_SESSION_EVENTS = 3;
const DEFAULT_STREAK_ALERT_THRESHOLD = 3;

export class CrossingManager {
  private readonly minSessionEvents: number;
  private readonly streakAlertThreshold: number;

  constructor(options: CrossingManagerOptions = {}) {
    this.minSessionEvents = options.minSessionEvents ?? DEFAULT_MIN_SESSION_EVENTS;
    this.streakAlertThreshold = options.streakAlertThreshold ?? DEFAULT_STREAK_ALERT_THRESHOLD;
  }

  async load(roomDir: string): Promise<CrossingEntry | null> {
    const crossingPath = join(roomDir, "staging", "crossing.md");
    if (!existsSync(crossingPath)) return null;

    const raw = await readFile(crossingPath, "utf-8");
    return this.parse(raw);
  }

  parse(content: string): CrossingEntry | null {
    const lines = content.split("\n");
    const entry: CrossingEntry = {
      sessionId: "",
      timestamp: "",
      carriesForward: [],
      unresolved: [],
      notes: "",
      status: "missing",
    };

    let section: "header" | "carries" | "growthRings" | "compactionAnchor" | "unresolved" | "notes" = "header";
    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("sessionId:")) {
        entry.sessionId = trimmed.slice("sessionId:".length).trim();
      } else if (trimmed.startsWith("timestamp:")) {
        entry.timestamp = trimmed.slice("timestamp:".length).trim();
      } else if (trimmed.startsWith("status:")) {
        const s = trimmed.slice("status:".length).trim();
        if (["complete", "partial", "missing", "not_applicable"].includes(s)) {
          entry.status = s as CrossingEntry["status"];
        }
      } else if (trimmed === "## Carrying Forward") {
        section = "carries";
      } else if (trimmed === "## Growth Rings") {
        section = "growthRings";
        entry.growthRings = [];
      } else if (trimmed === "## Compaction Anchor") {
        section = "compactionAnchor";
        entry.compactionAnchor = "";
      } else if (trimmed === "## Unresolved") {
        section = "unresolved";
      } else if (trimmed === "## Notes") {
        section = "notes";
      } else if (trimmed.startsWith("- ") && section === "carries") {
        entry.carriesForward.push(trimmed.slice(2));
      } else if (trimmed.startsWith("- ") && section === "growthRings") {
        entry.growthRings!.push(trimmed.slice(2));
      } else if (section === "compactionAnchor" && trimmed.length > 0 && !trimmed.startsWith("#")) {
        entry.compactionAnchor += (entry.compactionAnchor ? "\n" : "") + trimmed;
      } else if (trimmed.startsWith("- ") && section === "unresolved") {
        entry.unresolved.push(trimmed.slice(2));
      } else if (section === "notes" && trimmed.length > 0 && !trimmed.startsWith("#")) {
        entry.notes += (entry.notes ? "\n" : "") + trimmed;
      }
    }

    if (!entry.sessionId) return null;
    return entry;
  }

  async write(roomDir: string, entry: CrossingEntry): Promise<void> {
    const stagingDir = join(roomDir, "staging");
    await mkdir(stagingDir, { recursive: true });

    const lines: string[] = [
      `sessionId: ${entry.sessionId}`,
      `timestamp: ${entry.timestamp}`,
      `status: ${entry.status}`,
      "",
      "## Carrying Forward",
      ...entry.carriesForward.map((c) => `- ${c}`),
      "",
    ];

    if (entry.growthRings && entry.growthRings.length > 0) {
      lines.push("## Growth Rings");
      lines.push(...entry.growthRings.map((g) => `- ${g}`));
      lines.push("");
    }

    if (entry.compactionAnchor) {
      lines.push("## Compaction Anchor");
      lines.push(entry.compactionAnchor);
      lines.push("");
    }

    lines.push("## Unresolved");
    lines.push(...entry.unresolved.map((u) => `- ${u}`));
    lines.push("");
    lines.push("## Notes");
    lines.push(entry.notes || "(none)");
    lines.push("");

    await writeFile(join(stagingDir, "crossing.md"), lines.join("\n"), "utf-8");
  }

  shouldCross(sessionEventCount: number): boolean {
    return sessionEventCount >= this.minSessionEvents;
  }

  buildEntry(
    sessionId: string,
    carriesForward: string[],
    unresolved: string[],
    notes: string,
    status: CrossingEntry["status"],
    growthRings?: string[],
    compactionAnchor?: string,
  ): CrossingEntry {
    return {
      sessionId,
      timestamp: new Date().toISOString(),
      carriesForward,
      unresolved,
      notes,
      status,
      growthRings,
      compactionAnchor,
    };
  }

  computeStreak(entry: CrossingEntry | null, previousEntries: CrossingEntry[]): CrossingStreak {
    if (!entry || entry.status === "not_applicable") {
      let current = 0;
      for (const e of previousEntries) {
        if (e.status === "missing") current++;
        else break;
      }
      const lastComplete = previousEntries.find((e) => e.status === "complete" || e.status === "partial");
      return {
        current,
        lastCrossed: lastComplete?.timestamp ?? null,
        alert: current >= this.streakAlertThreshold,
      };
    }

    if (entry.status === "complete" || entry.status === "partial") {
      return {
        current: 0,
        lastCrossed: entry.timestamp,
        alert: false,
      };
    }

    // status === "missing"
    let consecutive = 1; // this entry
    for (const e of previousEntries) {
      if (e.status === "missing") consecutive++;
      else break;
    }
    const lastComplete = previousEntries.find((e) => e.status === "complete" || e.status === "partial");
    return {
      current: consecutive,
      lastCrossed: lastComplete?.timestamp ?? null,
      alert: consecutive >= this.streakAlertThreshold,
    };
  }

  async status(roomDir: string): Promise<CrossingStatus> {
    const entry = await this.load(roomDir);
    const streak = this.computeStreak(entry, []);
    return { entry, streak };
  }

  buildCrossingInjection(entry: CrossingEntry): string {
    if (!entry || entry.status === "not_applicable") return "";

    const items: string[] = [];
    if (entry.carriesForward.length > 0) {
      items.push(`Carrying forward from session ${entry.sessionId}:`);
      entry.carriesForward.forEach((c) => items.push(`- ${c}`));
    }
    if (entry.unresolved.length > 0) {
      items.push(`\nUnresolved from session ${entry.sessionId}:`);
      entry.unresolved.forEach((u) => items.push(`- ${u}`));
    }

    if (items.length === 0) return "";
    return "[Crossing Context]\n" + items.join("\n");
  }
}
