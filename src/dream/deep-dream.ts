import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { parseBeamEntries, type BeamEntry } from "./light-nap";

export interface DreamState {
  /** ISO timestamp when this dream run started. */
  startedAt: string;
  /** Agents that have been fully processed. */
  completedAgents: string[];
  /** The current agent being processed (empty if all done). */
  currentAgent: string;
  /** Whether cross-agent links have been written. */
  crossLinksWritten: boolean;
}

export interface CrossAgentLink {
  fromAgent: string;
  toAgent: string;
  sharedKeywords: string[];
  fromContent: string;
  toContent: string;
}

/**
 * Deep Dream — daily cron that iterates all agents, reads beams from the last
 * 24 hours, cross-references beams between agents, and writes a consolidated
 * dream report to staging/dreams/YYYY-MM-DD.md.
 *
 * Crash recovery via `.dream-state.json` in the rooms staging dir.
 * Cross-agent links are written LAST, after all per-agent processing.
 */
export class DeepDream {
  /**
   * Run the deep dream for all agents under `roomsDir`.
   * Never throws. Failures are logged and swallowed per agent.
   */
  async run(roomsDir: string): Promise<void> {
    try {
      const stagingDir = join(roomsDir, "staging");
      await mkdir(stagingDir, { recursive: true });
      const statePath = join(stagingDir, ".dream-state.json");

      let state = await this.loadState(statePath);
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
      const dates = [...new Set([yesterday, today])]; // deduplicate if same day

      // Discover agents
      const agents = await this.listAgents(roomsDir);

      if (!state) {
        state = {
          startedAt: now.toISOString(),
          completedAgents: [],
          currentAgent: agents[0] || "",
          crossLinksWritten: false,
        };
      }

      // Phase 1: Process each agent transactionally
      const completedSet = new Set(state.completedAgents);
      for (const agent of agents) {
        if (completedSet.has(agent)) continue;
        state.currentAgent = agent;
        await this.saveState(statePath, state);

        try {
          await this.processAgent(roomsDir, agent, dates);
          state.completedAgents.push(agent);
          await this.saveState(statePath, state);
        } catch (err) {
          console.error(
            JSON.stringify({
              level: "error",
              ts: new Date().toISOString(),
              msg: "deep dream failed for agent",
              agent,
              error: String(err),
            }),
          );
          break; // stop processing — resume from this agent next cron run
        }
      }

      // Phase 2: Cross-reference beams and write dream report (written LAST)
      if (!state.crossLinksWritten && state.completedAgents.length > 0) {
        try {
          const allBeams = new Map<string, BeamEntry[]>();
          for (const agent of state.completedAgents) {
            const beams = await this.readAgentBeams(join(roomsDir, agent), dates);
            if (beams.length > 0) {
              allBeams.set(agent, beams);
            }
          }

          const links = this.crossReferenceBeams(allBeams);
          const dreamsDir = join(roomsDir, "staging", "dreams");
          await mkdir(dreamsDir, { recursive: true });
          const dreamPath = join(dreamsDir, `${today}.md`);
          await this.writeDreamReport(dreamPath, today, allBeams, links);

          state.crossLinksWritten = true;
          await this.saveState(statePath, state);
        } catch (err) {
          console.error(
            JSON.stringify({
              level: "error",
              ts: new Date().toISOString(),
              msg: "deep dream cross-linking failed",
              error: String(err),
            }),
          );
        }
      }

      // Mark as fully completed
      if (state.crossLinksWritten) {
        try {
          await writeFile(
            statePath,
            JSON.stringify(
              { completed: true, completedAt: new Date().toISOString() },
              null,
              2,
            ),
            "utf-8",
          );
        } catch {
          // cleanup failures are non-fatal
        }
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          ts: new Date().toISOString(),
          msg: "deep dream run failed",
          error: String(err),
        }),
      );
    }
  }

  /**
   * Per-agent processing. Currently a no-op since beams are already stored
   * by light nap. Exists as a hook for future per-agent consolidation.
   */
  private async processAgent(
    roomsDir: string,
    agent: string,
    _dates: string[],
  ): Promise<void> {
    // Beams already stored by light-nap. Deep dream reads them in phase 2.
    // If we need per-agent consolidation or summarization, it goes here.
  }

  /**
   * Read beam entries for an agent across the given dates.
   * Falls back to reading recent neurons from anima memory.db if no beams exist.
   */
  async readAgentBeams(agentDir: string, dates: string[]): Promise<BeamEntry[]> {
    const allBeams: BeamEntry[] = [];

    // Phase 1: Try beam files (original path)
    for (const date of dates) {
      const beamPath = join(agentDir, "staging", "beams", `${date}.md`);
      if (!existsSync(beamPath)) continue;
      try {
        const content = await readFile(beamPath, "utf-8");
        const entries = parseBeamEntries(content);
        allBeams.push(...entries);
      } catch {
        // skip unreadable beam files
      }
    }

    if (allBeams.length > 0) return allBeams;

    // Phase 2: Fallback — read recent neurons from anima memory.db
    const agentName = agentDir.split("/").pop() ?? "";
    return this.readNeuronsAsBeams(agentName, dates);
  }

  /**
   * Read recent neurons from an agent's memory.db and convert to beam entries.
   * This is the fallback when LightNap beams don't exist.
   */
  private readNeuronsAsBeams(agentName: string, dates: string[]): BeamEntry[] {
    const homeBase = process.env.ANIMA_HOME ?? join(homedir(), ".anima");
    const dbPath = join(homeBase, "agents", agentName, "memory.db");
    if (!existsSync(dbPath)) return [];

    try {
      const db = new Database(dbPath, { readonly: true });
      const startDate = dates[0] + "T00:00:00.000Z";
      const endDate = (dates[dates.length - 1] ?? dates[0]) + "T23:59:59.999Z";

      const rows = db.prepare(
        `SELECT id, content, scope, tags, confidence, created_at FROM neurons
         WHERE created_at >= ? AND created_at <= ?
         ORDER BY created_at DESC LIMIT 50`
      ).all(startDate, endDate) as Array<{
        id: string; content: string; scope: string;
        tags: string; confidence: number; created_at: string;
      }>;

      db.close();

      const BEAM_KEYWORDS = ["insight", "learned", "discovered", "realized", "pattern", "decision", "observation"];

      return rows.map(row => {
        const contentLower = row.content.toLowerCase();
        const keywords = BEAM_KEYWORDS.filter(kw => contentLower.includes(kw));
        let parsedTags: string[] = [];
        try { parsedTags = JSON.parse(row.tags ?? "[]"); } catch {}
        return {
          timestamp: row.created_at,
          agent: agentName,
          session: "memory-db",
          keywords: keywords.length > 0 ? keywords : parsedTags.slice(0, 3),
          source: row.id,
          content: row.content.slice(0, 500),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Cross-reference beams between all agent pairs.
   * Returns links where two beams share one or more keywords.
   */
  private crossReferenceBeams(
    allBeams: Map<string, BeamEntry[]>,
  ): CrossAgentLink[] {
    const agents = [...allBeams.keys()];
    const links: CrossAgentLink[] = [];
    const MAX_LINKS_PER_PAIR = 3;

    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const aBeams = allBeams.get(agents[i])!;
        const bBeams = allBeams.get(agents[j])!;
        let pairLinks = 0;

        for (const aBeam of aBeams) {
          if (pairLinks >= MAX_LINKS_PER_PAIR) break;
          for (const bBeam of bBeams) {
            if (pairLinks >= MAX_LINKS_PER_PAIR) break;
            const shared = aBeam.keywords.filter((kw) =>
              bBeam.keywords.includes(kw),
            );
            if (shared.length > 0) {
              links.push({
                fromAgent: agents[i],
                toAgent: agents[j],
                sharedKeywords: shared,
                fromContent: aBeam.content,
                toContent: bBeam.content,
              });
              pairLinks++;
            }
          }
        }
      }
    }

    return links;
  }

  /**
   * Write the consolidated dream report markdown file.
   */
  private async writeDreamReport(
    dreamPath: string,
    date: string,
    allBeams: Map<string, BeamEntry[]>,
    links: CrossAgentLink[],
  ): Promise<void> {
    const lines: string[] = [];
    lines.push(`# Dream — ${date}`);
    lines.push("");

    // Per-agent beam summary
    for (const [agent, beams] of allBeams) {
      lines.push(`## ${agent}`);
      for (const beam of beams) {
        lines.push(
          `- [${beam.timestamp}] ${beam.content} (${beam.keywords.join(", ")})`,
        );
      }
      lines.push("");
    }

    // Cross-agent links
    if (links.length > 0) {
      lines.push("## Cross-Agent Links");
      lines.push("");
      for (const link of links) {
        lines.push(`### ${link.fromAgent} ↔ ${link.toAgent}`);
        lines.push(`- Shared keywords: ${link.sharedKeywords.join(", ")}`);
        lines.push(`- From "${link.fromAgent}": ${link.fromContent}`);
        lines.push(`- From "${link.toAgent}": ${link.toContent}`);
        lines.push("");
      }
    }

    await mkdir(dirname(dreamPath), { recursive: true });
    await writeFile(dreamPath, lines.join("\n"), "utf-8");
  }

  /**
   * Load dream state from the JSON file. Returns null if no state file
   * exists, the file is corrupt, or the previous run completed.
   */
  private async loadState(statePath: string): Promise<DreamState | null> {
    try {
      if (!existsSync(statePath)) return null;
      const content = await readFile(statePath, "utf-8");
      const parsed = JSON.parse(content);
      // Previous run completed — start fresh
      if (parsed.completed) return null;
      // Validate required fields
      if (
        typeof parsed.startedAt !== "string" ||
        !Array.isArray(parsed.completedAgents) ||
        typeof parsed.crossLinksWritten !== "boolean"
      ) {
        return null;
      }
      return parsed as DreamState;
    } catch {
      return null; // corrupt or unreadable — start fresh
    }
  }

  /**
   * Save dream state to the JSON file.
   */
  private async saveState(
    statePath: string,
    state: DreamState,
  ): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  /**
   * List agent directories that contain a config.yaml file.
   */
  private async listAgents(roomsDir: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(roomsDir);
    } catch {
      return [];
    }

    const agents: string[] = [];
    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const configPath = join(roomsDir, name, "config.yaml");
      if (existsSync(configPath)) {
        agents.push(name);
      }
    }
    return agents.sort();
  }
}
