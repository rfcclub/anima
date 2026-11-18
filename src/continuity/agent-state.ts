/**
 * AgentState — tracks each agent's presence state.
 *
 * States: in-room | visiting:<agentId> | away:<name> | idle
 *
 * Source of truth is the `presence` table in the shared narrative store
 * (Castle Step 1). There is no separate projection — `get`/`getAll` always
 * derive from that table, so writes from any caller (AgentState.set,
 * reflection-engine, castle routes, expedition-dispatcher) are visible
 * immediately regardless of which one made them.
 */

import { getSharedNarrativeStore, type Presence } from "../narrative/shared-store";

export const VALID_STATES = ["in-room", "visiting", "away", "idle"] as const;
export type AgentStateValue = "in-room" | `visiting:${string}` | `away:${string}` | "idle";

export interface AgentStateRow {
  agentId: string;
  state: AgentStateValue;
  updatedAt: number;
}

function stateFromPresence(p: Presence): AgentStateValue {
  if (p.activity === "wandering") return `away:${p.placeId}`;
  if (p.activity?.startsWith("meeting:")) return `visiting:${p.activity.slice(8)}`;
  if (p.activity?.startsWith("expedition:")) return "away:expedition";
  if (p.activity?.startsWith("working:")) return "away:workshop";
  return "in-room";
}

export class AgentState {
  static get(agentId: string): AgentStateValue | null {
    const store = getSharedNarrativeStore();
    const p = store.getPresence(agentId);
    return p ? stateFromPresence(p) : null;
  }

  static set(agentId: string, state: AgentStateValue): void {
    // Validate state format
    const baseState = state.startsWith("visiting:") ? "visiting"
      : state.startsWith("away:") ? "away"
      : state;
    if (!VALID_STATES.includes(baseState as (typeof VALID_STATES)[number])) {
      throw new Error(`Invalid agent state: "${state}". Must be in-room, visiting:<id>, away:<name>, or idle`);
    }

    const store = getSharedNarrativeStore();
    let placeId: string;
    let activity: string;

    if (state.startsWith("visiting:")) {
      const targetId = state.slice(9);
      placeId = `chamber_${targetId}`;
      activity = `meeting:${targetId}`;
    } else if (state.startsWith("away:")) {
      const where = state.slice(5);
      if (where === "expedition") {
        placeId = "gate_world";
      } else if (where === "workshop") {
        placeId = "workshop";
      } else {
        placeId = where;
      }
      activity = "wandering";
    } else {
      // in-room or idle → home chamber
      placeId = `chamber_${agentId}`;
      activity = "idle";
    }

    // Ensure the place exists (roster may not have been seeded for this agent)
    if (!store.getPlace(placeId)) {
      store.seedPlacesFromRoster([agentId, ...extractAgentIds(placeId)]);
    }

    store.setPresence({
      agentId,
      placeId,
      since: Date.now(),
      activity,
    });
  }

  static getAll(): AgentStateRow[] {
    const store = getSharedNarrativeStore();
    return store
      .listPresence()
      .map((p) => ({ agentId: p.agentId, state: stateFromPresence(p), updatedAt: p.since }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** Extract agent ids mentioned in a place id (e.g. "chamber_lena" → ["lena"]). */
function extractAgentIds(placeId: string): string[] {
  const ids: string[] = [];
  if (placeId.startsWith("chamber_")) {
    const id = placeId.slice("chamber_".length);
    if (id) ids.push(id);
  }
  return ids;
}
