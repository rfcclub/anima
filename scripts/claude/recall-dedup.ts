import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecallResult } from "../identity-runtime/host-session";
import type { SensitiveGuard } from "./sensitive-terms";
import { acquireRecallGuard } from "./recall-guard";

export type DuplicateFilter = (candidates: string[], recent: string[], signal?: AbortSignal) => Promise<boolean[]>;
export interface DedupOptions {
  directory: string;
  decision?: DuplicateFilter;
  deadlineMs?: number;
  maxDecisionCandidates?: number;
  now?: () => number;
}
interface SeenState { version: 1; updatedAt: number; hashes: string[]; recent: Array<{ hash: string; text: string }> }
interface Item { kind: "runtime" | "hindsight" | "local"; body: string; heading: string; original: string; hash: string; normalized: string }
export interface RecallSources { runtime: RecallResult[]; hindsight: string[]; local: string[]; hindsightLabel?: string }
const TTL = 2 * 86400000;
const HASH = /^[a-f0-9]{64}$/;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_HASHES = 500;
const RECENT = 5;
const ENTRY_CHARS = 600;
const RUNTIME_CHARS = 1800;
const MAX_DECISION_ITEMS = 32;
const MAX_STATE_BYTES = 128 * 1024;

/** Only retrieval-envelope fields are stripped. Dates/numbers in the body remain. */
export function normalizeRecallBody(text: string): string {
  return text.normalize("NFC")
    .replace(/^\s*(?:[-*]\s*)?(?:score|timestamp|retrieved[_ -]?at|retrieval[_ -]?id)\s*[:=].*$/gim, "")
    .replace(/[\[(](?:score|timestamp|retrieved[_ -]?at|retrieval[_ -]?id)\s*[:=][^\]\)\n]*[\])]/gi, "")
    .replace(/^\s*-\s*\[[^\]\n]+#[^\]\n]+\]\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "").replace(/\s+/g, " ").trim();
}
function item(kind: Item["kind"], body: string, heading = "", original = body): Item | undefined {
  const normalized = normalizeRecallBody(body);
  if (!normalized || /^\(no results\)$/i.test(normalized)) return undefined;
  return { kind, body: body.trim(), heading, original, normalized, hash: createHash("sha256").update(normalized).digest("hex") };
}
function candidates(sources: RecallSources): Item[] {
  const out: Array<Item | undefined> = [];
  for (const result of sources.runtime) {
    let heading = result.source;
    let body: string[] = [];
    const flush = () => { if (body.join("\n").trim()) out.push(item("runtime", body.join("\n"), heading, heading + "\n" + body.join("\n"))); body = []; };
    for (const line of result.content.split("\n")) {
      if (/^##\s+/.test(line)) { flush(); heading = `${result.source} / ${line.replace(/^##\s+/, "")}`; }
      else body.push(line);
    }
    flush();
  }
  for (const body of sources.hindsight) out.push(item("hindsight", body));
  for (const body of sources.local) out.push(item("local", body));
  return out.filter((entry): entry is Item => !!entry);
}
function render(items: Item[], label?: string): { parts: string[]; emitted: Item[] } {
  const parts: string[] = [], emitted: Item[] = [];
  let runtime = "";
  for (const entry of items.filter(i => i.kind === "runtime")) {
    const prefix = `${runtime ? "\n\n" : ""}## ${entry.heading}\n`;
    const body = entry.body.slice(0, Math.max(0, Math.min(ENTRY_CHARS, RUNTIME_CHARS - runtime.length - prefix.length)));
    if (!body) continue;
    runtime += prefix + body;
    emitted.push(entry);
  }
  if (runtime) parts.push(`RECALLED MEMORY (identity-runtime, per-turn):\n${runtime}`);
  for (const kind of ["hindsight", "local"] as const) {
    const group = items.filter(i => i.kind === kind);
    if (!group.length) continue;
    const title = kind === "hindsight" ? `Hindsight, bank ${label}` : "local bruno-entity fallback — runtime returned nothing";
    parts.push(`RECALLED MEMORY (${title}):\n${group.map(i => i.body).join("\n")}`);
    emitted.push(...group);
  }
  return { parts, emitted };
}
function empty(now: number): SeenState { return { version: 1, updatedAt: now, hashes: [], recent: [] }; }
function load(path: string, now: number): SeenState {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(now); throw error; }
  let value: SeenState;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES || lstatSync(path).isSymbolicLink()) throw Error("invalid state file");
    value = JSON.parse(readFileSync(fd, "utf8"));
  }
  finally { closeSync(fd); }
  if (!value || value.version !== 1 || !Number.isFinite(value.updatedAt) || !Array.isArray(value.hashes) || value.hashes.length > MAX_HASHES || !value.hashes.every(h => typeof h === "string" && HASH.test(h)) || !Array.isArray(value.recent) || value.recent.length > RECENT || !value.recent.every(r => r && typeof r.hash === "string" && HASH.test(r.hash) && value.hashes.includes(r.hash) && typeof r.text === "string" && r.text.length <= ENTRY_CHARS)) throw Error("invalid seen state");
  return now - value.updatedAt > TTL ? empty(now) : value;
}
function prune(directory: string, now: number): void {
  for (const name of readdirSync(directory)) {
    if (!/^[A-Za-z0-9_-]{1,128}\.json(?:\.lock)?$/.test(name)) continue;
    const path = join(directory, name), stat = lstatSync(path);
    if (stat.isFile() && now - stat.mtimeMs > TTL) unlinkSync(path);
  }
}

/** Undefined means use the unchanged legacy output: all state failures fail open. */
export async function deduplicateRecall(sessionId: unknown, sources: RecallSources, options: DedupOptions | undefined, guard: SensitiveGuard): Promise<string[] | undefined> {
  if (!options || typeof sessionId !== "string" || !SESSION.test(sessionId)) return undefined;
  const now = (options.now ?? Date.now)(), path = join(options.directory, `${sessionId}.json`), lock = path + ".lock";
  let release: (() => void) | undefined, temporary: string | undefined;
  try {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(options.directory).isSymbolicLink()) return undefined;
    chmodSync(options.directory, 0o700);
    prune(options.directory, now);
    release = acquireRecallGuard(options.directory, sessionId);
    if (!release) return undefined;
    // Legacy writers keep their existing two-day prune; never overlap a remaining lock.
    try { lstatSync(lock); return undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const state = load(path, now);
    const privateItem = (entry: Item) => !guard.ready || guard.isSensitive(entry.original) || guard.isSensitive(entry.normalized);
    const shortPublicItem = (entry: Item) => !privateItem(entry) && entry.normalized.length <= ENTRY_CHARS;
    // Current policy also fences text saved under a previous terms list.
    state.recent = state.recent.filter(r => guard.ready && !guard.isSensitive(r.text));
    const known = new Set(state.hashes);
    const unseen = candidates(sources).filter(entry => { if (known.has(entry.hash)) return false; known.add(entry.hash); return true; });
    const remote = unseen.filter(shortPublicItem);
    let duplicates: boolean[] = remote.map(() => false);
    const cap = Math.min(MAX_DECISION_ITEMS, options.maxDecisionCandidates ?? MAX_DECISION_ITEMS);
    const deadline = Math.min(2000, options.deadlineMs ?? 2000);
    if (options.decision && remote.length > 0 && remote.length <= cap && state.recent.length > 0 && deadline > 0) {
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          Promise.resolve().then(() => options.decision!(remote.map(i => i.normalized), state.recent.map(i => i.text), controller.signal)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("decision deadline")); }, deadline); }),
        ]);
        if (Array.isArray(answer) && answer.length === remote.length && answer.every(v => typeof v === "boolean")) duplicates = answer;
      } catch { /* keep exact-only output */ }
      finally { clearTimeout(timer); }
    }
    const dropped = new Set(remote.filter((_, i) => duplicates[i]).map(i => i.hash));
    const rendered = render(unseen.filter(i => !dropped.has(i.hash)), sources.hindsightLabel);
    for (const entry of rendered.emitted) {
      state.hashes.push(entry.hash);
      if (shortPublicItem(entry)) state.recent.push({ hash: entry.hash, text: entry.normalized });
    }
    state.hashes = [...new Set(state.hashes)].slice(-MAX_HASHES);
    state.recent = state.recent.filter(r => state.hashes.includes(r.hash)).slice(-RECENT);
    state.updatedAt = now;
    temporary = path + `.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path); temporary = undefined;
    return rendered.parts;
  } catch { return undefined; }
  finally {
    if (temporary) { try { unlinkSync(temporary); } catch {} }
    release?.();
  }
}
