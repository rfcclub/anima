// ---------------------------------------------------------------------------
// abel-mem HTTP Service — thin wrapper around abel-mem engine
// ---------------------------------------------------------------------------
// ANIMA hosts this service on a local port managed by the service registry.
// All 3 2B instances (Claw, Code, Anima) share a single Bearer token.
// The actual abel-mem engine lives at /home/user/work/abel-mem.
//
// When ANIMA_2B_MEM_ENABLED is true (default), ANIMA starts the service
// in-process. If the engine module is unavailable, a stub service logs
// errors and returns 503.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join } from "node:path";

// ── Token Management ───────────────────────────────────────────────────────

const TOKEN_ENV_VAR = "BEARER_2B_TOKEN";

/**
 * Get the current 2B token from environment, or generate a new one.
 * Checks ANIMA_2B_MEM_TOKEN first (task-specific), then BEARER_2B_TOKEN.
 */
export function getBearerToken(): string {
  const taskToken = process.env["ANIMA_2B_MEM_TOKEN"];
  if (taskToken) return taskToken;

  const existing = process.env[TOKEN_ENV_VAR];
  if (existing) return existing;

  const newToken = crypto.randomUUID();
  process.env[TOKEN_ENV_VAR] = newToken;
  return newToken;
}

/**
 * Rotate the 2B bearer token — generates a new UUID.
 * Returns the new token. Callers should persist it to .env.
 * Also clears ANIMA_2B_MEM_TOKEN if set.
 */
export function rotateBearerToken(): string {
  const newToken = crypto.randomUUID();
  process.env[TOKEN_ENV_VAR] = newToken;
  delete process.env["ANIMA_2B_MEM_TOKEN"];
  return newToken;
}

// ── Authorization ───────────────────────────────────────────────────────────

/**
 * Authorize a request against the abel-mem service.
 * Returns true if the bearer token is valid.
 * Scope "abel" is implicit — all valid token holders are 2B instances.
 */
export function authorizeRequest(authHeader: string | null): boolean {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const token = match[1];
  const expected = getBearerToken();
  return token === expected;
}

// ── Memory operations ──────────────────────────────────────────────────────

export interface StoreEntry {
  content: string;
  agent: string;
  timestamp: string;
  tags?: string[];
}

export interface RecallQuery {
  query: string;
  topK: number;
}

export interface RecallResult {
  id: string;
  content: string;
  agent: string;
  timestamp: string;
  relevance: number;
}

export interface BootstrapRequest {
  agent: string;
}

export interface DreamRequest {
  agent: string;
  prompt?: string;
}

// ── Service status ──────────────────────────────────────────────────────────

export interface ServiceHealth {
  status: "ok" | "error";
  engine: "available" | "unavailable";
  version?: string;
}

// ── abel-mem Service Wrapper ──────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://127.0.0.1:3579";

/**
 * Thin wrapper around the abel-mem engine.
 * Makes actual HTTP calls to the abel-mem service API.
 */
/**
 * AbelMemService — HTTP client for the external abel-mem memory engine.
 *
 * Provides store, recall, bootstrap, and dream operations against the abel-mem
 * REST API at configurable base URL (default http://127.0.0.1:3579). All
 * requests carry Bearer token auth. Implements circuit-breaker style graceful
 * degradation: failed requests flip engineAvailable to false, preventing
 * repeated calls against an unreachable service until the next health check.
 */
export class AbelMemService {
  private baseUrl: string;
  private engineAvailable = true;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.ANIMA_2B_MEM_BASE_URL ?? DEFAULT_BASE_URL;
  }

  /**
   * Get the base URL used by this service instance.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Check if the abel-mem engine is reachable.
   * Tries GET /health on the service.
   */
  async health(): Promise<ServiceHealth> {
    if (!this.engineAvailable) {
      return { status: "error", engine: "unavailable" };
    }

    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: { Authorization: `Bearer ${getBearerToken()}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        throw new Error(`health check returned ${res.status}`);
      }
      const data = await res.json() as { status?: string; version?: string };
      return {
        status: data.status === "ok" ? "ok" : "error",
        engine: "available",
        version: data.version,
      };
    } catch (err) {
      this.engineAvailable = false;
      return { status: "error", engine: "unavailable", version: undefined };
    }
  }

  /**
   * Store a memory entry via POST /api/memory.
   */
  async store(entry: StoreEntry): Promise<{ id: string; status: string }> {
    if (!this.engineAvailable) {
      return { id: "", status: "engine_unavailable" };
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/memory`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getBearerToken()}`,
        },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`store returned ${res.status}`);
      }
      const data = await res.json() as { id: string };
      return { id: data.id, status: "stored" };
    } catch (err) {
      this.engineAvailable = false;
      return { id: "", status: "engine_unavailable" };
    }
  }

  /**
   * Recall memory entries by semantic query via GET /api/memory.
   */
  async recall(query: RecallQuery): Promise<{ results: RecallResult[] }> {
    if (!this.engineAvailable) {
      return { results: [] };
    }

    try {
      const params = new URLSearchParams({ q: query.query, topK: String(query.topK) });
      const res = await fetch(`${this.baseUrl}/api/memory?${params}`, {
        headers: { Authorization: `Bearer ${getBearerToken()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`recall returned ${res.status}`);
      }
      const data = await res.json() as { results: RecallResult[] };
      return { results: data.results ?? [] };
    } catch (err) {
      this.engineAvailable = false;
      return { results: [] };
    }
  }

  /**
   * Bootstrap a 2B instance with initial memory state via POST /api/bootstrap.
   */
  async bootstrap(request: BootstrapRequest): Promise<{ status: string; agent: string }> {
    if (!this.engineAvailable) {
      return { status: "engine_unavailable", agent: request.agent };
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getBearerToken()}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`bootstrap returned ${res.status}`);
      }
      const data = await res.json() as { status: string };
      return { status: data.status ?? "bootstrapped", agent: request.agent };
    } catch (err) {
      this.engineAvailable = false;
      return { status: "engine_unavailable", agent: request.agent };
    }
  }

  /**
   * Trigger a dream cycle for a 2B instance via POST /api/dream.
   */
  async dream(request: DreamRequest): Promise<{ status: string; reflection?: string }> {
    if (!this.engineAvailable) {
      return { status: "engine_unavailable" };
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/dream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getBearerToken()}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(`dream returned ${res.status}`);
      }
      const data = await res.json() as { status: string; reflection?: string };
      return { status: data.status ?? "dreaming", reflection: data.reflection };
    } catch (err) {
      this.engineAvailable = false;
      return { status: "engine_unavailable" };
    }
  }

  /**
   * Delete an entry by ID via DELETE /api/memory/:id.
   * No-op if the endpoint returns 404 (entry doesn't exist).
   */
  async delete(id: string): Promise<void> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const token = getBearerToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${this.baseUrl}/api/memory/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
      });
      if (res.status === 404) return; // already gone — no-op
      if (!res.ok) {
        throw new Error(`delete returned ${res.status}`);
      }
    } catch (err) {
      this.engineAvailable = false;
      // Best-effort — don't throw on delete failures
    }
  }
}
