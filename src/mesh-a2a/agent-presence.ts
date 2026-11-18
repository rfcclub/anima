/**
 * rfcclub/anima#103 slice 1: every agent the ANIMA server hosts joins Colony Mesh as its own installation
 * (harness `anima`) and holds a mesh ID while the server runs.
 *
 * Per agent: an identity-runtime join with a `mesh` hint (identity enrolls with Mesh), the shared
 * `MeshSidecar` for heartbeat and leave, and the sidecar socket API at `<ANIMA home>/run/mesh/<agent>.sock`
 * for tools and `anima talk` children. Sockets are served before any join: colony-mesh's socket ownership
 * refuses a path a live server holds, so a second server on the same home never joins (AJ-20).
 * Credentials stay in this module's memory and are never logged.
 */
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describeInstallation, meshMachineName, MeshSidecar } from "colony-mesh/a2a/mesh-sidecar";
import { serveSidecarSocket, type SidecarReply } from "colony-mesh/a2a/mesh-sidecar-socket";

export type PresenceLog = (level: "info" | "error", message: string, fields: Record<string, unknown>) => void;

function safeLog(log: PresenceLog, level: "info" | "error", message: string, fields: Record<string, unknown>): void {
  try {
    const result: unknown = log(level, message, fields);
    if (result && (typeof result === "object" || typeof result === "function") &&
        typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch { /* diagnostics must not change presence behavior */ }
}

export interface AnimaMeshPresenceOptions {
  agents: readonly string[];
  /** The ANIMA home. Its realpath is the installation cwd, so a mesh ID never depends on process.cwd(). */
  animaHome: string;
  identityUrl?: string;
  meshUrl?: string;
  machine?: string;
  heartbeatIntervalMs?: number;
  /** Delay before an identity join that could not complete is tried again. */
  joinRetryMs?: number;
  /**
   * A join carries `notAfter = now + joinDeadlineMs`; identity-runtime does not enroll it after that. The
   * client waits `joinGraceMs` longer (identity's own bounded enroll call), so when it gives up no
   * enrollment of that join can still commit and revoke a replacement (Eli, review of bce805e5).
   */
  joinDeadlineMs?: number;
  joinGraceMs?: number;
  fetch?: typeof fetch;
  log: PresenceLog;
  /** Monotonic clock for observed durations; defaults to performance.now(). */
  monotonicNow?: () => number;
}

export type PresenceState = "idle" | "running" | "busy" | "stopped";

const HARNESS = "anima";
const NOT_ONLINE: SidecarReply = { status: 503, body: { error: "mesh presence is not online" } };
const REQUEST_TIMEOUT_MS = 10_000;
const JOIN_DEADLINE_MS = 10_000;
/** identity-runtime's enroll call is bounded at 1.5 s; the rest is slack for a loaded machine. */
const JOIN_GRACE_MS = 5_000;
/** Mesh checks a proof's expiry in whole seconds before a synchronous commit; this covers that commit. */
const FENCE_SLACK_MS = 100;

export function presenceRunDir(animaHome: string): string {
  return join(realpathSync(animaHome), "run", "mesh");
}

export function presenceSocketPath(animaHome: string, agent: string): string {
  return join(presenceRunDir(animaHome), `${agent}.sock`);
}

export class AnimaMeshPresence {
  state: PresenceState = "idle";
  private readonly installations = new Map<string, AgentInstallation>();
  private readonly sockets: Array<{ stop: () => void }> = [];
  private stopping: Promise<void> | null = null;

  constructor(private readonly options: AnimaMeshPresenceOptions) {}

  /** Serves every agent's socket, then joins the agents in turn. Never throws. */
  async start(): Promise<void> {
    if (this.state !== "idle") return;
    const cwd = realpathSync(this.options.animaHome);
    for (const agent of this.options.agents) {
      const installation = new AgentInstallation(agent, cwd, this.options);
      try {
        this.sockets.push(serveSidecarSocket({
          path: presenceSocketPath(this.options.animaHome, agent),
          list: () => installation.list(),
          send: (input) => installation.send(input),
        }));
      } catch (error) {
        const inUse = error instanceof Error && error.message.includes("in use");
        safeLog(this.options.log, "error", "mesh presence not started", { agent, outcome: inUse ? "home-in-use" : "socket-unavailable" });
        for (const socket of this.sockets.splice(0)) socket.stop();
        this.state = "busy";
        return;
      }
      this.installations.set(agent, installation);
    }
    this.state = "running";
    for (const installation of this.installations.values()) {
      if (this.stopping) return;
      await installation.start();
    }
  }

  meshId(agent: string): string | null {
    return this.installations.get(agent)?.meshId() ?? null;
  }

  /** The agent's inbox address and current registration credential; it changes after a rejoin. */
  inbox(agent: string): { address: string; capability: string } | null {
    return this.installations.get(agent)?.inbox() ?? null;
  }

  list(agent: string): Promise<SidecarReply> {
    return this.installations.get(agent)?.list() ?? Promise.resolve(NOT_ONLINE);
  }

  send(agent: string, input: { target: string; content: string; messageId?: string }): Promise<SidecarReply> {
    const installation = this.installations.get(agent);
    if (!installation) return Promise.resolve(NOT_ONLINE);
    return installation.send({ ...input, messageId: input.messageId ?? crypto.randomUUID() });
  }

  /**
   * Memoized complete shutdown. Every installation first drains its in-flight join and leaves any lease
   * that join returns; only then are the sockets, and with them ownership of the home, released. So a
   * replacement on the same home can join only after the old one's last enrollment has settled.
   */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.state = "stopped";
      await Promise.all([...this.installations.values()].map((installation) => installation.stop()));
      for (const socket of this.sockets.splice(0)) socket.stop();
    })();
    return this.stopping;
  }
}

class AgentInstallation {
  private sidecar: MeshSidecar | null = null;
  private session: IdentitySession | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private lastOutcome: string | null = null;
  private stopped = false;
  /**
   * Until when an admission this installation caused may still commit in Mesh: set only when an outcome
   * was ambiguous (no answer, or identity answered "pending"). Each proof expires by its deadline.
   */
  private admissionsUntil = 0;
  /** The deadline of the proof the sidecar fetched last, for the Mesh join that follows it. */
  private lastProofDeadline = 0;
  /** The join in flight, if any; stop() waits for it. */
  private joining: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly identityUrl: string;
  private readonly machine: string;
  private incident: {
    id: string; started: number; lastSample: number; observedMs: number; persistent: boolean;
  } | null = null;

  constructor(private readonly agent: string, private readonly cwd: string, private readonly options: AnimaMeshPresenceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.identityUrl = options.identityUrl ?? "http://127.0.0.1:13541";
    this.machine = options.machine ?? hostname();
  }

  meshId(): string | null {
    return this.sidecar?.onlineMeshId() ?? null;
  }

  inbox(): { address: string; capability: string } | null {
    return this.sidecar?.inbox() ?? null;
  }

  list(): Promise<SidecarReply> {
    if (!this.session || !this.meshId()) return Promise.resolve(NOT_ONLINE);
    return this.session.forward(`${this.identityUrl}/identity-runtime/continuity/mesh/list`, {});
  }

  /** Sends as this installation only: `from` is always its own mesh ID, whatever the caller passed. */
  send(input: { target: string; content: string; messageId: string }): Promise<SidecarReply> {
    const meshId = this.meshId();
    if (!this.session || !meshId) return Promise.resolve(NOT_ONLINE);
    return this.session.forward(`${this.identityUrl}/identity-runtime/continuity/mesh/send`, {
      target: input.target, content: input.content, messageId: input.messageId, from: meshId,
    });
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.joining ??= this.join().finally(() => { this.joining = null; });
    return this.joining;
  }

  private async join(): Promise<void> {
    const joinUrl = `${this.identityUrl}/identity-runtime/${encodeURIComponent(this.agent)}/join`;
    const joinBody = { clientId: HARNESS, surfaceId: `mesh-${HARNESS}`, message: `Colony Mesh enrollment for ${this.agent} on ${HARNESS}.` };
    const deadlineMs = this.options.joinDeadlineMs ?? JOIN_DEADLINE_MS;
    const notAfter = Date.now() + deadlineMs;
    const joined = await postJson(this.fetchImpl, joinUrl, { ...joinBody, mesh: { harness: HARNESS, cwd: this.cwd, machine: this.machine, notAfter } },
      deadlineMs + (this.options.joinGraceMs ?? JOIN_GRACE_MS));
    if (!joined || typeof joined.leaseId !== "string" || typeof joined.sessionToken !== "string") {
      this.fence(notAfter); // identity may still be working on this join
      return this.later("identity-unreachable");
    }
    const enrollment = joined.meshEnrollment as { status?: string; meshId?: string; heartbeatCredential?: string } | undefined;
    // "pending" can mean identity's own Mesh call timed out while the request may still reach Mesh.
    if (enrollment?.status === "pending") this.fence(notAfter);
    if (this.stopped) {
      // Stopped while the join was in flight: give back the registration it obtained, never heartbeat it.
      if (enrollment?.meshId && enrollment.heartbeatCredential) await this.leave(enrollment.meshId, enrollment.heartbeatCredential);
      return;
    }
    if (!enrollment) return this.later("not-configured");
    if (enrollment.status === "expired") return this.later("join-expired");
    if (enrollment.status === "rejected") return this.report("error", "rejected");

    const session = new IdentitySession(this.fetchImpl, { leaseId: joined.leaseId, clientId: HARNESS, sessionToken: joined.sessionToken }, async () => {
      const renewed = await postJson(this.fetchImpl, joinUrl, joinBody);
      if (typeof renewed?.leaseId !== "string" || typeof renewed.sessionToken !== "string") return null;
      return { leaseId: renewed.leaseId, clientId: HARNESS, sessionToken: renewed.sessionToken };
    });
    this.session = session;
    this.sidecar = new MeshSidecar({
      baseUrl: this.options.meshUrl ?? "http://127.0.0.1:1526",
      fetch: this.fenced(),
      installation: describeInstallation({ agent: this.agent, harness: HARNESS, cwd: this.cwd, machine: meshMachineName(this.machine) }),
      lease: enrollment.status === "enrolled" && enrollment.meshId && enrollment.heartbeatCredential
        ? { meshId: enrollment.meshId, heartbeatCredential: enrollment.heartbeatCredential }
        : undefined,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      proof: async () => {
        this.lastProofDeadline = Date.now() + deadlineMs;
        const issued = await session.forward(`${this.identityUrl}/identity-runtime/continuity/mesh-proof`, { notAfter: this.lastProofDeadline });
        const proof = (issued.body as { proof?: unknown } | null)?.proof;
        if (issued.status !== 200 || typeof proof !== "string") throw new Error("mesh proof unavailable");
        return proof;
      },
    });
    const meshId = await this.sidecar.start();
    this.report(meshId ? "info" : "error", this.sidecar.state, meshId ? { meshId } : {});
    this.watch(this.sidecar);
  }

  /**
   * Follows the sidecar after start: every change of its state is logged once, and a sidecar that has
   * failed (it gives up after repeated Mesh join failures or a second 401) is dropped and the agent
   * joins again from identity, so one bad stretch cannot leave it offline until the server restarts.
   */
  private watch(sidecar: MeshSidecar): void {
    if (this.watcher) clearInterval(this.watcher);
    const watcher = setInterval(() => {
      if (this.stopped || this.sidecar !== sidecar) { clearInterval(watcher); return; }
      const meshId = sidecar.onlineMeshId();
      this.report(meshId ? "info" : "error", sidecar.state, meshId ? { meshId } : {});
      if (sidecar.state !== "failed") return;
      clearInterval(watcher);
      this.sidecar = null;
      this.session = null;
      const timer = setTimeout(() => { this.retry = null; void this.start(); }, this.options.joinRetryMs ?? 30_000);
      (timer as { unref?: () => void }).unref?.();
      this.retry = timer;
    }, this.options.heartbeatIntervalMs ?? 10_000);
    (watcher as { unref?: () => void }).unref?.();
    this.watcher = watcher;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try { this.endIncidentOnStop(); } catch { /* diagnostics are non-fatal */ }
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    await this.joining;
    await this.sidecar?.stop();
    // An admission still in transit can commit only until its proof expires; keep the home until then.
    const open = this.admissionsUntil - Date.now();
    if (open > 0) await Bun.sleep(open + FENCE_SLACK_MS);
  }

  private fence(until: number): void {
    this.admissionsUntil = Math.max(this.admissionsUntil, until);
  }

  /** The sidecar's fetch: a Mesh join that fails in transit may still commit until its proof expires. */
  private fenced(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      try {
        return await this.fetchImpl(input, init);
      } catch (error) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === "/mesh/v1/join") this.fence(this.lastProofDeadline);
        throw error;
      }
    }) as typeof fetch;
  }

  private async leave(meshId: string, credential: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.options.meshUrl ?? "http://127.0.0.1:1526"}/mesh/v1/${encodeURIComponent(meshId)}/leave`, {
        method: "POST", headers: { "x-mesh-registration-credential": credential }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch { /* Mesh unreachable: the registration lapses with its lease */ }
  }

  private later(outcome: string): void {
    this.report("error", outcome);
    if (this.stopped) return;
    const timer = setTimeout(() => { this.retry = null; void this.start(); }, this.options.joinRetryMs ?? 30_000);
    (timer as { unref?: () => void }).unref?.();
    this.retry = timer;
  }

  /** One line per change of outcome; correlate incident diagnostics without adding credentials. */
  private report(level: "info" | "error", outcome: string, extra: { meshId?: string } = {}): void {
    let incidentId: string | undefined;
    const observed = outcome === "online" && !(typeof extra.meshId === "string" && extra.meshId.trim()) ? "unknown" : outcome;
    try { incidentId = this.observeIncident(observed); } catch { /* diagnostics are non-fatal */ }
    if (outcome === this.lastOutcome) return;
    this.lastOutcome = outcome;
    safeLog(this.options.log, level, "mesh presence", { agent: this.agent, outcome, ...extra, ...(incidentId ? { incidentId } : {}) });
  }

  /** Incidents reflect sampled states, not an inferred cause or the actual outage start. */
  private observeIncident(outcome: string): string | undefined {
    if (this.stopped) return undefined;
    const sample = performance.now();
    const now = this.options.monotonicNow?.() ?? sample;
    if (!Number.isFinite(now)) return undefined;
    const interval = Math.max(1, this.options.heartbeatIntervalMs ?? 10_000);
    const maxGap = Math.max(2 * interval, interval + 50);
    if (this.incident && sample - this.incident.lastSample >= maxGap) {
      this.finishIncident("ended", this.incident.observedMs, outcome === "failed" ? "sidecar-failed" : undefined);
    }
    if (outcome === "retrying") {
      if (!this.incident) {
        this.incident = { id: crypto.randomUUID(), started: now, lastSample: sample, observedMs: 0, persistent: false };
        this.emitIncident("retrying", this.incident, 0);
      } else {
        const incident = this.incident;
        incident.lastSample = sample;
        incident.observedMs = this.observedDuration(incident.started, now);
        if (!incident.persistent && incident.observedMs >= 60_000) {
          incident.persistent = true;
          this.emitIncident("persistent", incident, incident.observedMs);
        }
      }
      return this.incident.id;
    }
    if (!this.incident) return undefined;
    const id = this.incident.id;
    this.finishIncident(
      outcome === "online" ? "recovered" : "ended",
      this.observedDuration(this.incident.started, now),
      outcome === "failed" ? "sidecar-failed" : undefined,
    );
    return id;
  }

  private endIncidentOnStop(): void {
    if (!this.incident) return;
    const sample = performance.now();
    const interval = Math.max(1, this.options.heartbeatIntervalMs ?? 10_000);
    const now = this.options.monotonicNow?.() ?? sample;
    const observedMs = Number.isFinite(now) && sample - this.incident.lastSample < Math.max(2 * interval, interval + 50)
      ? this.observedDuration(this.incident.started, now)
      : this.incident.observedMs;
    this.finishIncident("ended", observedMs);
  }

  private observedDuration(started: number, now: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(now - started)));
  }

  private finishIncident(phase: "recovered" | "ended", observedMs: number, reason?: "sidecar-failed"): void {
    const incident = this.incident;
    if (!incident) return;
    this.incident = null;
    this.emitIncident(phase, incident, observedMs, reason);
  }

  private emitIncident(phase: "retrying" | "persistent" | "recovered" | "ended", incident: { id: string }, observedMs: number, reason?: "sidecar-failed"): void {
    safeLog(this.options.log, phase === "recovered" ? "info" : "error", "mesh presence incident", {
      agent: this.agent, incidentId: incident.id, phase, result: phase === "recovered" ? "recovered" : "unknown",
      observedMs, cause: "unknown", ...(reason ? { reason } : {}),
    });
  }
}

interface SessionFields { leaseId: string; clientId: string; sessionToken: string }

/** The answers identity-runtime gives (401) for a lapsed lease or a session it no longer holds. */
const RENEWABLE = new Set(["lease is unavailable", "runtime session is unavailable"]);

/** One agent's identity session: forwards calls with it and renews it once when identity refuses it. */
class IdentitySession {
  private renewing: Promise<boolean> | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private current: SessionFields,
    private readonly rejoin: () => Promise<SessionFields | null>,
  ) {}

  async forward(url: string, fields: Record<string, unknown>): Promise<SidecarReply> {
    const used = this.current;
    const reply = await forward(this.fetchImpl, url, { ...used, ...fields });
    if (reply.status !== 401 || !RENEWABLE.has(String((reply.body as { error?: unknown } | null)?.error))) return reply;
    if (!await this.renew(used)) return reply;
    return forward(this.fetchImpl, url, { ...this.current, ...fields });
  }

  /** Concurrent refusals of the same session share one re-join. */
  private renew(refused: SessionFields): Promise<boolean> {
    if (this.current !== refused) return Promise.resolve(true);
    this.renewing ??= this.rejoin().then((next) => {
      if (next) this.current = next;
      return next !== null;
    }).finally(() => { this.renewing = null; });
    return this.renewing;
  }
}

async function forward(fetchImpl: typeof fetch, url: string, body: unknown): Promise<SidecarReply> {
  try {
    const response = await fetchImpl(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let payload: unknown = null;
    try { payload = await response.json(); } catch { /* empty body */ }
    return { status: response.status, body: payload };
  } catch {
    return { status: 503, body: { error: "identity-runtime is unreachable" } };
  }
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, any> | null> {
  try {
    const response = await fetchImpl(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? await response.json() as Record<string, any> : null;
  } catch {
    return null;
  }
}
