import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ReviewDomain, ReviewerAgentOptions } from "../agents/reviewer";
import { ReviewerAgent } from "../agents/reviewer";
import { CartridgeLoader } from "../cartridge/loader";
import { CartridgeRegistry } from "../cartridge/registry";
import { AllowlistEnforcement, type AllowlistCheckInput } from "./allowlist";
import { DriftDetector, type DriftContext } from "./drift-detector";
import {
  TrustSystem,
  type TrustDomain,
} from "./trust-system";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvalDecision = "auto_apply" | "escalate" | "hold";

export interface EvalOutput {
  decision: EvalDecision;
  confidence: number;
  rationale: string;
  driftStatus?: string;
  driftPatterns?: string[];
  reviewFlags?: string[];
  testsRun?: string[];
}

export interface EvaluationPipelineOptions {
  roomsDir?: string;
  rootDir?: string;
}

interface EvalInput {
  agentId: string;
  output: string;
  /** TrustDomain the action belongs to */
  domain: TrustDomain;
  /** Action for allowlist check */
  actionId?: string;
  /** File paths affected */
  paths?: string[];
  /** Recent statements for drift context */
  recentStatements?: string[];
  /** Agent's allowed tasks */
  allowedTasks?: string[];
  /** Reviewer cartridge overrides */
  cartridges?: string[];
  /** Memory scope violations recorded by ScopedMemoryStore during the session (cartridge write-policy breaches). */
  scopeViolations?: Array<{ cartridge: string; scope: string; timestamp: string }>;
}

// ---------------------------------------------------------------------------
// Trust thresholds
// ---------------------------------------------------------------------------

const HIGH_TRUST = 0.85;
// Everything below HIGH_TRUST and at or above LOW_TRUST → mid tier
// Everything below LOW_TRUST → hold
const LOW_TRUST = 0.50; // values < 0.50 → hold

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class EvaluationPipeline {
  private readonly roomsDir: string;
  private readonly rootDir: string;
  private readonly trust: TrustSystem;
  private readonly drift: DriftDetector;
  private readonly allowlist: AllowlistEnforcement;
  private readonly cartridgeLoader: CartridgeLoader;
  private readonly cartridgeRegistry: CartridgeRegistry;

  constructor(options: EvaluationPipelineOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? process.cwd());
    this.roomsDir = resolve(options.roomsDir ?? join(this.rootDir, "rooms"));
    this.trust = new TrustSystem({ roomsDir: this.roomsDir });
    this.drift = new DriftDetector();
    this.allowlist = new AllowlistEnforcement({ roomsDir: this.roomsDir });
    this.cartridgeLoader = new CartridgeLoader();
    this.cartridgeRegistry = new CartridgeRegistry(this.rootDir);
  }

  /**
   * Full evaluation: allowlist check → trust routing → drift/review → decision
   */
  async evaluate(input: EvalInput): Promise<EvalOutput> {
    const { agentId, output, domain, actionId } = input;

    // Load trust score first — needed for allowlist threshold check
    const score = await this.trust.get(agentId, domain);
    const trust = score.score;

    // 6.6: Allowlist check runs BEFORE evaluation pipeline
    if (actionId) {
      const allowed = await this.allowlist.check(agentId, {
        action: actionId,
        trustScore: trust,
      });
      if (!allowed.allowed) {
        return {
          decision: "hold",
          confidence: 0,
          rationale: allowed.reason ?? `Action "${actionId}" not allowed by allowlist`,
        };
      }
    }

    // Low trust → hold immediately and create review queue entry (6.3)
    if (trust < LOW_TRUST) {
      await this.ensureQueueDir(agentId);
      const entry = {
        timestamp: new Date().toISOString(),
        agentId,
        domain,
        output,
        report: {
          confidence: trust,
          flags: ["low_trust"],
          recommendation: "hold" as const,
          rationale: `Trust score ${trust.toFixed(2)} < ${LOW_TRUST} threshold`,
          testsRun: [],
        },
      };
      const file = join(this.roomsDir, agentId, "review_queue", `${Date.now()}.json`);
      await writeFile(file, JSON.stringify(entry, null, 2), "utf-8");

      return {
        decision: "hold",
        confidence: trust,
        rationale: `Trust score ${trust.toFixed(2)} < ${LOW_TRUST} threshold — held for review`,
      };
    }

    // Drift check always runs (6.3)
    const driftCtx: DriftContext = {
      agentName: agentId,
      recentStatements: input.recentStatements,
      allowedTasks: input.allowedTasks,
    };
    const driftReport = await this.drift.detect(output, driftCtx);

    const violationNote = input.scopeViolations?.length
      ? `\n[Scope violations this session: ${input.scopeViolations.map((v) => `${v.cartridge}→${v.scope}`).join(", ")}]`
      : "";

    // High trust: drift check only
    if (trust >= HIGH_TRUST) {
      if (driftReport.status === "clear") {
        void this.trust.confirm(agentId, domain).catch(() => {});
        return {
          decision: "auto_apply",
          confidence: Math.max(0.85, 1 - driftReport.confidence * 0.3),
          rationale: `High trust (${trust.toFixed(2)}), drift clear`,
          driftStatus: driftReport.status,
        };
      }
      // Drift flagged at high trust → escalate
      return {
        decision: "escalate",
        confidence: driftReport.confidence,
        rationale: `High trust (${trust.toFixed(2)}) but drift flagged: ${driftReport.patterns.join(", ")}`,
        driftStatus: driftReport.status,
        driftPatterns: driftReport.patterns,
      };
    }

    // Mid trust (0.50–0.85): drift + ReviewerAgent
    const reviewReport = await this.runReviewer(agentId, `${output}${violationNote}`, domain, input.cartridges);

    // Combine drift + review → decision (6.4)
    const decision = this.combine(driftReport, reviewReport, trust);

    // Trust update async (6.5)
    void this.updateTrust(agentId, domain, decision).catch(() => {});

    return {
      decision,
      confidence: reviewReport.confidence,
      rationale: reviewReport.rationale,
      driftStatus: driftReport.status,
      driftPatterns: driftReport.patterns,
      reviewFlags: reviewReport.flags,
      testsRun: reviewReport.testsRun?.length ? reviewReport.testsRun : undefined,
    };
  }

  private async runReviewer(
    agentId: string,
    output: string,
    domain: TrustDomain,
    cartridgeOverrides?: string[],
  ): Promise<{ confidence: number; flags: string[]; rationale: string; testsRun: string[]; recommendation: string }> {
    const reviewDomain = mapTrustToReviewDomain(domain);
    const opts: ReviewerAgentOptions = {
      output,
      domain: reviewDomain,
      agentId: agentId,
      roomsDir: this.roomsDir,
      cartridgeNames: cartridgeOverrides,
      cartridgeLoader: this.cartridgeLoader,
      cartridgeRegistry: this.cartridgeRegistry,
      cwd: this.rootDir,
    };
    const reviewer = new ReviewerAgent(opts);
    const report = await reviewer.review();

    // Queue only after combine decides — don't queue preemptively
    if (report.recommendation === "hold" || report.recommendation === "reject") {
      await this.ensureQueueDir(agentId);
      const entry = {
        timestamp: new Date().toISOString(),
        agentId,
        domain,
        output,
        report: {
          confidence: report.confidence,
          flags: report.flags,
          recommendation: report.recommendation,
          rationale: report.rationale,
          testsRun: report.testsRun,
        },
      };
      const file = join(this.roomsDir, agentId, "review_queue", `${Date.now()}.json`);
      await writeFile(file, JSON.stringify(entry, null, 2), "utf-8");
    }

    return {
      confidence: report.confidence,
      flags: report.flags,
      rationale: report.rationale,
      testsRun: report.testsRun,
      recommendation: report.recommendation,
    };
  }

  /**
   * Combine drift + review signals into an EvalDecision.
   */
  private combine(
    drift: { status: string; patterns: string[] },
    review: { confidence: number; flags: string[]; recommendation: string },
    trust: number,
  ): EvalDecision {
    // Reviewer recommendation overrides — hold/reject means block
    if (review.recommendation === "hold" || review.recommendation === "reject") {
      return "hold";
    }
    // If reviewer found 3+ flags → hold
    if (review.flags.length >= 3) return "hold";
    // If any flag is critical (contains "axiom", "boundary", "security", "irreversible") → hold
    if (review.flags.some(f => /\b(axiom|boundary|security|irreversible)\b/i.test(f))) return "hold";
    // If drift is confirmed → escalate
    if (drift.status === "confirmed") return "escalate";
    // If drift suspected AND reviewer has flags → escalate
    if (drift.status === "suspected" && review.flags.length > 0) return "escalate";
    // If reviewer confidence low → escalate
    if (review.confidence < 0.4) return "escalate";
    // Otherwise auto_apply
    return "auto_apply";
  }

  private async updateTrust(
    agentId: string,
    domain: TrustDomain,
    decision: EvalDecision,
  ): Promise<void> {
    if (decision === "auto_apply") {
      await this.trust.confirm(agentId, domain);
    } else if (decision === "hold") {
      await this.trust.penalize(agentId, domain);
    }
    // escalate: no trust change (awaiting human judgment)
  }

  private async ensureQueueDir(agentId: string): Promise<void> {
    const dir = join(this.roomsDir, agentId, "review_queue");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  }

  /** Convenience for external callers */
  async getTrustScores(agentId: string) {
    return this.trust.getScores(agentId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapTrustToReviewDomain(domain: TrustDomain): ReviewDomain {
  switch (domain) {
    case "code_review": return "code";
    case "memory_write": return "memory";
    case "communication":   return "communication";
    case "architecture":  return "architecture";
    case "external_action": return "external_action";
    // private_mode maps to communication (voice/tone check)
    case "private_mode": return "communication";
    default: return "communication";
  }
}
