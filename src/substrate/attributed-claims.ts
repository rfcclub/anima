/**
 * Attributed claims — the shared provenance layer for substrate writes.
 *
 * This module owns the *claim record* that #155 pins: path, file format, id
 * scheme, and the closed vocabularies for claim kind, status and uncertainty.
 * It also owns disagreement detection, resolution records, the projection
 * contract (a projection may shorten evidence but never raise authority), the
 * attribution flags that feed #156's detection backstop, and the migration
 * freeze manifest.
 *
 * Residual, stated deliberately: attribution is a claim, not authentication.
 * `author` is a string the writer types into a plain file; until #156's write
 * boundary separates actors, it is evidence of who says they wrote a record,
 * not proof. Nothing here refuses a write — that is #156's write gate.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Pinned locations and vocabularies ────────────────────────────

/** Append-only claim log, relative to the substrate root. */
export const CLAIMS_FILE = "_claims/claims.jsonl";
/** Append-only log of resolution acts (the separate, recorded act). */
export const RESOLUTIONS_FILE = "_claims/resolutions.jsonl";
/** Freeze hash manifest written before any attribution, relative to the root. */
export const MANIFEST_FILE = "_claims/manifest.json";

/**
 * Closed set of claim kinds. `observation` and `commitment` are the two levels
 * this change defines; a claim's kind never rises as a side effect of
 * ingestion, reflection or compilation.
 */
export const CLAIM_KINDS = ["observation", "commitment"] as const;

/** Closed set of claim statuses. */
export const CLAIM_STATUSES = ["open", "contested", "resolved", "retracted"] as const;

/** Closed, ordered uncertainty scale (least to most confident). */
export const UNCERTAINTY_LEVELS = ["speculative", "possible", "likely", "certain"] as const;

export type ClaimKind = (typeof CLAIM_KINDS)[number];
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type UncertaintyLevel = (typeof UNCERTAINTY_LEVELS)[number];

/** Authority ordering: only governance may raise a claim's kind. */
const AUTHORITY_RANK: Record<ClaimKind, number> = {
  observation: 0,
  commitment: 1,
};

// ─── Records ──────────────────────────────────────────────────────

/** What a writer supplies. `status` defaults to `open`. */
export interface ClaimInput {
  kind: ClaimKind;
  topic: string;
  statement: string;
  author: string;
  /**
   * The instance whose self-model the claim is about. Defaults to `author`:
   * a claim is about the writer unless it says otherwise.
   */
  subject?: string;
  evidence: string[];
  uncertainty: UncertaintyLevel;
  status?: ClaimStatus;
}

/** A claim input after validation: `subject` and `status` are resolved. */
export interface ValidatedClaimInput extends ClaimInput {
  subject: string;
  status: ClaimStatus;
}

/** What is stored in the claim log, one JSON object per line. */
export interface ClaimRecord {
  id: string;
  version: number;
  kind: ClaimKind;
  topic: string;
  statement: string;
  author: string;
  /** The instance whose self-model the claim is about (defaults to `author`). */
  subject: string;
  evidence: string[];
  uncertainty: UncertaintyLevel;
  status: ClaimStatus;
  /** Id of the previous claim by the same author on the same topic, if any. */
  supersedes?: string;
  recordedAt: string;
}

export interface ResolutionInput {
  resolves: string[];
  by: string;
  note: string;
}

export interface ResolutionRecord {
  id: string;
  resolves: string[];
  by: string;
  note: string;
  recordedAt: string;
}

export interface Disagreement {
  topic: string;
  claims: ClaimRecord[];
}

export interface ProjectedClaim {
  id: string;
  kind: ClaimKind;
  topic: string;
  author: string;
  /** Survives projection, like the author: provenance is not shortening. */
  subject: string;
  evidence: string[];
  uncertainty: UncertaintyLevel;
  /** Projected text. Never restates a claim at a higher authority. */
  text: string;
}

export interface AttributionFlag {
  topic: string;
  /** The writer as claimed by the record — not authenticated. */
  claimedWriter: string;
  previousAuthor: string;
  previousClaimId: string;
  claimId: string;
  /** The revision record the flag needs and that is absent. */
  absentRevisionRecord: string;
}

export interface AttributionManifest {
  version: 1;
  frozenAt: string;
  /** File path (relative to the root) to sha256 of its frozen content. */
  files: Record<string, string>;
}

export interface ManifestVerification {
  ok: boolean;
  missing: string[];
  changed: string[];
}

/** Raised when a claim input violates the pinned vocabularies. */
export class ClaimValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimValidationError";
  }
}

// ─── Validation ───────────────────────────────────────────────────

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClaimValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validate a claim input against the pinned vocabularies. Throws
 * `ClaimValidationError` for an unknown kind, status or uncertainty value, a
 * blank author, or an empty evidence list.
 */
export function validateClaimInput(input: ClaimInput): ValidatedClaimInput {
  if (!isOneOf(CLAIM_KINDS, input.kind)) {
    throw new ClaimValidationError(`unknown claim kind: ${String(input.kind)}`);
  }
  if (!isOneOf(UNCERTAINTY_LEVELS, input.uncertainty)) {
    throw new ClaimValidationError(`unknown uncertainty level: ${String(input.uncertainty)}`);
  }
  if (input.status !== undefined && !isOneOf(CLAIM_STATUSES, input.status)) {
    throw new ClaimValidationError(`unknown claim status: ${String(input.status)}`);
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    throw new ClaimValidationError("evidence must contain at least one reference");
  }
  return {
    kind: input.kind,
    topic: requireText(input.topic, "topic"),
    statement: requireText(input.statement, "statement"),
    author: requireText(input.author, "author"),
    subject: requireText(input.subject ?? input.author, "subject"),
    evidence: input.evidence.map((ref) => requireText(ref, "evidence reference")),
    uncertainty: input.uncertainty,
    status: input.status ?? "open",
  };
}

// ─── Files ────────────────────────────────────────────────────────

function pathIn(root: string, relative: string): string {
  return join(root, relative);
}

function ensureParent(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function appendJsonl(path: string, record: unknown): void {
  ensureParent(path);
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${existing}${separator}${JSON.stringify(record)}\n`);
}

function hashId(prefix: string, content: string): string {
  return `${prefix}_${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

/** Read the append-only claim log. Missing file reads as an empty log. */
export function readClaims(root: string): ClaimRecord[] {
  return readJsonl<ClaimRecord>(pathIn(root, CLAIMS_FILE));
}

/** Read the append-only resolution log. Missing file reads as an empty log. */
export function readResolutions(root: string): ResolutionRecord[] {
  return readJsonl<ResolutionRecord>(pathIn(root, RESOLUTIONS_FILE));
}

/**
 * Append one attributed claim. The previous claim by the same author on the
 * same topic is linked with `supersedes` and left untouched in the log.
 */
export function appendClaim(root: string, input: ClaimInput): ClaimRecord {
  const valid = validateClaimInput(input);
  const existing = readClaims(root);
  const previous = [...existing]
    .reverse()
    .find((claim) => claim.topic === valid.topic && claim.author === valid.author);

  const version = previous ? previous.version + 1 : 1;
  const record: ClaimRecord = {
    id: hashId(
      "clm",
      [valid.author, valid.topic, valid.statement, String(version), String(existing.length)].join("|"),
    ),
    version,
    kind: valid.kind,
    topic: valid.topic,
    statement: valid.statement,
    author: valid.author,
    subject: valid.subject,
    evidence: valid.evidence,
    uncertainty: valid.uncertainty,
    status: valid.status ?? "open",
    ...(previous ? { supersedes: previous.id } : {}),
    recordedAt: new Date().toISOString(),
  };

  appendJsonl(pathIn(root, CLAIMS_FILE), record);
  return record;
}

/**
 * Record a resolution act: the separate, recorded step that settles contested
 * claims. Appending a resolution never rewrites the claim log.
 */
export function recordResolution(root: string, input: ResolutionInput): ResolutionRecord {
  if (!Array.isArray(input.resolves) || input.resolves.length === 0) {
    throw new ClaimValidationError("a resolution must name the claim it resolves");
  }
  const record: ResolutionRecord = {
    id: hashId("res", input.resolves.join("|") + "|" + input.note),
    resolves: [...input.resolves],
    by: requireText(input.by, "by"),
    note: requireText(input.note, "note"),
    recordedAt: new Date().toISOString(),
  };
  appendJsonl(pathIn(root, RESOLUTIONS_FILE), record);
  return record;
}

// ─── Disagreement ─────────────────────────────────────────────────

/**
 * Topics where more than one author holds an open claim. Both records are
 * kept; this only reports that the disagreement exists.
 */
export function detectDisagreements(claims: ClaimRecord[]): Disagreement[] {
  const topics = new Map<string, ClaimRecord[]>();
  for (const claim of claims) {
    if (claim.status === "retracted") continue;
    const group = topics.get(claim.topic) ?? [];
    group.push(claim);
    topics.set(claim.topic, group);
  }

  const disagreements: Disagreement[] = [];
  for (const [topic, group] of topics) {
    if (new Set(group.map((claim) => claim.author)).size > 1) {
      disagreements.push({ topic, claims: group });
    }
  }
  return disagreements;
}

// ─── Projection ───────────────────────────────────────────────────

export interface ProjectionOptions {
  /** Keep at most this many evidence references; the rest are summarised. */
  maxEvidence?: number;
}

/**
 * Project claims for a fresh session. Evidence may be shortened; kind, author
 * and uncertainty survive verbatim, so projection cannot raise authority.
 */
export function projectClaims(
  claims: ClaimRecord[],
  options: ProjectionOptions = {},
): ProjectedClaim[] {
  return claims.map((claim) => {
    const evidence = shortenEvidence(claim.evidence, options.maxEvidence);
    return {
      id: claim.id,
      kind: claim.kind,
      topic: claim.topic,
      author: claim.author,
      subject: claim.subject,
      evidence,
      uncertainty: claim.uncertainty,
      text: renderProjectedText(claim, evidence),
    };
  });
}

function shortenEvidence(evidence: string[], maxEvidence?: number): string[] {
  if (maxEvidence === undefined || evidence.length <= maxEvidence) return [...evidence];
  const kept = evidence.slice(0, Math.max(0, maxEvidence));
  const dropped = evidence.length - kept.length;
  return [...kept, `episode:+${dropped} more`];
}

function renderProjectedText(claim: ClaimRecord, evidence: string[]): string {
  const source = evidence.length > 0 ? evidence.join(", ") : "no retained evidence";
  const about = claim.subject === claim.author ? "" : `; about ${claim.subject}`;
  return `[${claim.kind}] ${claim.statement} (claimed by ${claim.author}${about}; uncertainty: ${claim.uncertainty}; evidence: ${source})`;
}

/**
 * Ids of claims whose projected kind outranks the stored kind. An empty list
 * means the projection preserved every claim's authority.
 */
export function projectionAuthorityViolations(
  claims: ClaimRecord[],
  projected: ProjectedClaim[],
): string[] {
  const stored = new Map(claims.map((claim) => [claim.id, claim]));
  const violations: string[] = [];
  for (const item of projected) {
    const original = stored.get(item.id);
    if (!original) continue;
    if (AUTHORITY_RANK[item.kind] > AUTHORITY_RANK[original.kind]) violations.push(item.id);
  }
  return violations;
}

// ─── Attribution backstop feed (#156) ─────────────────────────────

/**
 * Writes that cross an ownership boundary with no recorded resolution: a
 * shared commitment rewritten by a different instance, or a claim about
 * another instance's self-model that overrides that instance's own latest
 * claim on the topic. The flag names the writer as claimed and the absent
 * revision record; detection, reporting and refusal are #156's.
 */
export function attributionFlags(
  claims: ClaimRecord[],
  resolutions: ResolutionRecord[],
): AttributionFlag[] {
  const resolved = new Set(resolutions.flatMap((resolution) => resolution.resolves));
  const flags: AttributionFlag[] = [];
  const latest = new Map<string, ClaimRecord>();

  for (const claim of claims) {
    const previous = latest.get(claim.topic);
    latest.set(claim.topic, claim);
    if (!previous) continue;
    if (resolved.has(claim.id)) continue;

    const sharedCommitmentRewritten =
      claim.kind === "commitment" && previous.author !== claim.author;
    const selfModelOverridden =
      claim.subject !== claim.author && previous.subject === claim.subject;

    if (!sharedCommitmentRewritten && !selfModelOverridden) continue;
    flags.push({
      topic: claim.topic,
      claimedWriter: claim.author,
      previousAuthor: previous.author,
      previousClaimId: previous.id,
      claimId: claim.id,
      absentRevisionRecord: claim.id,
    });
  }
  return flags;
}

// ─── Migration freeze manifest ────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Freeze the current content of the given files (paths relative to `root`).
 * Written before any attribution so a later check can show nothing was lost.
 */
export function writeAttributionManifest(root: string, files: string[]): AttributionManifest {
  const hashes: Record<string, string> = {};
  for (const file of files) {
    hashes[file] = sha256(readFileSync(pathIn(root, file), "utf-8"));
  }
  const manifest: AttributionManifest = {
    version: 1,
    frozenAt: new Date().toISOString(),
    files: hashes,
  };
  const path = pathIn(root, MANIFEST_FILE);
  ensureParent(path);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Recompute the frozen hashes and report any missing or changed content. */
export function verifyAttributionManifest(root: string): ManifestVerification {
  const path = pathIn(root, MANIFEST_FILE);
  if (!existsSync(path)) {
    return { ok: false, missing: [MANIFEST_FILE], changed: [] };
  }
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as AttributionManifest;
  const missing: string[] = [];
  const changed: string[] = [];

  for (const [file, expected] of Object.entries(manifest.files)) {
    const absolute = pathIn(root, file);
    if (!existsSync(absolute)) {
      missing.push(file);
      continue;
    }
    if (sha256(readFileSync(absolute, "utf-8")) !== expected) changed.push(file);
  }

  missing.sort();
  changed.sort();
  return { ok: missing.length === 0 && changed.length === 0, missing, changed };
}
