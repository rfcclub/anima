import { join } from "node:path";
import { homedir } from "node:os";
import { promises as dns } from "node:dns";
import type { ProviderToolCall } from "../providers/interface";
import { runMeshTool } from "../mesh-a2a/agent-tools";
import type { AgentMemoryStore } from "../memory/contract";
import type { AnimaEntityStore } from "../memory/anima-entity-store";
import type { ContextEngine } from "@anima/context-engine";
import type { ToolPolicy } from "../config/types";
import { checkBroadScan, checkPolicy, checkSecretsPath, type PolicyRule } from "./policy-enforcer";
import { handleWebChatTool } from "../web-chat/tool";
import type { WebChatClient } from "../web-chat/client";
import { currentToolBoundary, sandboxToolCommand, sandboxToolEnvironment } from "../web-chat/tool-boundary";
import { handleGithubTool } from "./github-app";

const MAX_OUTPUT_CHARS = 110_000;
/** Default limit for a bash or grep tool call; `ANIMA_TOOL_COMMAND_TIMEOUT_MS` overrides it. */
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
/** Time between SIGTERM and SIGKILL when a command is stopped at its limit. */
const KILL_GRACE_MS = 2_000;

export interface PolicyViolationRecord {
  event: "policy_violation";
  agent: string | undefined;
  tool: string;
  target: string;
  rule: PolicyRule;
  reason: string;
  mode: "warn" | "block";
}

/** One line per bash call, so a log reader can tell which agent ran which command. */
export interface ToolCommandRecord {
  event: "tool_command";
  agent: string | undefined;
  tool: "bash";
  cwd: string | undefined;
  /** The command, cut to MAX_LOGGED_COMMAND_CHARS. */
  command: string;
}

const MAX_LOGGED_COMMAND_CHARS = 500;

export interface ExecuteToolOptions {
  cwd?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Trusted host injection; never a model argument. */
  webChatClient?: WebChatClient;
  agentName?: string;
  memoryStore?: AgentMemoryStore;
  contextEngine?: ContextEngine;
  /** The caller's tool policy. `null` is an explicit "no policy here" (e.g. ScopedExecutor has its own scope).
   *  Required so a new call site cannot silently skip enforcement. */
  policy: ToolPolicy | null;
  /** Receives one record per violation. Defaults to a single JSON line on console.warn. */
  logViolation?: (record: PolicyViolationRecord) => void;
  /** Receives one record per bash call. Defaults to a single JSON line on console.info. */
  logCommand?: (record: ToolCommandRecord) => void;
  /** Limit for a bash or grep call, after which the command and everything it started are stopped. */
  commandTimeoutMs?: number;
}

/** Option, then `ANIMA_TOOL_COMMAND_TIMEOUT_MS`, then the default; only a finite positive value counts. */
function commandTimeout(option: number | undefined): number {
  for (const value of [option, Number(process.env.ANIMA_TOOL_COMMAND_TIMEOUT_MS)]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

function defaultLogViolation(record: PolicyViolationRecord): void {
  console.warn(JSON.stringify(record));
}

function defaultLogCommand(record: ToolCommandRecord): void {
  console.info(JSON.stringify(record));
}

/** Execute a single tool call and return its string result. */
export async function executeTool(call: ProviderToolCall, opts: ExecuteToolOptions): Promise<string> {
  const { cwd, agentName, memoryStore, contextEngine, policy } = opts;
  const timeoutMs = commandTimeout(opts.commandTimeoutMs);
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return `Error: could not parse tool arguments: ${call.arguments}`;
  }

  const boundary = currentToolBoundary();
  if (boundary && ["read", "write", "edit", "grep", "glob"].includes(call.name)) {
    const path = resolvePath(String((call.name === "glob" ? args.cwd : args.path) ?? cwd ?? process.cwd()), cwd);
    if (!boundary.fileAllowed(path, call.name === "write" || call.name === "edit")) {
      return "Error: private bridge/source path denied";
    }
  }

  if (call.name === "bash") {
    (opts.logCommand ?? defaultLogCommand)({
      event: "tool_command",
      agent: agentName,
      tool: "bash",
      cwd,
      command: String(args.command ?? "").slice(0, MAX_LOGGED_COMMAND_CHARS),
    });
  }

  // Hard rules: agent tools never reach the GitHub App keys and never scan the whole home directory,
  // whatever the room's enforce mode.
  const secretsDecision = checkSecretsPath({ tool: call.name, args, cwd });
  const secrets = secretsDecision.allowed ? checkBroadScan({ tool: call.name, args, cwd }) : secretsDecision;
  if (!secrets.allowed) {
    (opts.logViolation ?? defaultLogViolation)({
      event: "policy_violation",
      agent: agentName,
      tool: call.name,
      target: secrets.target,
      rule: secrets.rule,
      reason: secrets.reason,
      mode: "block",
    });
    return `Error: policy violation (${secrets.rule}): ${secrets.reason}`;
  }

  const mode = policy?.enforce ?? "warn";
  if (policy && mode !== "off") {
    const decision = checkPolicy({ tool: call.name, args, policy, cwd });
    if (!decision.allowed) {
      (opts.logViolation ?? defaultLogViolation)({
        event: "policy_violation",
        agent: agentName,
        tool: call.name,
        target: decision.target,
        rule: decision.rule,
        reason: decision.reason,
        mode,
      });
      if (mode === "block") return `Error: policy violation (${decision.rule}): ${decision.reason}`;
    }
  }

  try {
    switch (call.name) {
      case "anima_web_chat":
        return await handleWebChatTool(args, opts);
      case "bash":
        return await runBash(String(args.command ?? ""), timeoutMs, cwd);
      case "read":
        return await runRead(String(args.path ?? ""), args.offset as number | undefined, args.limit as number | undefined, cwd);
      case "grep":
        return await runGrep(String(args.pattern ?? ""), String(args.path ?? ""), String(args.flags ?? ""), timeoutMs, cwd);
      case "glob":
        return await runGlob(String(args.pattern ?? ""), args.cwd ? String(args.cwd) : cwd);
      case "write":
        return await runWrite(String(args.path ?? ""), String(args.content ?? ""), cwd);
      case "edit":
        return await runEdit(String(args.path ?? ""), String(args.old_string ?? ""), String(args.new_string ?? ""), cwd);
      case "anima_github":
        return await handleGithubTool(args, { agentName, policy, cwd });
      case "mesh_send":
      case "mesh_agents":
        return await runMeshTool(call.name, args, agentName ?? "unknown");

      // ── Phase 3b: Memory tools ────────────────────────────────────────
      case "anima_remember":
      case "anima_recall":
      case "anima_forget":
      case "anima_bootstrap":
      case "anima_update":
      case "anima_list_all":
      case "anima_memory_list":
      case "anima_stats":
      case "anima_diagnose":
      case "anima_export":
      case "anima_import":
      case "anima_invalidate":
      case "anima_triple_add":
      case "anima_triple_query":
      case "anima_scratchpad_write":
      case "anima_scratchpad_read":
      case "anima_scratchpad_clear":
      case "anima_agent_status":
      case "anima_sleep":
      case "anima_tool_list":
        return await handleAnimaMemoryTool(call.name === "anima_list_all" ? "anima_memory_list" : call.name, args, memoryStore, agentName);

      case "anima_context_search":
      case "anima_context_describe":
      case "anima_context_expand":
        return handleAnimaContextTool(call.name, args, contextEngine);

      case "task":
        return await runTask(String(args.action ?? "list"), args, cwd);
      case "agent":
        return await runMeshTool("mesh_send", { to: args.to, content: args.body ?? args.content }, agentName ?? "unknown");

      case "web_search":
        return await runWebSearch(args);
      case "web_fetch":
        return await runWebFetch(args);

      case "lcm_grep":
      case "lcm_describe":
      case "lcm_expand":
        return await handleLcmTool(call.name, args, agentName);

      default:
        return `Error: unknown tool: ${call.name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Runs a command in its own process group. At the limit the whole group gets SIGTERM, then SIGKILL,
 * and the output so far is returned with a note, so one slow command cannot hold the agent's turn.
 */
async function runCommand(argv: string[], timeoutMs: number, cwd?: string): Promise<{ stdout: string; stderr: string; note: string }> {
  const proc = Bun.spawn(sandboxToolCommand(argv, cwd), { cwd: cwd ?? process.cwd(), env: sandboxToolEnvironment(), stdout: "pipe", stderr: "pipe", detached: true });
  const signalGroup = (signal: NodeJS.Signals) => { try { process.kill(-proc.pid, signal); } catch { /* already gone */ } };
  let timedOut = false;
  const limitTimer = setTimeout(() => {
    timedOut = true;
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return { stdout, stderr, note: timedOut ? `[stopped: timed out after ${timeoutMs / 1000} s]` : "" };
  } finally {
    // Once stopped, the SIGKILL still fires: a child that ignores SIGTERM can outlive the leader and the pipes.
    clearTimeout(limitTimer);
  }
}

function withNote(text: string, note: string): string {
  return [text, note].filter(Boolean).join("\n");
}

async function runBash(command: string, timeoutMs: number, cwd?: string): Promise<string> {
  const { stdout, stderr, note } = await runCommand(["bash", "-c", command], timeoutMs, cwd);
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  // The note goes after the length cut, so a long output cannot push it out.
  return withNote(truncate(combined || (note ? "" : "(no output)")), note);
}

async function runRead(path: string, offset?: number, limit?: number, cwd?: string): Promise<string> {
  const resolved = resolvePath(path, cwd);
  const text = await Bun.file(resolved).text();
  const lines = text.split("\n");
  const start = offset !== undefined ? Math.max(0, offset - 1) : 0;
  const end = limit !== undefined ? start + limit : lines.length;
  const slice = lines.slice(start, end).map((line, i) => `${start + i + 1}\t${line}`).join("\n");
  return truncate(slice);
}

async function runGrep(pattern: string, path: string, flags: string, timeoutMs: number, cwd?: string): Promise<string> {
  const resolved = resolvePath(path, cwd);
  const args = ["grep", "-n", ...parseFlags(flags), "--", pattern, resolved];
  const { stdout, stderr, note } = await runCommand(args, timeoutMs, cwd);
  const out = stdout.trim();
  return withNote(truncate(out || stderr.trim() || (note ? "" : "(no matches)")), note);
}

async function runGlob(pattern: string, cwd?: string): Promise<string> {
  const base = cwd ?? process.cwd();
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const file of glob.scan({ cwd: base, onlyFiles: false })) {
    const boundary = currentToolBoundary();
    if (!boundary || boundary.fileAllowed(join(base, file))) matches.push(file);
  }
  return truncate(matches.sort().join("\n") || "(no matches)");
}

async function runWrite(path: string, content: string, cwd?: string): Promise<string> {
  const resolved = resolvePath(path, cwd);
  await Bun.write(resolved, content);
  return `Written ${content.length} chars to ${resolved}`;
}

async function runEdit(path: string, oldString: string, newString: string, cwd?: string): Promise<string> {
  const resolved = resolvePath(path, cwd);
  const original = await Bun.file(resolved).text();
  if (!original.includes(oldString)) {
    return `Error: old_string not found in ${resolved}`;
  }
  const updated = original.replace(oldString, newString);
  await Bun.write(resolved, updated);
  return `Edited ${resolved}: replaced ${oldString.length} chars`;
}

async function runTask(action: string, args: Record<string, unknown>, cwd?: string): Promise<string> {
  const taskFile = join(cwd ?? process.cwd(), "tasks.md");

  const readTasks = async (): Promise<string[]> => {
    const file = Bun.file(taskFile);
    if (!(await file.exists())) return [];
    const text = await file.text();
    return text.split("\n").filter(Boolean);
  };

  const writeTasks = async (lines: string[]): Promise<void> => {
    await Bun.write(taskFile, lines.join("\n") + (lines.length ? "\n" : ""));
  };

  switch (action) {
    case "list": {
      const lines = await readTasks();
      if (lines.length === 0) return "No tasks.";
      return lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
    }
    case "create": {
      const title = String(args.title ?? "").trim();
      if (!title) return "Error: title required";
      const lines = await readTasks();
      lines.push(`[ ] ${title}`);
      await writeTasks(lines);
      return JSON.stringify({ status: "created", id: lines.length, title });
    }
    case "complete": {
      const id = Number(args.id);
      const lines = await readTasks();
      if (!id || id < 1 || id > lines.length) return `Error: invalid id ${args.id}`;
      lines[id - 1] = lines[id - 1]!.replace(/^\[ \]/, "[x]");
      await writeTasks(lines);
      return JSON.stringify({ status: "completed", id });
    }
    case "delete": {
      const id = Number(args.id);
      const lines = await readTasks();
      if (!id || id < 1 || id > lines.length) return `Error: invalid id ${args.id}`;
      lines.splice(id - 1, 1);
      await writeTasks(lines);
      return JSON.stringify({ status: "deleted", id });
    }
    default:
      return `Error: unknown action '${action}'. Use: create | list | complete | delete`;
  }
}

async function runWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return JSON.stringify({ results: [], note: "empty query" });

  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return JSON.stringify({ status: "error", message: "BRAVE_API_KEY not set" });

  const count = Math.min(typeof args.count === "number" ? args.count : 10, 20);
  const offset = typeof args.offset === "number" ? args.offset : 0;

  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    if (offset) url.searchParams.set("offset", String(offset));

    const res = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return JSON.stringify({ status: "error", message: `Brave API: ${res.status} ${body.slice(0, 200)}` });
    }

    const data = await res.json() as Record<string, unknown>;
    const web = data.web as Record<string, unknown> | undefined;
    const results = (web?.results as Array<Record<string, unknown>> | undefined) ?? [];
    const output = results.map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      description: r.description ?? "",
    }));

    return JSON.stringify({ results: output, count: output.length });
  } catch (err) {
    return JSON.stringify({ status: "error", message: `web_search failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function runWebFetch(args: Record<string, unknown>): Promise<string> {
  const rawUrl = String(args.url ?? "").trim();
  if (!rawUrl) return JSON.stringify({ status: "error", message: "empty url" });

  let url: URL;
  try { url = new URL(rawUrl); } catch {
    return JSON.stringify({ status: "error", message: `invalid url: ${rawUrl}` });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return JSON.stringify({ status: "error", message: "only http/https urls allowed" });
  }

  // SSRF protection — reject internal/private hosts
  const hostBlocked = isPrivateHost(url.hostname);
  if (hostBlocked) {
    return JSON.stringify({ status: "error", message: hostBlocked });
  }
  // DNS-level check for hostnames that aren't raw IPs
  if (!isRawIP(url.hostname)) {
    const dnsBlocked = await isPrivateResolved(url.hostname);
    if (dnsBlocked) {
      return JSON.stringify({ status: "error", message: dnsBlocked });
    }
  }

  const maxChars = typeof args.max_chars === "number" ? Math.min(args.max_chars, 32000) : 8000;

  try {
    // Manual redirect handling — re-validate each target to prevent redirect-based SSRF
    let currentUrl = url;
    for (let redirects = 0; redirects < 5; redirects++) {
      const res = await fetch(currentUrl.toString(), {
        headers: { "User-Agent": "Anima/1.0 WebFetcher" },
        signal: AbortSignal.timeout(15000),
        redirect: "manual",
      });

      // Follow redirect manually — validate target before following
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return JSON.stringify({ status: "error", message: `HTTP ${res.status} redirect without location` });
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          return JSON.stringify({ status: "error", message: `invalid redirect location: ${location}` });
        }
        if (nextUrl.protocol !== "https:" && nextUrl.protocol !== "http:") {
          return JSON.stringify({ status: "error", message: "redirect to non-http protocol blocked" });
        }
        const redirectBlocked = isPrivateHost(nextUrl.hostname);
        if (redirectBlocked) {
          return JSON.stringify({ status: "error", message: `redirect blocked: ${redirectBlocked}` });
        }
        if (!isRawIP(nextUrl.hostname)) {
          const dnsBlocked2 = await isPrivateResolved(nextUrl.hostname);
          if (dnsBlocked2) {
            return JSON.stringify({ status: "error", message: `redirect blocked: ${dnsBlocked2}` });
          }
        }
        currentUrl = nextUrl;
        continue;
      }

      if (!res.ok) {
        return JSON.stringify({ status: "error", message: `HTTP ${res.status}: ${res.statusText}` });
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        return JSON.stringify({ status: "error", message: `unsupported content type: ${contentType} — only text/html and text/plain` });
      }

      const html = await res.text();
      // Strip HTML tags and decode entities
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return truncate(text.slice(0, maxChars));
    }
    return JSON.stringify({ status: "error", message: "too many redirects" });
  } catch (err) {
    return JSON.stringify({ status: "error", message: `web_fetch failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function isRawIP(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower) || lower.includes(":");
}

function isPrivateHost(hostname: string): string | null {
  const lower = hostname.toLowerCase();

  // Block exact matches
  if (new Set(["localhost", "0.0.0.0", "[::1]", "::1"]).has(lower)) {
    return `url host not allowed: ${hostname}`;
  }

  // Block special-use TLDs
  if (lower.endsWith(".local") || lower.endsWith(".internal")) {
    return `url host not allowed: ${hostname}`;
  }

  // Check if hostname is a raw IPv4 in private/loopback/link-local ranges
  const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 127) return `url resolves to loopback: ${hostname}`;
    if (a === 10) return `url resolves to private address: ${hostname}`;
    if (a === 172 && b >= 16 && b <= 31) return `url resolves to private address: ${hostname}`;
    if (a === 192 && b === 168) return `url resolves to private address: ${hostname}`;
    if (a === 169 && b === 254) return `url resolves to link-local: ${hostname}`;
    if (a === 0) return `url host not allowed: ${hostname}`;
    return null; // public IPv4 — DNS resolution not needed
  }

  // Check if hostname is a raw IPv6 in private/loopback/link-local ranges
  const isIPv6 = lower.includes(":") || lower.startsWith("[");
  if (isIPv6) {
    const stripped = lower.replace(/^\[|\]$/g, ""); // unwrap brackets
    if (stripped === "::1") return `url host not allowed: ${hostname}`;
    if (stripped.startsWith("fe80:")) return `url resolves to link-local: ${hostname}`;
    if (stripped.startsWith("fc") || stripped.startsWith("fd")) return `url resolves to private address: ${hostname}`;
    // IPv4-mapped IPv6 (::ffff:x.x.x.x) — check the embedded IPv4
    const m4 = stripped.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
    if (m4) {
      return isPrivateHost(`${m4[1]}.${m4[2]}.${m4[3]}.${m4[4]}`);
    }
    // Other IPv6 — not an IP pattern we fully validate without DNS; let DNS handle it
  }

  // Not a raw IP — DNS-resolve-able hostname. Will be checked at resolve time.
  return null;
}

async function isPrivateResolved(hostname: string): Promise<string | null> {
  try {
    const records = await dns.resolve4(hostname).catch(() => []);
    for (const ip of records) {
      const blocked = isPrivateHost(ip);
      if (blocked) return blocked;
    }
    const v6 = await dns.resolve6(hostname).catch(() => []);
    for (const ip of v6) {
      const blocked = isPrivateHost(ip);
      if (blocked) return blocked;
    }
  } catch {
    // DNS failure — let fetch handle it
  }
  return null;
}

function resolvePath(path: string, cwd?: string): string {
  if (path.startsWith("~/")) {
    return join(process.env.HOME ?? "~", path.slice(2));
  }
  if (path.startsWith("/")) return path;
  return join(cwd ?? process.cwd(), path);
}

function parseFlags(flags: string): string[] {
  return flags.trim().split(/\s+/).filter(Boolean);
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n[truncated — ${text.length - MAX_OUTPUT_CHARS} chars omitted]`;
}

// ── Phase 3b: Memory Tool Handlers ───────────────────────────────────────────

async function handleAnimaMemoryTool(
  toolName: string,
  args: Record<string, unknown>,
  store?: AgentMemoryStore,
  agentName?: string,
): Promise<string> {
  if (!store) {
    return JSON.stringify({ status: "error", message: "memory store not available — add anima_* tools to agent config to enable" });
  }

  const entityStore = store as unknown as AnimaEntityStore;

  switch (toolName) {
    case "anima_remember": {
      const entry = await store.remember({
        content: String(args.content ?? ""),
        scope: (args.scope as string | undefined) as never ?? "fact",
        confidence: typeof args.confidence === "number" ? args.confidence : 0.8,
        tags: Array.isArray(args.tags) ? args.tags as string[] : [],
        source: String(args.source ?? "agent-tool"),
        parentIds: Array.isArray(args.parent_ids) ? args.parent_ids as string[] : undefined,
        constraints: Array.isArray(args.constraints) ? args.constraints as string[] : undefined,
      });
      return JSON.stringify({ id: entry.id, createdAt: entry.createdAt });
    }
    case "anima_recall": {
      const entries = await store.recall(String(args.query ?? ""), {
        topK: typeof args.top_k === "number" ? args.top_k : 5,
        scopes: Array.isArray(args.scopes) ? args.scopes as never[] : undefined,
        minConfidence: typeof args.min_confidence === "number" ? args.min_confidence : 0,
      });
      return JSON.stringify(entries.map((e) => ({ id: e.id, content: e.content, scope: e.scope, confidence: e.confidence })));
    }
    case "anima_forget": {
      await store.forget(String(args.id ?? ""));
      return JSON.stringify({ status: "ok", message: "entry removed (or not found — nothing to remove)" });
    }
    case "anima_bootstrap": {
      const entries = await store.bootstrap({
        maxEntries: typeof args.max_entries === "number" ? args.max_entries : 10,
        currentPrompt: args.current_prompt ? String(args.current_prompt) : undefined,
      });
      return JSON.stringify(entries.map((e) => ({ id: e.id, content: e.content, scope: e.scope, confidence: e.confidence })));
    }
    case "anima_update": {
      if (!entityStore.updateNeuron) {
        return JSON.stringify({ status: "error", message: "update not supported by this store" });
      }
      const id = String(args.id ?? "");
      const existing = entityStore.getNeuron?.(id);
      if (!existing) return JSON.stringify({ status: "error", message: "entry not found" });
      entityStore.updateNeuron(
        id,
        args.content !== undefined ? String(args.content) : undefined,
        undefined,
        typeof args.confidence === "number" ? args.confidence : undefined,
      );
      return JSON.stringify({ status: "ok", id });
    }
    case "anima_stats": {
      if (!entityStore.stats) return JSON.stringify({ status: "error", message: "stats not supported" });
      return JSON.stringify(entityStore.stats());
    }
    case "anima_diagnose": {
      if (!entityStore.diagnose) return JSON.stringify({ status: "error", message: "diagnose not supported" });
      return JSON.stringify(entityStore.diagnose());
    }
    case "anima_export": {
      if (!entityStore.exportAll) return JSON.stringify({ status: "error", message: "export not supported" });
      const scopes = Array.isArray(args.scopes) ? args.scopes as string[] : undefined;
      const data = entityStore.exportAll(scopes);
      return JSON.stringify(data);
    }
    case "anima_import": {
      if (!entityStore.importAll) return JSON.stringify({ status: "error", message: "import not supported" });
      let parsed: { neurons?: unknown[]; synapses?: unknown[] };
      try { parsed = JSON.parse(String(args.data ?? "")); } catch { return JSON.stringify({ status: "error", message: "invalid JSON" }); }
      const merge = args.merge !== false;
      const result = entityStore.importAll(parsed.neurons ?? [], parsed.synapses ?? [], merge);
      return JSON.stringify(result);
    }
    case "anima_invalidate": {
      if (!entityStore.dryRunInvalidateBySource) return JSON.stringify({ status: "error", message: "invalidate not supported" });
      const source = String(args.source ?? "");
      if (!args.confirm) {
        const ids = entityStore.dryRunInvalidateBySource(source);
        return JSON.stringify({ dry_run: true, affected_ids: ids, count: ids.length });
      }
      const changed = entityStore.invalidateBySource(source);
      return JSON.stringify({ status: "ok", invalidated: changed });
    }
    case "anima_triple_add": {
      if (!entityStore.addSynapse) return JSON.stringify({ status: "error", message: "graph not supported" });
      const sourceNeuron = entityStore.getNeuron?.(String(args.source_id ?? ""));
      if (!sourceNeuron) return JSON.stringify({ status: "error", message: `neuron not found: ${args.source_id}` });
      const targetNeuron = entityStore.getNeuron?.(String(args.target_id ?? ""));
      if (!targetNeuron) return JSON.stringify({ status: "error", message: `neuron not found: ${args.target_id}` });
      const synapseId = entityStore.addSynapse(
        String(args.source_id),
        String(args.target_id),
        String(args.type ?? "relates_to"),
        typeof args.weight === "number" ? args.weight : 0.8,
      );
      return JSON.stringify({ synapse_id: synapseId, status: "ok" });
    }
    case "anima_triple_query": {
      if (!entityStore.getSynapses) return JSON.stringify({ status: "error", message: "graph not supported" });
      const sourceId = args.source_id ? String(args.source_id) : undefined;
      const targetId = args.target_id ? String(args.target_id) : undefined;
      const typeFilter = args.type ? String(args.type) : undefined;
      // getSynapses returns WHERE source_id=? OR target_id=?, so works for both directions
      let synapses = sourceId
        ? entityStore.getSynapses(sourceId).filter((s) => !targetId || s.targetId === targetId)
        : targetId
          ? entityStore.getSynapses(targetId).filter((s) => s.targetId === targetId)
          : [];
      if (typeFilter) synapses = synapses.filter((s) => s.type === typeFilter);
      synapses.sort((a, b) => b.weight - a.weight);
      return JSON.stringify(synapses);
    }
    case "anima_scratchpad_write": {
      if (!entityStore.scratchpadSet) return JSON.stringify({ status: "error", message: "scratchpad not supported" });
      entityStore.scratchpadSet(String(args.key ?? ""), String(args.value ?? ""));
      return JSON.stringify({ status: "ok", key: args.key });
    }
    case "anima_scratchpad_read": {
      if (!entityStore.scratchpadGet) return JSON.stringify({ status: "error", message: "scratchpad not supported" });
      return JSON.stringify(entityStore.scratchpadGet(String(args.key ?? "")));
    }
    case "anima_scratchpad_clear": {
      if (!entityStore.scratchpadDelete) return JSON.stringify({ status: "error", message: "scratchpad not supported" });
      const deleted = entityStore.scratchpadDelete(args.key ? String(args.key) : undefined);
      return JSON.stringify({ status: "ok", deleted });
    }
    case "anima_memory_list": {
      if (!entityStore.listAll) return JSON.stringify({ status: "error", message: "list not supported" });
      const scope = args.scope ? String(args.scope) : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const offset = typeof args.offset === "number" ? args.offset : 0;
      const entries = entityStore.listAll(scope, limit, offset);
      return JSON.stringify({ entries, count: entries.length });
    }
    case "anima_agent_status": {
      const stats = typeof (store as any).stats === "function"
        ? await (store as any).stats()
        : {};
      return JSON.stringify({ status: "healthy", agent: agentName ?? "unknown", ...stats });
    }
    case "anima_sleep": {
      return JSON.stringify({ status: "error", message: "consolidation not implemented in this runtime" });
    }
    case "anima_tool_list": {
      const tools = [
        "anima_remember", "anima_recall", "anima_forget", "anima_bootstrap", "anima_update",
        "anima_memory_list", "anima_stats", "anima_diagnose", "anima_agent_status",
        "anima_triple_add", "anima_triple_query",
        "anima_scratchpad_write", "anima_scratchpad_read", "anima_scratchpad_clear",
        "anima_export", "anima_import", "anima_invalidate",
        "anima_context_search", "anima_context_describe",
        "anima_tool_list", "lcm_grep", "lcm_describe", "lcm_expand",
      ];
      return JSON.stringify({ tools, count: tools.length });
    }
    default:
      return JSON.stringify({ status: "error", message: `unknown memory tool: ${toolName}` });
  }
}

async function handleLcmTool(
  toolName: string,
  args: Record<string, unknown>,
  agentName?: string,
): Promise<string> {
  if (!agentName) return JSON.stringify({ status: "error", message: "agent name required for lcm tools" });
  const dbPath = join(homedir(), ".anima", "rooms", agentName, "context.db");
  let db: import("bun:sqlite").Database | null = null;
  try {
    db = new (await import("bun:sqlite")).Database(dbPath, { readonly: true });
  } catch {
    return JSON.stringify({ status: "error", message: `context.db not found at ${dbPath}` });
  }
  try {
    switch (toolName) {
      case "lcm_grep": {
        const pattern = String(args.pattern ?? "").trim();
        if (!pattern) return JSON.stringify({ results: [], note: "empty pattern" });
        const scope = String(args.scope ?? "both");
        const limit = Math.min(typeof args.limit === "number" ? args.limit : 50, 200);
        const safe = pattern.replace(/["'*+^:~()-]/g, " ").trim();
        const results: unknown[] = [];
        if (safe && (scope === "both" || scope === "messages")) {
          try {
            const rows = db.query(`SELECT m.message_id AS id, m.conversation_id, m.content, m.created_at FROM messages m JOIN messages_fts f ON m.rowid=f.rowid WHERE messages_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`).all(`"${safe}"`, limit);
            results.push(...(rows as unknown[]).map((r: unknown) => ({ type: "message", ...(r as object) })));
          } catch { /* fts may not exist */ }
        }
        if (safe && (scope === "both" || scope === "summaries")) {
          try {
            const rows = db.query(`SELECT s.summary_id AS id, s.conversation_id, s.content, s.created_at FROM summaries s JOIN summaries_fts f ON s.rowid=f.rowid WHERE summaries_fts MATCH ? ORDER BY s.created_at DESC LIMIT ?`).all(`"${safe}"`, limit);
            results.push(...(rows as unknown[]).map((r: unknown) => ({ type: "summary", ...(r as object) })));
          } catch { /* fts may not exist */ }
        }
        return JSON.stringify({ results: results.slice(0, limit), count: results.length });
      }
      case "lcm_describe": {
        const id = String(args.id ?? "").trim();
        if (!id) return JSON.stringify({ status: "error", message: "id required" });
        const row = db.query("SELECT * FROM summaries WHERE summary_id = ?").get(id);
        if (!row) return JSON.stringify({ status: "error", message: `not found: ${id}` });
        return JSON.stringify(row);
      }
      case "lcm_expand": {
        const summaryIds = Array.isArray(args.summaryIds) ? args.summaryIds as string[] : [];
        const query = args.query ? String(args.query).trim() : "";
        let ids = summaryIds;
        if (!ids.length && query) {
          const safe = query.replace(/["'*+^:~()-]/g, " ").trim();
          if (safe) {
            try {
              const rows = db.query(`SELECT s.summary_id FROM summaries s JOIN summaries_fts f ON s.rowid=f.rowid WHERE summaries_fts MATCH ? LIMIT 5`).all(`"${safe}"`);
              ids = (rows as Array<{ summary_id: string }>).map((r) => r.summary_id);
            } catch { /* fts may not exist */ }
          }
        }
        if (!ids.length) return JSON.stringify({ results: [], note: "no summaries matched" });
        const results = ids.slice(0, 5).map((sid) => db!.query("SELECT * FROM summaries WHERE summary_id = ?").get(sid)).filter(Boolean);
        return JSON.stringify({ results, count: results.length });
      }
      default:
        return JSON.stringify({ status: "error", message: `unknown lcm tool: ${toolName}` });
    }
  } finally {
    db.close();
  }
}

function handleAnimaContextTool(
  toolName: string,
  args: Record<string, unknown>,
  contextEngine?: ContextEngine,
): string {
  if (toolName === "anima_context_expand") {
    return JSON.stringify({ status: "error", message: "context expand not implemented — use anima_context_search instead" });
  }
  if (!contextEngine) {
    return JSON.stringify({ results: [], note: "context engine not available for this session" });
  }
  switch (toolName) {
    case "anima_context_search": {
      try {
        const results = (contextEngine as unknown as { search?: (q: string, n: number) => unknown[] }).search?.(
          String(args.query ?? ""), typeof args.limit === "number" ? args.limit : 5,
        ) ?? [];
        return JSON.stringify({ results });
      } catch { return JSON.stringify({ results: [] }); }
    }
    case "anima_context_describe": {
      try {
        const assembled = (contextEngine as unknown as { assemble: (opts: Record<string, unknown>) => { systemPromptAddition?: string } }).assemble({
          tokenBudget: 2000,
        });
        return assembled.systemPromptAddition ?? "(no context assembled yet)";
      } catch { return "(context describe failed)"; }
    }
    default:
      return JSON.stringify({ results: [], note: `unknown context tool: ${toolName}` });
  }
}


