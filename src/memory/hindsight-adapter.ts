import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryAdapter, MemoryEntry, RecallOptions } from "./adapter";

export type HindsightLog = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface HindsightRecallOptions {
  bank: string;
  /** Agent name, used as MemoryEntry.namespace and in log lines. */
  namespace: string;
  timeoutMs?: number;
  /** Hindsight client config holding apiUrl and apiToken. Read on every call. */
  configPath?: string;
  fetchFn?: typeof fetch;
  log?: HindsightLog;
}

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_CONFIG_PATH = join(homedir(), ".hindsight", "coding-agent.json");
const MAX_TOKENS = 512;

interface HindsightConfig {
  apiUrl: string;
  apiToken: string;
}

interface HindsightResult {
  id?: string;
  text?: string;
  mentioned_at?: string;
}

/**
 * Recall-only view of one Hindsight bank. It never throws: any failure yields no rows,
 * so it can sit beside a primary adapter without affecting the turn.
 * Log lines carry agent, bank, latency, count and outcome only: no query, result text or token.
 */
export class HindsightRecallAdapter implements MemoryAdapter {
  private readonly bank: string;
  private readonly namespace: string;
  private readonly timeoutMs: number;
  private readonly configPath: string;
  private readonly fetchFn: typeof fetch;
  private readonly log: HindsightLog;

  constructor(options: HindsightRecallOptions) {
    this.bank = options.bank;
    this.namespace = options.namespace;
    this.timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    this.configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    this.fetchFn = options.fetchFn ?? fetch;
    this.log = options.log ?? (() => {});
  }

  async store(_entry: MemoryEntry): Promise<void> {
    // recall-only pilot
  }

  async recall(query: string, opts?: RecallOptions): Promise<MemoryEntry[]> {
    const started = Date.now();
    const done = (outcome: "ok" | "timeout" | "error", extra: Record<string, unknown> = {}) =>
      this.log(outcome === "ok" ? "info" : "error", "hindsight recall", {
        agent: this.namespace,
        bank: this.bank,
        latencyMs: Date.now() - started,
        outcome,
        ...extra,
      });

    const config = this.readConfig();
    if (!config) {
      done("error", { reason: "config-unavailable" });
      return [];
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/default/banks/${encodeURIComponent(this.bank)}/memories/recall`;
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, budget: "low", max_tokens: MAX_TOKENS }),
        signal: controller.signal,
      });
      if (!res.ok) {
        done("error", { status: res.status });
        return [];
      }
      const body = (await res.json()) as { results?: HindsightResult[] };
      const topK = opts?.topK ?? 5;
      const rows = (body.results ?? [])
        .filter((r): r is HindsightResult & { text: string } => typeof r.text === "string" && r.text.length > 0)
        .slice(0, topK)
        .map((r) => ({
          id: r.id,
          namespace: this.namespace,
          content: r.text,
          type: "fact" as const,
          timestamp: r.mentioned_at ?? new Date().toISOString(),
        }));
      done("ok", { count: rows.length });
      return rows;
    } catch (err) {
      const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      done(aborted ? "timeout" : "error", aborted ? {} : { errorName: err instanceof Error ? err.name : "unknown" });
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private readConfig(): HindsightConfig | null {
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf-8")) as Partial<HindsightConfig>;
      if (typeof parsed.apiUrl === "string" && typeof parsed.apiToken === "string" && parsed.apiUrl && parsed.apiToken) {
        return { apiUrl: parsed.apiUrl, apiToken: parsed.apiToken };
      }
      return null;
    } catch {
      return null;
    }
  }
}
