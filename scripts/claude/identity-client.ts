/**
 * Claude Code host client for the shared identity-runtime.
 *
 *   identity-client.ts hook                    UserPromptSubmit hook: recall for this turn, inject as context
 *   identity-client.ts recall <query...>       one recall, prints JSON
 *   identity-client.ts remember --content <text> [--scope observation] [--tags a,b] [--confidence 0.7] [--source claude-code-cli]
 *   identity-client.ts join                    join (or reuse the stored session), prints a summary
 *
 * Session lives in ~/.agent-runtime/<tenant>/session.json (0600). Recall goes
 * through the runtime over HTTP; on a host that also has local bruno-entity, an
 * empty/failed runtime answer falls back to it (same runtime-first, local-second
 * pattern as the SessionStart hook). The hook is fail-open: it always exits 0.
 */
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { IdentityRuntimeTenant } from "../identity-runtime/fetch-projection.ts";
import { FileSessionStore, HostSession, type RecallResult } from "../identity-runtime/host-session.ts";
import { jevRelevance, type RelevanceFilter } from "./relevance-filter.ts";
import { defaultSensitiveGuard, type SensitiveGuard } from "./sensitive-terms.ts";
import { deduplicateRecall, type DedupOptions } from "./recall-dedup.ts";
import { jevDuplicates } from "./duplicate-filter.ts";

const MAX_QUERY_CHARS = 300;
const MIN_QUERY_CHARS = 12;
const SHORT_QUERY_CHARS = 60;
const MAX_CONTEXT_CHARS = 1800;
const MAX_ENTRY_CHARS = 600;
const DEFAULT_DEADLINE_MS = 3000;
const FILTER_DEADLINE_MS = 1500;
const NOTE_INTERVAL_MS = 10 * 60_000;

/** The text worth recalling on: no markup, one line of whitespace, bounded; undefined = skip this turn. */
export function promptToQuery(prompt: string): string | undefined {
  const text = prompt.replace(/<\/?[a-zA-Z][^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < MIN_QUERY_CHARS || text.startsWith("/")) return undefined;
  return text.slice(0, MAX_QUERY_CHARS);
}

/** promptToQuery plus the project as context when the prompt is too short to carry its own. */
export function composeQuery(prompt: string, project?: string): string | undefined {
  const query = promptToQuery(prompt);
  if (!query) return undefined;
  return project && query.length < SHORT_QUERY_CHARS ? `${query} (project: ${project})` : query;
}

export function formatRecall(results: RecallResult[]): string {
  const sections = results
    .filter((r) => r.content.trim() && !/^\(no results\)$/i.test(r.content.trim()))
    .map((r) => `## ${r.source}\n${r.content.trim().slice(0, MAX_ENTRY_CHARS)}`);
  return sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
}

const HINDSIGHT_MAX_RESULTS = 3;
const HINDSIGHT_MAX_ENTRY_CHARS = 300;

export interface HindsightOptions {
  apiUrl: string;
  bank: string;
  /** Bearer token for a Hindsight server behind an API key; omitted for an open local server. */
  apiToken?: string;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/** Recall from a Hindsight bank (self-hosted server); "" when nothing matches, throws when the server errors. */
export async function hindsightRecall(query: string, options: HindsightOptions): Promise<string> {
  const url = `${options.apiUrl.replace(/\/+$/, "")}/v1/default/banks/${encodeURIComponent(options.bank)}/memories/recall`;
  const response = await (options.fetcher ?? fetch)(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiToken ? { authorization: `Bearer ${options.apiToken}` } : {}),
    },
    body: JSON.stringify({ query, max_tokens: 500 }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DEADLINE_MS),
  });
  if (!response.ok) throw new Error(`hindsight recall failed (${response.status})`);
  const body = (await response.json()) as { results?: Array<{ text?: string; content?: string }> };
  return (body.results ?? [])
    .map((r) => (r.text ?? r.content ?? "").trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .slice(0, HINDSIGHT_MAX_RESULTS)
    .map((text) => `- ${text.slice(0, HINDSIGHT_MAX_ENTRY_CHARS)}`)
    .join("\n");
}

export interface NoteGate {
  shouldNote(): boolean;
  markNoted(): void;
}

export interface HookDeps {
  recall(query: string): Promise<RecallResult[]>;
  /** Per-session dedup; absent means legacy rendering with no seen-state. */
  dedup?: DedupOptions;
  /** Optional local memory, used only when the runtime fails or times out. */
  localRecall?(query: string): Promise<string>;
  /** A second memory source queried in parallel with the runtime (e.g. a Hindsight bank). */
  hindsight?: { label: string; recall(query: string): Promise<string> };
  /** Optional Jev-backed filter that drops memories unrelated to the prompt (Hindsight + local blocks only; runtime memory is never sent out). */
  relevance?: RelevanceFilter;
  /** Tells private memories apart (terms come from a local file); defaults to the guard built from it. Without terms nothing is sent to the filter. */
  guard?: SensitiveGuard;
  /** Cap on the filter call; past it every memory is kept. */
  filterDeadlineMs?: number;
  /** Current project, appended to short queries for context. */
  project?: string;
  noteGate: NoteGate;
  /** Cap on each remote/local step so a slow runtime can never hold the turn. */
  deadlineMs?: number;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function tryLocal(query: string, deps: HookDeps, ms: number): Promise<string> {
  if (!deps.localRecall) return "";
  try {
    return (await withDeadline(deps.localRecall(query), ms)).trim();
  } catch {
    return "";
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
}

const lines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * Drops memories the filter calls unrelated. Sensitive memories are never sent
 * out and are dropped unless the prompt itself is sensitive (then the filter is
 * skipped and everything is kept as retrieved). With no usable terms file the
 * guard cannot tell what is sensitive, so the filter is skipped (nothing is sent
 * out) and everything is kept. Fail-open: a slow or failing filter keeps every memory.
 */
async function applyRelevance(query: string, blocks: string[][], deps: HookDeps): Promise<string[][]> {
  const guard = deps.guard ?? defaultSensitiveGuard();
  if (!deps.relevance || !guard.ready || guard.isSensitive(query)) return blocks;
  const candidates = blocks.flat().filter((item) => !guard.isSensitive(item));
  if (candidates.length === 0) return blocks.map((block) => block.filter((item) => !guard.isSensitive(item)));
  const verdict = await settle(withDeadline(deps.relevance(query, candidates), deps.filterDeadlineMs ?? FILTER_DEADLINE_MS));
  const flags = verdict.ok && verdict.value.length === candidates.length ? verdict.value : candidates.map(() => true);
  const kept = new Set(candidates.filter((_, i) => flags[i]));
  return blocks.map((block) => block.filter((item) => kept.has(item)));
}

/** Returns the hook's JSON stdout, or undefined when there is nothing to inject. */
export async function runHook(input: { prompt?: unknown; session_id?: unknown }, deps: HookDeps): Promise<string | undefined> {
  const query = typeof input.prompt === "string" ? composeQuery(input.prompt, deps.project) : undefined;
  if (!query) return undefined;
  const ms = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;

  // Runtime and Hindsight are independent sources: ask both at once, each under its own deadline.
  const [runtime, hindsight] = await Promise.all([
    settle(withDeadline(deps.recall(query), ms)),
    settle(deps.hindsight ? withDeadline(deps.hindsight.recall(query), ms) : Promise.resolve("")),
  ]);

  const parts: string[] = [];
  const notes: string[] = [];
  let runtimeText = "";
  if (runtime.ok) {
    runtimeText = formatRecall(runtime.value);
  } else if (deps.noteGate.shouldNote()) {
    const message = runtime.error instanceof Error ? runtime.error.message : String(runtime.error);
    notes.push(`[identity-runtime recall unavailable: ${message}]`);
    parts.push(...notes);
    deps.noteGate.markNoted();
  }
  if (runtimeText) parts.push(`RECALLED MEMORY (identity-runtime, per-turn):\n${runtimeText}`);

  // A failing or slow Hindsight is skipped silently: it is a bonus source, not the primary one.
  const hindsightItems = lines(hindsight.ok ? hindsight.value : "");
  // Local recall only stands in for a runtime that could not answer; an empty answer is a real "nothing".
  const localItems = runtime.ok ? [] : lines(await tryLocal(query, deps, ms));

  const [hindsightKept, localKept] = await applyRelevance(query, [hindsightItems, localItems], deps);
  if (hindsightKept.length > 0 && deps.hindsight) {
    parts.push(`RECALLED MEMORY (Hindsight, bank ${deps.hindsight.label}):\n${hindsightKept.join("\n")}`);
  }
  if (localKept.length > 0) {
    parts.push(`RECALLED MEMORY (local bruno-entity fallback — runtime returned nothing):\n${localKept.join("\n")}`);
  }

  const deduped = await deduplicateRecall(input.session_id, {
    runtime: runtime.ok ? runtime.value : [], hindsight: hindsightKept, local: localKept, hindsightLabel: deps.hindsight?.label,
  }, deps.dedup, deps.guard ?? defaultSensitiveGuard());
  const output = deduped === undefined ? parts : [...notes, ...deduped];
  if (output.length === 0) return undefined;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: output.join("\n\n") },
  });
}

/** Rate-limits the "recall unavailable" note via a marker file's mtime. */
export class FileNoteGate implements NoteGate {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  shouldNote(): boolean {
    try {
      return this.now() - statSync(this.path).mtimeMs > NOTE_INTERVAL_MS;
    } catch {
      return true;
    }
  }

  markNoted(): void {
    try {
      if (existsSync(this.path)) utimesSync(this.path, new Date(), new Date());
      else writeFileSync(this.path, "");
    } catch {
      // best effort: a note gate must never break the hook
    }
  }
}

/** Local bruno-entity recall for hosts that have it (checkout directory in BRUNO_ENTITY_DIR); "" when unset, the files are absent or nothing matches. */
export async function brunoEntityLocalRecall(query: string, timeoutMs = DEFAULT_DEADLINE_MS): Promise<string> {
  const entityDir = Bun.env.BRUNO_ENTITY_DIR;
  if (!entityDir) return "";
  const script = join(entityDir, "scripts", "recall.mjs");
  const db = join(entityDir, "data", "bruno.db");
  if (!existsSync(script) || !existsSync(db)) return "";
  const proc = Bun.spawn(["node", script, "--db", db, "--query", query, "--topK", "3", "--session", `cc-uprompt-${Date.now()}`], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const neurons = (JSON.parse(out) as { neurons?: Array<{ type: string; id: number | string; content: string }> }).neurons ?? [];
    return neurons.map((n) => `- [${n.type}#${n.id}] ${n.content.slice(0, 200).replace(/\n/g, " ")}`).join("\n");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function config() {
  const tenant = (Bun.env.IDENTITY_TENANT ?? Bun.env.AGENT_NAME ?? "bruno") as IdentityRuntimeTenant;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(tenant)) throw new Error(`invalid tenant id: ${tenant}`); // the runtime rejects ids it has not registered
  const statePath = Bun.env.IDENTITY_SESSION_PATH ?? join(homedir(), ".agent-runtime", tenant, "session.json");
  const session = new HostSession({
    origin: Bun.env.IDENTITY_RUNTIME_URL ?? "http://127.0.0.1:13541",
    tenant,
    clientId: "claude-code",
    surfaceId: "claude-code-host-client",
    joinMessage: `Claude Code host client for ${tenant} (per-turn recall / remember).`,
    store: new FileSessionStore(statePath),
    timeoutMs: DEFAULT_DEADLINE_MS,
  });
  return { tenant, statePath, session };
}

/** Repo root's basename for the working directory, falling back to the directory's own name. */
function projectName(cwd: string): string | undefined {
  try {
    const top = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stderr: "ignore" }).stdout.toString().trim();
    return basename(top || cwd) || undefined;
  } catch {
    return basename(cwd) || undefined;
  }
}

/** The Hindsight bank for this project (`coding-agent::<project>`, as the Hindsight hook uses); off when disabled or unknown. */
function hindsightSource(project: string | undefined): HookDeps["hindsight"] {
  if (Bun.env.IDENTITY_HOOK_HINDSIGHT === "0") return undefined;
  const bank = Bun.env.HINDSIGHT_BANK ?? (project ? `coding-agent::${project}` : undefined);
  if (!bank) return undefined;
  let apiUrl = Bun.env.HINDSIGHT_API_URL ?? "http://localhost:8891";
  let apiToken = Bun.env.HINDSIGHT_API_TOKEN;
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".hindsight", "coding-agent.json"), "utf8")) as { apiUrl?: string; apiToken?: string };
    if (config.apiUrl && !Bun.env.HINDSIGHT_API_URL) apiUrl = config.apiUrl;
    if (config.apiToken && !apiToken) apiToken = config.apiToken;
  } catch {
    // no config file: default local server
  }
  return { label: bank, recall: (q) => hindsightRecall(q, { apiUrl, bank, apiToken }) };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { tenant, statePath, session } = config();

  if (command === "hook") {
    // Always exit 0 with (possibly) no output: a memory hook must never block a turn.
    try {
      const input = JSON.parse(await Bun.stdin.text()) as { prompt?: unknown; cwd?: unknown; session_id?: unknown };
      const project = projectName(typeof input.cwd === "string" ? input.cwd : process.cwd());
      const out = await runHook(input, {
        recall: (q) => session.directRecall(q),
        localRecall: tenant === "bruno" ? (q) => brunoEntityLocalRecall(q) : undefined,
        hindsight: hindsightSource(project),
        relevance: Bun.env.IDENTITY_HOOK_JEV === "0" || !Bun.env.OPENROUTER_API_KEY ? undefined : jevRelevance({ apiKey: Bun.env.OPENROUTER_API_KEY }),
        dedup: {
          directory: join(dirname(statePath), "recall-seen"),
          decision: Bun.env.IDENTITY_HOOK_JEV === "0" || !Bun.env.OPENROUTER_API_KEY ? undefined : jevDuplicates({ apiKey: Bun.env.OPENROUTER_API_KEY }),
        },
        project,
        noteGate: new FileNoteGate(`${statePath}.note`),
      });
      if (out) console.log(out);
    } catch {
      // swallow
    }
    return;
  }

  if (command === "recall") {
    console.log(JSON.stringify(await session.directRecall(rest.join(" ")), null, 2));
    return;
  }

  if (command === "remember") {
    const content = flag(rest, "--content");
    if (!content) throw new Error("--content is required");
    const confidence = flag(rest, "--confidence");
    const tags = flag(rest, "--tags");
    console.log(JSON.stringify(await session.remember({
      content,
      scope: flag(rest, "--scope"),
      tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      confidence: confidence ? Number(confidence) : undefined,
      source: flag(rest, "--source") ?? "claude-code-cli",
    })));
    return;
  }

  if (command === "join") {
    const s = await session.ensure();
    console.log(JSON.stringify({ ok: true, tenant, leaseId: s.leaseId, expiresAt: new Date(s.expiresAt).toISOString(), statePath }));
    return;
  }

  console.error("usage: identity-client.ts <hook|recall <query>|remember --content <text>|join>");
  process.exitCode = 2;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
