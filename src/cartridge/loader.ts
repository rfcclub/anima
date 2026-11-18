import type { PermissionMode } from "../config/types";
import type { CartridgeKind } from "./types";
import type { CartridgeEntry } from "./registry";

export const CARTRIDGE_CATEGORIES = ["craft", "think", "create", "operate"] as const;
export type CartridgeCategory = (typeof CARTRIDGE_CATEGORIES)[number];

export interface LayerContext {
  mode: PermissionMode;
  message: string;
  selfSelect?: string;
  defaultRole?: string;
  /** Default cartridge names applied as a tie-breaker when no stronger signal wins. */
  defaults?: string[];
  taskPatterns?: Record<string, string[]>;
  recentTasks?: string[];
}

export interface ScoredCandidate {
  entry: CartridgeEntry;
  score: number;
  source: "exact-trigger" | "keyword" | "mode" | "self-select" | "default" | "task-continuity";
}

export interface CartridgeTriggerContext {
  mode: PermissionMode;
  message: string;
  selfSelect?: string;
  taskPatterns?: Record<string, string[]>;
}

export class CartridgeLoader {
  resolve(ctx: CartridgeTriggerContext): CartridgeCategory | null {
    if (ctx.selfSelect) {
      const cat = ctx.selfSelect as CartridgeCategory;
      if (["craft", "think", "create", "operate"].includes(cat)) {
        return cat;
      }
    }

    if (ctx.taskPatterns) {
      const fromTask = this.taskToCategory(ctx.message, ctx.taskPatterns);
      if (fromTask) return fromTask;
    }

    return this.modeToCategory(ctx.mode);
  }

  resolveWithSource(
    ctx: CartridgeTriggerContext,
  ): { category: CartridgeCategory; source: "self-select" | "task" | "mode" } | null {
    if (ctx.selfSelect && ["craft", "think", "create", "operate"].includes(ctx.selfSelect)) {
      return { category: ctx.selfSelect as CartridgeCategory, source: "self-select" };
    }
    if (ctx.taskPatterns) {
      const fromTask = this.taskToCategory(ctx.message, ctx.taskPatterns);
      if (fromTask) return { category: fromTask, source: "task" };
    }
    const fromMode = this.modeToCategory(ctx.mode);
    return fromMode ? { category: fromMode, source: "mode" } : null;
  }

  modeToCategory(mode: PermissionMode): CartridgeCategory | null {
    switch (mode) {
      case "plan": return "think";
      case "edit": return "craft";
      case "auto": return "operate";
      default: return null;
    }
  }

  taskToCategory(message: string, patterns: Record<string, string[]>): CartridgeCategory | null {
    const lowerMessage = message.toLowerCase();
    for (const [category, keywords] of Object.entries(patterns)) {
      for (const keyword of keywords) {
        if (lowerMessage.includes(keyword.toLowerCase())) {
          return category as CartridgeCategory;
        }
      }
    }
    return null;
  }

  /** Score candidates for a single layer. Returns sorted by score descending. */
  resolveLayer(
    kind: CartridgeKind,
    entries: CartridgeEntry[],
    ctx: LayerContext,
  ): ScoredCandidate[] {
    const lowerMessage = ctx.message.toLowerCase();
    const candidates: ScoredCandidate[] = [];

    for (const entry of entries) {
      if (entry.kind !== kind) continue;

      let score = 0;
      let source: ScoredCandidate["source"] = "default";

      // Persona cartridges get a base score — they're always eligible
      if (kind === "persona") {
        score = 1;
      }

      // Exact trigger match (highest signal)
      const taskTriggers = entry.triggers?.task ?? [];
      let exactMatch = false;
      for (const trigger of taskTriggers) {
        if (lowerMessage.includes(trigger.toLowerCase())) {
          score += 10;
          source = "exact-trigger";
          exactMatch = true;
          break;
        }
      }

      // Mode trigger match (low signal, broad category selector)
      if (!exactMatch && entry.triggers?.mode) {
        const modeCategory = this.modeToCategory(ctx.mode);
        if (modeCategory && entry.triggers.mode.includes(modeCategory)) {
          score += 3;
          source = "mode";
        }
      }

      // Keyword match from taskPatterns (medium signal)
      if (!exactMatch && ctx.taskPatterns) {
        const categoryKeywords = ctx.taskPatterns[entry.category] ?? [];
        for (const keyword of categoryKeywords) {
          if (lowerMessage.includes(keyword.toLowerCase())) {
            score += 5;
            source = "keyword";
            break;
          }
        }
      }

      // selfSelect preference: either a specific cartridge name or a category
      if (ctx.selfSelect) {
        if (entry.name === ctx.selfSelect) {
          score += 2;
          if (source === "default") source = "self-select";
        } else if (entry.category === ctx.selfSelect && CARTRIDGE_CATEGORIES.includes(ctx.selfSelect as CartridgeCategory)) {
          score += 1;
          if (source === "default") source = "self-select";
        }
      }

      // agentDefault preference (low signal, tie-breaker)
      if (ctx.defaultRole && entry.name === ctx.defaultRole) {
        score += 1;
        if (source === "default") source = "default";
      }

      // defaults preference (low signal, tie-breaker)
      if (ctx.defaults?.includes(entry.name)) {
        score += 1;
        if (source === "default") source = "default";
      }

      // Task continuity (recent tasks get a small boost)
      if (ctx.recentTasks?.includes(entry.name)) {
        score += 1;
        if (source === "default") source = "task-continuity";
      }

      // Priority tie-breaker
      if (entry.priority) {
        score += entry.priority * 0.01; // tiny nudge
      }

      if (score > 0) {
        candidates.push({ entry, score, source });
      }
    }

    // Sort by score descending, then by name for determinism
    candidates.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

    // Conflict resolution: if winner declares conflicts, exclude conflicting entries
    if (candidates.length > 0) {
      const winner = candidates[0];
      const conflicts = winner.entry.conflicts ?? [];
      if (conflicts.length > 0) {
        return candidates.filter(c => c === winner || !conflicts.includes(c.entry.name));
      }
    }

    return candidates;
  }

  /** Recursively expand a role cartridge's requires: list. Cycle-safe. */
  expandDependencies(
    entry: CartridgeEntry,
    allEntries: CartridgeEntry[],
    visited = new Set<string>(),
  ): CartridgeEntry[] {
    if (!entry.requires?.length) return [];
    const deps: CartridgeEntry[] = [];

    for (const depName of entry.requires) {
      if (visited.has(depName)) continue; // cycle guard
      visited.add(depName);

      const depEntry = allEntries.find(e => e.name === depName);
      if (depEntry) {
        deps.push(depEntry);
        // Transitive expansion
        deps.push(...this.expandDependencies(depEntry, allEntries, visited));
      }
    }

    return deps;
  }
}
