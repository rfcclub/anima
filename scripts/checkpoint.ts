/**
 * checkpoint.ts — Memory + session stats for all ANIMA agents.
 *
 * Default (no flags): shows stats only (memory neurons, session turns, latest activity).
 * --commit: also runs summarization (needs ANIMA server env for providers).
 *
 * Usage:   bun run scripts/checkpoint.ts [agent|--all] [--commit]
 * Cron:    0 */4 * * * cd /path/to/anima && bun run scripts/checkpoint.ts --all --commit
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/memory/session-store";
import { createAgentMemoryStore } from "../src/memory/store-registry";
import { writeSessionSummary } from "../src/session/cross-session-memory";
import { loadRoomConfig } from "../src/config/types";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import { AnthropicProvider } from "../src/providers/anthropic";
import { GeminiProvider } from "../src/providers/gemini";
import { ProviderRegistry } from "../src/providers/registry";
import type { Provider } from "../src/providers/interface";

// ── Paths ────────────────────────────────────────────────────────────

function animaHome(): string {
  if (Bun.env.ANIMA_HOME) return Bun.env.ANIMA_HOME;
  return join(Bun.env.HOME ?? process.env.HOME ?? "/tmp", ".anima");
}

function roomsDir(): string {
  return Bun.env.ANIMA_ROOMS_DIR ?? join(process.cwd(), "rooms");
}

// ── Provider resolution ──────────────────────────────────────────────

let _registry: ProviderRegistry | null | undefined;

async function getProviderRegistry(): Promise<ProviderRegistry | null> {
  if (_registry !== undefined) return _registry;
  const providersDir = join(animaHome(), "providers.d");
  try {
    _registry = await ProviderRegistry.load(providersDir);
  } catch {
    _registry = null;
  }
  return _registry;
}

async function resolveProvider(roomDir: string): Promise<Provider | null> {
  const configPath = join(roomDir, "config.yaml");
  if (!existsSync(configPath)) return null;
  const config = loadRoomConfig(readFileSync(configPath, "utf-8"));
  const type = (config.provider as any)?.type as string;
  if (!type) return null;

  // Try provider registry
  const registry = await getProviderRegistry();
  const def = registry?.get(type);
  if (def) return new OpenAICompatProvider(def);

  // Built-in providers
  switch (type) {
    case "claude": return new AnthropicProvider({ log: () => {} });
    case "gemini": return new GeminiProvider();
  }
  return null;
}

// ── Agent stats ──────────────────────────────────────────────────────

interface AgentStats {
  agent: string;
  roomExists: boolean;
  sessions: number;
  latestSessionId: string | null;
  latestStarted: string | null;
  turns: number;
  memoryNeurons: number;
  memoryDbPath: string | null;
}

async function getAgentStats(agentName: string): Promise<AgentStats> {
  const roomDir = join(roomsDir(), agentName);
  const stats: AgentStats = {
    agent: agentName,
    roomExists: existsSync(roomDir),
    sessions: 0,
    latestSessionId: null,
    latestStarted: null,
    turns: 0,
    memoryNeurons: 0,
    memoryDbPath: null,
  };

  const sessionsDb = join(animaHome(), "sessions.db");
  if (existsSync(sessionsDb)) {
    const db = new Database(sessionsDb);
    try {
      const srows = db.query(
        "SELECT id, started FROM sessions WHERE agent = ? ORDER BY started DESC",
      ).all(agentName) as Array<{ id: string; started: string }>;
      stats.sessions = srows.length;
      if (srows.length > 0) {
        stats.latestSessionId = srows[0].id;
        stats.latestStarted = srows[0].started;
      }
    } catch { /* ignore */ }
    db.close();
  }

  if (stats.latestSessionId) {
    const sessionStore = new SessionStore(sessionsDb);
    try {
      stats.turns = sessionStore.getTurns(stats.latestSessionId).length;
    } catch { /* ignore */ }
  }

  // Try loading memory store for neuron count
  if (stats.roomExists) {
    try {
      const configPath = join(roomDir, "config.yaml");
      if (existsSync(configPath)) {
        const config = loadRoomConfig(readFileSync(configPath, "utf-8"));
        const store = await createAgentMemoryStore(config, roomDir);
        if (store) {
          const diag = (store as any).diagnose?.() ?? (store as any).getStats?.() ?? {};
          stats.memoryNeurons = diag.total_neurons ?? diag.total_entries ?? diag.totalEntries ?? 0;
          stats.memoryDbPath = (store as any).getDbPath?.() ?? null;
        }
      }
    } catch { /* store creation may fail without full server env */ }
  }

  return stats;
}

// ── Checkpoint (summarize) ───────────────────────────────────────────

async function checkpointAgent(agentName: string): Promise<string> {
  const roomDir = join(roomsDir(), agentName);
  if (!existsSync(roomDir)) return "room not found";

  const configPath = join(roomDir, "config.yaml");
  if (!existsSync(configPath)) return "no config.yaml";

  const sessionsDb = join(animaHome(), "sessions.db");
  if (!existsSync(sessionsDb)) return "no sessions.db";

  const config = loadRoomConfig(readFileSync(configPath, "utf-8"));
  const store = await createAgentMemoryStore(config, roomDir);
  if (!store) return "no memory store";

  const db = new Database(sessionsDb);
  const rows = db.query(
    "SELECT id FROM sessions WHERE agent = ? ORDER BY started DESC LIMIT 1",
  ).all(agentName) as Array<{ id: string }>;
  db.close();

  if (rows.length === 0) return "no active session";

  const sessionId = rows[0].id;
  const sessionStore = new SessionStore(sessionsDb);
  const turns = sessionStore.getTurns(sessionId);
  if (turns.length === 0) return "no turns";

  const provider = await resolveProvider(roomDir);
  if (!provider) return `unsupported provider for ${agentName}`;

  try {
    await writeSessionSummary(store, provider, sessionId, turns);
    return `summarized ${turns.length} turns`;
  } catch (err) {
    return `error: ${String(err)}`;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = Bun.argv.slice(2);
  const commit = args.includes("--commit");
  const filterArgs = args.filter((a) => a !== "--commit");
  const target = filterArgs[0] || "--all";

  let agents: string[];
  if (target === "--all") {
    const { readdir } = await import("node:fs/promises");
    const dir = roomsDir();
    if (!existsSync(dir)) {
      console.error(`Rooms directory not found: ${dir}`);
      process.exit(1);
    }
    const entries = await readdir(dir, { withFileTypes: true });
    agents = entries.filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);
  } else {
    agents = [target];
  }

  console.log(`[checkpoint] Mode: ${commit ? "COMMIT" : "STATS ONLY"} | Agents: ${agents.join(", ")}\n`);

  // ── Stats table ──
  console.log("AGENT       SESSIONS  TURNS  NEURONS  LAST ACTIVE");
  console.log("----------  --------  -----  -------  -----------");
  for (const agent of agents) {
    const s = await getAgentStats(agent);
    const name = s.agent.padEnd(10);
    const sess = String(s.sessions).padStart(6);
    const turns = String(s.turns).padStart(5);
    const neurons = String(s.memoryNeurons).padStart(7);
    const last = s.latestStarted ? s.latestStarted.slice(0, 16).replace("T", " ") : "N/A".padStart(10);
    console.log(`${name}  ${sess}  ${turns}  ${neurons}  ${last}`);
  }

  // ── Commit (summarize) ──
  if (commit) {
    console.log("\n[checkpoint] Running summarization...");
    for (const agent of agents) {
      const result = await checkpointAgent(agent);
      const icon = result.startsWith("summarized") ? "✅" : result.startsWith("error") ? "❌" : "⏭️";
      console.log(`  ${icon} ${agent}: ${result}`);
    }
  }

  console.log("\n[checkpoint] Done.");
}

main().catch((err) => {
  console.error("[checkpoint] Fatal error:", err);
  process.exit(2);
});
