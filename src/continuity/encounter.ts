import { randomUUID } from "node:crypto";
import { ENCOUNTER_MARK_TTL_MS } from "../narrative/automation-marks";
import type { SharedNarrativeStore } from "../narrative/shared-store";

const BUSY_PREFIXES = ["meeting:", "working:", "expedition:"];
const FREE = (activity: string | null | undefined) =>
  !activity || activity === "idle" || activity === "wandering";

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export interface DetectInput {
  agentId: string;
  placeId: string;
  placeKind: string;
  activity: string | null | undefined;
  copresent: Array<{ agentId: string; activity: string | null | undefined }>;
  cooldownExpired: (a: string, b: string) => boolean;
}

export function detectEncounter(
  input: DetectInput,
): { encounterId: string; colleague: string } | null {
  if (!FREE(input.activity)) return null;
  const candidates = input.copresent
    .filter((c) => c.agentId !== input.agentId)
    .filter((c) => FREE(c.activity))
    .filter((c) => !BUSY_PREFIXES.some((p) => (c.activity ?? "").startsWith(p)))
    .filter((c) => input.cooldownExpired(input.agentId, c.agentId))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
  if (candidates.length === 0) return null;
  return { encounterId: `e-${randomUUID().slice(0, 8)}`, colleague: candidates[0].agentId };
}

export function encounterCooldownExpired(
  store: Pick<SharedNarrativeStore, "getMark">,
  a: string,
  b: string,
  now: number,
): boolean {
  const flag = store.getMark(`encounter:${pairKey(a, b)}`);
  return flag?.value !== dateKey(now);
}

export function recordEncounterCooldown(
  store: Pick<SharedNarrativeStore, "setMark">,
  a: string,
  b: string,
  now: number,
  byAgent: string,
): void {
  store.setMark(`encounter:${pairKey(a, b)}`, dateKey(now), byAgent, ENCOUNTER_MARK_TTL_MS);
}

export function grantPendingLine(
  store: Pick<SharedNarrativeStore, "setMark">,
  agentId: string,
  encounterId: string,
  colleague: string,
  placeId: string,
): void {
  store.setMark(`encounter-line:${agentId}`, `${encounterId}|${colleague}|${placeId}`, agentId);
}

export function takePendingLine(
  store: Pick<SharedNarrativeStore, "getMark" | "setMark">,
  agentId: string,
): { encounterId: string; colleague: string; placeId: string } | null {
  const flag = store.getMark(`encounter-line:${agentId}`);
  if (!flag?.value) return null;
  store.setMark(`encounter-line:${agentId}`, "", agentId);
  const [encounterId, colleague, placeId] = flag.value.split("|");
  if (!encounterId || !colleague || !placeId) return null;
  return { encounterId, colleague, placeId };
}

function dateKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
