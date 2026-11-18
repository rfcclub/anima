import { useEffect, useState } from "react";

/** A snapshot of who is where. Keyed by placeId (e.g. "chamber_bruno",
 *  "hall_main"); value is the list of agentIds currently there (the owner
 *  plus any visitors). In-room = owner present; visiting = a non-owner
 *  present; away = owner absent. */
export type PresenceMap = Record<string, string[]>;

export interface PresenceEntry {
  agentId: string;
  placeId: string;
  activity: string | null;
}

/** Poll /api/castle/presence on an interval, return a placeId→[agentIds] map.
 *  Polling (not WS) is deliberate per castle-vnengine non-goals: "No WebSocket
 *  infrastructure (polling is sufficient for v1)". 5s is frequent enough that
 *  an agent's move shows up on the map within one tick without hammering the
 *  server. */
export function usePresence(intervalMs = 5000): PresenceMap {
  const [presence, setPresence] = useState<PresenceMap>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/castle/presence");
        const { agents } = (await res.json()) as { agents: PresenceEntry[] };
        if (cancelled) return;
        const map: PresenceMap = {};
        for (const a of agents) {
          (map[a.placeId] ??= []).push(a.agentId);
        }
        setPresence(map);
      } catch {
        // Swallow — presence is a nice-to-have overlay; a failed poll must not
        // break the map. Next tick retries.
      }
    }
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return presence;
}

/** Like usePresence, but also returns an agentId→activity map. The RoomScreen
 *  meeting-passive banner needs each agent's activity ("A looks {{activity}}"),
 *  which the placeId→[agentIds] map discards; the castle maps use it to show
 *  who is talking. */
export function usePresenceWithActivity(intervalMs = 5000): {
  presence: PresenceMap;
  activityByAgent: Record<string, string | null>;
} {
  const [presence, setPresence] = useState<PresenceMap>({});
  const [activityByAgent, setActivityByAgent] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/castle/presence");
        const { agents } = (await res.json()) as { agents: PresenceEntry[] };
        if (cancelled) return;
        const map: PresenceMap = {};
        const activity: Record<string, string | null> = {};
        for (const a of agents) {
          (map[a.placeId] ??= []).push(a.agentId);
          activity[a.agentId] = a.activity;
        }
        setPresence(map);
        setActivityByAgent(activity);
      } catch {
        // Swallow — see usePresence.
      }
    }
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { presence, activityByAgent };
}
