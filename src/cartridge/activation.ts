import type { PermissionMode } from "../config/types";
import type { CartridgeLoader } from "./loader";
import type { CartridgeEntry, CartridgeRegistry } from "./registry";
import { estimateTokens } from "./registry";
import type { CartridgeBlock, CartridgeKind, ExecutionPlan, SubstrateRetrievalPlan } from "./types";

const LAYER_ORDER: CartridgeKind[] = ["kernel", "persona", "role", "language", "framework", "project", "review", "task"];

export type ActivationSource = "override" | "self-select" | "task" | "mode";

export interface ActivationInput {
  entries: CartridgeEntry[];
  loader: CartridgeLoader;
  mode: PermissionMode;
  message: string;
  /** string = force this cartridge; null = force none; undefined = auto-resolve */
  cartridgeOverride?: string | null;
  agentCartridgeConfig?: { selfSelect?: string; taskPatterns?: Record<string, string[]> };
  /** Per-turn total cartridge budget; defaults to the entry's own budget. */
  budgetTokens?: number;
  /** Skip budget refusal (SC-008 force escape hatch). */
  force?: boolean;
}

export interface ActivationResult {
  base: CartridgeBlock[];
  active?: CartridgeBlock;
  entry?: CartridgeEntry;
  source?: ActivationSource;
  events: Array<Record<string, unknown> & { type: string }>;
}

function toBlock(entry: CartridgeEntry, content: string): CartridgeBlock {
  return { name: entry.name, scope: entry.scope, category: entry.category, content };
}

export async function resolveActivation(
  registry: CartridgeRegistry,
  input: ActivationInput,
): Promise<ActivationResult> {
  const events: ActivationResult["events"] = [];
  const base = input.entries
    .filter((e) => e.scope === "shared" || e.scope === "agent")
    .map((e) => toBlock(e, e.content));

  if (input.cartridgeOverride === null) return { base, events };

  let name = input.cartridgeOverride;
  let source: ActivationSource = "override";
  if (!name) {
    const resolved = input.loader.resolveWithSource({
      mode: input.mode,
      message: input.message,
      selfSelect: input.agentCartridgeConfig?.selfSelect,
      taskPatterns: input.agentCartridgeConfig?.taskPatterns,
    });
    if (resolved) {
      source = resolved.source;
      name = input.entries.find(
        (e) => e.scope === "pluggable" && e.category === resolved.category,
      )?.name;
    }
  }
  if (!name) return { base, events };

  const entry = input.entries.find((e) => e.name === name);
  if (!entry) return { base, events };

  const check = await registry.budgetCheck(entry);
  const baseEstimate = base.reduce((sum, b) => sum + estimateTokens(b.content), 0);
  const budget = input.budgetTokens ?? check.budget;
  if (!input.force && (check.over || baseEstimate + check.estimate > budget)) {
    events.push({
      type: "cartridge_budget_exceeded",
      name: entry.name,
      estimate: baseEstimate + check.estimate,
      budget,
    });
    return { base, events };
  }

  const expanded = await registry.expand(entry);
  events.push({
    type: "cartridge_activated",
    name: entry.name,
    scope: entry.scope,
    category: entry.category,
    source,
    estimatedTokens: check.estimate,
  });
  return { base, active: toBlock(entry, expanded), entry, source, events };
}

export interface ExecutionPlanInput {
  mode: PermissionMode;
  message: string;
  identity: string;
  selfSelect?: string;
  defaultRole?: string;
  /** Always-on cartridges by name (new path). */
  universal?: string[];
  /** Default category or cartridge names applied when no stronger signal wins. */
  defaults?: string[];
  budgetTokens?: number;
  recentTasks?: string[];
  /** Force a specific cartridge name; null forces no override. */
  cartridgeOverride?: string | null;
  /** Fallback topK for cartridges without a retrieval policy. */
  fallbackTopK?: number;
}

/** Resolve a full ExecutionPlan — multi-layer composition replacing single-slot activation. */
export async function resolveExecutionPlan(
  registry: CartridgeRegistry,
  loader: CartridgeLoader,
  entries: CartridgeEntry[],
  input: ExecutionPlanInput,
): Promise<ExecutionPlan> {
  const events: ExecutionPlan["events"] = [];
  const budgetLimit = input.budgetTokens ?? 5000;
  const universalNames = input.universal ?? [];

  // 1. Inject universal entries unconditionally
  const universal: CartridgeBlock[] = [];
  const universalEntries: CartridgeEntry[] = [];
  for (const name of universalNames) {
    const entry = entries.find(e => e.name === name);
    if (entry) {
      universalEntries.push(entry);
      const expanded = await registry.expand(entry);
      universal.push(toBlock(entry, expanded));
    }
  }

  // 2. Per-layer scoring
  const layerCtx = {
    mode: input.mode,
    message: input.message,
    selfSelect: input.selfSelect,
    defaultRole: input.defaultRole,
    defaults: input.defaults,
    recentTasks: input.recentTasks,
  };

  const layerWinners = new Map<CartridgeKind, { entry: CartridgeEntry; expanded: string }>();

  // cartridgeOverride forces a specific cartridge to win its kind
  const overrideEntry = input.cartridgeOverride != null && input.cartridgeOverride !== ""
    ? entries.find(e => e.name === input.cartridgeOverride)
    : undefined;

  if (input.cartridgeOverride === null) {
    // Force no pluggable layer winners; universal/dependencies still apply.
  } else if (overrideEntry && overrideEntry.kind) {
    const expanded = await registry.expand(overrideEntry);
    layerWinners.set(overrideEntry.kind, { entry: overrideEntry, expanded });
    events.push({ type: "cartridge_activated", name: overrideEntry.name, kind: overrideEntry.kind, scope: overrideEntry.scope, source: "override" });
  } else if (input.cartridgeOverride) {
    events.push({ type: "cartridge_override_missing", name: input.cartridgeOverride });
  }

  for (const kind of LAYER_ORDER) {
    if (kind === "kernel") continue; // kernels loaded via dependency graph or universal
    if (layerWinners.has(kind)) continue; // forced by override
    const candidates = loader.resolveLayer(kind, entries, layerCtx);
    if (candidates.length > 0) {
      const winner = candidates[0].entry;
      const expanded = await registry.expand(winner);
      layerWinners.set(kind, { entry: winner, expanded });
    }
  }

  // 3. Dependency graph expansion from working role
  const roleWinner = layerWinners.get("role");
  const dependencyEntries: CartridgeEntry[] = [];
  if (roleWinner) {
    const deps = loader.expandDependencies(roleWinner.entry, entries);
    for (const dep of deps) {
      dependencyEntries.push(dep);
    }
  }

  // 4. Expand dependencies
  const dependencies: CartridgeBlock[] = [];
  for (const dep of dependencyEntries) {
    const expanded = await registry.expand(dep);
    dependencies.push(toBlock(dep, expanded));
  }

  // 5. Cross-layer conflict resolution (SC-011: within-layer OR across-layer)
  const allWinners = new Map(layerWinners);
  for (const [kind, winner] of allWinners) {
    const conflicts = winner.entry.conflicts ?? [];
    for (const conflictName of conflicts) {
      for (const [otherKind, otherWinner] of allWinners) {
        if (otherKind === kind) continue;
        if (otherWinner.entry.name !== conflictName) continue;
        const winnerPriority = winner.entry.priority ?? 0;
        const otherPriority = otherWinner.entry.priority ?? 0;
        if (winnerPriority >= otherPriority) {
          allWinners.delete(otherKind);
          events.push({ type: "cartridge_conflict", winner: winner.entry.name, dropped: conflictName, layer: otherKind });
        } else {
          allWinners.delete(kind);
          events.push({ type: "cartridge_conflict", winner: conflictName, dropped: winner.entry.name, layer: kind });
          break;
        }
      }
    }
  }

  // 6. Build ExecutionPlan fields from conflict-resolved winners
  const persona = allWinners.get("persona");
  const role = allWinners.get("role");
  const language = allWinners.get("language");
  const framework = allWinners.get("framework");
  const project = allWinners.get("project");
  const task = allWinners.get("task");

  // 7. Budget gate — sum all tokens
  const allBlocks = [
    ...universal,
    ...dependencies,
    ...(persona ? [toBlock(persona.entry, persona.expanded)] : []),
    ...(role ? [toBlock(role.entry, role.expanded)] : []),
    ...(language ? [toBlock(language.entry, language.expanded)] : []),
    ...(framework ? [toBlock(framework.entry, framework.expanded)] : []),
    ...(project ? [toBlock(project.entry, project.expanded)] : []),
    ...(task ? [toBlock(task.entry, task.expanded)] : []),
  ];
  let estimated = allBlocks.reduce((sum, b) => sum + estimateTokens(b.content), 0);

  // Drop lowest-scoring layers if over budget.
  // Protected: kernel (identity-critical), role (task-critical), persona (identity-adjacent, typically small).
  const droppable: Array<{ kind: CartridgeKind; block: CartridgeBlock; entry: CartridgeEntry }> = [];
  if (language) droppable.push({ kind: "language", block: toBlock(language.entry, language.expanded), entry: language.entry });
  if (framework) droppable.push({ kind: "framework", block: toBlock(framework.entry, framework.expanded), entry: framework.entry });
  if (project) droppable.push({ kind: "project", block: toBlock(project.entry, project.expanded), entry: project.entry });
  if (task) droppable.push({ kind: "task", block: toBlock(task.entry, task.expanded), entry: task.entry });

  // Sort droppable by priority (lowest first = dropped first)
  droppable.sort((a, b) => (a.entry.priority ?? 0) - (b.entry.priority ?? 0));

  const dropped = new Set<string>();
  while (estimated > budgetLimit && droppable.length > 0) {
    const victim = droppable.shift()!;
    const victimEstimate = estimateTokens(victim.block.content);
    const estimateBefore = estimated;
    estimated -= victimEstimate;
    dropped.add(victim.kind);
    events.push({
      type: "cartridge_budget_exceeded",
      name: victim.entry.name,
      kind: victim.kind,
      estimate: estimateBefore,
      remaining: estimated,
      budget: budgetLimit,
    });
  }

  if (estimated > budgetLimit) {
    // All droppable layers removed but protected layers still exceed budget.
    events.push({
      type: "cartridge_budget_unrecoverable",
      estimated,
      budget: budgetLimit,
      protectedLayers: ["kernel", "persona", "role", "universal", "dependencies"],
    });
  }

  // 7. Compile substrate retrieval plan from active cartridges
  const activeEntries: CartridgeEntry[] = [
    ...universalEntries,
    ...dependencyEntries,
  ];
  if (persona) activeEntries.push(persona.entry);
  if (role) activeEntries.push(role.entry);
  if (language && !dropped.has("language")) activeEntries.push(language.entry);
  if (framework && !dropped.has("framework")) activeEntries.push(framework.entry);
  if (project && !dropped.has("project")) activeEntries.push(project.entry);
  if (task && !dropped.has("task")) activeEntries.push(task.entry);
  const substrateRetrievalPlan = compileRetrievalPlan(activeEntries, budgetLimit, input.fallbackTopK);

  // 8. Assemble plan
  const plan: ExecutionPlan = {
    identity: input.identity,
    interactionPersona: persona ? toBlock(persona.entry, persona.expanded) : undefined,
    workingRole: role ? toBlock(role.entry, role.expanded) : undefined,
    defaultRole: input.defaultRole,
    dependencies, // deps are protected and never dropped by the budget gate
    language: language && !dropped.has("language") ? toBlock(language.entry, language.expanded) : undefined,
    framework: framework && !dropped.has("framework") ? toBlock(framework.entry, framework.expanded) : undefined,
    project: project && !dropped.has("project") ? toBlock(project.entry, project.expanded) : undefined,
    task: task && !dropped.has("task") ? toBlock(task.entry, task.expanded) : undefined,
    universal,
    substrateRetrievalPlan,
    budget: { estimated, limit: budgetLimit },
    events,
  };

  // Emit activation events for each winner
  for (const [kind, winner] of allWinners) {
    if (!dropped.has(kind)) {
      events.push({
        type: "cartridge_activated",
        name: winner.entry.name,
        kind,
        scope: winner.entry.scope,
      });
    }
  }

  return plan;
}

/** Compile a SubstrateRetrievalPlan from resolved cartridges' retrieval policies. */
export function compileRetrievalPlan(
  entries: CartridgeEntry[],
  globalBudget: number,
  fallbackTopK?: number,
): SubstrateRetrievalPlan {
  const requests: SubstrateRetrievalPlan["requests"] = [];

  for (const entry of entries) {
    if (entry.retrieval?.scopes?.length) {
      requests.push({
        cartridgeName: entry.name,
        scopes: entry.retrieval.scopes,
        top_k: entry.retrieval.top_k ?? 5,
        max_tokens: entry.retrieval.max_tokens ?? 2000,
        require_evidence: entry.retrieval.require_evidence ?? false,
        allow_unverified_fallback: entry.retrieval.allow_unverified_fallback ?? false,
      });
    }
  }

  const plan: SubstrateRetrievalPlan = {
    requests,
    globalBudget,
  };

  // Only set fallbackTopK if there are un-migrated cartridges
  const hasUnmigrated = entries.some(e => !e.retrieval?.scopes?.length);
  if (hasUnmigrated && fallbackTopK) {
    plan.fallbackTopK = fallbackTopK;
  }

  return plan;
}
