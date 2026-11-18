// ---------------------------------------------------------------------------
// Memory Store Registry — maps agent names to their AgentMemoryStore backend
// ---------------------------------------------------------------------------
// Core agents (2B, Bruno) use custom memory backends. All other colony
// agents fall back to AnimaEntityStore with a shared SQLite database.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join } from "node:path";
import type { RoomConfig } from "../config/types";
import type { AgentMemoryStore } from "./contract";
import { AbelMemBunAdapter } from "./abel-mem-bun-adapter";
import { BrunoEntityAdapter } from "./bruno-entity-adapter";
import { AnimaEntityStore } from "./anima-entity-store";
import { MemoryHealthRegistry } from "./health-registry";
import { ContinuityAdapter, defaultContinuityDbPath } from "./continuity-adapter";
import { LeaseStore, DomainRevisions } from "@anima/continuity-core";

// ── Agent classifications ────────────────────────────────────────────────────

/** Agents whose memory is backed by 2B-MEM (native bun:sqlite). */
const ABEL_MEM_AGENTS = new Set(["abel"]);

/** Agents whose memory is backed by Bruno's neural graph (bruno-entity). */
const BRUNO_ENTITY_AGENTS = new Set(["bruno"]);

// ── Per-agent DB path resolution ──────────────────────────────────────────────

/**
 * Resolve the per-agent memory database path.
 * Core agents get dedicated DBs alongside existing custom backends.
 * All other agents use a shared DB for now, migrating to per-agent later.
 */
function perAgentMemoryDb(agentName: string): string {
  return join(homedir(), ".anima", "agents", agentName, "memory.db");
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the appropriate AgentMemoryStore for a given agent.
 *
 * Core agents (2B, Bruno) get custom backends wired to their respective
 * memory services. All other agents use AnimaEntityStore as the standard
 * fallback with a shared SQLite database.
 *
 * @returns The AgentMemoryStore instance, or undefined if the agent has no
 *          cross-session memory configured.
 */
export async function createAgentMemoryStore(
  config: RoomConfig,
  _roomDir: string,
): Promise<AgentMemoryStore | undefined> {
  const agentName = config.identity.name;

  // ── 2B agents — AbelMemBunAdapter ─────────────────────────────────────────
  if (ABEL_MEM_AGENTS.has(agentName)) {
    const store = new AbelMemBunAdapter();
    await store.ensureFallbackReady();
    MemoryHealthRegistry.getInstance().register(agentName, store);
    return store;
  }

  // ── Bruno — BrunoEntityAdapter ───────────────────────────────────────────
  if (BRUNO_ENTITY_AGENTS.has(agentName)) {
    const store = new BrunoEntityAdapter({ agentName });
    MemoryHealthRegistry.getInstance().register(agentName, store);
    return store;
  }

  // Colony agents with type: shared or crossSessionBootstrap get a per-agent AnimaEntityStore
  const useEntityStore =
    config.memory?.type === "shared" || config.memory?.crossSessionBootstrap;
  if (!useEntityStore) {
    return undefined;
  }

  // ── Standard fallback — AnimaEntityStore with per-agent DB ──────────────
  const store = new AnimaEntityStore(perAgentMemoryDb(agentName));

  // Await initialization — must complete before any method calls on the store.
  // SQLite file creation + CREATE TABLE IF NOT EXISTS + FTS + triggers run here.
  await store.initialize().catch((err) => {
    console.error(
      `[store-registry] AnimaEntityStore init failed for ${agentName}: ${err}`,
    );
    throw err;
  });

  // Register in health registry for /api/memory/health endpoint
  MemoryHealthRegistry.getInstance().register(agentName, store);

  return store;
}

/**
 * Create a ContinuityPort for an agent — additive only. `createAgentMemoryStore`
 * is untouched and the raw-adapter bypass it hands out stays open and documented.
 *
 * Returns undefined if the agent has no cross-session memory configured, since
 * there is no raw adapter to serve as the ProposalPromoter's privileged writer.
 */
export async function createContinuityPort(
  config: RoomConfig,
  roomDir: string,
  dbPathOverride?: string,
): Promise<ContinuityAdapter | undefined> {
  const rawStore = await createAgentMemoryStore(config, roomDir);
  if (!rawStore) return undefined;

  const dbPath = dbPathOverride ?? defaultContinuityDbPath(config.identity.name);
  const leaseStore = new LeaseStore(dbPath);
  const domainRevisions = new DomainRevisions(dbPath);

  return new ContinuityAdapter(rawStore, leaseStore, domainRevisions, dbPath);
}
