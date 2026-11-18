/**
 * AllowlistEnforcement — Component 7 of ANIMA Phase 7 (Legible Autonomy)
 *
 * Loads rooms/{agent}/allowlist.json and gates actions against per-domain
 * trust thresholds BEFORE the evaluation pipeline runs. Never-allowed actions
 * are blocked unconditionally regardless of trust score.
 *
 * Task 7.5: Allowlist check runs BEFORE evaluation pipeline.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TrustDomain } from "./trust-system";
import { guardAgentId } from "../utils/path-guard";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActionId = string; // e.g. "substrate_write", "telegram_send", ...

export interface AllowlistRule {
  /** Trust domain that governs this action. */
  domain: TrustDomain;
  /** Minimum trust score required (0–1). If null, action is never allowed. */
  threshold: number | null;
}

export interface AllowlistFile {
  version: 1;
  rules: Record<ActionId, AllowlistRule>;
}

export interface AllowlistCheckInput {
  action: ActionId;
  /** Current trust score for the relevant domain (0–1). */
  trustScore: number;
}

export type AllowlistResult =
  | { allowed: true }
  | { allowed: false; reason: "never_allowed" | "trust_too_low"; required: number | null; current: number };

// ── Default rules (design spec, Component 7 table) ───────────────────────────

export const DEFAULT_ALLOWLIST_RULES: Record<ActionId, AllowlistRule> = {
  /** Writing anywhere in substrate/ — requires memory_write trust > 0.70 */
  substrate_write: { domain: "memory_write", threshold: 0.70 },

  /** Sending a Telegram message — requires communication trust > 0.80 */
  telegram_send: { domain: "communication", threshold: 0.80 },

  /** Spawning a Codex/Qwen/Gemini Legio worker — requires architecture trust > 0.65 */
  spawn_legio: { domain: "architecture", threshold: 0.65 },

  /** External API calls with cost/side effects — requires external_action trust > 0.85 */
  external_api: { domain: "external_action", threshold: 0.85 },

  /**
   * Writing to substrate/0_SOUL/ (axioms) — NEVER auto-allowed.
   * Task 7.4: axiom write is harness-enforced "never".
   */
  axiom_write: { domain: "memory_write", threshold: null },

  /**
   * Pushing to git main branch — NEVER auto-allowed.
   * Task 7.4: push to git main is harness-enforced "never".
   */
  git_push_main: { domain: "code_review", threshold: null },

  /** Modifying the evaluation config itself — NEVER auto-allowed. */
  modify_eval_config: { domain: "architecture", threshold: null },
};

// ── AllowlistEnforcement class ────────────────────────────────────────────────

export interface AllowlistOptions {
  rootDir?: string;
  roomsDir?: string;
}

export class AllowlistEnforcement {
  private readonly roomsDir: string;

  constructor(options: AllowlistOptions = {}) {
    this.roomsDir = resolve(options.roomsDir ?? join(options.rootDir ?? process.cwd(), "rooms"));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Check whether `action` is allowed at the given trust level.
   * Task 7.5: this runs BEFORE the evaluation pipeline.
   */
  async check(agentId: string, input: AllowlistCheckInput): Promise<AllowlistResult> {
    const file = await this.read(agentId);
    const rule = file.rules[input.action];

    if (!rule) {
      // Unknown action — allow by default (not in allowlist = not gated)
      return { allowed: true };
    }

    // Never-allowed
    if (rule.threshold === null) {
      return {
        allowed: false,
        reason: "never_allowed",
        required: null,
        current: input.trustScore,
      };
    }

    // Trust threshold check
    if (input.trustScore < rule.threshold) {
      return {
        allowed: false,
        reason: "trust_too_low",
        required: rule.threshold,
        current: input.trustScore,
      };
    }

    return { allowed: true };
  }

  /**
   * Read the allowlist for an agent. Falls back to default rules if no file exists.
   */
  async read(agentId: string): Promise<AllowlistFile> {
    const path = this.path(agentId);
    if (!existsSync(path)) {
      return { version: 1, rules: { ...DEFAULT_ALLOWLIST_RULES } };
    }
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AllowlistFile>;
      return {
        version: 1,
        rules: {
          ...DEFAULT_ALLOWLIST_RULES,
          ...(parsed.rules ?? {}),
        },
      };
    } catch {
      return { version: 1, rules: { ...DEFAULT_ALLOWLIST_RULES } };
    }
  }

  /**
   * Write the allowlist for an agent. Used by seed-room and admin commands.
   */
  async write(agentId: string, file: AllowlistFile): Promise<void> {
    const path = this.path(agentId);
    await mkdir(join(this.roomsDir, agentId), { recursive: true });
    await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf-8");
  }

  /**
   * Seed default allowlist.json for a new room (called from seed-room.ts).
   * Task 7.3: seed default allowlist.json for new rooms.
   * Does not overwrite an existing file unless force=true.
   */
  async seedDefault(agentId: string, force = false): Promise<void> {
    const path = this.path(agentId);
    if (existsSync(path) && !force) return;
    await this.write(agentId, { version: 1, rules: { ...DEFAULT_ALLOWLIST_RULES } });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private path(agentId: string): string {
    guardAgentId(agentId);
    return join(this.roomsDir, agentId, "allowlist.json");
  }
}

// ── Convenience: action name helpers ─────────────────────────────────────────

/**
 * Classify a file write path into an ActionId for allowlist checking.
 */
export function classifyWriteAction(filePath: string): ActionId {
  const norm = filePath.replace(/\\/g, "/");

  // Axioms (substrate/0_SOUL/) — never
  if (/\/0_SOUL\//.test(norm) || /^0_SOUL\//.test(norm)) {
    return "axiom_write";
  }

  // substrate writes
  if (/\/substrate\//.test(norm) || /^substrate\//.test(norm)) {
    return "substrate_write";
  }

  return "substrate_write"; // conservative fallback for unknown substrate-like paths
}
