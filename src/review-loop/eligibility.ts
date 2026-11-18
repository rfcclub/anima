import policy from "../../data/pr-review-policy.json";

type Fields = Record<string, unknown>;
type Collection<T> = { complete: boolean; items: T[] };
interface Review {
  id: number;
  appLogin: string;
  state: string;
  headSha: string;
  body: string;
  submittedAt: number;
}
interface Candidate {
  repo: string;
  number: number;
  state: string;
  draft: boolean;
  headSha: string;
  baseSha: string;
  observedHeadSha: string;
  observedBaseSha: string;
  ownerAgents: string[];
  authorLogin: string;
  paths: Collection<{ path: string; previousPath?: string }>;
  commits: Collection<{ sha: string; authorLogin: string; committerLogin: string; message: string }>;
  reviews: Collection<Review>;
  threads: Collection<{ resolved: boolean }>;
  ci: { complete: boolean; configured: boolean | null; headSha: string; results: string[] };
  issue: { number: number; type: string; approved: boolean } | null;
  loop: { complete: boolean; rounds: number; lastAttemptAt: number } | null;
}
export interface ReviewAuditContext {
  /** Trusted caller configuration, never inferred from PR prose. */
  apps: Record<string, string>;
  /** Future tool-layer receipt store; do not populate from review body text. */
  bindings: Array<{ reviewId: number; headSha: string; baseSha: string; appLogin: string }>;
  now: number;
  /** Caller-owned minimum elapsed duration; equality has finished the cooldown. */
  cooldownMs: number;
}
export interface ReviewAudit {
  /** This diagnostic has no merge action, even if other facts are satisfied. */
  automaticMerge: false;
  reasons: string[];
}

const MAX_ITEMS = 10_000;
const MAX_TEXT_LENGTH = 65_536;
const object = (v: unknown): v is Fields => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_TEXT_LENGTH;
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v > 0;
const sha = (v: unknown): v is string => text(v) && /^[a-f0-9]{40}$/.test(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_ITEMS && v.every(text);
function collection(v: unknown, check: (item: unknown) => boolean): boolean {
  return object(v) && bool(v.complete) && Array.isArray(v.items) && v.items.length <= MAX_ITEMS && v.items.every(check);
}
function candidate(v: unknown): v is Candidate {
  return object(v)
    && text(v.repo) && /^rfcclub\/[A-Za-z0-9._-]+$/.test(v.repo) && positive(v.number)
    && text(v.state) && bool(v.draft) && sha(v.headSha) && sha(v.baseSha)
    && sha(v.observedHeadSha) && sha(v.observedBaseSha) && strings(v.ownerAgents) && text(v.authorLogin)
    && collection(v.paths, p => object(p) && text(p.path) && (p.previousPath === undefined || text(p.previousPath)))
    && collection(v.commits, c => object(c) && sha(c.sha) && text(c.authorLogin) && text(c.committerLogin) && text(c.message))
    && collection(v.reviews, r => object(r) && positive(r.id) && text(r.appLogin) && text(r.state)
      && sha(r.headSha) && text(r.body) && finite(r.submittedAt) && r.submittedAt >= 0)
    && collection(v.threads, t => object(t) && bool(t.resolved))
    && object(v.ci) && bool(v.ci.complete) && (v.ci.configured === null || bool(v.ci.configured))
    && sha(v.ci.headSha) && strings(v.ci.results)
    && (v.issue === null || (object(v.issue) && positive(v.issue.number) && text(v.issue.type) && bool(v.issue.approved)))
    && (v.loop === null || (object(v.loop) && bool(v.loop.complete) && finite(v.loop.rounds) && finite(v.loop.lastAttemptAt)));
}
function context(v: unknown): v is ReviewAuditContext {
  return object(v) && object(v.apps) && Object.keys(v.apps).length <= MAX_ITEMS && Object.entries(v.apps).every(([agent, login]) =>
    /^[a-z0-9][a-z0-9_-]*$/.test(agent) && text(login) && /^[a-z0-9][a-z0-9-]*\[bot\]$/i.test(login))
    && Object.keys(v.apps).length > 0 && Array.isArray(v.bindings) && v.bindings.length <= MAX_ITEMS && v.bindings.every(b =>
      object(b) && positive(b.reviewId) && sha(b.headSha) && sha(b.baseSha) && text(b.appLogin))
    && finite(v.now) && v.now >= 0 && Number.isSafeInteger(v.cooldownMs) && (v.cooldownMs as number) >= 0;
}
/** Capture trusted tool-side inputs before any await. This proves shape, not issuer or custody. */
export function captureReviewAuditContext(input: unknown): ReviewAuditContext | null {
  try {
    if (!object(input)) return null;
    const apps = input.apps, bindings = input.bindings, now = input.now, cooldownMs = input.cooldownMs;
    if (!object(apps) || !Array.isArray(bindings)) return null;
    const keys = Reflect.ownKeys(apps), length = bindings.length;
    if (keys.length === 0 || keys.length > MAX_ITEMS || length > MAX_ITEMS) return null;
    const copiedApps: Record<string, string> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") return null;
      copiedApps[key] = apps[key] as string;
    }
    const copiedBindings: ReviewAuditContext["bindings"] = [];
    for (let i = 0; i < length; i++) {
      const binding = bindings[i];
      if (!object(binding)) return null;
      copiedBindings.push({ reviewId: binding.reviewId as number, headSha: binding.headSha as string,
        baseSha: binding.baseSha as string, appLogin: binding.appLogin as string });
    }
    const captured = { apps: copiedApps, bindings: copiedBindings, now, cooldownMs };
    if (!context(captured) || new Set(Object.values(captured.apps).map(login => login.toLowerCase())).size !== keys.length) return null;
    return captured;
  } catch { return null; }
}

function glob(pattern: string): RegExp {
  let result = "^";
  for (let i = 0; i < pattern.length;) {
    if (pattern.slice(i, i + 3) === "**/") { result += "(?:[^/]+/)*"; i += 3; }
    else if (pattern.slice(i, i + 2) === "**") { result += ".*"; i += 2; }
    else if (pattern[i] === "*") { result += "[^/]*"; i++; }
    else { result += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i++; }
  }
  return new RegExp(result + "$");
}
const allowed = policy.autoMerge.map(glob);
// Protect case-colliding names without widening the code directory allowlist.
const human = policy.humanOnly.map(pattern => new RegExp(glob(pattern), "i"));

/** Policy matching only: never a proof of complete GitHub data or permission to merge. */
export function classifyReviewPath(path: unknown): "code" | "human" | "invalid" {
  if (!text(path) || !path || /[\\\x00-\x1f\x7f]/.test(path)
    || path.split("/").some(part => part === "" || part === "." || part === "..")) return "invalid";
  if (human.some(pattern => pattern.test(path))) return "human";
  return allowed.some(pattern => pattern.test(path)) ? "code" : "human";
}
function tag(body: string, name: "Reviewer" | "Agent"): string | null {
  const matches = [...body.matchAll(new RegExp(`^${name}: ([a-z0-9][a-z0-9_-]*)\\r?$`, "gm"))];
  return matches.length === 1 ? matches[0]![1]! : null;
}

/**
 * Pure audit of normalized facts supplied by a future trusted collector.
 * No production caller, attestation producer, claim, turn or mutation is wired here.
 */
export function auditReviewEligibility(input: unknown, config: unknown): ReviewAudit {
  const reasons = new Set<string>(["atomic_base_guard_unproven"]);
  const result = (): ReviewAudit => ({ automaticMerge: false, reasons: [...reasons].sort() });
  if (!context(config)) { reasons.add("audit_context_invalid"); return result(); }
  const agents = new Map(Object.entries(config.apps).map(([agent, login]) => [login.toLowerCase(), agent]));
  if (agents.size !== Object.keys(config.apps).length) { reasons.add("registry_invalid"); return result(); }
  if (!candidate(input)) { reasons.add("malformed_snapshot"); return result(); }
  if (input.state !== "OPEN") reasons.add("not_open");
  if (input.draft) reasons.add("draft");
  if (input.headSha !== input.observedHeadSha || input.baseSha !== input.observedBaseSha) reasons.add("snapshot_moved");
  for (const name of ["paths", "commits", "reviews", "threads", "ci"] as const) {
    if (!input[name].complete) reasons.add(`incomplete_${name}`);
  }
  const owner = input.ownerAgents.length === 1 ? input.ownerAgents[0] : undefined;
  const ownerLogin = owner && Object.hasOwn(config.apps, owner) ? config.apps[owner] : undefined;
  if (!ownerLogin || ownerLogin.toLowerCase() !== input.authorLogin.toLowerCase()) reasons.add("owner_unverified");
  if (!input.paths.items.length) reasons.add("empty_paths");
  for (const file of input.paths.items) {
    for (const path of [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])]) {
      const kind = classifyReviewPath(path);
      if (kind !== "code") reasons.add(kind === "invalid" ? "invalid_path" : "human_path");
    }
  }
  if (!input.commits.items.length) reasons.add("empty_commits");
  const commitShas = new Set(input.commits.items.map(commit => commit.sha));
  if (!commitShas.has(input.headSha)) reasons.add("head_commit_missing");
  if (commitShas.size !== input.commits.items.length) reasons.add("commit_evidence_ambiguous");
  for (const commit of input.commits.items) {
    if (!ownerLogin || commit.authorLogin.toLowerCase() !== ownerLogin.toLowerCase()
      || commit.committerLogin.toLowerCase() !== ownerLogin.toLowerCase() || tag(commit.message, "Agent") !== owner) {
      reasons.add("foreign_commit");
    }
  }
  if (new Set(input.reviews.items.map(review => review.id)).size !== input.reviews.items.length) {
    reasons.add("review_evidence_ambiguous");
  }
  const reviews = input.reviews.items.filter(review =>
    review.headSha === input.headSha && review.appLogin.toLowerCase() !== ownerLogin?.toLowerCase());
  const latest = [...reviews].sort((a, b) => b.submittedAt - a.submittedAt || b.id - a.id)[0];
  if (!latest) reasons.add("approval_missing");
  else {
    const reviewer = agents.get(latest.appLogin.toLowerCase());
    // Unique registry logins and the author-login filter above already exclude the owner.
    if (!reviewer || tag(latest.body, "Reviewer") !== reviewer) reasons.add("reviewer_unverified");
    if (latest.state !== "APPROVED") reasons.add("latest_review_not_approved");
    const bindings = config.bindings.filter(binding => binding.reviewId === latest.id);
    const binding = bindings.length === 1 ? bindings[0] : undefined;
    if (!binding || binding.headSha !== input.headSha || binding.baseSha !== input.baseSha
      || binding.appLogin.toLowerCase() !== latest.appLogin.toLowerCase()) reasons.add("review_base_unbound");
  }
  if (input.threads.items.some(thread => !thread.resolved)) reasons.add("unresolved_thread");
  if (input.ci.configured === null) reasons.add("ci_configuration_unproven");
  else if (input.ci.configured && (input.ci.headSha !== input.headSha
    || !input.ci.results.length || input.ci.results.some(state => state !== "SUCCESS"))) reasons.add("ci_not_green");
  if (!input.issue || !["bug", "enhancement"].includes(input.issue.type)) reasons.add("intent_unverified");
  else if (input.issue.type === "enhancement" && !input.issue.approved) reasons.add("intent_unapproved");
  if (input.loop === null) reasons.add("loop_state_unproven");
  else {
    if (!input.loop.complete || !Number.isSafeInteger(input.loop.rounds) || input.loop.rounds < 1
      || input.loop.lastAttemptAt < 0 || input.loop.lastAttemptAt > config.now) reasons.add("loop_state_unproven");
    if (input.loop.rounds > 3) reasons.add("round_limit");
    if (config.now - input.loop.lastAttemptAt < config.cooldownMs) reasons.add("cooldown");
  }
  return result();
}
