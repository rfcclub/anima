/**
 * Agent Skills discovery (agentskills.io). A skill is a directory holding a `SKILL.md` with YAML
 * frontmatter and optional `scripts/`, `references/` and `assets/` bundles. Skill content is untrusted
 * input: it never widens permissions, project roots load only when trusted, and nothing is fetched at runtime.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import yaml from "js-yaml";

export type SkillSource = "project" | "user";

/** A location to scan. Project roots are loaded only from trusted workspaces; user roots are trusted. */
export interface SkillRoot {
  root: string;
  source: SkillSource;
  trusted?: boolean;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Free-form map. `metadata` is preserved verbatim. */
  metadata?: Record<string, unknown>;
  /** Experimental `allowed-tools`. Advisory only — the host decides whether it maps to its permission model. */
  allowedTools?: string[];
}

export interface SkillResource {
  /** Path relative to the skill directory, using forward slashes. Listed, never read on activation. */
  path: string;
}

export interface Skill {
  /** The validated `name` (equals the directory name). */
  name: string;
  /** The directory name the skill was found under. */
  slug: string;
  description: string;
  frontmatter: SkillFrontmatter;
  /** The `SKILL.md` body after the frontmatter — loaded only on activation. */
  body: string;
  /** Absolute path to `SKILL.md`. */
  path: string;
  /** Absolute path to the skill directory. */
  dir: string;
  source: SkillSource;
  /** Bundled files under `scripts/`, `references/`, `assets/`, listed but not read. */
  resources: SkillResource[];
}

export interface SkippedSkill {
  path: string;
  reason: string;
}

export interface SkillCollision {
  name: string;
  winner: SkillSource;
  loser: SkillSource;
}

export interface DiscoveryResult {
  skills: Skill[];
  skipped: SkippedSkill[];
  collisions: SkillCollision[];
}

/** Documented precedence: project before user. Lower rank wins a name collision. */
const PRECEDENCE: Record<SkillSource, number> = { project: 0, user: 1 };

/** `name`: 1-64 chars, lowercase letters, digits and single hyphens; no leading/trailing/double hyphen. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_COMPATIBILITY = 500;
const RESOURCE_DIRS = ["scripts", "references", "assets"] as const;

/** Quotes a scalar value that contains an unquoted colon so the lenient guide's example parses. */
function repairLenientYaml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*)([A-Za-z0-9_-]+):(\s+)(.+)$/);
      if (!match) return line;
      const [, indent, key, sep, value] = match;
      const trimmed = value.trim();
      if (!trimmed.includes(":")) return line;
      // Leave already-quoted or structured values (flow, block scalars) untouched.
      if (/^["'[{|>]/.test(trimmed)) return line;
      return `${indent}${key}:${sep}${JSON.stringify(trimmed)}`;
    })
    .join("\n");
}

/** Parse the frontmatter, first strictly and then leniently for unquoted colons. Throws if both fail. */
function parseFrontmatter(yamlText: string): unknown {
  try {
    return yaml.load(yamlText);
  } catch {
    return yaml.load(repairLenientYaml(yamlText));
  }
}

function splitFrontmatter(raw: string): { yamlText: string; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  return { yamlText: match[1]!, body: match[2]!.trim() };
}

async function collectResources(dir: string): Promise<SkillResource[]> {
  const found: string[] = [];
  for (const sub of RESOURCE_DIRS) {
    const base = join(dir, sub);
    if (!existsSync(base)) continue;
    await walk(base, sub, found);
  }
  return found.sort().map((path) => ({ path }));
}

async function walk(absDir: string, relDir: string, out: string[]): Promise<void> {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(join(absDir, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/** Validate one skill directory. Returns the skill, or a skip reason. */
async function readSkill(dir: string, source: SkillSource): Promise<{ skill: Skill } | { reason: string; path: string }> {
  const path = join(dir, "SKILL.md");
  if (!existsSync(path)) return { reason: "no SKILL.md", path };

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return { reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`, path };
  }

  const split = splitFrontmatter(raw);
  if (!split) return { reason: "missing frontmatter", path };

  let parsed: unknown;
  try {
    parsed = parseFrontmatter(split.yamlText);
  } catch (error) {
    return { reason: `malformed YAML: ${error instanceof Error ? error.message : String(error)}`, path };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: "frontmatter is not a mapping", path };
  }

  const fm = parsed as Record<string, unknown>;
  const slug = basename(dir);

  const name = fm.name;
  if (typeof name !== "string" || name.length === 0) {
    return { reason: "missing required field: name", path };
  }
  if (name.length > MAX_NAME || !NAME_PATTERN.test(name)) {
    return { reason: `invalid name "${name}" (1-64 chars, lowercase letters, digits, single hyphens)`, path };
  }
  if (name !== slug) {
    return { reason: `name "${name}" does not match directory "${slug}"`, path };
  }

  const description = fm.description;
  if (typeof description !== "string" || description.length === 0) {
    return { reason: "missing required field: description", path };
  }
  if (description.length > MAX_DESCRIPTION) {
    return { reason: `description too long (${description.length} > ${MAX_DESCRIPTION})`, path };
  }

  const license = typeof fm.license === "string" ? fm.license : undefined;
  const compatibility = typeof fm.compatibility === "string" ? fm.compatibility : undefined;
  if (compatibility && compatibility.length > MAX_COMPATIBILITY) {
    return { reason: `compatibility too long (${compatibility.length} > ${MAX_COMPATIBILITY})`, path };
  }

  const metadata =
    fm.metadata && typeof fm.metadata === "object" && !Array.isArray(fm.metadata)
      ? (fm.metadata as Record<string, unknown>)
      : undefined;

  const rawAllowed = fm["allowed-tools"];
  const allowedTools = Array.isArray(rawAllowed)
    ? rawAllowed.filter((t): t is string => typeof t === "string")
    : typeof rawAllowed === "string"
      ? rawAllowed.split(/\s+/).filter(Boolean)
      : undefined;

  const frontmatter: SkillFrontmatter = { name, description };
  if (license !== undefined) frontmatter.license = license;
  if (compatibility !== undefined) frontmatter.compatibility = compatibility;
  if (metadata !== undefined) frontmatter.metadata = metadata;
  if (allowedTools !== undefined) frontmatter.allowedTools = allowedTools;

  return {
    skill: {
      name,
      slug,
      description,
      frontmatter,
      body: split.body,
      path,
      dir,
      source,
      resources: await collectResources(dir),
    },
  };
}

/**
 * Discover skills across roots. Roots are visited in precedence order (project, then user) regardless of the
 * order they are passed, so a name collision resolves deterministically and the loser is reported.
 */
export async function discoverSkills(roots: SkillRoot[]): Promise<DiscoveryResult> {
  const skills: Skill[] = [];
  const skipped: SkippedSkill[] = [];
  const collisions: SkillCollision[] = [];
  const byName = new Map<string, Skill>();

  const ordered = [...roots].sort((a, b) => PRECEDENCE[a.source] - PRECEDENCE[b.source]);

  for (const root of ordered) {
    // Project roots are loaded only from trusted workspaces.
    if (root.source === "project" && root.trusted !== true) {
      skipped.push({ path: root.root, reason: "untrusted workspace: project skills not loaded" });
      continue;
    }
    if (!existsSync(root.root)) continue;

    let entries: Dirent[];
    try {
      entries = await readdir(root.root, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: root.root, reason: `unreadable root: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root.root, entry.name);
      const outcome = await readSkill(dir, root.source);
      if ("reason" in outcome) {
        skipped.push({ path: outcome.path, reason: outcome.reason });
        console.warn(`[skill] ${outcome.path}: ${outcome.reason} — skipped`);
        continue;
      }
      const skill = outcome.skill;
      const existing = byName.get(skill.name);
      if (existing) {
        collisions.push({ name: skill.name, winner: existing.source, loser: skill.source });
        console.warn(`[skill] collision on "${skill.name}": ${existing.source} wins over ${skill.source}`);
        continue;
      }
      byName.set(skill.name, skill);
      skills.push(skill);
    }
  }

  return { skills, skipped, collisions };
}
