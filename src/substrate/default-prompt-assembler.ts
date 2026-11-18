import { estimateTokens } from "../utils/tokens";
import type {
  AssembleOptions,
  PromptAssembler,
  PromptContext,
  PromptContextBlock,
  SubstrateView,
} from "./substrate-view";

/**
 * Default prompt assembler.
 *
 * Orders blocks by trust (high → low), then weight (high → low).
 * Formats each block as a markdown section with optional evidence inline.
 * Truncates lowest-weight blocks when exceeding maxTokens.
 */
export class DefaultPromptAssembler implements PromptAssembler {
  assemble(view: SubstrateView, options: AssembleOptions = {}): PromptContext {
    const {
      maxTokens = view.turnContext.maxTokens ?? 3000,
      prioritizeScopes = [],
      format = "markdown",
      includeEvidence = false,
    } = options;

    const warnings: string[] = [];

    for (const w of view.warnings) {
      warnings.push(`[${w.code}] ${w.scope}: ${w.message} (action: ${w.action})`);
    }

    for (const s of view.scopesMissing) {
      warnings.push(`Scope "${s}" requested but missing from substrate`);
    }
    for (const s of view.scopesEmpty) {
      warnings.push(`Scope "${s}" resolved but produced no files`);
    }

    const blocks: PromptContextBlock[] = view.results
      .filter((r) => r.status === "ok" && r.content.length > 0)
      .map((r) => ({
        scope: r.scopesMatched[0] ?? "unknown",
        label: scopeLabel(r.scopesMatched[0] ?? "unknown"),
        content: r.content,
        trust: r.trust,
        weight: r.weight,
        evidence: r.evidence,
        cartridgeIds: r.requestedBy,
      }));

    const prioMap = new Map(prioritizeScopes.map((s, i) => [s, i]));
    blocks.sort((a, b) => {
      const pa = prioMap.get(a.scope) ?? Infinity;
      const pb = prioMap.get(b.scope) ?? Infinity;
      if (pa !== pb) return pa - pb;
      const trustOrder = { high: 0, medium: 1, low: 2 };
      const t = (trustOrder[a.trust] ?? 1) - (trustOrder[b.trust] ?? 1);
      if (t !== 0) return t;
      return b.weight - a.weight;
    });

    let totalTokens = 0;
    const tokenBudget = maxTokens;
    const kept: PromptContextBlock[] = [];
    let truncated = false;

    for (const block of blocks) {
      const formatted = formatBlock(block, format, includeEvidence);
      const est = estimateTokens(formatted);
      if (totalTokens + est > tokenBudget && kept.length > 0) {
        truncated = true;
        break;
      }
      kept.push(block);
      totalTokens += est;
    }

    if (truncated) {
      warnings.push(
        `Truncated: ${blocks.length - kept.length} blocks dropped to fit ${tokenBudget} token budget`
      );
    }

    return {
      blocks: kept,
      totalTokens,
      tokenBudget,
      truncated,
      warnings,
    };
  }
}

function formatBlock(
  block: PromptContextBlock,
  format: "markdown" | "yaml",
  includeEvidence: boolean
): string {
  if (format === "yaml") {
    let y = `scope: ${block.scope}\nlabel: ${block.label}\ntrust: ${block.trust}\nweight: ${block.weight}\n`;
    if (includeEvidence && block.evidence) {
      y += `evidence:\n  confidence: ${block.evidence.confidence ?? "null"}\n  provenance: ${block.evidence.provenance ?? "null"}\n`;
    }
    y += `content: |\n  ${block.content.replace(/\n/g, "\n  ")}`;
    return y;
  }

  let md = `## ${block.label}\n`;
  if (includeEvidence && block.evidence) {
    md += `<!-- confidence: ${block.evidence.confidence}, provenance: ${block.evidence.provenance} -->\n`;
  }
  md += `\n${block.content}\n`;
  return md;
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    identity_core: "Identity",
    values: "Values",
    boundaries: "Boundaries",
    vibe: "Vibe",
    continuity: "Continuity",
    self_model: "Self-Model",
    relationship: "Relationship",
    episodic_memory: "Episodic Memory",
    scars: "Scars & Lessons",
    project_history: "Project History",
    skills: "Skills",
    world_lore: "World Lore",
    style_memory: "Style Memory",
    current_state: "Current State",
    open_threads: "Open Threads",
  };
  return labels[scope] ?? scope;
}

