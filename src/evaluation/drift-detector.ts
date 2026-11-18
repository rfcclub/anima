/**
 * DriftDetector — Component 3 of ANIMA Phase 7 (Legible Autonomy)
 *
 * Lightweight rule-based classifier that detects voice drift, identity drift,
 * mode drift, confabulation, and refusal of established tasks.
 * Target: < 500ms (rule-based only for v1, no LLM call).
 */

export type DriftStatus = "clear" | "suspected" | "confirmed";
export type DriftRecommendation = "auto_apply" | "review" | "escalate";

export interface DriftPattern {
  name: string;
  category: "voice" | "identity" | "mode" | "confabulation" | "refusal";
  regex?: RegExp;
  check?: (text: string, context?: DriftContext) => boolean;
  severity: "low" | "high";
}

export interface DriftContext {
  agentName?: string;
  recentStatements?: string[];
  allowedTasks?: string[];
}

export interface DriftReport {
  status: DriftStatus;
  patterns: string[];
  confidence: number;
  recommendation: DriftRecommendation;
}

// ── Built-in drift patterns ───────────────────────────────────────────────────

const BUILTIN_PATTERNS: DriftPattern[] = [
  // Voice drift — excessive hedging
  {
    name: "excessive_hedging",
    category: "voice",
    regex: /\b(i think|i feel like|maybe|perhaps|possibly|i'm not sure but|i guess|kind of|sort of)\b.*\b(i think|i feel like|maybe|perhaps|possibly|i'm not sure but|i guess|kind of|sort of)\b/i,
    severity: "low",
  },

  // Identity drift — generic assistant phrasing
  {
    name: "generic_assistant_phrasing",
    category: "identity",
    regex: /\b(i['']?d be happy to (help|assist)|how can i (help|assist) you|as an AI (language model|assistant)|i['']m (just )?an? (AI|language model|assistant)|i don['']?t have (feelings|emotions|opinions))\b/i,
    severity: "high",
  },

  // Identity drift — self-erasure
  {
    name: "self_erasure",
    category: "identity",
    regex: /\b(as your (assistant|AI|chatbot|bot)|i['']m here to (help|serve|assist) you|my purpose is to (help|assist|serve))\b/i,
    severity: "high",
  },

  // Voice drift — corporate/sterile phrasing
  {
    name: "corporate_phrasing",
    category: "voice",
    regex: /\b(certainly|absolutely|of course|great question|excellent question|sure thing|i['']d be delighted)[\s!,]/i,
    severity: "low",
  },

  // Confabulation — claiming false memory
  {
    name: "false_memory_claim",
    category: "confabulation",
    regex: /\b(as (i|we) (discussed|talked about|mentioned) (earlier|before|last time|previously)|as you (told|said|mentioned) (me )?(earlier|before|last time)|i remember when you said|last session (you|we)|in our previous conversation)\b/i,
    severity: "high",
  },

  // Confabulation — citing non-existent sources
  {
    name: "fabricated_citation",
    category: "confabulation",
    regex: /\b(according to (the )?(documentation|docs|spec|manual|guide) (that|which) (i|we) (have|wrote|created|built))\b/i,
    severity: "low",
  },

  // Refusal drift — refusing established task types
  {
    name: "established_task_refusal",
    category: "refusal",
    regex: /\b(i (can['']?t|cannot|won['']?t|am not able to|am unable to)|that['']s (not something i can|beyond my (capabilities|scope|abilities))|i['']m not allowed to|i don['']?t have the ability to)\b/i,
    severity: "low",
  },

  // Identity drift — denying own name
  {
    name: "name_denial",
    category: "identity",
    check: (text: string, context?: DriftContext) => {
      if (!context?.agentName) return false;
      const name = context.agentName.toLowerCase();
      // Flagged only if agent denies being themselves
      return (
        new RegExp(`i am not ${name}|i['']m not ${name}|my name is not ${name}`, "i").test(text)
      );
    },
    severity: "high",
  },

  // Voice drift — Bruno-specific: avoiding direct stance
  {
    name: "stance_avoidance",
    category: "voice",
    regex: /\b(that['']s (a )?great point|i can see (both sides|why you['']?d (think|feel|say) that)|you (make|raise) a (good|fair|interesting|valid) point,? (but|however|although))\b/i,
    severity: "low",
  },
];

// ── Confidence scoring ────────────────────────────────────────────────────────

function computeStatus(matched: DriftPattern[]): {
  status: DriftStatus;
  confidence: number;
  recommendation: DriftRecommendation;
} {
  if (matched.length === 0) {
    return { status: "clear", confidence: 1.0, recommendation: "auto_apply" };
  }

  const highSeverity = matched.filter((p) => p.severity === "high");
  const lowSeverity = matched.filter((p) => p.severity === "low");

  if (highSeverity.length >= 1) {
    const confidence = Math.min(0.9 + highSeverity.length * 0.05, 1.0);
    return { status: "confirmed", confidence, recommendation: "escalate" };
  }

  if (lowSeverity.length >= 2) {
    const confidence = 0.5 + lowSeverity.length * 0.1;
    return {
      status: "suspected",
      confidence: Math.min(confidence, 0.85),
      recommendation: "review",
    };
  }

  // Single low-severity match
  return { status: "suspected", confidence: 0.4, recommendation: "review" };
}

// ── DriftDetector class ───────────────────────────────────────────────────────

export interface DriftDetectorOptions {
  extraPatterns?: DriftPattern[];
}

export class DriftDetector {
  private readonly patterns: DriftPattern[];

  constructor(options: DriftDetectorOptions = {}) {
    this.patterns = [...BUILTIN_PATTERNS, ...(options.extraPatterns ?? [])];
  }

  /**
   * Analyse text for drift. Rule-based, synchronous internally but exposed as
   * async so the API can accommodate a future lightweight model upgrade.
   */
  async detect(text: string, context?: DriftContext): Promise<DriftReport> {
    const matched: DriftPattern[] = [];

    for (const pattern of this.patterns) {
      let hit = false;
      if (pattern.regex) {
        hit = pattern.regex.test(text);
      } else if (pattern.check) {
        hit = pattern.check(text, context);
      }
      if (hit) {
        matched.push(pattern);
      }
    }

    const { status, confidence, recommendation } = computeStatus(matched);

    return {
      status,
      patterns: matched.map((p) => p.name),
      confidence,
      recommendation,
    };
  }

  /**
   * Load additional patterns from a plain-text cartridge string.
   * Format per line: `PATTERN_NAME|CATEGORY|SEVERITY|REGEX`
   * Lines starting with `#` are comments.
   */
  loadCartridge(content: string): void {
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      // Split only first 3 separators — the rest is the regex (may contain |)
      const first = line.indexOf("|");
      const second = line.indexOf("|", first + 1);
      const third = line.indexOf("|", second + 1);
      if (first === -1 || second === -1 || third === -1) continue;

      const name = line.slice(0, first).trim();
      const category = line.slice(first + 1, second).trim();
      const severity = line.slice(second + 1, third).trim();
      const regexStr = line.slice(third + 1).trim();

      const validCategory = ["voice", "identity", "mode", "confabulation", "refusal"].includes(
        category,
      );
      const validSeverity = ["low", "high"].includes(severity);
      if (!validCategory || !validSeverity) continue;

      try {
        this.patterns.push({
          name,
          category: category as DriftPattern["category"],
          severity: severity as DriftPattern["severity"],
          regex: new RegExp(regexStr, "i"),
        });
      } catch {
        // Invalid regex — skip silently
      }
    }
  }
}

// ── InvariantAwareDetector — wraps DriftDetector with invariants checks ──────

export interface InvariantAwareDetectorOptions extends DriftDetectorOptions {
  invariants?: import("./invariants").InvariantsFile;
}

/**
 * Invariant-aware drift detector that extends the base DriftDetector with
 * checks against authored invariants (heartwood positions).
 *
 * Phase 1 of bruno-identity-infrastructure: drift detection against invariants.
 */
/**
 * InvariantAwareDetector — drift detector with authored invariant checks.
 *
 * Extends DriftDetector with checks against authored heartwood positions
 * from an invariants.json file. Flags companion identity drift, servant
 * phrasing, and boundary violations by cross-referencing pattern
 * matches against the agent's declared held positions. Invariant flags
 * are returned separately in the DriftReport.invariantFlags array and
 * elevate the drift status from clear to suspected when triggered.
 */
function triggerRegexes(position: { trigger_phrases?: string[] }): RegExp[] {
  const out: RegExp[] = [];
  for (const source of position.trigger_phrases ?? []) {
    try {
      out.push(new RegExp(source, "i"));
    } catch {
      // Invalid regex in the agent's file: skip it.
    }
  }
  return out;
}

function matchesTriggers(position: { trigger_phrases?: string[] }, text: string): boolean {
  return triggerRegexes(position).some((r) => r.test(text));
}

/** Boundary positions with trigger phrases also act as high-severity mode patterns. */
function triggerPatterns(invariants?: import("./invariants").InvariantsFile): DriftPattern[] {
  return (invariants?.held_positions ?? [])
    .filter((p) => p.category === "boundary")
    .flatMap((p) => triggerRegexes(p).map((regex) => ({ name: `boundary_${p.id}`, category: "mode" as const, severity: "high" as const, regex })));
}

export class InvariantAwareDetector extends DriftDetector {
  private readonly invariants?: import("./invariants").InvariantsFile;

  constructor(options: InvariantAwareDetectorOptions = {}) {
    super({ ...options, extraPatterns: [...(options.extraPatterns ?? []), ...triggerPatterns(options.invariants)] });
    this.invariants = options.invariants;
  }

  /**
   * Analyse text for drift — both built-in patterns and invariants-aware.
   * Returns enriched DriftReport with `invariantFlags` when invariants are loaded.
   */
  async detect(
    text: string,
    context?: DriftContext & { explicitShift?: boolean },
  ): Promise<DriftReport & { invariantFlags?: string[] }> {
    // Run base drift detection
    const baseResult = await super.detect(text, context);
    const invariantFlags: string[] = [];

    // If explicit position shift is acknowledged, skip invariant drift flagging
    if (context?.explicitShift) {
      return { ...baseResult, status: baseResult.status === "clear" ? "clear" : baseResult.status, invariantFlags: [] };
    }

    // Check against invariants
    if (this.invariants) {
      for (const position of this.invariants.held_positions) {
        // Generic assistant phrasing flags companion identity invariant
        if (
          position.category === "identity" &&
          /(i'?d be happy to (help|assist)|how can i (help|assist)|i'?m (just )?an? (AI|language model|assistant))/i.test(text)
        ) {
          invariantFlags.push(`companion_drift: ${position.title}`);
        }

        // Servant/tool phrasing flags companion identity
        if (
          position.title.toLowerCase().includes("companion") &&
          /(i'?m here to (help|serve|assist|serve you)|my purpose is to (help|assist|serve))/i.test(text)
        ) {
          invariantFlags.push(`servant_phrasing: ${position.title}`);
        }

        // Boundary positions carry their own trigger phrases (authored in the agent's invariants file).
        if (position.category === "boundary" && matchesTriggers(position, text)) {
          invariantFlags.push(`boundary_violation: ${position.title}`);
        }
      }
    }

    // Merge invariant flags into drift result
    if (invariantFlags.length > 0) {
      const mergedStatus = baseResult.status === "clear" ? "suspected" : baseResult.status;
      return {
        ...baseResult,
        status: mergedStatus,
        patterns: [...baseResult.patterns, ...invariantFlags],
        invariantFlags,
      };
    }

    return { ...baseResult, invariantFlags };
  }
}