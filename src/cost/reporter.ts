/**
 * CostReporter — Aggregation queries on token usage data.
 *
 * (cost-ledger-accuracy, anima #134) Calls are counted from `provider_calls`
 * parents, never from detail rows; every known detail is priced once from one
 * price-table load; legacy (v1) rows are reported apart as stored and are never
 * mixed into the v2 totals; calls whose usage is unknown or partial are counted
 * next to the estimate, which is then marked incomplete. Ranges are UTC
 * `[since, until)`.
 *
 * The dashboard opens the database read-only and possibly before the writer has
 * migrated it, so every v2 query is skipped when the v2 tables are not there.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createPricer, type PricingConfig } from "./pricing";

export interface SummaryResult {
  /** v2 calls (parents). Legacy requests are in `legacy`. */
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimate over the usage that was reported; see `estimateComplete`. */
  estimatedCost: number;
  /** v2 calls whose usage was not reported at all. */
  unknownCalls: number;
  /** v2 calls with some but not all usage categories reported. */
  partialCalls: number;
  /** Details priced at a fallback (provider default for an unlisted model, or an unknown provider)
   *  instead of their own price entry: a guess, not a verified charge. */
  fallbackPriced: Array<{ provider: string; model: string; calls: number }>;
  /** false when unknownCalls, partialCalls or fallbackPriced is non-empty: the estimate may be off. */
  estimateComplete: boolean;
}

export interface LegacySummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
}

export interface ModelBreakdown {
  model: string;
  provider: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  /** Distinct calls that involved this model. Not additive across models. */
  requestCount: number;
  nonAdditive?: true;
}

export interface AgentBreakdown {
  agentId: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
}

export interface AgentModelBreakdown {
  agentId: string;
  model: string;
  provider: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
}

export interface ProviderBreakdown {
  provider: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  requestCount: number;
}

export interface SummaryFilter {
  /** ISO-8601 instant (zone-less means UTC) or YYYY-MM-DD (that UTC midnight). */
  since?: string;
  /** ISO-8601 instant (zone-less means UTC) or YYYY-MM-DD (the next UTC midnight). Exclusive. */
  until?: string;
  agentId?: string;
}

/** Everything one castle work cost, across its start session and every revise session (anima #135). */
export interface WorkReceipt {
  workId: string;
  /** Provider calls (parents) made for the work; a multi-model call is one. */
  calls: number;
  sessions: Array<{ sessionNo: number; jobId: string; claimId: string; calls: number }>;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  unknownCalls: number;
  partialCalls: number;
  fallbackPriced: Array<{ provider: string; model: string; calls: number }>;
  estimateComplete: boolean;
  /** True only when there is at least one call and nothing about the estimate is unknown, partial or guessed. */
  complete: boolean;
  /** What this receipt cannot vouch for, in words. */
  limits: string[];
}

export interface LegacyReport {
  summary: LegacySummary;
  byModel: ModelBreakdown[];
  byAgent: AgentBreakdown[];
  byAgentModel: AgentModelBreakdown[];
  byProvider: ProviderBreakdown[];
}

export interface ReporterOptions {
  /** Reads the price table; called once per report. Default: ~/.anima/pricing.json or the built-in table. */
  loadPricing?: () => PricingConfig;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ZONELESS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function parseInstant(label: string, value: string, endOfDay: boolean): string {
  let text = value.trim();
  if (DATE_ONLY.test(text)) {
    const start = Date.parse(`${text}T00:00:00.000Z`);
    if (!Number.isFinite(start)) throw new RangeError(`invalid ${label}: ${value}`);
    return new Date(start + (endOfDay ? 24 * 60 * 60 * 1000 : 0)).toISOString();
  }
  if (ZONELESS.test(text)) text += "Z";
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(text)) throw new RangeError(`invalid ${label}: ${value}`);
  return new Date(ms).toISOString();
}

/** Normalises a filter to ISO-8601 UTC instants with millisecond precision; throws RangeError on a bad date. */
export function parseRange(f?: { since?: string; until?: string }): { since?: string; until?: string } {
  const out: { since?: string; until?: string } = {};
  if (f?.since) out.since = parseInstant("since", f.since, false);
  if (f?.until) out.until = parseInstant("until", f.until, true);
  return out;
}

const LEGACY_TIME = "strftime('%Y-%m-%dT%H:%M:%fZ', u.created_at)";

export class CostReporter {
  private db: Database;
  private readonly loadPricing?: () => PricingConfig;

  constructor(db: Database, options: ReporterOptions = {}) {
    this.db = db;
    this.loadPricing = options.loadPricing;
  }

  private columns(table: string): string[] {
    return (this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  /** The v2 tables exist (a database the writer has not opened yet has only the old token_usage). */
  private hasV2(): boolean {
    return this.columns("provider_calls").length > 0 && this.columns("token_usage").includes("call_id");
  }

  private hasVersionColumn(): boolean {
    return this.columns("token_usage").includes("usage_version");
  }

  private v2Where(f?: SummaryFilter): { clause: string; params: SQLQueryBindings[] } {
    const range = parseRange(f);
    const conds: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (range.since) { conds.push("p.started_at >= ?"); params.push(range.since); }
    if (range.until) { conds.push("p.started_at < ?"); params.push(range.until); }
    if (f?.agentId) { conds.push("p.agent_id = ?"); params.push(f.agentId); }
    return { clause: conds.length > 0 ? "WHERE " + conds.join(" AND ") : "", params };
  }

  private legacyWhere(f?: SummaryFilter): { clause: string; params: SQLQueryBindings[] } {
    const range = parseRange(f);
    const conds: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (this.hasVersionColumn()) conds.push("(u.usage_version IS NULL OR u.usage_version = 1)");
    if (range.since) { conds.push(`${LEGACY_TIME} >= ?`); params.push(range.since); }
    if (range.until) { conds.push(`${LEGACY_TIME} < ?`); params.push(range.until); }
    if (f?.agentId) { conds.push("u.agent_id = ?"); params.push(f.agentId); }
    return { clause: conds.length > 0 ? "WHERE " + conds.join(" AND ") : "", params };
  }

  summary(f?: SummaryFilter): SummaryResult {
    const empty: SummaryResult = { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0, unknownCalls: 0, partialCalls: 0, fallbackPriced: [], estimateComplete: true };
    const { clause, params } = this.v2Where(f);
    if (!this.hasV2()) return empty;

    const calls = this.db
      .query(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(p.coverage = 'unknown'), 0) AS unknown_calls,
                COALESCE(SUM(p.coverage = 'partial'), 0) AS partial_calls
         FROM provider_calls p ${clause}`,
      )
      .get(...params) as { n: number; unknown_calls: number; partial_calls: number };

    const rows = this.db
      .query(
        `SELECT u.call_id, u.provider, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens
         FROM provider_calls p JOIN token_usage u ON u.call_id = p.call_id ${clause}`,
      )
      .all(...params) as Array<{ call_id: string; provider: string; model: string; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null }>;

    const pricer = createPricer(this.loadPricing);
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    const fallback = new Map<string, { provider: string; model: string; calls: Set<string> }>();
    for (const r of rows) {
      const i = r.input_tokens ?? 0, o = r.output_tokens ?? 0, cr = r.cache_read_tokens ?? 0, cw = r.cache_write_tokens ?? 0;
      input += i; output += o; cacheRead += cr; cacheWrite += cw;
      cost += pricer.cost(i, o, cr, cw, r.provider, r.model);
      if (pricer.isFallback(r.provider, r.model)) {
        const key = `${r.provider}\u0000${r.model}`;
        const entry = fallback.get(key) ?? { provider: r.provider, model: r.model, calls: new Set<string>() };
        entry.calls.add(r.call_id);
        fallback.set(key, entry);
      }
    }
    const fallbackPriced = [...fallback.values()]
      .map((f) => ({ provider: f.provider, model: f.model, calls: f.calls.size }))
      .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));

    return {
      totalRequests: calls.n,
      totalInputTokens: input,
      totalOutputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      estimatedCost: Math.round(cost * 10000) / 10000,
      unknownCalls: calls.unknown_calls,
      partialCalls: calls.partial_calls,
      fallbackPriced,
      estimateComplete: calls.unknown_calls === 0 && calls.partial_calls === 0 && fallbackPriced.length === 0,
    };
  }

  /** The receipt of one work: every call stamped with its work id, summed across sessions and jobs. */
  workReceipt(workId: string): WorkReceipt {
    const limits = [
      "an estimate from the local price table, not a provider invoice",
      "only calls made through the metered provider path are counted; hidden SDK requests and proxy passthrough streams are not",
    ];
    const empty: WorkReceipt = {
      workId, calls: 0, sessions: [], totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0,
      unknownCalls: 0, partialCalls: 0, fallbackPriced: [], estimateComplete: true, complete: false, limits: [...limits, "no calls were recorded for this work"],
    };
    if (!this.hasV2() || !this.columns("provider_calls").includes("work_id")) return empty;

    const parents = this.db
      .query(
        `SELECT call_id, coverage, job_id, claim_id, session_no FROM provider_calls WHERE work_id = ? ORDER BY started_at, rowid`,
      )
      .all(workId) as Array<{ call_id: string; coverage: string; job_id: string | null; claim_id: string | null; session_no: number | null }>;
    if (parents.length === 0) return empty;

    const bySession = new Map<number, { sessionNo: number; jobId: string; claimId: string; calls: number }>();
    let unknownCalls = 0, partialCalls = 0;
    for (const p of parents) {
      if (p.coverage === "unknown") unknownCalls++;
      if (p.coverage === "partial") partialCalls++;
      const no = p.session_no ?? 0;
      const entry = bySession.get(no) ?? { sessionNo: no, jobId: p.job_id ?? "", claimId: p.claim_id ?? "", calls: 0 };
      entry.calls++;
      bySession.set(no, entry);
    }

    const rows = this.db
      .query(
        `SELECT u.call_id, u.provider, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens
         FROM provider_calls p JOIN token_usage u ON u.call_id = p.call_id WHERE p.work_id = ?`,
      )
      .all(workId) as Array<{ call_id: string; provider: string; model: string; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null }>;

    const pricer = createPricer(this.loadPricing);
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    const fallback = new Map<string, { provider: string; model: string; calls: Set<string> }>();
    for (const r of rows) {
      const i = r.input_tokens ?? 0, o = r.output_tokens ?? 0, cr = r.cache_read_tokens ?? 0, cw = r.cache_write_tokens ?? 0;
      input += i; output += o; cacheRead += cr; cacheWrite += cw;
      cost += pricer.cost(i, o, cr, cw, r.provider, r.model);
      if (pricer.isFallback(r.provider, r.model)) {
        const key = `${r.provider}\u0000${r.model}`;
        const entry = fallback.get(key) ?? { provider: r.provider, model: r.model, calls: new Set<string>() };
        entry.calls.add(r.call_id);
        fallback.set(key, entry);
      }
    }
    const fallbackPriced = [...fallback.values()].map((f) => ({ provider: f.provider, model: f.model, calls: f.calls.size }));
    const estimateComplete = unknownCalls === 0 && partialCalls === 0 && fallbackPriced.length === 0;
    if (unknownCalls > 0) limits.push(`${unknownCalls} call${unknownCalls === 1 ? "" : "s"} reported no usage, so their cost is not in the total`);
    if (partialCalls > 0) limits.push(`${partialCalls} call${partialCalls === 1 ? "" : "s"} reported only part of their usage`);
    if (fallbackPriced.length > 0) limits.push("some calls were priced at a provider default because their model has no price entry");

    return {
      workId, calls: parents.length, sessions: [...bySession.values()].sort((a, b) => a.sessionNo - b.sessionNo),
      totalInputTokens: input, totalOutputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
      estimatedCost: Math.round(cost * 10000) / 10000, unknownCalls, partialCalls, fallbackPriced, estimateComplete,
      complete: estimateComplete, limits,
    };
  }

  byModel(f?: SummaryFilter): ModelBreakdown[] {
    if (!this.hasV2()) return [];
    const { clause, params } = this.v2Where(f);
    const rows = this.db
      .query(
        `SELECT u.model AS model, u.provider AS provider,
                COALESCE(SUM(u.input_tokens), 0) AS totalInputTokens,
                COALESCE(SUM(u.output_tokens), 0) AS totalOutputTokens,
                COALESCE(SUM(u.cache_read_tokens), 0) AS cacheReadTokens,
                COUNT(DISTINCT p.call_id) AS requestCount
         FROM provider_calls p JOIN token_usage u ON u.call_id = p.call_id ${clause}
         GROUP BY u.model, u.provider
         ORDER BY totalInputTokens DESC`,
      )
      .all(...params) as ModelBreakdown[];
    return rows.map((r) => ({ ...r, nonAdditive: true as const }));
  }

  byAgent(f?: SummaryFilter): AgentBreakdown[] {
    if (!this.hasV2()) return [];
    const { clause, params } = this.v2Where(f);
    return this.db
      .query(
        `SELECT p.agent_id AS agentId,
                COALESCE(SUM(COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)), 0) AS totalTokens,
                COALESCE(SUM(u.input_tokens), 0) AS totalInputTokens,
                COALESCE(SUM(u.output_tokens), 0) AS totalOutputTokens,
                COUNT(DISTINCT p.call_id) AS requestCount
         FROM provider_calls p LEFT JOIN token_usage u ON u.call_id = p.call_id ${clause}
         GROUP BY p.agent_id
         ORDER BY totalTokens DESC`,
      )
      .all(...params) as AgentBreakdown[];
  }

  byAgentModel(f?: SummaryFilter): AgentModelBreakdown[] {
    if (!this.hasV2()) return [];
    const { clause, params } = this.v2Where(f);
    return this.db
      .query(
        `SELECT p.agent_id AS agentId, u.model AS model, u.provider AS provider,
                COALESCE(SUM(u.input_tokens), 0) AS totalInputTokens,
                COALESCE(SUM(u.output_tokens), 0) AS totalOutputTokens,
                COUNT(DISTINCT p.call_id) AS requestCount
         FROM provider_calls p JOIN token_usage u ON u.call_id = p.call_id ${clause}
         GROUP BY p.agent_id, u.model, u.provider
         ORDER BY totalInputTokens DESC`,
      )
      .all(...params) as AgentModelBreakdown[];
  }

  byProvider(f?: SummaryFilter): ProviderBreakdown[] {
    if (!this.hasV2()) return [];
    const { clause, params } = this.v2Where(f);
    return this.db
      .query(
        `SELECT p.backend AS provider,
                COALESCE(SUM(u.input_tokens), 0) AS totalInputTokens,
                COALESCE(SUM(u.output_tokens), 0) AS totalOutputTokens,
                COALESCE(SUM(u.cache_read_tokens), 0) AS cacheReadTokens,
                COUNT(DISTINCT p.call_id) AS requestCount
         FROM provider_calls p LEFT JOIN token_usage u ON u.call_id = p.call_id ${clause}
         GROUP BY p.backend
         ORDER BY totalInputTokens DESC`,
      )
      .all(...params) as ProviderBreakdown[];
  }

  /** Rows written before call records existed. Reported as stored: their token meaning
   *  and backend may be uncertain, so they are never relabelled or added to the v2 totals. */
  legacy(f?: SummaryFilter): LegacyReport {
    if (this.columns("token_usage").length === 0) {
      return {
        summary: { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0 },
        byModel: [], byAgent: [], byAgentModel: [], byProvider: [],
      };
    }
    const { clause, params } = this.legacyWhere(f);
    const rows = this.db
      .query(
        `SELECT u.provider, u.model, u.agent_id, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens
         FROM token_usage u ${clause}`,
      )
      .all(...params) as Array<{ provider: string; model: string; agent_id: string; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null }>;

    const pricer = createPricer(this.loadPricing);
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    for (const r of rows) {
      const i = r.input_tokens ?? 0, o = r.output_tokens ?? 0, cr = r.cache_read_tokens ?? 0, cw = r.cache_write_tokens ?? 0;
      input += i; output += o; cacheRead += cr; cacheWrite += cw;
      cost += pricer.cost(i, o, cr, cw, r.provider, r.model);
    }

    const grouped = (select: string, groupBy: string, order: string) =>
      this.db.query(`SELECT ${select} FROM token_usage u ${clause} GROUP BY ${groupBy} ORDER BY ${order}`).all(...params);

    return {
      summary: {
        totalRequests: rows.length,
        totalInputTokens: input,
        totalOutputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        estimatedCost: Math.round(cost * 10000) / 10000,
      },
      byModel: grouped(
        `u.model AS model, u.provider AS provider, COALESCE(SUM(u.input_tokens), 0) AS totalInputTokens, COALESCE(SUM(u.output_tokens), 0) AS totalOutputTokens, COALESCE(SUM(u.cache_read_tokens), 0) AS cacheReadTokens, COUNT(*) AS requestCount`,
        "u.model, u.provider",
        "totalInputTokens DESC",
      ) as ModelBreakdown[],
      byAgent: grouped(
        `u.agent_id AS agentId, COALESCE(SUM(COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)), 0) AS totalTokens, COALESCE(SUM(u.input_tokens), 0) AS totalInputTokens, COALESCE(SUM(u.output_tokens), 0) AS totalOutputTokens, COUNT(*) AS requestCount`,
        "u.agent_id",
        "totalTokens DESC",
      ) as AgentBreakdown[],
      byAgentModel: grouped(
        `u.agent_id AS agentId, u.model AS model, u.provider AS provider, COALESCE(SUM(u.input_tokens), 0) AS totalInputTokens, COALESCE(SUM(u.output_tokens), 0) AS totalOutputTokens, COUNT(*) AS requestCount`,
        "u.agent_id, u.model, u.provider",
        "totalInputTokens DESC",
      ) as AgentModelBreakdown[],
      byProvider: grouped(
        `u.provider AS provider, COALESCE(SUM(u.input_tokens), 0) AS totalInputTokens, COALESCE(SUM(u.output_tokens), 0) AS totalOutputTokens, COALESCE(SUM(u.cache_read_tokens), 0) AS cacheReadTokens, COUNT(*) AS requestCount`,
        "u.provider",
        "totalInputTokens DESC",
      ) as ProviderBreakdown[],
    };
  }
}
