import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { glob } from "glob";
import { load as parseYaml } from "js-yaml";
import type { TrustLevel } from "../substrate/substrate-adapter";

/**
 * On-demand substrate loading for a client that does not share this host.
 *
 * The projection carries virtual ids (`<agent>/<path relative to the substrate
 * root>`), never real paths. This port turns those ids back into content, and
 * is the only way a remote client may read a substrate file: a file the
 * substrate map does not declare, or one whose resolved path leaves the
 * declared root, is refused.
 */

export interface SubstrateMappingEntry {
  /** `<agent>/<path relative to the substrate root>`; the only name a client sees. */
  id: string;
  scope: string;
  trust: TrustLevel;
  /** Bytes on disk at mapping time; a hint for the client's own budgeting. */
  size: number;
}

export interface SubstrateFile {
  id: string;
  scope: string;
  trust: TrustLevel;
  content: string;
}

export interface SubstrateLoaderPort {
  /** The virtual mapping: declared files only, no absolute path, no root. */
  mapping(): Promise<SubstrateMappingEntry[]>;
  /** One declared file by virtual id, after a containment check. */
  load(id: string): Promise<SubstrateFile>;
}

export interface MappedSubstrateLoaderOptions {
  mapContent: string;
  /** Test-only override; defaults to the map's own root. */
  rootOverride?: string;
}

/** A single load is bounded so one request cannot stream an arbitrary file. */
export const MAX_SUBSTRATE_LOAD_BYTES = 256 * 1024;

interface DeclaredPath {
  scope: string;
  trust: TrustLevel;
  pattern: string;
}

interface SubstrateMapShape {
  agent_id: string;
  root: string;
  scopes: Record<string, { sources?: Array<{ type: string; paths?: string[]; trust: TrustLevel }> }>;
}

const GLOB_CHARS = /[*?{}[\]]/;

export function mappedSubstrateLoader(options: MappedSubstrateLoaderOptions): SubstrateLoaderPort {
  const map = parseMap(options.mapContent);
  const agentId = map.agent_id;
  const root = resolve(options.rootOverride ?? resolveHome(map.root));
  const realRoot = safeRealpath(root);
  const declared = declaredPaths(map);
  const mappingCache = new Map<string, { scope: string; trust: TrustLevel }>();
  /** Declared paths whose resolved target leaves the root: named, but never listed or served. */
  const escaped = new Set<string>();

  /**
   * Resolve one declared pattern to the files it names under the root. Each
   * match keeps its matched path (the id the map declares) and its realpath
   * (the containment check), because a symlink can differ between the two.
   */
  const expand = (pattern: string): Array<{ matched: string; real: string }> => {
    if (isAbsolute(pattern) || hasTraversal(pattern)) return [];
    const absolute = join(root, pattern);
    const target = GLOB_CHARS.test(pattern) ? absolute : expandDirectory(absolute);
    return glob.sync(target, { nodir: true, absolute: true })
      .map((matched) => ({ matched, real: safeRealpath(matched) }));
  };

  const refreshMapping = (): void => {
    mappingCache.clear();
    escaped.clear();
    for (const entry of declared) {
      for (const { matched, real } of expand(entry.pattern)) {
        const matchedRelative = relativeTo(matched, root);
        if (!matchedRelative) continue;
        const id = `${agentId}/${matchedRelative}`;
        if (!isInside(real, realRoot)) {
          // A declared path that resolves outside the root (`..` through a
          // symlink, a mount): record it so load() refuses loudly instead of
          // reporting it as merely undeclared.
          escaped.add(id);
          continue;
        }
        // A file declared by several scopes keeps the first (map order) scope, the highest trust.
        const existing = mappingCache.get(id);
        mappingCache.set(id, existing
          ? { scope: existing.scope, trust: higherTrust(existing.trust, entry.trust) }
          : { scope: entry.scope, trust: entry.trust });
      }
    }
  };

  return {
    async mapping() {
      refreshMapping();
      return [...mappingCache.entries()]
        .map(([id, meta]) => ({ id, scope: meta.scope, trust: meta.trust, size: sizeOf(join(realRoot, id.slice(agentId.length + 1))) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async load(id) {
      refreshMapping();
      const meta = mappingCache.get(id);
      if (!meta) {
        // Declared by the map but resolving elsewhere (symlink, mount): the
        // real file is not the one the map meant, so refuse.
        if (escaped.has(id)) throw new Error(`substrate file escapes the substrate root: ${id}`);
        throw new Error(`substrate file is not declared: ${id}`);
      }
      const absolute = safeRealpath(join(realRoot, id.slice(agentId.length + 1)));
      if (!isInside(absolute, realRoot)) throw new Error(`substrate file escapes the substrate root: ${id}`);
      const size = sizeOf(absolute);
      if (size > MAX_SUBSTRATE_LOAD_BYTES) {
        throw new Error(`substrate file exceeds ${MAX_SUBSTRATE_LOAD_BYTES} bytes: ${id}`);
      }
      return { id, scope: meta.scope, trust: meta.trust, content: await Bun.file(absolute).text() };
    },
  };
}

/**
 * The mapping a compile needs to rewrite real paths: virtual id lookup by the
 * real path a projection mentions. Rebuilt per compile, so it always follows
 * the substrate map on disk.
 */
export interface SubstratePathRewriter {
  /** The virtual id for a real path, or undefined when the map does not declare it. */
  virtualIdFor(realPath: string): string | undefined;
}

export function buildPathRewriter(
  loader: SubstrateLoaderPort,
  agentId: string,
  substrateRoot: string,
): Promise<SubstratePathRewriter> {
  return loader.mapping().then((entries) => {
    const realRoot = safeRealpath(resolve(substrateRoot));
    const byPath = new Map(entries.map((entry) => [
      safeRealpath(join(realRoot, entry.id.slice(agentId.length + 1))),
      entry.id,
    ]));
    return {
      virtualIdFor(realPath: string): string | undefined {
        const absolute = safeRealpath(resolve(realPath));
        return byPath.get(absolute);
      },
    };
  });
}

function parseMap(mapContent: string): SubstrateMapShape {
  const trimmed = mapContent.trimStart();
  if (!trimmed.startsWith("{")) {
    const parsed = parseYaml(mapContent) as SubstrateMapShape;
    if (!parsed || typeof parsed !== "object") throw new Error("substrate map is not an object");
    return parsed;
  }
  const parsed = JSON.parse(mapContent) as SubstrateMapShape;
  if (!parsed || typeof parsed !== "object") throw new Error("substrate map is not an object");
  return parsed;
}

function declaredPaths(map: SubstrateMapShape): DeclaredPath[] {
  const result: DeclaredPath[] = [];
  if (!map.agent_id) throw new Error("substrate map agent_id is required");
  for (const [scope, config] of Object.entries(map.scopes ?? {})) {
    for (const source of config.sources ?? []) {
      for (const pattern of source.paths ?? []) {
        if (isAbsolute(pattern) || hasTraversal(pattern)) continue;
        result.push({ scope, trust: source.trust ?? "low", pattern });
      }
    }
  }
  return result;
}

function expandDirectory(absolute: string): string {
  try {
    if (statSync(absolute).isDirectory()) return join(absolute, "**", "*");
  } catch {
    // A literal path that does not exist resolves to nothing.
  }
  return absolute;
}

function hasTraversal(pattern: string): boolean {
  return pattern.split(/[\\/]/).some((part) => part === ".." || part === "~");
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A path that does not exist cannot be inside the root; return it unchanged
    // so every containment check still refuses it.
    return path;
  }
}

function relativeTo(absolute: string, root: string): string | undefined {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : undefined;
}

function isInside(absolute: string, root: string): boolean {
  return absolute === root || absolute.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function higherTrust(a: TrustLevel | undefined, b: TrustLevel): TrustLevel {
  const order: TrustLevel[] = ["low", "medium", "high"];
  if (!a) return b;
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

function resolveHome(input: string): string {
  if (input.startsWith("~/")) return join(process.env.HOME ?? "/", input.slice(2));
  return input;
}
