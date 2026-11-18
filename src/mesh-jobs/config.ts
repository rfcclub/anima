import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadWorkConfig, type WorkCaps } from "../work/config";

/** One ANIMA agent. It works as its mesh ID, with the credential of its current enrollment (rfcclub/anima#103). */
export interface MeshJobsWorker {
  agent: string;
  /** Review model for this worker's turns; set together, or neither (the room's own model). */
  provider?: string;
  model?: string;
}

/** One independent reviewer of a work's pull request (anima #135). */
export interface WorkReviewer { agent: string; meshId: string; login: string }

/** An agent that may also carry works, besides `author`. It works as its own mesh ID. */
export interface WorkExtraAuthor { agent: string; meshId: string }

/** The castle work loop (anima #135). Absent unless `work.enabled` is true. */
export interface MeshJobsWorkConfig {
  /** The one logical agent that carries works; must be one of `workers`. */
  author: string;
  /** Optional work-session model; set together, or neither (the work default). */
  provider?: string;
  model?: string;
  externalAdapter?: "off" | "low";
  /**
   * When true, a work that ends at its time or session limit with an uncommitted tree is judged, committed and opened
   * as a draft pull request by the host (rfcclub/anima#305). Off unless the operator sets it.
   */
  hostPublish: boolean;
  /** Optional limits for new works; omitted limits use the work defaults. */
  caps?: Partial<WorkCaps>;
  /** The GitHub login the author's pull requests and reviews carry. */
  authorActor: string;
  authorMeshId: string;
  /**
   * More agents that may carry works, so several works run at once (one writer per work). Each must be a listed
   * worker and never a reviewer. A work is pinned to the author that first claims it. They share `authorActor`,
   * the model and the limits above. Absent or empty: `author` alone carries every work, as before.
   */
  extraAuthors?: WorkExtraAuthor[];
  /** Maximum simultaneous works in this runtime. Defaults to the number of authors. */
  maxConcurrentWorks?: number;
  /** The presence agent whose mesh identity enqueues and confirms review and revise jobs. */
  enqueuer: string;
  base: string;
  /** Per-repository base branch (anima #372); a repository without an entry uses `base`. */
  repoBases?: Record<string, string>;
  reviewers: WorkReviewer[];
  /**
   * GitHub logins of outside reviewers (a cloud review bot, the owner's own review account) whose standing change
   * request on the current head starts a revise. They never count as approvals for the merge. Operator config only.
   */
  externalReviewers: string[];
  releaseBackoffMs: number;
  reconcileIntervalMs: number;
  perToolCallMs: number;
  /**
   * Where a work clones from; `{repo}` is replaced by owner/name. Either an https URL or an absolute path on this
   * machine (a checkout kept up to date by the operator), which needs no network and no credential.
   */
  cloneUrl: string;
}

export interface MeshJobsConfig {
  gatewayUrl: string;
  intervalMs: number;
  heartbeatMs: number;
  turnTimeoutMs: number;
  workers: MeshJobsWorker[];
  work?: MeshJobsWorkConfig;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function defaultMeshJobsConfigPath(): string {
  return Bun.env.ANIMA_MESH_JOBS_CONFIG ?? join(process.env.HOME ?? "~", ".anima", "secrets", "mesh-jobs.json");
}

/**
 * Returns null when the file is absent (consumer off). Throws on any invalid
 * field. Error messages name the field and never include its value.
 */
export function loadMeshJobsConfig(path: string): MeshJobsConfig | null {
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`mesh jobs config must be mode 0600, got ${mode.toString(8)}`);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    throw new Error("mesh jobs config must contain valid JSON");
  }

  const gatewayUrl = parseGatewayUrl(raw.gatewayUrl);
  const intervalMs = parseMs(raw.intervalMs, "intervalMs", 60_000, 10_000);
  const heartbeatMs = parseMs(raw.heartbeatMs, "heartbeatMs", 60_000, 1_000);
  const turnTimeoutMs = parseMs(raw.turnTimeoutMs, "turnTimeoutMs", 600_000, 1_000);

  if (!Array.isArray(raw.workers) || raw.workers.length === 0) {
    throw new Error("mesh jobs config needs at least one entry in workers");
  }
  const workers = raw.workers.map((value, index) => parseWorker(value, index));
  const work = parseWork(raw.work, workers);
  return { gatewayUrl, intervalMs, heartbeatMs, turnTimeoutMs, workers, ...(work ? { work } : {}) };
}

function parseGatewayUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(typeof value === "string" ? value : "");
  } catch {
    throw new Error("mesh jobs config: invalid gatewayUrl");
  }
  // The gateway is loopback-only (colony-mesh#4 is open), so a remote URL is a mistake.
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port) {
    throw new Error("mesh jobs config: gatewayUrl must be http://127.0.0.1:<port> or http://localhost:<port>");
  }
  return url.origin;
}

function parseMs(value: unknown, field: string, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`mesh jobs config: ${field} must be an integer of at least ${min}`);
  }
  return value;
}

function parseWorker(value: unknown, index: number): MeshJobsWorker {
  const worker = (value ?? {}) as Record<string, unknown>;
  const fail = (field: string): never => {
    throw new Error(`mesh jobs worker ${index}: invalid ${field}`);
  };
  const agent = typeof worker.agent === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(worker.agent) ? worker.agent : fail("agent");
  for (const field of ["address", "capability"]) {
    if (field in worker) throw new Error(`mesh jobs worker ${index}: remove ${field}; the worker uses the agent's mesh ID and enrollment`);
  }
  if (worker.provider === undefined && worker.model === undefined) return { agent };
  const provider = typeof worker.provider === "string" && worker.provider.length > 0 ? worker.provider : fail("provider");
  const model = typeof worker.model === "string" && worker.model.length > 0 ? worker.model : fail("model");
  return { agent, provider, model };
}

const MESH_ID = /^[a-z0-9][a-z0-9_.-]*@[a-z0-9][a-z0-9_.-]*$/;
const WORK_KEYS = new Set(["enabled", "author", "provider", "model", "caps", "externalAdapter", "hostPublish", "authorActor", "authorMeshId", "extraAuthors", "maxConcurrentWorks", "enqueuer", "base", "repoBases", "reviewers", "externalReviewers", "releaseBackoffMs", "reconcileIntervalMs", "perToolCallMs", "cloneUrl"]);

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BASE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * A branch name git accepts as a ref (`git check-ref-format --branch`). The character set is already limited, so the
 * remaining rules are per component: not empty, not starting with a dot, not ending in `.lock`; and not ending in a
 * dot or holding `..` anywhere.
 */
function validBaseBranch(branch: string): boolean {
  if (!BASE_BRANCH.test(branch) || branch.includes("..") || branch.endsWith(".")) return false;
  return branch.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/**
 * Per-repository base branches (anima #372): `{ "owner/name": "branch" }`. Keys are normalised to lower case and
 * a repository may appear only once, in any case. A branch is checked with the same rules the workspace applies.
 * Never names the offending value, only the field.
 */
function parseRepoBases(value: unknown): Record<string, string> {
  const fail = (): never => { throw new Error("mesh jobs config: invalid work.repoBases"); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const out: Record<string, string> = {};
  for (const [repo, branch] of Object.entries(value as Record<string, unknown>)) {
    if (!REPO_NAME.test(repo) || repo.includes("..")) fail();
    const key = repo.toLowerCase();
    if (key in out) fail();
    if (typeof branch !== "string" || !validBaseBranch(branch)) fail();
    out[key] = branch as string;
  }
  return out;
}

/**
 * `work.extraAuthors`: `[{ agent, meshId }]`. Every agent is a listed worker, differs from the primary author and from
 * every reviewer, and no agent or mesh ID repeats, so an author never reviews and no identity is shared. Never names
 * the offending value, only the field.
 */
function parseExtraAuthors(value: unknown, workers: MeshJobsWorker[], author: string, authorMeshId: string, reviewers: unknown): WorkExtraAuthor[] {
  const fail = (): never => { throw new Error("mesh jobs config: invalid work.extraAuthors"); };
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail();
  const reviewerList = Array.isArray(reviewers) ? (reviewers as Array<Record<string, unknown>>) : [];
  const agents = new Set<string>([author]);
  const meshIds = new Set<string>([authorMeshId.toLowerCase()]);
  const out: WorkExtraAuthor[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail();
    const { agent, meshId, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return fail();
    if (typeof agent !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(agent)) return fail();
    if (typeof meshId !== "string" || !MESH_ID.test(meshId)) return fail();
    if (!workers.some((worker) => worker.agent === agent)) return fail();
    if (agents.has(agent) || meshIds.has(meshId.toLowerCase())) return fail();
    if (reviewerList.some((r) => r?.agent === agent || (typeof r?.meshId === "string" && r.meshId.toLowerCase() === meshId.toLowerCase()))) return fail();
    agents.add(agent);
    meshIds.add(meshId.toLowerCase());
    out.push({ agent, meshId });
  }
  return out;
}

/** Null when absent or disabled. Every other problem is an error naming `work.<field>`. */
function parseWork(value: unknown, workers: MeshJobsWorker[]): MeshJobsWorkConfig | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("mesh jobs config: work must be an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!WORK_KEYS.has(key)) throw new Error(`mesh jobs config: unknown field work.${key}`);
  if (raw.enabled !== true) return null;

  const fail = (field: string): never => { throw new Error(`mesh jobs config: invalid work.${field}`); };
  const text = (field: string): string => (typeof raw[field] === "string" && (raw[field] as string).trim() !== "" ? (raw[field] as string) : fail(field));
  const name = (field: string): string => { const v = text(field); return /^[a-z0-9][a-z0-9_-]*$/.test(v) ? v : fail(field); };
  const meshId = (field: string): string => { const v = text(field); return MESH_ID.test(v) ? v : fail(field); };
  const ms = (field: string, fallback: number, min: number, max = 3_600_000): number => {
    if (raw[field] === undefined) return fallback;
    const v = raw[field];
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fail(field);
  };

  const author = name("author");
  const externalAdapter = raw.externalAdapter === undefined ? "off" : raw.externalAdapter;
  if (externalAdapter !== "off" && externalAdapter !== "low") fail("externalAdapter");
  const hostPublish = raw.hostPublish === undefined ? false : raw.hostPublish;
  if (typeof hostPublish !== "boolean") fail("hostPublish");
  if (!workers.some((worker) => worker.agent === author)) fail("author");
  let provider: string | undefined;
  let model: string | undefined;
  if (raw.provider !== undefined || raw.model !== undefined) {
    provider = text("provider");
    model = text("model");
  }
  let caps: Partial<WorkCaps> | undefined;
  if (raw.caps !== undefined) {
    if (typeof raw.caps !== "object" || raw.caps === null || Array.isArray(raw.caps)) fail("caps");
    caps = raw.caps as Partial<WorkCaps>;
    try {
      loadWorkConfig({ caps });
    } catch {
      fail("caps");
    }
  }
  const authorActor = text("authorActor");
  const authorMeshId = meshId("authorMeshId");
  const enqueuer = name("enqueuer");
  const base = text("base");
  const repoBases = raw.repoBases === undefined ? undefined : parseRepoBases(raw.repoBases);

  const extraAuthors = parseExtraAuthors(raw.extraAuthors, workers, author, authorMeshId, raw.reviewers);
  const maxConcurrentWorks = raw.maxConcurrentWorks === undefined ? 1 + extraAuthors.length : raw.maxConcurrentWorks;
  if (typeof maxConcurrentWorks !== "number" || !Number.isSafeInteger(maxConcurrentWorks) || maxConcurrentWorks < 1) {
    fail("maxConcurrentWorks");
  }

  if (!Array.isArray(raw.reviewers) || raw.reviewers.length === 0) fail("reviewers");
  const reviewers: WorkReviewer[] = (raw.reviewers as unknown[]).map((entry) => {
    const r = (entry ?? {}) as Record<string, unknown>;
    const ok = typeof r.agent === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(r.agent)
      && typeof r.meshId === "string" && MESH_ID.test(r.meshId)
      && typeof r.login === "string" && r.login.trim() !== "";
    if (!ok) return fail("reviewers");
    // the author never reviews its own work
    if (r.agent === author || r.meshId === authorMeshId || (r.login as string).toLowerCase() === authorActor.toLowerCase()) return fail("reviewers");
    return { agent: r.agent as string, meshId: r.meshId as string, login: r.login as string };
  });

  const externalReviewers: string[] = [];
  if (raw.externalReviewers !== undefined) {
    if (!Array.isArray(raw.externalReviewers) || raw.externalReviewers.length > 10) fail("externalReviewers");
    for (const login of raw.externalReviewers as unknown[]) {
      const ok = typeof login === "string" && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\[bot\])?$/i.test(login)
        && login.toLowerCase() !== authorActor.toLowerCase()
        && !externalReviewers.some((seen) => seen.toLowerCase() === login.toLowerCase());
      if (!ok) fail("externalReviewers");
      externalReviewers.push(login as string);
    }
  }

  const cloneUrl = raw.cloneUrl === undefined ? "https://github.com/{repo}.git" : text("cloneUrl");
  const localPath = cloneUrl.startsWith("/") && !cloneUrl.split("/").includes("..") && !/["\\\n\r\0]/.test(cloneUrl);
  if (!(cloneUrl.startsWith("https://") || localPath) || !cloneUrl.includes("{repo}")) fail("cloneUrl");

  return {
    author, ...(provider && model ? { provider, model } : {}), ...(caps !== undefined ? { caps } : {}), externalAdapter: externalAdapter as "off" | "low", hostPublish: hostPublish as boolean,
    authorActor, authorMeshId, extraAuthors, maxConcurrentWorks: maxConcurrentWorks as number, enqueuer, base, ...(repoBases ? { repoBases } : {}), reviewers, externalReviewers, cloneUrl,
    releaseBackoffMs: ms("releaseBackoffMs", 30_000, 5_000),
    reconcileIntervalMs: ms("reconcileIntervalMs", 60_000, 10_000),
    perToolCallMs: ms("perToolCallMs", 120_000, 1_000, 600_000),
  };
}
