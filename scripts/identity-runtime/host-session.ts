import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IdentityRuntimeTenant, ProjectionFetcher } from "./fetch-projection.ts";

/**
 * A host-side client for the shared identity-runtime tenant API: join once,
 * keep the session, then recall / remember over HTTP. HTTP-only on purpose so
 * the same code serves any host, including one with no local DB.
 * (fetch-projection.ts only joins and throws the session away.)
 */

export interface SessionState {
  origin: string;
  tenant: IdentityRuntimeTenant;
  clientId: string;
  surfaceId: string;
  leaseId: string;
  sessionToken: string;
  stateHash: string;
  /** Epoch ms; the runtime's lease TTL is 30 min by default. */
  expiresAt: number;
  joinedAt: number;
}

export interface SessionStore {
  load(): SessionState | undefined;
  save(state: SessionState): void;
}

export interface RecallResult {
  source: string;
  content: string;
}

export interface RememberEntry {
  content: string;
  source: string;
  scope?: string;
  tags?: string[];
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface HostSessionOptions {
  origin: string;
  tenant: IdentityRuntimeTenant;
  clientId: string;
  surfaceId: string;
  store: SessionStore;
  fetcher?: ProjectionFetcher;
  now?: () => number;
  /** Re-join when fewer than this many ms of lease remain. */
  renewMarginMs?: number;
  /** Per-request abort, so a slow runtime can never hold a hook hostage. */
  timeoutMs?: number;
  joinMessage?: string;
}

const DEFAULT_RENEW_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
/** Runtime errors that mean "your session is no good, join again". */
const SESSION_ERROR = /\b(lease|stale|session)\b/i;

/** Session file holding a bearer-like token: created 0600, parents on demand. */
export class FileSessionStore implements SessionStore {
  constructor(private readonly path: string) {}

  load(): SessionState | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SessionState>;
      const strings = ["origin", "tenant", "clientId", "surfaceId", "leaseId", "sessionToken", "stateHash"] as const;
      if (strings.some((key) => typeof raw[key] !== "string" || !raw[key])) return undefined;
      if (typeof raw.expiresAt !== "number" || typeof raw.joinedAt !== "number") return undefined;
      return raw as SessionState;
    } catch {
      return undefined;
    }
  }

  save(state: SessionState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state), { mode: 0o600 });
    chmodSync(this.path, 0o600); // `mode` only applies when the file is created
  }
}

export class HostSession {
  private readonly origin: string;
  private readonly fetcher: ProjectionFetcher;
  private readonly now: () => number;
  private readonly renewMarginMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: HostSessionOptions) {
    this.origin = options.origin.replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.renewMarginMs = options.renewMarginMs ?? DEFAULT_RENEW_MARGIN_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The stored session if it is ours and still has lease left, else a fresh join. */
  async ensure(): Promise<SessionState> {
    const stored = this.options.store.load();
    if (stored && this.usable(stored)) return stored;
    return this.join();
  }

  async directRecall(query: string): Promise<RecallResult[]> {
    const result = await this.authorized("/identity-runtime/continuity/direct-recall", (s) => ({
      leaseId: s.leaseId,
      clientId: s.clientId,
      sessionToken: s.sessionToken,
      stateHash: s.stateHash,
      query,
    }));
    if (!Array.isArray(result)) throw new Error("unexpected direct-recall response");
    return result as RecallResult[];
  }

  async remember(entry: RememberEntry): Promise<{ id: string; createdAt: string }> {
    if (!entry.content.trim()) throw new Error("content is required");
    const scope = entry.scope ?? "observation";
    // Stable for identical content, so a retried call cannot write twice.
    const idempotencyKey = createHash("sha256")
      .update([this.options.tenant, scope, entry.source, entry.content].join("\n"))
      .digest("hex");
    const saved = (await this.authorized("/identity-runtime/continuity/remember", (s) => ({
      leaseId: s.leaseId,
      clientId: s.clientId,
      sessionToken: s.sessionToken,
      stateHash: s.stateHash,
      idempotencyKey,
      entry: {
        scope,
        content: entry.content,
        tags: entry.tags ?? [],
        confidence: entry.confidence ?? 0.7,
        source: entry.source,
        metadata: entry.metadata,
      },
    }))) as { id: string; createdAt: string };
    this.spend();
    return saved;
  }

  /**
   * A write advances ANIMA's canonical revision but not the lease's stateHash, so
   * one lease carries exactly one write. Drop the spent session (expiresAt 0 makes
   * `usable` false) rather than let the next remember spend a stale hash and fail.
   */
  private spend(): void {
    const stored = this.options.store.load();
    if (stored) this.options.store.save({ ...stored, expiresAt: 0 });
  }

  private usable(state: SessionState): boolean {
    return (
      state.origin === this.origin
      && state.tenant === this.options.tenant
      && state.clientId === this.options.clientId
      && state.expiresAt - this.now() > this.renewMarginMs
    );
  }

  private async join(): Promise<SessionState> {
    const body = await this.post(`/identity-runtime/${this.options.tenant}/join`, {
      clientId: this.options.clientId,
      surfaceId: this.options.surfaceId,
      message: this.options.joinMessage ?? "Claude Code host client session.",
    }, "join failed");
    for (const key of ["leaseId", "sessionToken", "stateHash"]) {
      if (typeof body[key] !== "string" || !body[key]) throw new Error(`join failed: response has no ${key}`);
    }
    const state: SessionState = {
      origin: this.origin,
      tenant: this.options.tenant,
      clientId: this.options.clientId,
      surfaceId: this.options.surfaceId,
      leaseId: body.leaseId as string,
      sessionToken: body.sessionToken as string,
      stateHash: body.stateHash as string,
      expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : this.now(),
      joinedAt: this.now(),
    };
    this.options.store.save(state); // the projection text is deliberately not stored
    return state;
  }

  /** Call an authorized endpoint; if the runtime says the session is bad, join again and retry once. */
  private async authorized(path: string, build: (s: SessionState) => unknown): Promise<any> {
    let session = await this.ensure();
    try {
      return await this.post(path, build(session));
    } catch (error) {
      if (!(error instanceof Error) || !SESSION_ERROR.test(error.message)) throw error;
      session = await this.join();
      return this.post(path, build(session));
    }
  }

  private async post(path: string, body: unknown, errorPrefix?: string): Promise<any> {
    const response = await this.fetcher(this.origin + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : `request failed (${response.status})`;
      throw new Error(errorPrefix ? `${errorPrefix}: ${message}` : message);
    }
    return payload;
  }
}
