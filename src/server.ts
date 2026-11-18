import { statSync, existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { handleProxyRequest } from "./proxy/index";
import { loadRoomConfig } from "./config/types";
import yaml from "js-yaml";
import { createGatewayFromEnv, createMultiAgentGatewaysFromEnv, type TelegramGateway } from "./channels/telegram-gateway";
import { MaturationLedger } from "./continuity/maturation";
import { DeepDream } from "./dream/deep-dream";
import { LucidDream } from "./dream/lucid-dream";
import { LucidDreamSweep } from "./dream/lucid-dream-sweep";
import { AnthropicProvider } from "./providers/anthropic";
import { GeminiProvider } from "./providers/gemini";
import { ProviderRegistry } from "./providers/registry";
import { ModeRouter } from "./providers/router";
import { OpenAICompatProvider } from "./providers/openai-compat";
import type { Provider, ProviderType } from "./providers/interface";
import type { ModeMap } from "./config/types";
import { StagingManager } from "./continuity/staging";
import { fireDailyIfDue, fireWeeklyIfDue } from "./continuity/wall-clock-schedule";
import { CrossingManager } from "./continuity/crossing";
import { AnimaEntityStore } from "./memory/anima-entity-store";
import { createAgentMemoryStore } from "./memory";
import type { AgentMemoryStore } from "./memory/contract";
import { TrustSystem } from "./evaluation/trust-system";
import { TRUST_DOMAINS, type TrustDomain } from "./evaluation/trust-system";
import { AgoraClient } from "./agora/client";
import { ANIMA } from "./agora/index";
import type { LegioDescriptor, LegioType } from "./agora/types";
import { SessionStore } from "./memory/session-store";
import { acquireSharedWriterLock, type SharedWriterLock } from "./conversation/writer-lock";
import { detectReboot } from "./session/boot-id";
import { buildSessionEndHandler, lightNapFromTurns } from "./session/cross-session-memory";
import { MemoryHealthRegistry } from "./memory/health-registry";
import type { ReflectionScheduler } from "./continuity/reflection-engine";
import { PULSE_ANIMA_HEALTH_FIELD, pulseAnimaHealthField } from "./continuity/pulse-readiness";

let reflectionScheduler: ReflectionScheduler | null = null;
/** Set true only when `ReflectionScheduler.start()` installed the Pulse
 *  dispatcher and its interval timer. `/health` reports it so a deploy can
 *  tell "castle took over" from "reflection init threw and we kept serving"
 *  (pulse-single-owner, anima #133: retiring the old LaunchAgent on a
 *  degraded startup would lose every later slot). */
let pulseAnimaScheduled = false;
/** Set once the server's mesh presence exists: a reflection message goes to the target's mesh ID (rfcclub/anima#103). */
let reflectionSend: ((fromAgent: string, targetAgent: string, content: string) => Promise<void>) | null = null;
import { Database } from "bun:sqlite";
import { PersistentThreadStore } from "./memory/thread-store";
import { handleApiLogs, DEFAULT_LOG_PATH } from "./api/logs";
import { createLogStream } from "./api/logs-stream";
import { AgentSessionChannel } from "./channels/agent-session-channel";
import { loadReflectionAgents } from "./continuity/reflection-config";
import { SessionManager } from "./session/manager";
import { getSessionStore as getTownSessionStore } from "./ui/services/session-store";
import { closeOpenSessions, resolveSessionStore } from "./session/close-open-sessions";
import { parseActivationMode } from "./continuity/activation-config";
import { MeshActivationRuntime } from "./continuity/mesh-activation-runtime";
import { getOrCreateActivationLayer } from "./continuity/activation-layer";
import { createMeshSessionHandlers } from "./continuity/mesh-session-handlers";
import { JsonlGardenEventStore } from "./garden/event-store";
import { createGardenEvent } from "./garden/events";
import { createEliContinuityService } from "./identity-runtime/eli-continuity-service";
import { createBrunoContinuityService } from "./identity-runtime/bruno-continuity-service";
import { createAgentContinuityService } from "./identity-runtime/agent-continuity-service";
import { readRosterAgentIds, resolveColonyPath } from "@anima/identity-runtime/roster";
import { handleTenantContinuityRequest } from "./api/identity-runtime/handlers";
import type { AnimaContinuityService } from "./identity-runtime/continuity-service";
import { readExternalSharedRoom } from "./identity-runtime/shared-room-read";
import { commitExternalSharedRoom } from "./identity-runtime/shared-room-commit";
import type { AnimaContinuityServiceOptions } from "./identity-runtime/continuity-service";
import { meterProvider } from "./cost/meter";
import { coreGuardConfig, startCoreHttpServer, withCoreGuard } from "./core-http";

const port = Number(Bun.env.PORT ?? 3700);
let activationMode: ReturnType<typeof parseActivationMode> | undefined;
function processActivationMode(): ReturnType<typeof parseActivationMode> {
  return activationMode ??= parseActivationMode(Bun.env.ANIMA_ACTIVATION_MODE);
}
const startedAt = Date.now();
const version = "0.1.0";

process.on("unhandledRejection", (reason, promise) => {
  const msg = reason instanceof Error ? reason.stack : String(reason);
  // Suppress "ReadableStream is locked" — this is a known Bun race when
  // an SSE client disconnects mid-stream. The stream's cancel() runs while
  // the reader pump is still in-flight, triggering a harmless rejection.
  if (msg?.includes("ReadableStream is locked")) {
    process.stderr.write(`[suppressed] ReadableStream is locked (client disconnect race)\n`);
    return;
  }
  process.stderr.write(`[CRASH] unhandledRejection: ${msg}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[CRASH] uncaughtException: ${err.stack ?? String(err)}\n`);
});
let telegramGateway: TelegramGateway | null = null;
let eliContinuityService: Promise<AnimaContinuityService> | undefined;
let brunoContinuityService: Promise<AnimaContinuityService> | undefined;
const sessionStore = new SessionStore(
  join(process.env.ANIMA_STATE_DIR ?? join(process.cwd(), "state"), "sessions.db"),
);
let sharedWriterLock: SharedWriterLock | null = null;
if (Bun.env.ANIMA_SHARED_CONVERSATIONS === "1") {
  // This is the canonical shared store used by Castle UI and the reflection
  // adapter — never the app-server state DB by accidental fallback.
  const sharedDbPath = process.env.ANIMA_SESSIONS_DB
    ?? join(Bun.env.ANIMA_UI_STATE_DIR ?? join(process.env.HOME ?? "~", ".anima"), "sessions.db");
  sharedWriterLock = acquireSharedWriterLock(sharedDbPath);
  const sharedRecoveryStore = new SessionStore(sharedDbPath);
  sharedRecoveryStore.interruptRunningSharedRequests();
  sharedRecoveryStore.close();
  const releaseSharedWriterLock = () => sharedWriterLock?.release();
  process.once("SIGINT", releaseSharedWriterLock);
  process.once("SIGTERM", releaseSharedWriterLock);
}
const { isReboot, currentBootId } = detectReboot();

type LogFields = Record<string, unknown>;
type StatusAgent = {
  name: string;
  label: string;
  provider: string;
  mount: "ok" | "missing";
  lastSession: string | null;
};

function log(level: "info" | "error", msg: string, fields: LogFields = {}): void {
  process.stderr.write(JSON.stringify({ level, ts: new Date().toISOString(), msg, ...fields }) + "\n");
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function listRoomNames(): Promise<string[]> {
  try {
    const entries = await readdir(roomsDir(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("_"))
      .sort();
  } catch (error) {
    if (isMissingPath(error)) {
      return [];
    }
    throw error;
  }
}

async function readAgentStatus(name: string): Promise<StatusAgent | null> {
  const roomDir = join(roomsDir(), name);
  const configPath = join(roomDir, "config.yaml");
  let configText: string;

  try {
    configText = await Bun.file(configPath).text();
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }

  const config = loadRoomConfig(configText);
  return {
    name: config.identity.name,
    label: config.identity.label,
    provider: config.provider.type,
    mount: mountExists(join(roomDir, "mount")) ? "ok" : "missing",
    lastSession: await readLastSessionTimestamp(join(roomDir, "sessions")),
  };
}

function roomsDir(): string {
  return Bun.env.ANIMA_ROOMS_DIR ?? join(process.cwd(), "rooms");
}

function readContinuityRoom(callerId: string, placeId: string, conversationId: string) {
  return readExternalSharedRoom({
    roomsDir: roomsDir(),
    knownAgentIds: [...new Set(["eli", "bruno", "abel", ...readRosterAgentIds(resolveColonyPath() ?? "")])],
  }, callerId, placeId, conversationId);
}

const commitContinuityRoom: NonNullable<AnimaContinuityServiceOptions["commitRoom"]> = (callerId, input, signal, authorizeGrant) => {
  return commitExternalSharedRoom({
    roomsDir: roomsDir(),
    knownAgentIds: [...new Set(["eli", "bruno", "abel", ...readRosterAgentIds(resolveColonyPath() ?? "")])],
  }, callerId, input, signal, authorizeGrant);
};

function getEliContinuityService(): Promise<AnimaContinuityService> {
  eliContinuityService ??= createEliContinuityService({
    roomsDir: roomsDir(),
    projectRoot: process.cwd(),
    readRoom: readContinuityRoom,
    commitRoom: commitContinuityRoom,
  });
  return eliContinuityService;
}

function getBrunoContinuityService(): Promise<AnimaContinuityService> {
  brunoContinuityService ??= createBrunoContinuityService({
    roomsDir: roomsDir(),
    readRoom: readContinuityRoom,
    commitRoom: commitContinuityRoom,
  });
  return brunoContinuityService;
}

/**
 * Identities served through the generic factory (identity compiled from the agent's own
 * substrate map): every roster agent except bruno and eli, which have bespoke services.
 * abel (Quin) is always included so a missing roster file cannot take her off.
 */
let genericContinuityAgents: Set<string> | undefined;
function isGenericContinuityAgent(agentId: string): boolean {
  genericContinuityAgents ??= new Set([
    "abel",
    ...readRosterAgentIds(resolveColonyPath() ?? ""),
  ].filter((id) => id !== "bruno" && id !== "eli"));
  return genericContinuityAgents.has(agentId);
}
const genericContinuityServices = new Map<string, Promise<AnimaContinuityService>>();

function getGenericContinuityService(agentId: string): Promise<AnimaContinuityService> {
  let service = genericContinuityServices.get(agentId);
  if (!service) {
    service = createAgentContinuityService({ agentId, roomsDir: roomsDir(), projectRoot: process.cwd(), readRoom: readContinuityRoom, commitRoom: commitContinuityRoom });
    genericContinuityServices.set(agentId, service);
  }
  return service;
}

function getContinuityService(agentId: string): Promise<AnimaContinuityService> | undefined {
  if (agentId === "eli") return getEliContinuityService();
  if (agentId === "bruno") return getBrunoContinuityService();
  if (isGenericContinuityAgent(agentId)) return getGenericContinuityService(agentId);
  return undefined;
}

async function resolveAgentProvider(roomDir: string): Promise<Provider> {
  const configPath = join(roomDir, "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`no config.yaml in ${roomDir}`);
  }
  const config = loadRoomConfig(readFileSync(configPath, "utf-8"));
  const type = config.provider?.type as ProviderType;
  return createProviderForType(type);
}

/** Resolve an agent's AgentMemoryStore without the full AgentLoader boot
 *  (no gene/soul reads, no extra-action hooks) — used by dream jobs that
 *  need to write memory directly, not by a live agent session. */
async function resolveAgentMemoryStore(roomDir: string): Promise<AgentMemoryStore | undefined> {
  const configPath = join(roomDir, "config.yaml");
  if (!existsSync(configPath)) return undefined;
  const config = loadRoomConfig(readFileSync(configPath, "utf-8"));
  return createAgentMemoryStore(config, roomDir);
}

async function createProviderForType(type: ProviderType): Promise<Provider> {
  // Try registry first — supports any provider defined in providers.d/
  const registry = await getRegistry();
  const def = registry?.get(type);
  if (def) {
    return meterProvider(new OpenAICompatProvider(def), { path: "server" });
  }

  // Fallback to built-in providers
  switch (type) {
    case "claude": return meterProvider(new AnthropicProvider({ log: () => {} }), { path: "server" });
    case "gemini": return meterProvider(new GeminiProvider(), { path: "server" });
    default: throw new Error(`unsupported provider type: ${type}`);
  }
}

// Lazy-loaded registry — loads once on first use
let _registry: ProviderRegistry | null | undefined;
async function getRegistry(): Promise<ProviderRegistry | null> {
  if (_registry !== undefined) return _registry;
  const dir = join(roomsDir(), "..", "providers.d");
  try {
    _registry = await ProviderRegistry.load(dir);
    return _registry;
  } catch {
    _registry = null;
    return null;
  }
}

async function listAgentStatuses(): Promise<StatusAgent[]> {
  const names = await listRoomNames();
  const agents = await Promise.all(names.map((name) => readAgentStatus(name)));
  return agents.filter((agent): agent is StatusAgent => agent !== null);
}

function mountExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}

async function readLastSessionTimestamp(sessionsDir: string): Promise<string | null> {
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    const jsonlFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(sessionsDir, entry.name));

    let latest = 0;
    for (const file of jsonlFiles) {
      const mtime = statSync(file).mtimeMs;
      latest = Math.max(latest, mtime);
    }

    return latest > 0 ? new Date(latest).toISOString() : null;
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is { code?: unknown; stack?: unknown } {
  return typeof value === "object" && value !== null;
}

// ── Colony REST API helpers ────────────────────────────────────────────────

interface ColonyAgent {
  name: string;
  substrateName: string;
  substratePath: string;
  bootSequence: string[];
  squad: string | null;
  continuityMode: string;
  platform: string;
  needsEntityMemory: boolean;
  reflectionEnabled?: boolean;
  reflectionIntervalHours?: number;
}

interface TrustEntry {
  domain: string;
  score: number;
  samples: number;
}

const trustSystem = new TrustSystem({ roomsDir: roomsDir() });


async function loadColonyData(): Promise<{ agents: ColonyAgent[] }> {
  const file = Bun.file(join(process.cwd(), "data", "colony.json"));
  if (!(await file.exists())) {
    return { agents: [] };
  }
  const colony = await file.json();

  // Build agent detail lookup from the top-level agents array (contains full metadata)
  const agentMap = new Map<string, Record<string, unknown>>();
  const rawAgents: Record<string, unknown>[] = Array.isArray(colony) ? colony : (colony.agents as Record<string, unknown>[] | undefined) ?? [];
  for (const a of rawAgents) {
    agentMap.set(a.name as string, a);
  }

  // Collect member agentIds from companies structure (new colony.json v2 format)
  const memberIds = new Set<string>();
  const companies = colony.companies as Record<string, { members?: { agentId: string }[] }> | undefined;
  if (companies) {
    for (const key of Object.keys(companies)) {
      const members = companies[key]?.members;
      if (Array.isArray(members)) {
        for (const m of members) {
          if (m.agentId) memberIds.add(m.agentId);
        }
      }
    }
  }

  // If companies exist, use member IDs as the authoritative agent list
  // Otherwise fall back to the raw agents array (legacy format)
  const activeIds: string[] = memberIds.size > 0
    ? [...memberIds]
    : rawAgents.map((a) => a.name as string);

  const agents: ColonyAgent[] = [];
  for (const id of activeIds) {
    const details = agentMap.get(id) ?? {};
    agents.push({
      name: id,
      substrateName: (details.substrateName as string) ?? "",
      substratePath: (details.substratePath as string) ?? "",
      bootSequence: (details.bootSequence as string[]) ?? [],
      squad: (details.squad as string) ?? null,
      continuityMode: (details.continuityMode as string) ?? "standard",
      platform: Array.isArray(details.platforms) ? (details.platforms[0] as string) : "cli",
      needsEntityMemory: (details.needsEntityMemory as boolean) ?? false,
      reflectionEnabled: (details.reflectionEnabled as boolean) ?? false,
      reflectionIntervalHours: (details.reflectionIntervalHours as number) ?? undefined,
    });
  }

  return { agents };
}

async function getTopTrustDomains(agentId: string, count: number = 3): Promise<TrustEntry[]> {
  try {
    const trust = await trustSystem.read(agentId);
    const entries: TrustEntry[] = TRUST_DOMAINS.map((domain) => ({
      domain,
      score: trust.domains[domain].score,
      samples: trust.domains[domain].samples,
    }));
    return entries.sort((a, b) => b.score - a.score).slice(0, count);
  } catch {
    return [];
  }
}

async function getAllTrustDomains(agentId: string): Promise<TrustEntry[]> {
  try {
    const trust = await trustSystem.read(agentId);
    return TRUST_DOMAINS.map((domain) => ({
      domain,
      score: trust.domains[domain].score,
      samples: trust.domains[domain].samples,
    })).sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

async function handleApiColony(): Promise<Response> {
  const { agents } = await loadColonyData();
  const enriched = await Promise.all(
    agents.map(async (agent: ColonyAgent) => {
      const topTrust = await getTopTrustDomains(agent.name);
      return {
        ...agent,
        trust: { topDomains: topTrust },
        wounds: null,
        pendingReviews: null,
        lastCrossing: null,
      };
    }),
  );

  // 10.9 — Colony dashboard reads from Agora state (active tasks, Legio instances)
  let agoraState: { activeTasks: unknown[]; legioInstances: unknown[] } | null = null;
  try {
    if (ANIMA.initialized && ANIMA.client) {
      agoraState = await ANIMA.client.getColonyState();
    }
  } catch {
    // Agora not available, skip
  }

  return json({
    agents: enriched,
    agora: agoraState ?? { activeTasks: [], legioInstances: [] },
  });
}

async function handleColonyStates(): Promise<Response> {
  const { AgentState } = await import("./continuity/agent-state");
  const states = AgentState.getAll();
  return json(states);
}

// ── Cost Dashboard Handlers ──────────────────────────────────────────────────

function getCostReporter(): import("./cost/reporter").CostReporter {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const DB_PATH = process.env.ANIMA_COST_DB ?? join(process.env.HOME ?? "", ".anima", "cost.db");
  const { CostReporter } = require("./cost/reporter") as typeof import("./cost/reporter");
  return new CostReporter(new Database(DB_PATH, { create: true }));
}

function parseCostParams(searchParams: URLSearchParams) {
  return {
    since: searchParams.get("since") ?? undefined,
    until: searchParams.get("until") ?? undefined,
    agentId: searchParams.get("agentId") ?? undefined,
  };
}

/** Runs a report; an invalid since/until is the caller's mistake (400), not a server error. */
function costReport(
  sp: URLSearchParams,
  run: (reporter: import("./cost/reporter").CostReporter, filter: ReturnType<typeof parseCostParams>) => unknown,
): Response {
  try {
    return json(run(getCostReporter(), parseCostParams(sp)));
  } catch (error) {
    if (error instanceof RangeError) return json({ error: error.message }, 400);
    throw error;
  }
}

function handleCostSummary(sp: URLSearchParams): Response {
  // v2 totals, with the rows from before call records existed reported apart in `legacy`.
  return costReport(sp, (reporter, filter) => ({ ...reporter.summary(filter), legacy: reporter.legacy(filter).summary }));
}

function handleCostByModel(sp: URLSearchParams): Response {
  return costReport(sp, (reporter, filter) => reporter.byModel(filter));
}

function handleCostByAgent(sp: URLSearchParams): Response {
  return costReport(sp, (reporter, filter) => reporter.byAgent(filter));
}

function handleCostByProvider(sp: URLSearchParams): Response {
  return costReport(sp, (reporter, filter) => reporter.byProvider(filter));
}

async function handleApiAgent(agentId: string): Promise<Response> {
  const { agents } = await loadColonyData();
  const agentInfo = agents.find((a: ColonyAgent) => a.name === agentId);
  if (!agentInfo) {
    return json({ error: `agent_not_found: ${agentId}` }, 404);
  }

  const allTrust = await getAllTrustDomains(agentId);

  // Check Agora for the agent's active tasks
  let activeTasks: unknown[] = [];
  try {
    if (ANIMA.initialized && ANIMA.client) {
      const state = await ANIMA.client.getColonyState();
      activeTasks = state.activeTasks.filter((t) => t.agentId === agentId);
    }
  } catch {
    // Agora not available
  }

  return json({
    ...agentInfo,
    trust: { domains: allTrust },
    wounds: null,
    pendingReviews: null,
    lastCrossing: null,
    activeTasks,
  });
}

function uiStateDir(): string {
  return Bun.env.ANIMA_UI_STATE_DIR ?? join(process.env.HOME ?? "~", ".anima");
}

function uiSessionDbPath(): string {
  return join(uiStateDir(), "sessions.db");
}

async function handleMeshNotify(req: Request): Promise<Response> {
  let body: { recipient_id?: string; from_id?: string; from_platform?: string; to_platform?: string; subject?: string; content?: string; thread_id?: string | null };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const agentName = body.recipient_id?.replace(/^anima-/, "");
  if (!agentName || !body.content) {
    return json({ error: "missing recipient_id or content" }, 400);
  }
  try {
    const store = new SessionStore(uiSessionDbPath());
    try {
      const mgr = new SessionManager({ store });
      const session = mgr.openSession(agentName, "mesh");
      const inject = [body.subject, body.content].filter(Boolean).join("\n");
      mgr.appendTurn(session.id, "user", inject);
      return json({ ok: true, session_id: session.id });
    } finally {
      store.close();
    }
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  return withCoreGuard(dispatchRequest, coreGuardConfig(port, Bun.env))(req);
}

async function dispatchRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  log("info", "request", { method: req.method, path: url.pathname });

  // Serve docs site static files
  if (url.pathname.startsWith("/docs")) {
    const docsDir = Bun.env.ANIMA_DOCS_DIR || join(import.meta.dir, "..", "docs-site", ".vitepress", "dist");
    let filePath = url.pathname.replace("/docs", "");
    if (filePath === "" || filePath === "/") filePath = "/index.html";
    const fullPath = join(docsDir, filePath);
    const file = Bun.file(fullPath);
    if (await file.exists()) {
      return new Response(file);
    }
    // Try with .html extension
    const htmlFile = Bun.file(fullPath + ".html");
    if (await htmlFile.exists()) {
      return new Response(htmlFile);
    }
    // SPA fallback
    const indexFile = Bun.file(join(docsDir, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile);
    }
    return new Response("Not Found", { status: 404 });
  }

  if (url.pathname.startsWith("/ai/v1/")) {
    const registry = await getRegistry();
    if (!registry) {
      return Response.json({ error: { message: "provider registry not available", type: "api_error" } }, { status: 503 });
    }
    return handleProxyRequest(req, registry);
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const statuses = await listAgentStatuses();
    return json({
      status: "ok",
      version,
      uptime: Math.max(0, Date.now() - startedAt) / 1000,
      agents: statuses.map((agent) => agent.name),
      [PULSE_ANIMA_HEALTH_FIELD]: pulseAnimaHealthField(pulseAnimaScheduled),
    });
  }

  if (req.method === "GET" && url.pathname === "/status") {
    return json({ agents: await listAgentStatuses() });
  }

  if (url.pathname.startsWith("/internal/continuity/")) {
    return handleTenantContinuityRequest(req, getContinuityService);
  }

  if (req.method === "POST" && url.pathname === "/dream") {
    try {
      const body = await req.json() as { agent?: string; prompt?: string };
      if (!body.agent) return json({ error: "agent required" }, 400);

      // Validate agent name — no path traversal
      if (!/^[a-zA-Z0-9_-]+$/.test(body.agent)) {
        return json({ error: "invalid agent name" }, 400);
      }

      const roomDir = join(roomsDir(), body.agent);
      if (!existsSync(roomDir)) {
        return json({ error: `agent not found: ${body.agent}` }, 404);
      }

      // Resolve provider from agent config
      const provider = await resolveAgentProvider(roomDir);

      const lucidDream = new LucidDream();
      const result = await lucidDream.run({
        agentName: body.agent,
        roomDir,
        roomsDir: roomsDir(),
        userPrompt: body.prompt ?? "Reflect on your recent experience.",
        provider,
        memoryStore: await resolveAgentMemoryStore(roomDir),
      });
      return json({ agent: body.agent, reflection: result });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  if (req.method === "POST" && url.pathname === "/colony/reflect") {
    try {
      const body = await req.json() as { from: string; about: string; content: string };
      if (!body.from || !body.about || !body.content) {
        return json({ error: "from, about, content required" }, 400);
      }
      const staging = new StagingManager();
      const reflection = `**Cross-Agent Reflection**\nFrom: ${body.from}\nAbout: ${body.about}\n\n${body.content}`;
      const path = await staging.writeBeam(join(roomsDir(), body.about), reflection);
      return json({ status: "stored", path, agent: body.about });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  if (req.method === "POST" && url.pathname === "/reflection/tick") {
    try {
      const body = await req.json() as { agent?: string; intent?: string };
      const agent = body.agent ?? "bruno";
      const intent = body.intent ?? "manual tick trigger";
      if (!reflectionScheduler) {
        return json({ error: "reflection scheduler not initialized" }, 500);
      }
      const ok = reflectionScheduler.knock(agent, intent);
      if (!ok) {
        return json({ error: `agent not registered: ${agent}` }, 404);
      }
      return json({ status: "tick triggered", agent, intent });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  // Manual pulse-anima run — bypasses the hour window entirely, so
  // verifying a fix never depends on waiting for the next real slot
  // (requirement: it must not depend on the hour it runs).
  if (req.method === "POST" && url.pathname === "/pulse-anima/force-tick") {
    try {
      if (!reflectionScheduler) {
        return json({ error: "reflection scheduler not initialized" }, 500);
      }
      await reflectionScheduler.forcePulseAnimaTick();
      return json({ status: "pulse-anima force-tick complete" });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  if (req.method === "POST" && url.pathname === "/webhook/telegram" && telegramGateway) {
    return telegramGateway.handleWebhook(req);
  }

  // ── Colony REST API ─────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/colony") {
    return handleApiColony();
  }

  if (req.method === "GET" && url.pathname === "/api/colony/states") {
    return handleColonyStates();
  }

  // ── Cost Dashboard API ─────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/cost/summary") {
    return handleCostSummary(url.searchParams);
  }
  if (req.method === "GET" && url.pathname === "/api/cost/by-model") {
    return handleCostByModel(url.searchParams);
  }
  if (req.method === "GET" && url.pathname === "/api/cost/by-agent") {
    return handleCostByAgent(url.searchParams);
  }
  if (req.method === "GET" && url.pathname === "/api/cost/by-provider") {
    return handleCostByProvider(url.searchParams);
  }

  // ── Mesh realtime notify ─────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/api/mesh/notify") {
    return handleMeshNotify(req);
  }

  // ── Log Viewer API ────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/logs") {
    return handleApiLogs(req, DEFAULT_LOG_PATH);
  }

  if (req.method === "GET" && url.pathname === "/api/logs/stream") {
    return createLogStream(req, DEFAULT_LOG_PATH);
  }

  const agentMatch = url.pathname.match(/^\/api\/agent\/([a-zA-Z0-9_-]+)$/);
  if (req.method === "GET" && agentMatch) {
    return handleApiAgent(agentMatch[1]);
  }

  if (req.method === "GET" && url.pathname === "/cost") {
    const uiPort = Number(Bun.env.ANIMA_UI_PORT ?? 3000);
    if (Bun.env.ANIMA_UI_ENABLED !== "true"
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535) {
      return json({ error: "cost_ui_unavailable", message: "Open /cost on the configured Web UI origin; core cost JSON APIs remain available." }, 503);
    }
    const target = new URL(req.url);
    target.port = String(uiPort);
    return Response.redirect(target.toString(), 302);
  }

  if (req.method === "GET" && url.pathname === "/colony") {
    const { agents } = await loadColonyData();
    const ledger = new MaturationLedger();
    const enriched = await Promise.all(
      agents.map(async (agent) => {
        try {
          const roomDir = join(roomsDir(), agent.name);
          const status = await ledger.read(roomDir);
          return { ...agent, maturation: status };
        } catch {
          return agent;
        }
      }),
    );
    return json({ agents: enriched });
  }

  return json({ error: "not_found" }, 404);
}

// ── Legio detection ─────────────────────────────────────────────────────────

const LEGIO_COSTS: Record<LegioType, number> = {
  codex: 1.0,
  qwen: 0.3,
  gemini: 0.5,
};

function detectAvailableLegios(): LegioDescriptor[] {
  const descriptors: LegioDescriptor[] = [];
  const legioTypes: LegioType[] = ["codex", "qwen", "gemini"];

  for (const type of legioTypes) {
    const proc = Bun.spawnSync(["which", type], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode === 0) {
      descriptors.push({
        id: `${type}-1`,
        type,
        label: type,
        available: true,
        trustScore: 0.5,
        cost: LEGIO_COSTS[type],
        activeTasks: 0,
      });
    }
  }

  return descriptors;
}

function createDefaultAgoraClient(): AgoraClient {
  const client = new AgoraClient({
    roomsDir: roomsDir(),
    log,
  });

  for (const desc of detectAvailableLegios()) {
    client.registerLegio(desc);
  }
  log("info", "agora: legio detection complete", {
    type: "agora_legio_detected",
    count: client.getLegioRegistry().length,
  });

  client.installDefaultHandlers();
  return client;
}

// Set where the session-end handler is built (a different function than the DeepDream cron);
// the cron reads it when it fires.
let postDreamSessionEnd: ((sessionId: string, agentName: string) => Promise<void>) | undefined;

export async function startServer(gateway?: TelegramGateway, agoraClient?: AgoraClient): Promise<ReturnType<typeof Bun.serve>> {
  if (gateway) telegramGateway = gateway;
  // This is deliberately read once at the composition root: every autonomous
  // Castle path receives the same mode and cannot retain a legacy bypass.
  const activationMode = processActivationMode();

  // Initialize Agora + ANIMA dispatcher (always on in production)
  const effectiveClient = agoraClient ?? createDefaultAgoraClient();
  ANIMA.initialize(effectiveClient);
  log("info", "agora client initialized", {
    type: "agora_initialized",
    legioCount: effectiveClient.getLegioRegistry().length,
  });

  // Phase 6 / 2026-09-14: Deep dream cron — daily at 23h local. Was a naive
  // setInterval(fn, 24h), which anchors to process-start time rather than
  // the wall clock: a redeploy silently resets when it fires next. Polling
  // every 5 min through fireDailyIfDue (disk-marker-gated by calendar date,
  // same slotKey idea as PulseAnimaDispatcher) makes 23h the real, stable
  // firing time regardless of restarts. (requirement: DeepDream runs at 23:00 every day)
  const deepDreamMarkerPath = join(roomsDir(), "staging", ".deep-dream-schedule.json");
  const deepDreamCheckTimer = setInterval(async () => {
    try {
      if (!(await fireDailyIfDue(deepDreamMarkerPath, 23))) return;
      const deepDream = new DeepDream();
      await deepDream.run(roomsDir());
      log("info", "deep dream completed", {});
      // After the dream, agents start a fresh session.
      const { agents: colonyAgents } = await loadColonyData();
      const fresh = closeOpenSessions({
        store: getTownSessionStore(),
        agents: colonyAgents.map((a) => a.name),
        channel: "ui",
        onEnd: postDreamSessionEnd,
      });
      for (const f of fresh.failed) {
        log("error", "post-dream session close failed for agent", { agent: f.agent, error: f.error });
      }
      if (fresh.endHandlerMissing) log("error", "post-dream sessions closed without an end handler (no summary written)", {});
      log("info", "post-dream sessions closed", { closed: fresh.closed.length });
    } catch (err) {
      log("error", "deep dream cron failed", { error: String(err) });
    }
  }, 5 * 60 * 1000);

  // Lucid dream sweep cron — weekly, Sunday 1h local (same wall-clock-anchored
  // fix as deep dream above; was setInterval(fn, 7d) since process start).
  // Same iterate-all-agents-sequentially pattern as deep dream, but runs
  // LucidDream with a fixed review prompt instead. This enforces WHEN the
  // reflection happens — agents were never reliably self-triggering /dream
  // on their own — without deciding WHAT they do with it; LucidDream still
  // only writes to staging/dreams/. (requirement: LucidDream runs at 1 AM every week)
  const LUCID_DREAM_SWEEP_PROMPT =
    "Read your staging/INBOX.md if it exists, and go through anything waiting there. If it doesn't exist yet, just reflect freely on what you've noticed recently.";
  const lucidDreamSweepMarkerPath = join(roomsDir(), "staging", ".lucid-sweep-schedule.json");
  const lucidDreamSweepCheckTimer = setInterval(async () => {
    try {
      if (!(await fireWeeklyIfDue(lucidDreamSweepMarkerPath, 1, 0))) return;
      const sweep = new LucidDreamSweep();
      await sweep.run({
        roomsDir: roomsDir(),
        resolveProvider: resolveAgentProvider,
        resolveMemoryStore: resolveAgentMemoryStore,
        prompt: LUCID_DREAM_SWEEP_PROMPT,
      });
      log("info", "lucid dream sweep completed", {});
    } catch (err) {
      log("error", "lucid dream sweep cron failed", { error: String(err) });
    }
  }, 5 * 60 * 1000);

  // Reflection Engine: start autonomous tick loops for enabled agents
  reflectionScheduler = null;
  pulseAnimaScheduled = false;
  try {
    const { ReflectionScheduler } = await import("./continuity/reflection-engine");
    const { AgentSession } = await import("./agents/session");
    const reflectionAgents = await loadReflectionAgents(roomsDir());
    const activationLayer = getOrCreateActivationLayer({ activationMode, roomsDir: roomsDir(), log }) ?? undefined;
    reflectionScheduler = new ReflectionScheduler();
    reflectionScheduler.start(reflectionAgents, AgentSession, roomsDir(), {
      activationMode, activationLayer,
      sendMessage: (fromAgent, targetAgent, content) => reflectionSend?.(fromAgent, targetAgent, content) ?? Promise.resolve(),
    });
    // start() installs the pulse-anima dispatcher and its interval timer
    // synchronously before returning, so reaching here means castle really is
    // the scheduler. A throw above skips this and leaves the flag false.
    pulseAnimaScheduled = true;
    if (reflectionAgents.length === 0) {
      log("error", "reflection scheduler has ZERO agents — no room config enables reflection", {});
    } else {
      log("info", "reflection scheduler started", {
        agents: reflectionAgents.map((a) => `${a.name}(${a.reflectionIntervalHours}h)`).join(", "),
      });
    }
  } catch (err) {
    log("error", "reflection engine init failed", { error: String(err) });
  }

  const server = startCoreHttpServer(
    async (req) => {
      try {
        return await dispatchRequest(req);
      } catch (error) {
        log("error", "unhandled request error", {
          stack: error instanceof Error ? error.stack : undefined,
        });
        return json({ error: "internal_server_error" }, 500);
      }
    },
    { port },
  );

  log("info", "server started", { port });
  return server;
}

if (import.meta.main) {
  try {
    const { startWebChatFromEnv } = await import("./web-chat/host");
    const webChatHost = await startWebChatFromEnv();
    if (webChatHost) {
      const stopWebChat = () => { void webChatHost.stop(); };
      process.once("SIGTERM", stopWebChat);
      process.once("SIGINT", stopWebChat);
    }
    // The standalone mesh listener is outside startServer's lexical scope but
    // is the same composition root; keep it on the identical process policy.
    const activationMode = processActivationMode();
    if (isReboot) log("info", "system reboot detected", { bootId: currentBootId });

    // Build session-end handler for cross-session memory persistence
    const sessionEndHandler = async (sessionId: string, agentName: string): Promise<void> => {
      try {
        const memoryStore = MemoryHealthRegistry.getInstance().get(agentName);
        if (!memoryStore) {
          log("info", "onEnd: no memory store for agent", { agent: agentName });
          return;
        }
        const roomDir = join(roomsDir(), agentName);
        const provider = await resolveAgentProvider(roomDir);
        const handler = buildSessionEndHandler(memoryStore, provider, resolveSessionStore(sessionId, [sessionStore, getTownSessionStore()]) ?? sessionStore, undefined, roomDir);
        await handler(sessionId, agentName);
      } catch (err) {
        log("error", "onEnd handler failed", { agent: agentName, error: String(err) });
      }
    };
    postDreamSessionEnd = sessionEndHandler;

    // Town/Castle noon beam flush — 12h local. talk.ts (the actual chat
    // interface) had ZERO connection to LightNap/beams until
    // tonight's lightNapFromTurns() wiring, and even that only fires when
    // the "New" button closes a session (session.ts handleNew). This
    // periodic flush writes a beam for turns-so-far WITHOUT ending the
    // session, so DeepDream has same-day Town/Castle material even when
    // nobody ever clicks "New". Uses getTownSessionStore() specifically —
    // NOT the module-level `sessionStore` above, which points at a
    // different file (ANIMA_STATE_DIR/sessions.db, ~1.6MB) than the one
    // talk.ts actually reads/writes (ANIMA_UI_STATE_DIR default ~/.anima/
    // sessions.db, ~68MB in prod). (requirement: applies to Town/Castle too)
    const townNoonFlushMarkerPath = join(roomsDir(), "staging", ".town-noon-flush-schedule.json");
    const townNoonFlushCheckTimer = setInterval(async () => {
      try {
        if (!(await fireDailyIfDue(townNoonFlushMarkerPath, 12))) return;
        const { agents: colonyAgents } = await loadColonyData();
        const townSessionStore = getTownSessionStore();
        for (const agent of colonyAgents) {
          try {
            const session = townSessionStore.getLatestSession(agent.name, "ui");
            if (!session || session.ended) continue;
            const turns = townSessionStore.getTurns(session.id);
            if (turns.length === 0) continue;
            await lightNapFromTurns(join(roomsDir(), agent.name), agent.name, session.id, turns);
          } catch (err) {
            log("error", "town noon flush failed for agent", { agent: agent.name, error: String(err) });
          }
        }
        log("info", "town/castle noon beam flush completed", {});
      } catch (err) {
        log("error", "town noon flush cron failed", { error: String(err) });
      }
    }, 5 * 60 * 1000);

    // Town/Castle send-agents-home — 22h local, before deep dream at 23h.
    // Actually closes every agent's open "ui" session (fires the existing
    // onEnd handler: cross-session-memory summary + lightNapFromTurns), so
    // tomorrow's first Town/Castle message opens a fresh session instead of
    // one that's been open for days.
    const townSendHomeMarkerPath = join(roomsDir(), "staging", ".town-send-home-schedule.json");
    const townSendHomeCheckTimer = setInterval(async () => {
      try {
        if (!(await fireDailyIfDue(townSendHomeMarkerPath, 22))) return;
        const { agents: colonyAgents } = await loadColonyData();
        const sent = closeOpenSessions({
          store: getTownSessionStore(),
          agents: colonyAgents.map((a) => a.name),
          channel: "ui",
          onEnd: sessionEndHandler,
        });
        for (const f of sent.failed) {
          log("error", "town send-agents-home failed for agent", { agent: f.agent, error: f.error });
        }
        if (sent.endHandlerMissing) log("error", "send-agents-home closed sessions without an end handler (no summary written)", {});
        log("info", "town/castle send-agents-home completed", { closed: sent.closed.length });
      } catch (err) {
        log("error", "town send-agents-home cron failed", { error: String(err) });
      }
    }, 5 * 60 * 1000);

    const threadDbPath = join(process.env.ANIMA_STATE_DIR ?? join(process.cwd(), "state"), "threads.db");
    const threadStore = new PersistentThreadStore(new Database(threadDbPath));
    const gateway = createGatewayFromEnv({ log, sessionStore, threadStore: threadStore as unknown as import("./memory/thread-store").ThreadStore, onEnd: sessionEndHandler });
    const mainServer = startServer(gateway ?? undefined);

    if (gateway) {
      await gateway.start();
      log("info", "telegram gateway started", {});
    }

    // Start per-agent gateways (ANIMA_TELEGRAM_BOT_TOKEN_<AGENT> env vars)
    const agentGateways = createMultiAgentGatewaysFromEnv({ log, sessionStore, threadStore: threadStore as unknown as import("./memory/thread-store").ThreadStore, onEnd: sessionEndHandler });
    for (const agentGateway of agentGateways) {
      await agentGateway.start();
    }
    if (agentGateways.length > 0) {
      log("info", "telegram per-agent gateways started", { count: agentGateways.length });
    }

    // rfcclub/anima#103: every hosted agent holds its own mesh ID, reads its A2A inbox and answers on the
    // same conversation. Off unless ANIMA_MESH_PRESENCE=on, so tests and dev servers never join the live mesh.
    let meshJobsPresence: import("./mesh-jobs/start").MeshJobsPresence | null = null;
    try {
      const { agents: colonyAgents } = await loadColonyData();
      const agentNames = colonyAgents.map((a) => a.name).filter(Boolean);
      if (agentNames.length > 0 && Bun.env.ANIMA_MESH_PRESENCE === "on") {
        const { AnimaMeshPresence, presenceRunDir } = await import("./mesh-a2a/agent-presence");
        const { AgentInboxes, a2aConversation } = await import("./mesh-a2a/agent-inbox");
        const { createInboxDelivery } = await import("./mesh-a2a/inbox-delivery");
        const { ActivationStore } = await import("./continuity/activation-store");
        let replyStore: InstanceType<typeof ActivationStore> | null = null;
        const meshUrl = Bun.env.ANIMA_MESH_URL ?? "http://127.0.0.1:1526";
        const animaHome = Bun.env.ANIMA_HOME ?? join(process.env.HOME ?? "~", ".anima");
        const meshPresence = new AnimaMeshPresence({ agents: agentNames, animaHome, meshUrl, log });
        meshJobsPresence = meshPresence;
        const conversations = new Map<string, ReturnType<typeof a2aConversation>>();
        const conversationFor = (agentId: string) => {
          let port = conversations.get(agentId);
          if (!port) {
            port = a2aConversation({ url: `${meshUrl}/a2a`, capability: () => meshPresence.inbox(agentId)?.capability ?? null });
            conversations.set(agentId, port);
          }
          return port;
        };
        // A reflection message goes to the target's mesh ID, as the reflecting agent.
        reflectionSend = async (fromAgent, targetAgent, content) => {
          const target = meshPresence.meshId(targetAgent);
          if (!target) { log("info", "reflection message not sent: target has no mesh ID", { from: fromAgent, to: targetAgent }); return; }
          await meshPresence.send(fromAgent, { target, content });
        };

        const meshChannels = new Map<string, AgentSessionChannel>();
        for (const name of agentNames) {
          meshChannels.set(name, new AgentSessionChannel({
            roomsDir: roomsDir(),
            sessionStore,
            threadStore: threadStore as unknown as import("./memory/thread-store").ThreadStore,
            onEnd: sessionEndHandler,
          }));
        }
        const meshActivation = activationMode === "gate" || activationMode === "enforce"
          ? (() => {
              // castle-reflection-activation-wiring: reuse the same shared
              // store/broker ReflectionScheduler already claimed via
              // getOrCreateActivationLayer() in startServer() — mesh and
              // reflection candidates now compete through one due
              // queue/budget instead of mesh building its own broker.
              const layer = getOrCreateActivationLayer({ activationMode, roomsDir: roomsDir(), log });
              if (!layer) return null;
              const { store: activationStore, broker } = layer;
              const gardenEvents = new JsonlGardenEventStore(join(roomsDir(), "_shared", "garden", "events.jsonl"));
              const appendAttentionEvent = (type: "ATTENTION_OPENED" | "ATTENTION_STATE_CHANGED", item: import("./continuity/activation-store").AttentionItem) => {
                void gardenEvents.append(createGardenEvent({
                  id: `attention:${type}:${item.id}:${item.version}`,
                  type,
                  timestamp: new Date().toISOString(),
                  agentId: item.agentId,
                  instanceId: item.agentId,
                  runtime: "mesh",
                  project: "castle",
                  payload: {
                    sourceKind: item.sourceKind, sourceRef: item.sourceRef, occurrenceKey: item.occurrenceKey,
                    kind: item.kind, urgency: item.urgency, summary: item.summary,
                    openedAt: item.openedAt, dueAt: item.dueAt, expiresAt: item.expiresAt,
                    state: item.state, version: item.version, occurredAt: Date.now(),
                  },
                })).catch((error) => log("error", "attention audit event failed", {
                  type, attentionId: item.id, error: error instanceof Error ? error.message : String(error),
                }));
              };
              const runtime = new MeshActivationRuntime({
                store: activationStore,
                broker,
                now: () => Date.now(),
                onAttentionProjected: (item) => appendAttentionEvent("ATTENTION_OPENED", item),
                onAttentionStateChanged: (item) => appendAttentionEvent("ATTENTION_STATE_CHANGED", item),
                // rfcclub/anima#100: run the whole request, reply to its sender, report the last failure.
                // rfcclub/anima#103: the reply is the conversation's own A2A `replied`, forwarded by Mesh.
                ...((handlers) => ({
                  executeSession: handlers.executeSession,
                  onFailed: async (input: Parameters<typeof handlers.onFailed>[0]) => {
                    log(input.final ? "error" : "info", input.final ? "mesh session failed; sender notified" : "mesh session attempt failed; retrying", {
                      agent: input.candidate.agentId,
                      sourceRef: input.candidate.sourceRef,
                      attempts: input.attempts,
                      timedOut: input.timedOut,
                      error: input.error instanceof Error ? input.error.message : String(input.error),
                    });
                    await handlers.onFailed(input);
                  },
                }))(createMeshSessionHandlers({
                  runTurn: async (agentId, message, channelId) => {
                    const channel = meshChannels.get(agentId);
                    if (!channel) throw new Error(`no mesh session channel for ${agentId}`);
                    return (await channel.handleMessage({ agentName: agentId, message, channelId })).text;
                  },
                  conversation: conversationFor,
                  markReplied: (agentId, sourceRef) => activationStore.markMeshReplied(agentId, sourceRef, Date.now()),
                })),
              });
              layer.setDispatchRunner(() => runtime.dispatchNext());
              return runtime;
            })()
          : null;
        if (meshActivation) {
          const recovered = meshActivation.recover();
          log("info", "activation broker recovery completed", { mode: activationMode, candidates: recovered });
        }
        const { loadMeshJobsConfig, defaultMeshJobsConfigPath: meshJobsConfigPath } = await import("./mesh-jobs/config");
        let jobWorkers = new Set<string>();
        try {
          jobWorkers = new Set(loadMeshJobsConfig(meshJobsConfigPath())?.workers.map((worker) => worker.agent) ?? []);
        } catch {
          // The consumer logs a bad config itself and stays off; notices then run as chat.
        }
        const inboxes = new AgentInboxes({
          agents: agentNames,
          inbox: (agent) => meshPresence.inbox(agent),
          runDir: presenceRunDir(animaHome),
          url: `${meshUrl}/a2a`,
          deliver: createInboxDelivery({
            activation: meshActivation,
            // Outside gate mode there is no activation layer; items are still kept in mesh_sources first.
            retain: (source) => { (replyStore ??= new ActivationStore(join(roomsDir(), "_shared", "memory.db"))).retainMeshSource(source); },
            runTurn: async (agentName, message) => {
              const channel = meshChannels.get(agentName);
              if (!channel) throw new Error(`no mesh session channel for ${agentName}`);
              return (await channel.handleMessage({ agentName, message, channelId: "mesh" })).text;
            },
            conversation: conversationFor,
            now: () => Date.now(),
            log,
            // A job notice to an agent the job consumer works as is left to the consumer's claim turn.
            jobWorker: (agentName) => jobWorkers.has(agentName),
          }),
        });
        void mainServer.then(() => { inboxes.start(); return meshPresence.start(); }).catch((error) => log("error", "mesh presence failed to start — non-fatal", {
          error: error instanceof Error ? error.message : String(error),
        }));
        const stopMesh = () => { inboxes.stop(); void meshPresence.stop(); };
        process.on("SIGTERM", stopMesh);
        process.on("SIGINT", stopMesh);
        log("info", "colony-mesh presence started", { agents: agentNames });
      }
    } catch (meshErr) {
      log("error", "colony-mesh presence failed — non-fatal", {
        error: meshErr instanceof Error ? meshErr.message : String(meshErr),
      });
    }

    // Start Agent Town UI server if ANIMA_UI_ENABLED is set
    if (Bun.env.ANIMA_UI_ENABLED === "true") {
      const { startUIServer, buildClientBundle } = await import("./ui/app/server");
      await buildClientBundle().catch((err: unknown) =>
        log("error", "ui bundle build failed — serving stale or unbundled UI", {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      try {
        const { createReflectionProvider } = await import("./continuity/reflection-engine");
        const providers = new Map<string, Provider>();
        for (const agent of await loadReflectionAgents(roomsDir())) {
          const provider = await createReflectionProvider(agent);
          if (provider) providers.set(agent.name, provider);
        }
        startUIServer({ roomsDir: roomsDir(), providers });
        log("info", "agent town ui started", {});
      } catch (uiErr) {
        log("error", "agent town ui failed to start — non-fatal", {
          error: uiErr instanceof Error ? uiErr.message : String(uiErr),
        });
      }
    }

    // Remote talk listener (rfcclub/anima#78): off unless its config file
    // exists; never throws (see startRemoteTalkListener).
    const { startRemoteTalkListener } = await import("./remote-talk/listener");
    const { defaultRemoteTalkConfigPath } = await import("./remote-talk/config");
    startRemoteTalkListener({ configPath: defaultRemoteTalkConfigPath(), roomsDir: roomsDir(), log });

    // Mesh job consumer (rfcclub/anima#76, slice 3): off unless its config
    // file exists; each worker works as its agent's mesh ID (rfcclub/anima#103). Never throws.
    const { startMeshJobConsumer } = await import("./mesh-jobs/start");
    const { defaultMeshJobsConfigPath } = await import("./mesh-jobs/config");
    startMeshJobConsumer({ configPath: defaultMeshJobsConfigPath(), presence: meshJobsPresence, log });
  } catch (error) {
    log("error", "server failed to start", {
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
