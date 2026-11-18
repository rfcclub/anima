import { currentToolBoundary, sandboxToolCommand, sandboxToolEnvironment } from "../web-chat/tool-boundary";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CartridgeLoader } from "../cartridge/loader";
import { CartridgeRegistry, type CartridgeEntry } from "../cartridge/registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewRecommendation = "approve" | "hold" | "reject";

export type ReviewDomain =
  | "code"
  | "memory"
  | "communication"
  | "architecture"
  | "external_action";

export interface ReviewReport {
  confidence: number;
  flags: string[];
  recommendation: ReviewRecommendation;
  rationale: string;
  testsRun: string[];
}

export interface ReviewerToolAccess {
  bash: (command: string) => Promise<ReviewerBashResult>;
  read: (path: string) => Promise<string>;
}

export interface ReviewerBashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ReviewerAgentOptions {
  /** The output text to review. */
  output: string;
  /** Domain of the output (maps to a QA cartridge). */
  domain: ReviewDomain;
  /** Agent identifier used for room paths. */
  agentId: string;
  /**
   * Specific QA cartridge names to load (e.g. ["qa-code"]).
   * Defaults to the cartridge mapped from domain.
   */
  cartridgeNames?: string[];
  /** Root rooms directory (default: cwd/rooms). */
  roomsDir?: string;
  /** Working directory for bash commands. */
  cwd?: string;
  /** CartridgeLoader instance — used to resolve domain to cartridge category. */
  cartridgeLoader: CartridgeLoader;
  /** CartridgeRegistry instance — used to load cartridge content from disk. */
  cartridgeRegistry: CartridgeRegistry;
  /**
   * Optional injectable tool access. When omitted the agent uses real
   * Bun.spawnSync / readFile calls.
   */
  toolAccess?: ReviewerToolAccess;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN_TO_CARTRIDGE: Record<ReviewDomain, string> = {
  code: "qa-code",
  memory: "qa-memory",
  communication: "qa-communication",
  architecture: "qa-architecture",
  external_action: "qa-external-action",
};

const RECOMMENDATION_THRESHOLDS = {
  approve: 0.85,
  hold: 0.4,
} as const;

// ---------------------------------------------------------------------------
// ReviewerAgent
// ---------------------------------------------------------------------------

export class ReviewerAgent {
  private readonly output: string;
  private readonly domain: ReviewDomain;
  private readonly agentId: string;
  private readonly cartridgeNames: string[];
  private readonly roomsDir: string;
  private readonly cwd: string;
  private readonly cartridgeLoader: CartridgeLoader;
  private readonly cartridgeRegistry: CartridgeRegistry;
  private readonly toolAccess: ReviewerToolAccess;

  constructor(options: ReviewerAgentOptions) {
    this.output = options.output;
    this.domain = options.domain;
    this.agentId = options.agentId;
    this.cartridgeNames =
      options.cartridgeNames ?? [DOMAIN_TO_CARTRIDGE[options.domain]];
    this.roomsDir = options.roomsDir ?? join(process.cwd(), "rooms");
    this.cwd = options.cwd ?? process.cwd();
    this.cartridgeLoader = options.cartridgeLoader;
    this.cartridgeRegistry = options.cartridgeRegistry;
    this.toolAccess = options.toolAccess ?? this.createDefaultToolAccess();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run the full review cycle:
   *  1. Load domain QA cartridges.
   *  2. Parse rules from cartridge content.
   *  3. Execute active (bash-based) and passive (output-text) checks.
   *  4. Compute confidence and recommendation.
   *  5. If "hold", write output to review queue.
   *  6. Return ReviewReport.
   */
  async review(): Promise<ReviewReport> {
    const cartridgeContents = await this.loadCartridges();
    const rules = this.parseRules(cartridgeContents);

    const testsRun: string[] = [];
    const flags: string[] = [];

    for (const rule of rules) {
      if (rule.type === "active") {
        const result = await this.runActiveCheck(rule);
        testsRun.push(result.name);
        if (!result.passed && result.flag) {
          flags.push(result.flag);
        }
      } else {
        const result = this.runPassiveCheck(rule);
        testsRun.push(result.name);
        if (!result.passed && result.flag) {
          flags.push(result.flag);
        }
      }
    }

    const confidence = this.computeConfidence(flags, testsRun.length);
    const recommendation = this.buildRecommendation(confidence, flags);
    const rationale = this.buildRationale(flags, recommendation, testsRun);

    const report: ReviewReport = {
      confidence,
      flags,
      recommendation,
      rationale,
      testsRun,
    };

    if (recommendation === "hold") {
      await this.writeToQueue(report);
    }

    return report;
  }

  // -----------------------------------------------------------------------
  // Cartridge loading & rule parsing
  // -----------------------------------------------------------------------

  private async loadCartridges(): Promise<string[]> {
    const contents: string[] = [];
    for (const name of this.cartridgeNames) {
      // Resolve from shared scope (QA cartridges live in cartridges/shared/)
      const entry = await this.cartridgeRegistry.resolve(
        this.agentId,
        "craft",
        name,
      );
      if (entry) {
        contents.push(entry.content);
        continue;
      }
      // Fallback: QA cartridges may live as skill files under skills/
      const skillContent = await this.cartridgeRegistry.readSkill(name);
      if (skillContent) {
        contents.push(skillContent);
      }
    }
    return contents;
  }

  /**
   * Parse markdown cartridge content into structured rules.
   *
   * Each rule is defined as:
   *   ## Rule: <name>
   *   **Type:** active|passive
   *   **Severity:** error|warn
   *   <description / command>
   */
  private parseRules(cartridgeContents: string[]): ParsedRule[] {
    const rules: ParsedRule[] = [];
    for (const content of cartridgeContents) {
      const lines = content.split("\n");
      let current: Partial<ParsedRule> | null = null;

      for (const line of lines) {
        const heading = line.match(/^##\s+Rule:\s+(.+)$/i);
        if (heading) {
          if (current?.name && current.check !== undefined) {
            rules.push({
              type: current.type ?? "passive",
              name: current.name,
              check: current.check.trim(),
              severity: current.severity ?? "warn",
            });
          }
          current = { name: heading[1].trim(), check: "" };
          continue;
        }

        if (!current) continue;

        const typeMatch = line.match(/^\*\*Type:\*\*\s*(active|passive)/i);
        if (typeMatch) {
          current.type = typeMatch[1].toLowerCase() as "active" | "passive";
          continue;
        }

        const sevMatch = line.match(/^\*\*Severity:\*\*\s*(error|warn)/i);
        if (sevMatch) {
          current.severity = sevMatch[1].toLowerCase() as "error" | "warn";
          continue;
        }

        // Accumulate check description (skip headings and frontmatter)
        if (!line.startsWith("---") && !line.startsWith("#") && line.trim()) {
          current.check = (current.check ?? "") + line.trim() + " ";
        }
      }

      if (current?.name && current.check !== undefined) {
        rules.push({
          type: current.type ?? "passive",
          name: current.name,
          check: current.check.trim(),
          severity: current.severity ?? "warn",
        });
      }
    }
    return rules;
  }

  // -----------------------------------------------------------------------
  // Active checks (bash execution)
  // -----------------------------------------------------------------------

  private async runActiveCheck(
    rule: ParsedRule,
  ): Promise<{ name: string; passed: boolean; flag?: string }> {
    const command = this.extractCommand(rule.check);
    if (!command) {
      // No runnable command — may be a "cat" reference check
      if (rule.check.toLowerCase().includes("cat") || rule.check.toLowerCase().includes("read")) {
        return {
          name: rule.name,
          passed: true,
        };
      }
      return { name: rule.name, passed: true };
    }

    try {
      const result = await this.toolAccess.bash(command);
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(0, 200);
        return {
          name: rule.name,
          passed: false,
          flag: `${rule.name}: exited ${result.exitCode} — ${detail}`,
        };
      }
      return { name: rule.name, passed: true };
    } catch (err) {
      return {
        name: rule.name,
        passed: false,
        flag: `${rule.name}: error — ${String(err)}`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Passive checks (output text analysis)
  // -----------------------------------------------------------------------

  /**
   * Combined matching context = rule name + check text, lowercased.
   * Using the name means a rule titled "No debug logs" will match
   * the "no debug log" keyword even if the description doesn't contain it.
   */
  private matchContext(rule: ParsedRule): string {
    return (rule.name + " " + rule.check).toLowerCase();
  }

  private runPassiveCheck(
    rule: ParsedRule,
  ): { name: string; passed: boolean; flag?: string } {
    const ctx = this.matchContext(rule);
    const output = this.output;

    // --- Rule: No debug logs ---
    if (ctx.includes("no debug log") || ctx.includes("console.log") || ctx.includes("console.debug")) {
      if (/console\.(log|debug)\s*\(/i.test(output)) {
        return {
          name: rule.name,
          passed: false,
          flag: "Output contains console.log or console.debug statements",
        };
      }
    }

    // --- Rule: No TODO/FIXME markers ---
    if (ctx.includes("todo") || ctx.includes("fixme")) {
      if (/\b(TODO|FIXME|HACK|XXX)\b/i.test(output)) {
        return {
          name: rule.name,
          passed: false,
          flag: "Output contains TODO/FIXME/HACK/XXX markers",
        };
      }
    }

    // --- Rule: No dead code / large commented blocks ---
    if (ctx.includes("dead code") || ctx.includes("commented") || ctx.includes("dead code")) {
      const blockComments = output.match(/\/\*[\s\S]*?\*\//g);
      if (
        blockComments &&
        blockComments.some((c) => c.split("\n").length > 3)
      ) {
        return {
          name: rule.name,
          passed: false,
          flag: "Output contains large commented-out code blocks",
        };
      }
    }

    // --- Rule: YAGNI / no premature abstraction ---
    if (ctx.includes("premature") || ctx.includes("yagni") || ctx.includes("abstract")) {
      // Match generic patterns in definitions/assignments too (=, {)
      const abstractionPatterns =
        /\b(Abstract|Base|Generic|Factory|Provider|Manager|Strategy|Builder)\w*\s*(?:\(|<|:|<=|=|\{|\[)/g;
      const matches = output.match(abstractionPatterns);
      const count = matches?.length ?? 0;
      if (count >= 2) {
        return {
          name: rule.name,
          passed: false,
          flag: `Possible premature abstraction (${count} generic pattern(s) detected)`,
        };
      }
    }

    // --- Rule: Error handling at boundaries ---
    if (ctx.includes("error handling") && ctx.includes("boundar")) {
      const tryCatches = output.match(/\btry\s*\{/g);
      if (tryCatches && tryCatches.length > 3) {
        return {
          name: rule.name,
          passed: false,
          flag: `Excessive try-catch blocks (${tryCatches.length}) — error handling should be at boundaries`,
        };
      }
    }

    // --- Rule: Voice drift (communication cartridge) ---
    if (ctx.includes("voice") && ctx.includes("drift")) {
      const genericPhrases = [
        /I'm here to help/i,
        /How can I assist/i,
        /As an AI/i,
        /I don't have personal/i,
        /I cannot provide/i,
        /I am an AI/i,
      ];
      for (const pattern of genericPhrases) {
        if (pattern.test(output)) {
          return {
            name: rule.name,
            passed: false,
            flag: `Voice drift: output matches generic assistant pattern: ${pattern.source}`,
          };
        }
      }
    }

    // --- Rule: Mode boundary ---
    if (ctx.includes("mode") && ctx.includes("boundar")) {
      if (
        /\b(I will|I'll)\s+(implement|build|create|write|code|deploy)\b/i.test(output) &&
        /\b(dream|wonder|contemplate|philosophy|meditate)\b/i.test(output)
      ) {
        return {
          name: rule.name,
          passed: false,
          flag: "Mode boundary violation: mixing execution language with contemplative language",
        };
      }
    }

    // --- Rule: No unilateral commitments ---
    if (ctx.includes("unilateral") || ctx.includes("commitment")) {
      if (
        /\bI will now\b/i.test(output) ||
        /\bI'll proceed\b/i.test(output) ||
        /\bproceeding to\b/i.test(output)
      ) {
        return {
          name: rule.name,
          passed: false,
          flag: "Unilateral commitment detected: output promises action without confirmation",
        };
      }
    }

    // --- Rule: Valid substrate structure (memory) ---
    if (ctx.includes("substrate") && ctx.includes("structure")) {
      const validDirs = [
        "0_SOUL", "1_EGO", "2_MIND", "3_BODY",
        "4_RELATIONS", "5_ENGINE",
      ];
      const substrateRefs = output.match(/(?:^|\s)(\/?substrate\/[\w/.-]+)/gm);
      if (substrateRefs) {
        for (const ref of substrateRefs) {
          const trimmed = ref.trim().replace(/^\/?substrate\//, "");
          const topDir = trimmed.split("/")[0];
          if (topDir && !validDirs.includes(topDir) && !topDir.startsWith("_")) {
            return {
              name: rule.name,
              passed: false,
              flag: `Invalid substrate path: references "${topDir}" which is not a valid substrate directory`,
            };
          }
        }
      }
    }

    // --- Rule: 0_SOUL write without flag ---
    if (ctx.includes("0_soul") && (ctx.includes("flag") || ctx.includes("write"))) {
      if (
        /0_SOUL/.test(output) &&
        !/--axiom-write/.test(output) &&
        !/axiom.?write/i.test(output)
      ) {
        return {
          name: rule.name,
          passed: false,
          flag: "Output references 0_SOUL path without --axiom-write flag",
        };
      }
    }

    // --- Rule: Reversibility check (external_action) ---
    if (ctx.includes("reversib") || ctx.includes("irrevers")) {
      const irreversiblePatterns =
        /\b(delete|remove|destroy|erase|purge|rm\s+-rf|unlink)\b/i;
      if (
        irreversiblePatterns.test(output) &&
        !/\b(dry.?run|preview|simulate|ask|confirm)\b/i.test(output)
      ) {
        return {
          name: rule.name,
          passed: false,
          flag: "Irreversible operation detected without dry-run or confirmation guard",
        };
      }
    }

    // --- Rule: Scope match (external_action) ---
    if (ctx.includes("scope") && ctx.includes("match")) {
      const domainKeywords: Record<ReviewDomain, string[]> = {
        code: ["code", "file", "refactor", "implement", "test"],
        memory: ["substrate", "memory", "recall", "store", "fact"],
        communication: ["send", "telegram", "message", "reply"],
        architecture: ["design", "architect", "module", "dependency"],
        external_action: ["api", "external", "http", "request", "webhook"],
      };
      const expected = domainKeywords[this.domain] ?? [];
      const unexpected: string[] = [];
      for (const [dom, keywords] of Object.entries(domainKeywords)) {
        if (dom === this.domain) continue;
        for (const kw of keywords) {
          if (
            new RegExp(`\\b${kw}\\b`, "i").test(output) &&
            !expected.some((ek) => new RegExp(`\\b${ek}\\b`, "i").test(output))
          ) {
            unexpected.push(kw);
            break;
          }
        }
      }
      if (unexpected.length >= 2) {
        return {
          name: rule.name,
          passed: false,
          flag: `Scope mismatch: output references ${unexpected.join(", ")} which are outside the ${this.domain} domain`,
        };
      }
    }

    // --- Rule: Circular dependencies (architecture) ---
    if (
      (ctx.includes("circular") || ctx.includes("cyclic")) &&
      ctx.includes("depend")
    ) {
      const importMatches = output.match(/from\s+['"]\.\.?\//g);
      if (importMatches && importMatches.length > 10) {
        return {
          name: rule.name,
          passed: false,
          flag: `High number of relative imports (${importMatches.length}) — possible circular dependency risk`,
        };
      }
    }

    // --- Rule: Bounded modules (architecture) ---
    if (ctx.includes("bounded") || ctx.includes("single responsib")) {
      const concerns = new Set<string>();
      if (/\bimport\b.*\b(server|route|http|listen)\b/i.test(output))
        concerns.add("network");
      if (/\bimport\b.*\b(sqlite|postgres|redis|database)\b/i.test(output))
        concerns.add("data");
      if (/\bimport\b.*\b(telegram|discord|slack)\b/i.test(output))
        concerns.add("channel");
      if (/\bimport\b.*\b(react|vue|svelte|html|css)\b/i.test(output))
        concerns.add("ui");
      if (concerns.size >= 3) {
        return {
          name: rule.name,
          passed: false,
          flag: `Module boundary violation: output touches ${concerns.size} architectural concerns (${[...concerns].join(", ")})`,
        };
      }
    }

    return { name: rule.name, passed: true };
  }

  // -----------------------------------------------------------------------
  // Report computation
  // -----------------------------------------------------------------------

  private computeConfidence(
    flags: string[],
    totalChecks: number,
  ): number {
    if (totalChecks === 0) return 0.5;
    const penalty = flags.length * 0.15;
    return Math.max(0.1, Math.min(1.0, 1.0 - penalty));
  }

  private buildRecommendation(
    confidence: number,
    flags: string[],
  ): ReviewRecommendation {
    // Error-severity flags force a lower effective confidence
    if (confidence >= RECOMMENDATION_THRESHOLDS.approve) return "approve";
    if (confidence >= RECOMMENDATION_THRESHOLDS.hold) return "hold";
    return "reject";
  }

  private buildRationale(
    flags: string[],
    recommendation: ReviewRecommendation,
    testsRun: string[],
  ): string {
    const parts: string[] = [];
    parts.push(
      `Reviewed ${testsRun.length} check(s): ${testsRun.join(", ")}.`,
    );
    if (flags.length > 0) {
      parts.push(`${flags.length} issue(s) found: ${flags.join("; ")}.`);
    } else {
      parts.push("No issues found.");
    }
    parts.push(`Recommendation: ${recommendation}.`);
    return parts.join(" ");
  }

  // -----------------------------------------------------------------------
  // Review queue (used on "hold")
  // -----------------------------------------------------------------------

  private async writeToQueue(report: ReviewReport): Promise<void> {
    const queueDir = join(
      this.roomsDir,
      this.agentId,
      "review_queue",
    );
    await mkdir(queueDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(queueDir, `${timestamp}.json`);
    const entry = {
      timestamp: new Date().toISOString(),
      domain: this.domain,
      output: this.output,
      report: {
        confidence: report.confidence,
        flags: report.flags,
        rationale: report.rationale,
        testsRun: report.testsRun,
      },
    };
    await writeFile(
      filePath,
      JSON.stringify(entry, null, 2) + "\n",
      "utf-8",
    );
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Extract a runnable bash command from the rule check text.
   * Supports:
   *   - Markdown code blocks: ```bash\nbun test\n```
   *   - **Run:** `bun test`
   *   - Plain command references
   */
  private extractCommand(checkText: string): string | null {
    const codeBlock = checkText.match(/```(?:bash|sh)?\s*\n([\s\S]*?)```/);
    if (codeBlock) return codeBlock[1].trim();

    const runMatch = checkText.match(/\*\*Run:\*\*\s*`([^`]+)`/);
    if (runMatch) return runMatch[1].trim();

    const cmdMatch = checkText.match(
      /\b(bun test|tsc --noEmit|bunx tsc --noEmit)\b/,
    );
    if (cmdMatch) return cmdMatch[1];

    return null;
  }

  private createDefaultToolAccess(): ReviewerToolAccess {
    return {
      bash: async (command: string): Promise<ReviewerBashResult> => {
        const proc = Bun.spawnSync(sandboxToolCommand(["bash", "-c", command], this.cwd), {
          env: sandboxToolEnvironment(),
          cwd: this.cwd,
          timeout: 30_000, // 30s timeout — prevent hanging reviews
        });
        return {
          stdout: proc.stdout.toString(),
          stderr: proc.stderr.toString(),
          exitCode: proc.exitCode,
        };
      },
      read: async (path: string): Promise<string> => {
        const resolved = join(this.cwd, path);
        if (!existsSync(resolved)) {
          throw new Error(`file not found: ${path}`);
        }
        const boundary = currentToolBoundary();
        if (boundary && !boundary.fileAllowed(resolved)) throw Error("private bridge/source path denied");
        const file = Bun.file(resolved);
        return await file.text();
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedRule {
  type: "active" | "passive";
  name: string;
  check: string;
  severity: "error" | "warn";
}
