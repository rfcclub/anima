import { resolve, join, isAbsolute, sep } from "node:path";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { glob } from "glob";
import { load as parseYaml, CORE_SCHEMA } from "js-yaml";
import { parseSoul } from "./soul-parser";
import type { SoulPart } from "./soul-parser";
import {
  type EvidenceMetadata,
  type ResolvedFile,
  type ResolvedScope,
  type RetrievalRequest,
  type RetrievalResult,
  type ScopeDefinition,
  type SubstrateAdapter,
  type SubstrateSource,
  type TrustLevel,
  type ValidationDiagnostic,
  type ValidationResult,
} from "./substrate-adapter";

export interface SubstrateMapV1 {
  version: number;
  agent_id: string;
  substrate_type: string;
  root: string;
  required_scopes?: string[];
  scopes: Record<string, ScopeConfigV1>;
}

export interface ScopeConfigV1 {
  description: string;
  required?: boolean;
  sources: SourceConfigV1[];
}

export interface SourceConfigV1 {
  type: "paths" | "soul";
  paths: string[];
  trust: TrustLevel;
  weight: number;
  evidence_required?: boolean;
}

export interface MappedFilesystemAdapterOptions {
  mapPath: string;
  rootOverride?: string;
}

export class MappedFilesystemAdapter implements SubstrateAdapter {
  agentId: string;
  substrateType: string;

  private map: SubstrateMapV1;
  private root: string;
  private realRoot: string;
  /** Synthetic content for soul-type sources keyed by synthetic absolutePath. */
  private soulContent = new Map<string, string>();

  constructor(mapContent: string, opts?: MappedFilesystemAdapterOptions) {
    const parsed = JSON.parse(mapContent) as SubstrateMapV1;
    this.map = parsed;
    this.agentId = parsed.agent_id;
    this.substrateType = parsed.substrate_type;
    this.root = resolve(opts?.rootOverride ?? resolveHome(parsed.root));
    this.realRoot = this.resolveRoot();
  }

  /** Resolve root to realpath for traversal checks. */
  private resolveRoot(): string {
    try {
      return realpathSync(this.root);
    } catch {
      return this.root;
    }
  }

  listScopes(): ScopeDefinition[] {
    return Object.entries(this.map.scopes).map(([name, cfg]) => ({
      name,
      description: cfg.description,
      required: cfg.required ?? false,
      sources: (cfg.sources ?? []).map(this.normalizeSource),
    }));
  }

  hasScope(scope: string): boolean {
    return scope in this.map.scopes;
  }

  resolve(scope: string): ResolvedScope {
    // Synchronous callers expect a plain object; security checks happen in retrieve() where async is required.
    const cfg = this.map.scopes[scope];
    if (!cfg) {
      return {
        name: scope,
        description: "",
        required: false,
        files: [],
      };
    }

    const files: ResolvedFile[] = [];
    const sources = cfg.sources ?? []; // a scope shaped without `sources` (e.g. Lena's nocturne) contributes nothing
    for (let i = 0; i < sources.length; i++) {
      const source = this.normalizeSource(sources[i]);
      if (source.type === "soul") {
        files.push(...this.resolveSoulSource(scope, i, source));
        continue;
      }
      for (const p of source.paths) {
        if (!isAllowedPath(p)) {
          console.warn(`[substrate] rejected unsafe path in ${scope}: ${p}`);
          continue;
        }
        const absolute = expandDirectoryPath(join(this.root, p), p);
        const matches = glob.sync(absolute, { nodir: true, realpath: true });
        for (const match of matches) {
          if (!isInsideRootSync(match, this.root)) continue;
          const rel = match.slice(this.realRoot.length + 1);
          if (rel.includes("..") || isAbsolute(rel)) continue;
          files.push({
            absolutePath: match,
            relativePath: rel,
            scope,
            sourceIndex: i,
            trust: source.trust,
            weight: source.weight,
            evidenceRequired: source.evidenceRequired,
          });
        }
      }
    }

    return {
      name: scope,
      description: cfg.description,
      required: cfg.required ?? false,
      files,
    };
  }

  private resolveSoulSource(scope: string, sourceIndex: number, source: SubstrateSource): ResolvedFile[] {
    const files: ResolvedFile[] = [];
    for (const p of source.paths) {
      if (!isAllowedPath(p)) {
        console.warn(`[substrate] rejected unsafe soul path in ${scope}: ${p}`);
        continue;
      }
      const absolute = join(this.root, p);
      let content: string;
      try {
        content = readFileSync(absolute, "utf-8");
      } catch (err) {
        console.warn(`[substrate] could not read soul file ${absolute}: ${err}`);
        continue;
      }
      const parts = parseSoul(content);
      for (const part of parts) {
        const id = `soul://${absolute}#${part.scope}`;
        this.soulContent.set(id, part.content);
        files.push({
          absolutePath: id,
          relativePath: `${part.scope}.md`,
          scope: part.scope,
          sourceIndex,
          trust: source.trust,
          weight: source.weight,
          evidenceRequired: source.evidenceRequired,
        });
      }
    }
    return files;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult[]> {
    const byPath = new Map<string, RetrievalResult>();
    const statusOrder: Record<string, number> = {
      error: 4,
      unsupported_source: 3,
      missing_scope: 2,
      empty: 1,
      ok: 0,
    };

    for (const scope of request.scopes) {
      if (!this.hasScope(scope)) {
        const id = `missing:${scope}`;
        byPath.set(id, {
          id,
          absolutePath: "",
          relativePath: "",
          content: "",
          scopesMatched: [],
          sourceIds: [],
          requestedBy: [],
          trust: "low",
          weight: 0,
          status: "missing_scope",
        });
        continue;
      }

      const resolved = this.resolve(scope);
      if (resolved.files.length === 0) {
        const id = `empty:${scope}`;
        const existing = byPath.get(id);
        if (!existing || statusOrder.empty > statusOrder[existing.status]) {
          byPath.set(id, {
            id,
            absolutePath: "",
            relativePath: "",
            content: "",
            scopesMatched: [scope],
            sourceIds: [],
            requestedBy: [],
            trust: "low",
            weight: 0,
            status: "empty",
          });
        }
        continue;
      }

      for (const file of resolved.files) {
        const existing = byPath.get(file.absolutePath);
        if (existing) {
          if (!existing.scopesMatched.includes(scope)) {
            existing.scopesMatched.push(scope);
          }
          existing.weight = Math.max(existing.weight, file.weight);
          existing.trust = higherTrust(existing.trust, file.trust);
          continue;
        }

        try {
          let content: string;
          if (file.absolutePath.startsWith("soul://")) {
            content = this.soulContent.get(file.absolutePath) ?? "";
          } else {
            content = await Bun.file(file.absolutePath).text();
          }
          const evidence = file.evidenceRequired
            ? await extractEvidence(content, file.absolutePath)
            : undefined;

          byPath.set(file.absolutePath, {
            id: file.absolutePath,
            absolutePath: file.absolutePath,
            relativePath: file.relativePath,
            content,
            scopesMatched: [scope],
            sourceIds: [`${scope}:${file.sourceIndex}`],
            requestedBy: [],
            trust: file.trust,
            weight: file.weight,
            evidence,
            status: "ok",
          });
        } catch (err) {
          const id = `error:${file.absolutePath}`;
          byPath.set(id, {
            id,
            absolutePath: file.absolutePath,
            relativePath: file.relativePath,
            content: String(err),
            scopesMatched: [scope],
            sourceIds: [`${scope}:${file.sourceIndex}`],
            requestedBy: [],
            trust: file.trust,
            weight: file.weight,
            status: "error",
          });
        }
      }
    }

    const results = Array.from(byPath.values());
    if (request.requireEvidence) {
      return results.filter(
        (r) => r.status !== "ok" || r.evidence !== undefined || r.content.length === 0
      );
    }
    return results;
  }

  validateMap(): ValidationResult {
    const diagnostics: ValidationDiagnostic[] = [];
    let valid = true;

    if (this.map.version !== 1) {
      diagnostics.push({
        path: "version",
        code: "unsupported_version",
        severity: "error",
        message: `Expected version 1, got ${this.map.version}`,
      });
      valid = false;
    }

    if (!this.map.agent_id) {
      diagnostics.push({
        path: "agent_id",
        code: "missing_agent_id",
        severity: "error",
        message: "agent_id is required",
      });
      valid = false;
    }

    if (!this.map.substrate_type) {
      diagnostics.push({
        path: "substrate_type",
        code: "missing_substrate_type",
        severity: "error",
        message: "substrate_type is required",
      });
      valid = false;
    }

    if (!this.map.root) {
      diagnostics.push({
        path: "root",
        code: "missing_root",
        severity: "error",
        message: "root is required",
      });
      valid = false;
    }

    const required = this.map.required_scopes ?? [];
    for (const rs of ["identity_core", "current_state"]) {
      if (!required.includes(rs)) {
        diagnostics.push({
          path: `required_scopes`,
          code: "missing_required_runtime_scope",
          severity: "error",
          message: `Runtime-required scope ${rs} must be in required_scopes`,
        });
        valid = false;
      }
      if (!(rs in this.map.scopes)) {
        diagnostics.push({
          path: `scopes.${rs}`,
          code: "missing_scope_definition",
          severity: "error",
          message: `Runtime-required scope ${rs} must be defined in scopes`,
        });
        valid = false;
      }
    }

    for (const rs of required) {
      if (!(rs in this.map.scopes)) {
        diagnostics.push({
          path: `scopes.${rs}`,
          code: "required_scope_undefined",
          severity: "error",
          message: `Required scope ${rs} is not defined in scopes`,
        });
        valid = false;
      }
    }

    for (const [name, cfg] of Object.entries(this.map.scopes)) {
      if (!cfg.sources || cfg.sources.length === 0) {
        diagnostics.push({
          path: `scopes.${name}.sources`,
          code: "empty_sources",
          severity: "error",
          message: `Scope ${name} must have at least one source`,
        });
        valid = false;
        continue;
      }

      for (let i = 0; i < cfg.sources.length; i++) {
        const source = cfg.sources[i];
        const prefix = `scopes.${name}.sources[${i}]`;

        if (source.type !== "paths" && source.type !== "soul") {
          diagnostics.push({
            path: `${prefix}.type`,
            code: "unsupported_source_type",
            severity: "warning",
            message: `Source type ${source.type} is reserved but not supported in v1`,
          });
          continue;
        }

        if (!source.paths || source.paths.length === 0) {
          diagnostics.push({
            path: `${prefix}.paths`,
            code: "empty_paths",
            severity: "error",
            message: `paths source must have at least one path`,
          });
          valid = false;
        }

        if (!["low", "medium", "high"].includes(source.trust)) {
          diagnostics.push({
            path: `${prefix}.trust`,
            code: "invalid_trust",
            severity: "error",
            message: `trust must be low, medium, or high`,
          });
          valid = false;
        }

        if (typeof source.weight !== "number" || source.weight < 0 || source.weight > 1) {
          diagnostics.push({
            path: `${prefix}.weight`,
            code: "invalid_weight",
            severity: "error",
            message: `weight must be a number between 0.0 and 1.0`,
          });
          valid = false;
        }

        if (source.evidence_required) {
          diagnostics.push({
            path: `${prefix}.evidence_required`,
            code: "evidence_without_provider",
            severity: "warning",
            message: `evidence_required is true; ensure source provides provenance/confidence metadata`,
          });
        }
      }
    }

    return { valid, diagnostics };
  }

  private normalizeSource(source: SourceConfigV1): SubstrateSource {
    return {
      type: source.type,
      paths: source.paths,
      trust: source.trust,
      weight: source.weight,
      evidenceRequired: source.evidence_required ?? false,
    };
  }
}

const GLOB_CHARS = /[*?{}[\]]/;

/**
 * A bare directory path (e.g. "0_SOUL/", no glob metacharacters) matches
 * nothing under glob.sync's { nodir: true } — the directory entry itself
 * gets filtered out and nothing recurses into it. Source maps declare
 * whole directories to mean "this whole area of substrate" (see the
 * substrate-view-layer archived intent's original `substrate/0_SOUL` example),
 * so expand such paths into a recursive glob.
 */
function expandDirectoryPath(absolute: string, originalPath: string): string {
  if (GLOB_CHARS.test(originalPath)) return absolute;
  try {
    if (statSync(absolute).isDirectory()) {
      return join(absolute, "**", "*");
    }
  } catch {
    // literal path doesn't exist on disk; let glob.sync report zero matches
  }
  return absolute;
}

function isAllowedPath(p: string): boolean {
  if (isAbsolute(p)) return false;
  const parts = p.split(/[\\/]/);
  return !parts.some((part) => part === ".." || part.startsWith("../") || part === "~");
}

function isInsideRootSync(match: string, root: string): boolean {
  try {
    const realMatch = realpathSync(match);
    const realRoot = realpathSync(root);
    const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
    return realMatch === realRoot || realMatch.startsWith(prefix);
  } catch {
    return false;
  }
}

function resolveHome(input: string): string {
  if (input.startsWith("~/")) {
    return join(process.env.HOME ?? "/", input.slice(2));
  }
  return input;
}

function higherTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  const order: TrustLevel[] = ["low", "medium", "high"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

async function extractEvidence(content: string, path: string): Promise<EvidenceMetadata | undefined> {
  const frontmatter = parseFrontmatter(content);
  if (frontmatter) {
    return {
      confidence: frontmatter.confidence,
      provenance: frontmatter.provenance ?? path,
      episodeId: frontmatter.episode_id,
      sourceLink: frontmatter.source_link,
      parentMemoryId: frontmatter.parent_memory_id,
    };
  }

  const sidecarPath = `${path}.meta.json`;
  try {
    const raw = await Bun.file(sidecarPath).text();
    const sidecar = JSON.parse(raw);
    return {
      confidence: sidecar.confidence,
      provenance: sidecar.provenance ?? path,
      episodeId: sidecar.episode_id,
      sourceLink: sidecar.source_link,
      parentMemoryId: sidecar.parent_memory_id,
    };
  } catch {
    return undefined;
  }
}

function parseFrontmatter(content: string): Record<string, any> | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("---", 3);
  if (end === -1) return undefined;
  const yamlBlock = content.slice(3, end);
  try {
    const parsed = parseYaml(yamlBlock, { schema: CORE_SCHEMA });
    if (parsed === null || parsed === undefined) return undefined;
    if (typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, any>;
    return undefined;
  } catch {
    return undefined;
  }
}
