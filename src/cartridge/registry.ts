import { join } from "node:path";
import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import yaml from "js-yaml";
import { CARTRIDGE_CATEGORIES } from "./loader";
import type { CartridgeCategory } from "./loader";
import type { MemoryScope } from "../memory/contract";
import {
  isCanonicalSubstrateScope,
  type CanonicalSubstrateScope,
} from "../identity-runtime/contract/scope-mapper.ts";
import { CARTRIDGE_KINDS } from "./types";
import type { CartridgeMemoryPolicy, CartridgeKind, RetrievalPolicy } from "./types";
import { estimateTokens } from "../utils/tokens";
export { estimateTokens };

export type CartridgeScope = "shared" | "agent" | "pluggable" | "dynamic";

export interface CartridgeEntry {
  category: CartridgeCategory;
  kind?: CartridgeKind;
  name: string;
  path: string;
  content: string;
  scope: CartridgeScope;
  guides?: string[];
  rules?: string[];
  /** @deprecated Use guides/rules instead. Legacy fallback — treated as guides. */
  skills?: string[];
  requires?: string[];
  conflicts?: string[];
  priority?: number;
  persona?: string;
  retrieval?: RetrievalPolicy;
  triggers?: { task?: string[]; mode?: string[] };
  budgetTokens?: number;
  memory?: CartridgeMemoryPolicy;
}

export interface CartridgeRegistryOptions {
  projectRoot: string;
  /** Global root — defaults to ~/.anima */
  globalRoot?: string;
  /** Colony-wide root — defaults to ~/agora */
  colonyRoot?: string;
}

export class CartridgeRegistry {
  private readonly projectRoot: string;
  private readonly globalRoot: string;
  private readonly colonyRoot: string;

  constructor(optionsOrRoot: CartridgeRegistryOptions | string) {
    if (typeof optionsOrRoot === "string") {
      this.projectRoot = optionsOrRoot;
    } else {
      this.projectRoot = optionsOrRoot.projectRoot;
    }
    const globalRoot = typeof optionsOrRoot === "object" ? optionsOrRoot.globalRoot : undefined;
    this.globalRoot = globalRoot ?? join(homedir(), ".anima");
    const colonyRoot = typeof optionsOrRoot === "object" ? optionsOrRoot.colonyRoot : undefined;
    this.colonyRoot = colonyRoot ?? join(homedir(), "agora");
  }

  // mtime-keyed caches to avoid re-reading disk every turn
  private readonly entryCache = new Map<string, { mtime: number; entry: CartridgeEntry | null }>();
  private readonly skillCache = new Map<string, { mtime: number; content: string | null }>();

  async list(agentName: string, scopes?: CartridgeScope[]): Promise<CartridgeEntry[]> {
    const seen = new Map<string, CartridgeEntry>(); // key = name+category, higher priority wins

    const addAll = (newEntries: CartridgeEntry[]) => {
      for (const e of newEntries) {
        seen.set(`${e.name}:${e.category}`, e); // later calls (higher priority) overwrite
      }
    };

    // 0. Colony tier (lowest priority)
    addAll(await this.scanTier(this.colonyRoot, null, scopes));

    // 1. Global tier
    addAll(await this.scanTier(this.globalRoot, null, scopes));

    // 2. Project tier
    addAll(await this.scanTier(this.projectRoot, null, scopes));

    // 3. Agent-specific (highest priority)
    if (!scopes || scopes.includes("agent")) {
      const agentDir = join(this.projectRoot, "rooms", agentName, "cartridges");
      addAll(await this.scanDir(agentDir, "agent"));
    }

    return [...seen.values()];
  }

  async resolve(agentName: string, category: CartridgeCategory, name: string): Promise<CartridgeEntry | null> {
    const entries = await this.list(agentName);
    return entries.find(e => e.category === category && e.name === name) ?? null;
  }

  /** Expand a cartridge by inlining referenced skills before the cartridge body.
   *  Guides (or legacy skills) come first, then rules, then persona, then body. */
  async expand(entry: CartridgeEntry): Promise<string> {
    const hasGuides = entry.guides?.length;
    const hasRules = entry.rules?.length;
    const hasLegacySkills = entry.skills?.length;
    const hasPersona = entry.persona;

    if (!hasGuides && !hasRules && !hasLegacySkills && !hasPersona) return entry.content;

    const parts: string[] = [];

    // Guides (generation-time content)
    const guideNames = entry.guides ?? [];
    for (const skillName of guideNames) {
      const content = await this.readSkill(skillName);
      if (content) {
        parts.push(content);
      } else {
        console.warn(`[cartridge] ${entry.name}: guide "${skillName}" not found — skipped`);
      }
    }

    // Legacy skills fallback — treated as guides (design decision D5)
    if (!entry.guides?.length && entry.skills?.length) {
      for (const skillName of entry.skills) {
        const content = await this.readSkill(skillName);
        if (content) {
          parts.push(content);
        } else {
          console.warn(`[cartridge] ${entry.name}: skill "${skillName}" not found — skipped`);
        }
      }
    }

    // Rules (review-time content)
    if (entry.rules?.length) {
      for (const skillName of entry.rules) {
        const content = await this.readSkill(skillName);
        if (content) {
          parts.push(content);
        } else {
          console.warn(`[cartridge] ${entry.name}: rule "${skillName}" not found — skipped`);
        }
      }
    }

    // Persona block
    if (hasPersona) {
      parts.push(entry.persona!);
    }

    parts.push(entry.content);
    return parts.join("\n\n---\n\n");
  }

  async budgetCheck(entry: CartridgeEntry): Promise<{ over: boolean; estimate: number; budget: number }> {
    const expanded = await this.expand(entry);
    const estimate = estimateTokens(expanded);
    const budget = entry.budgetTokens ?? 5000;
    return { over: estimate > budget, estimate, budget };
  }

  /** Read a skill file from the skills/ directories (project, global, colony).
   *  Returns content after the YAML frontmatter, or null if not found/unreadable. */
  async readSkill(name: string): Promise<string | null> {
    // Search project first, then global, then colony
    for (const root of [this.projectRoot, this.globalRoot, this.colonyRoot]) {
      const path = join(root, "skills", `${name}.md`);
      if (!existsSync(path)) continue;
      try {
        const mtime = (await stat(path)).mtimeMs;
        const cached = this.skillCache.get(path);
        if (cached && cached.mtime === mtime) {
          return cached.content;
        }
        const raw = await readFile(path, "utf8");
        const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        const content = match ? match[1].trim() : null;
        this.skillCache.set(path, { mtime, content });
        return content;
      } catch { /* ignore */ }
    }
    return null;
  }

  private async scanTier(root: string, _agentName: string | null, scopes?: CartridgeScope[]): Promise<CartridgeEntry[]> {
    const entries: CartridgeEntry[] = [];

    const dirs: Array<[string, CartridgeScope]> = [
      [join(root, "cartridges", "shared"), "shared"],
      [join(root, "cartridges", "pluggable"), "pluggable"],
      [join(root, "cartridges", "dynamic"), "pluggable"],  // legacy
    ];

    for (const [dir, scope] of dirs) {
      if (scopes && !scopes.includes(scope)) continue;
      entries.push(...await this.scanDir(dir, scope));
    }

    return entries;
  }

  private async scanDir(dir: string, scope: CartridgeScope): Promise<CartridgeEntry[]> {
    if (!existsSync(dir)) return [];
    try {
      const files = await readdir(dir);
      const results: CartridgeEntry[] = [];
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const path = join(dir, file);
        const mtime = (await stat(path)).mtimeMs;
        const cached = this.entryCache.get(path);
        if (cached && cached.mtime === mtime) {
          if (cached.entry) results.push(cached.entry);
          continue;
        }
        const entry = await this.parseFile(path, scope);
        this.entryCache.set(path, { mtime, entry });
        if (entry) results.push(entry);
      }
      return results;
    } catch {
      return [];
    }
  }

  private async parseFile(path: string, scope: CartridgeScope): Promise<CartridgeEntry | null> {
    try {
      const raw = await readFile(path, "utf8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) return null;

      const frontmatter = yaml.load(match[1]) as Record<string, unknown>;
      if (!frontmatter || typeof frontmatter.category !== "string" || typeof frontmatter.name !== "string") {
        console.warn(`[cartridge] ${path}: missing required frontmatter (category/name) — skipped`);
        return null;
      }

      const category = frontmatter.category;
      if (!CARTRIDGE_CATEGORIES.includes(category as CartridgeCategory)) {
        console.warn(`[cartridge] ${path}: invalid category "${category}" — skipped`);
        return null;
      }

      let kind: CartridgeKind | undefined;
      if (typeof frontmatter.kind === "string") {
        if (CARTRIDGE_KINDS.includes(frontmatter.kind as CartridgeKind)) {
          kind = frontmatter.kind as CartridgeKind;
        } else {
          console.warn(`[cartridge] ${path}: invalid kind "${frontmatter.kind}" — skipped`);
          return null;
        }
      }
      const guides = Array.isArray(frontmatter.guides) ? (frontmatter.guides as string[]) : undefined;
      const rules = Array.isArray(frontmatter.rules) ? (frontmatter.rules as string[]) : undefined;
      const skills = Array.isArray(frontmatter.skills) ? (frontmatter.skills as string[]) : undefined;
      const requires = Array.isArray(frontmatter.requires) ? (frontmatter.requires as string[]) : undefined;
      const conflicts = Array.isArray(frontmatter.conflicts) ? (frontmatter.conflicts as string[]) : undefined;
      const priority = typeof frontmatter.priority === "number" ? frontmatter.priority : undefined;
      const persona = typeof frontmatter.persona === "string" ? frontmatter.persona : undefined;
      const rawRetrieval = frontmatter.retrieval as Record<string, unknown> | undefined;
      const rawSubstrateScopes = rawRetrieval?.substrate_scopes;
      if (rawSubstrateScopes !== undefined && (
        !Array.isArray(rawSubstrateScopes)
        || !rawSubstrateScopes.every((scope): scope is string => typeof scope === "string" && isCanonicalSubstrateScope(scope))
      )) {
        console.warn(`[cartridge] ${path}: invalid retrieval.substrate_scopes — skipped`);
        return null;
      }
      const retrieval = rawRetrieval && (Array.isArray(rawRetrieval.scopes) || Array.isArray(rawSubstrateScopes)) ? {
        scopes: Array.isArray(rawRetrieval.scopes) ? rawRetrieval.scopes as MemoryScope[] : undefined,
        substrate_scopes: Array.isArray(rawSubstrateScopes)
          ? rawSubstrateScopes as CanonicalSubstrateScope[]
          : undefined,
        top_k: typeof rawRetrieval.top_k === "number" ? rawRetrieval.top_k : undefined,
        max_tokens: typeof rawRetrieval.max_tokens === "number" ? rawRetrieval.max_tokens : undefined,
        require_evidence: typeof rawRetrieval.require_evidence === "boolean" ? rawRetrieval.require_evidence : undefined,
        allow_unverified_fallback: typeof rawRetrieval.allow_unverified_fallback === "boolean" ? rawRetrieval.allow_unverified_fallback : undefined,
      } : undefined;
      const rawTriggers = frontmatter.triggers as Record<string, unknown> | undefined;
      const triggers = rawTriggers ? {
        task: Array.isArray(rawTriggers.task) ? rawTriggers.task as string[] : undefined,
        mode: Array.isArray(rawTriggers.mode) ? rawTriggers.mode as string[] : undefined,
      } : undefined;
      const budgetTokens = typeof frontmatter.budget_tokens === "number" ? frontmatter.budget_tokens : undefined;
      const rawMemory = frontmatter.memory as Record<string, unknown> | undefined;
      const memory = rawMemory && Array.isArray(rawMemory.write_scopes)
        ? { writeScopes: rawMemory.write_scopes as MemoryScope[] }
        : undefined;

      return {
        category: category as CartridgeCategory,
        kind,
        name: frontmatter.name as string,
        path,
        content: match[2].trim(),
        scope,
        guides,
        rules,
        skills,
        requires,
        conflicts,
        priority,
        persona,
        retrieval,
        triggers,
        budgetTokens,
        memory,
      };
    } catch {
      return null;
    }
  }
}

export const LOCKED_WRITE_SCOPES: readonly string[] = ["identity", "private", "heartwood"];

export function validateEntry(entry: CartridgeEntry): string[] {
  const errors: string[] = [];
  const locked = entry.memory?.writeScopes.filter((s) => LOCKED_WRITE_SCOPES.includes(s)) ?? [];
  if (locked.length > 0) {
    errors.push(`declares locked write scopes: ${locked.join(", ")}`);
  }
  return errors;
}
