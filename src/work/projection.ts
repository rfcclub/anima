/**
 * The castle's read-only view of the work store (anima #135, WL-7).
 *
 * Bounded (50 works, 200 events each), allow-listed field by field, opened read-only. It carries no
 * transcript, token, capability, key or local path, and it grants nothing about Mesh jobs: it reads
 * ANIMA's own record of the work, not the gateway.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolveWorkDbPath } from "./store";
import type { WorkState } from "./store";

export interface ProjectedEvent {
  at: string;
  kind: string;
  detail: Record<string, string | number | boolean | null | Array<string | number>>;
}

export interface ProjectedWork {
  workId: string;
  repo: string;
  issue: number;
  author: string;
  provider: string;
  model: string;
  state: WorkState;
  blockedReason: string | null;
  pr: { number: number; url: string; head: string } | null;
  caps: { sessionsUsed: number; maxSessions: number; iterationsUsed: number; execMsUsed: number; workWallMs: number };
  lastProgress: { at: string; kind: string } | null;
  events: ProjectedEvent[];
}

export interface WorkProjection {
  works: ProjectedWork[];
}

export interface ProjectionOptions {
  maxWorks?: number;
  maxEvents?: number;
}

/** The only event fields that leave the store. Anything else (tokens, transcripts, paths) is dropped. */
const DETAIL_KEYS = new Set([
  "state", "reason", "no", "stopCause", "iterations", "execMs", "number", "head", "steps", "stale", "type",
  "approvals", "repo", "issue", "author", "jobId", "jobIds", "deadlineMs", "chargedMs", "outcome", "reviews",
]);
const MAX_TEXT = 300;
const MAX_ARRAY = 20;

function clean(value: unknown): string | number | boolean | null | Array<string | number> | undefined {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) return value.filter((v): v is string | number => typeof v === "string" || typeof v === "number").slice(0, MAX_ARRAY).map((v) => (typeof v === "string" ? clean(v) as string : v));
  return undefined;
}

function sanitiseDetail(detail: unknown): ProjectedEvent["detail"] {
  const out: ProjectedEvent["detail"] = {};
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return out;
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    if (!DETAIL_KEYS.has(key)) continue;
    const kept = clean(value);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

export function readWorkProjection(dbPath: string = resolveWorkDbPath(), options: ProjectionOptions = {}): WorkProjection {
  if (dbPath === ":memory:" || !existsSync(dbPath)) return { works: [] };
  const maxWorks = options.maxWorks ?? 50;
  const maxEvents = options.maxEvents ?? 200;
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    if (!tables.includes("works")) return { works: [] };
    const rows = db.query("SELECT * FROM works ORDER BY updated_at DESC, work_id LIMIT ?").all(maxWorks) as Array<Record<string, unknown>>;
    const works = rows.map((r): ProjectedWork => {
      const caps = JSON.parse(r.caps_json as string) as { maxSessions: number; workWallMs: number };
      const events = (tables.includes("work_events")
        ? (db.query(
            "SELECT at, kind, detail_json FROM (SELECT seq, at, kind, detail_json FROM work_events WHERE work_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq",
          ).all(r.work_id as string, maxEvents) as Array<{ at: string; kind: string; detail_json: string }>)
        : []
      ).map((e): ProjectedEvent => ({ at: e.at, kind: e.kind, detail: sanitiseDetail(safeParse(e.detail_json)) }));
      const last = events[events.length - 1];
      return {
        workId: r.work_id as string,
        repo: r.repo as string,
        issue: r.issue as number,
        author: r.author as string,
        provider: r.provider as string,
        model: r.model as string,
        state: r.state as WorkState,
        blockedReason: (r.blocked_reason as string | null) ?? null,
        pr: r.pr_number ? { number: r.pr_number as number, url: (r.pr_url as string) ?? "", head: (r.pr_head as string) ?? "" } : null,
        caps: {
          sessionsUsed: r.sessions_used as number, maxSessions: caps.maxSessions,
          iterationsUsed: r.iterations_used as number, execMsUsed: r.exec_ms_used as number, workWallMs: caps.workWallMs,
        },
        lastProgress: last ? { at: last.at, kind: last.kind } : null,
        events,
      };
    });
    return { works };
  } finally {
    db.close();
  }
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return {}; }
}
