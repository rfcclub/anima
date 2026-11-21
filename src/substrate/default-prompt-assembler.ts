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
 * Blocks that do not fit the budget are skipped (later, smaller blocks that fit are still kept) and the dropped
 * scopes are named in a warning. Scopes listed in `reserveScopes` keep room for their best block.
 */
export class DefaultPromptAssembler implements PromptAssembler {
  assemble(view: SubstrateView, options: AssembleOptions = {}): PromptContext {
    const {
      maxTokens = view.turnContext.maxTokens ?? 3000,
      prioritizeScopes = [],
      format = "markdown",
      includeEvidence = false,
      reserveScopes = [],
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
    const dropped: PromptContextBlock[] = [];

    // Room held back for each reserved scope that has no kept block yet: the cheapest remaining block of that scope
    // that can fit the budget at all. A reservation that can never fit holds back nothing, and a scope's own block is
    // never charged for its own reservation, but IS charged for every other reserved scope's.
    const reserved = new Set(reserveScopes);
    const costs = blocks.map((block) => estimateTokens(formatBlock(block, format, includeEvidence)));
    const keptScopes = new Set<string>();
    const heldBackFor = (index: number): number => {
      let held = 0;
      for (const scope of reserved) {
        if (scope === blocks[index].scope || keptScopes.has(scope)) continue;
        let cheapest = Infinity;
        for (let j = index + 1; j < blocks.length; j++) {
          if (blocks[j].scope === scope && costs[j] <= tokenBudget) cheapest = Math.min(cheapest, costs[j]);
        }
        if (cheapest !== Infinity) held += cheapest;
      }
      return held;
    };

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const est = costs[i];
      if (totalTokens + est + heldBackFor(i) > tokenBudget) {
        dropped.push(block);
        continue; // skip this block only; a later smaller block may still fit
      }
      kept.push(block);
      totalTokens += est;
      keptScopes.add(block.scope);
    }

    // Never hand back an empty view when there was content: keep the best block even if it is over budget.
    if (kept.length === 0 && blocks.length > 0) {
      const first = blocks[0];
      kept.push(first);
      totalTokens = costs[0];
      dropped.splice(dropped.indexOf(first), 1);
    }

    const truncated = dropped.length > 0;
    if (truncated) {
      const scopes = [...new Set(dropped.map((b) => b.scope))].join(", ");
      warnings.push(`Truncated: ${dropped.length} blocks dropped to fit ${tokenBudget} token budget (dropped scopes: ${scopes})`);
    }

    return {
      blocks: kept,
      totalTokens,
      tokenBudget,
      truncated,
      droppedScopes: [...new Set(dropped.map((b) => b.scope))],
      droppedBlocks: dropped.length,
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

