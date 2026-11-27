import { currentToolBoundary, sandboxToolCommand, sandboxToolEnvironment } from "../web-chat/tool-boundary";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { fileURLToPath } from "node:url";
import {
  ConfigValidationError,
  type RoomConfig,
  loadRoomConfig,
} from "../config/types";
import type { MemoryAdapter } from "../memory/adapter";
import { NullMemoryAdapter } from "../memory/null-adapter";
import { CustomMemoryAdapter } from "../memory/custom-adapter";
import { SharedMemoryAdapter } from "../memory/shared-adapter";
import { withHindsight } from "../memory/hybrid-adapter";
import type { AgentMemoryEntry, AgentMemoryStore } from "../memory/contract";
import { createAgentMemoryStore } from "../memory/store-registry";
import { createBunContextEngine, type BunContextEngine } from "../memory/context-store";
import { loadInvariants, type InvariantsFile } from "../evaluation/invariants";
import { CartridgeRegistry } from "../cartridge/registry";
import { CARTRIDGE_CATEGORIES } from "../cartridge/loader";
import { withHandoffContext } from "../session/handoff";
import { MappedFilesystemAdapter } from "../substrate/mapped-filesystem-adapter";
import { DefaultSubstrateViewLayer } from "../substrate/default-view-layer";
import type { SubstrateAdapter, SubstrateViewLayer } from "../substrate/substrate-adapter";

export interface BootFileContent {
  name: string;
  path: string;
  content: string;
}

export interface SessionContextFile {
  path: string;
  label?: string;
  content: string;
  maxChars?: number;
}

export interface ExtraActionResult {
  label: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LoadedAgent {
  name: string;
  label: string;
  roomDir: string;
  config: RoomConfig;
  geneContent: string;
  soulPath?: string;
  soulContent?: string;
  sessionContextFiles: SessionContextFile[];
  additionalSessionContext?: SessionContextFile[];
  extraActionResults?: ExtraActionResult[];
  sessionStore?: any;
  additionalContent: BootFileContent[];
  memoryAdapter: MemoryAdapter;
  /** AgentMemoryStore instance for cross-session memory. */
  memoryStore?: AgentMemoryStore;
  /** Bootstrap content injected at session start for cross-session continuity. */
  bootstrapContent?: string;
  /** Phase 3: DAG context engine for conversation continuity (lcm_* + anima_context_* tools). */
  contextEngine?: BunContextEngine;
  /** Substrate adapter exposing agent-scoped memory files (SOUL, invariants, etc.). */
  substrateAdapter?: SubstrateAdapter;
  /** Substrate view layer used to assemble scoped context per turn. */
  substrateViewLayer?: SubstrateViewLayer;
}

export class RoomNotFoundError extends Error {
  constructor(name: string) {
    super(`room not found: ${name}`);
    this.name = "RoomNotFoundError";
  }
}

export class SubstrateNotMountedError extends Error {
  constructor(name: string, cause?: unknown) {
    super(`substrate not mounted for room: ${name}`);
    this.name = "SubstrateNotMountedError";
    this.cause = cause;
  }
}

export class ConfigParseError extends Error {
  constructor(name: string, cause: unknown) {
    super(`failed to parse room config for ${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ConfigParseError";
    this.cause = cause;
  }
}

export interface AgentLoaderOptions {
  roomsDir?: string;
  /** Agent source root — defaults to ~/agora/familia. */
  agentSourceDir?: string;
  /** Bruno-specific source root — defaults to ~/substrate. */
  substrateDir?: string;
  log?: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * AgentLoader — loads agent substrate from disk into a fully-resolved LoadedAgent.
 *
 * Given an agent name, the loader reads the room directory's config.yaml,
 * resolves boot files (gene, soul, session context), runs extra actions,
 * loads the memory adapter, bootstraps cross-session memory, and returns a
 * complete LoadedAgent object ready for session execution. Path traversal
 * attacks are prevented by checking that relative boot paths stay within
 * the room directory.
 */
export class AgentLoader {
  private readonly roomsDir: string;
  private readonly agentSourceDir: string;
  private readonly substrateDir: string;
  private readonly log: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;

  constructor(options: AgentLoaderOptions = {}) {
    this.roomsDir = resolve(options.roomsDir ?? process.env.ANIMA_ROOMS_DIR ?? join(process.env.HOME ?? "~", ".anima", "rooms"));
    this.agentSourceDir = resolve(options.agentSourceDir ?? process.env.ANIMA_AGENT_SOURCE_DIR ?? join(process.env.HOME ?? "~", "agora", "familia"));
    this.substrateDir = resolve(options.substrateDir ?? process.env.ANIMA_SUBSTRATE_DIR ?? join(process.env.HOME ?? "~", "substrate"));
    this.log = options.log ?? structuredLog;
  }

  /** Read runtime configuration without executing boot actions or loading substrate and memory. */
  async loadConfig(name: string): Promise<RoomConfig> {
    const configPath = join(this.roomsDir, name, "config.yaml");
    if (!existsSync(configPath)) throw new RoomNotFoundError(name);
    return this.readConfig(name, configPath);
  }

  async loadIdentity(name: string): Promise<{ name: string; label: string }> {
    const { identity } = await this.loadConfig(name);
    return { name: identity.name, label: identity.label };
  }

  async load(name: string): Promise<LoadedAgent> {
    const roomDir = join(this.roomsDir, name);
    const configPath = join(roomDir, "config.yaml");

    if (!existsSync(configPath)) {
      throw new RoomNotFoundError(name);
    }

    const config = await this.readConfig(name, configPath);
    await this.validateCartridgeReferences(config, name);
    const geneContent = await this.readBootFile(name, roomDir, config.boot.gene);
    const soulContent = config.boot.soul
      ? await this.readBootFile(name, roomDir, config.boot.soul)
      : undefined;
    const bootContextFiles = await Promise.all(
      (config.boot.sessionContext ?? []).map((item) => this.readSessionContextFile(name, roomDir, item)),
    );
    // rfcclub/anima#669: after a session reset the agent wrote HANDOFF.md instead of keeping the old
    // conversation; it comes first so continuity survives the truncation of the boot context.
    const sessionContextFiles = await withHandoffContext(roomDir, bootContextFiles);
    const additionalSessionContext = await this.readAdditionalSessionContext(name, roomDir, config);
    const extraActionResults = await this.runExtraActions(config, roomDir);
    const additionalContent = await Promise.all(
      (config.boot.additional ?? []).map(async (path) => ({
        name: path.split("/").at(-1) ?? path,
        path,
        content: await this.readBootFile(name, roomDir, path),
      })),
    );

    const baseMemoryAdapter = await this.loadMemoryAdapter(name, roomDir, config);

    // Populate bootstrapContent from memory adapter if cross-session bootstrap is enabled
    let bootstrapContent: string | undefined;
    if (config.memory?.crossSessionBootstrap) {
      try {
        const bootstrapFn = (baseMemoryAdapter as unknown as { bootstrap?: () => Promise<AgentMemoryEntry[]> }).bootstrap;
        if (typeof bootstrapFn === "function") {
          const entries = await bootstrapFn.call(baseMemoryAdapter);
          if (entries && entries.length > 0) {
            const contentLines = entries.map((e) => `- ${e.content}`).join("\n");
            bootstrapContent = contentLines;
          }
        }
      } catch (err) {
        this.log("warn", "memory bootstrap failed", { agent: name, error: String(err) });
      }
    }

    // Pilot: optional recall-only Hindsight leg beside the normal adapter. Bootstrap above uses the base adapter.
    const memoryAdapter = withHindsight(baseMemoryAdapter, config.memory, name, (level, msg, fields) =>
      this.log(level === "error" ? "warn" : level, msg, fields),
    );

    // Create cross-session memory store from registry
    const memoryStore = await createAgentMemoryStore(config, roomDir);

    // Create DAG context engine for conversation continuity (lcm_* + anima_context_* tools)
    const contextEngine = await createBunContextEngine(config.identity.name);

    // Load agent substrate map if present; otherwise synthesize a minimal one from SOUL boot file.
    const { substrateAdapter, substrateViewLayer } = await this.loadSubstrate(name, roomDir);

    return {
      name: config.identity.name,
      label: config.identity.label,
      roomDir,
      config,
      geneContent,
      soulPath: config.boot.soul,
      soulContent,
      sessionContextFiles,
      additionalSessionContext,
      extraActionResults,
      additionalContent,
      memoryAdapter,
      memoryStore,
      bootstrapContent,
      contextEngine,
      substrateAdapter,
      substrateViewLayer,
    };
  }

  private async loadSubstrate(
    name: string,
    roomDir: string,
  ): Promise<{ substrateAdapter?: SubstrateAdapter; substrateViewLayer?: SubstrateViewLayer }> {
    // Source-of-truth maps live in the agent source tree (agora/familia or substrate).
    // Room maps are optional deployment overrides.
    if (!isValidAgentName(name)) {
      this.log("warn", "invalid agent name for substrate lookup; skipping", { agent: name });
      return {};
    }

    const candidates = [
      join(roomDir, "substrate.map.yaml"),
      join(this.agentSourceDir, name, "substrate.map.yaml"),
      name === "bruno" ? join(this.substrateDir, "substrate.map.yaml") : "",
    ].filter(Boolean);

    const mapPath = candidates.find((p) => existsSync(p));
    if (mapPath) {
      try {
        const raw = await protectedBootRead(mapPath, "utf-8");
        const mapContent = JSON.stringify(loadYaml(raw));
        const adapter = new MappedFilesystemAdapter(mapContent);
        return { substrateAdapter: adapter, substrateViewLayer: new DefaultSubstrateViewLayer() };
      } catch (err) {
        this.log("warn", "failed to load substrate map; continuing without substrate view", { agent: name, error: String(err) });
      }
    }
    return {};
  }

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.roomsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) {
        return [];
      }
      throw error;
    }

    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) {
        continue;
      }

      const configPath = join(this.roomsDir, entry.name, "config.yaml");
      if (!existsSync(configPath)) {
        continue;
      }

      try {
        await this.readConfig(entry.name, configPath);
        names.push(entry.name);
      } catch {
        // list() only exposes valid room configs; mount health is checked elsewhere.
      }
    }

    return names.sort();
  }

  private async readConfig(name: string, configPath: string): Promise<RoomConfig> {
    try {
      return loadRoomConfig(await protectedBootRead(configPath, "utf-8"));
    } catch (error) {
      if (error instanceof ConfigValidationError || error instanceof Error) {
        throw new ConfigParseError(name, error);
      }
      throw error;
    }
  }

  private async validateCartridgeReferences(config: RoomConfig, name: string): Promise<void> {
    const cartridgesConfig = (config as unknown as { cartridges?: Record<string, unknown> }).cartridges;
    if (!cartridgesConfig || typeof cartridgesConfig !== "object") return;

    const selfSelect = cartridgesConfig.selfSelect as string | undefined;
    const defaultRole = cartridgesConfig.defaultRole as string | undefined;
    if (!selfSelect && !defaultRole) return;

    const projectRoot = resolve(this.roomsDir, "..");
    const registry = new CartridgeRegistry({ projectRoot });
    const allEntries = await registry.list(name);
    const entryNames = new Set(allEntries.map((e) => e.name));

    if (selfSelect) {
      const isCategory = CARTRIDGE_CATEGORIES.includes(selfSelect as typeof CARTRIDGE_CATEGORIES[number]);
      const isCartridge = entryNames.has(selfSelect);
      if (!isCategory && !isCartridge) {
        this.log("warn", "config selfSelect references unknown value", {
          agent: name,
          selfSelect,
          validCategories: CARTRIDGE_CATEGORIES,
        });
      }
    }

    if (defaultRole) {
      if (!entryNames.has(defaultRole)) {
        this.log("warn", "config defaultRole references cartridge that does not exist", {
          agent: name,
          defaultRole,
        });
      }
    }
  }

  private async readBootFile(name: string, roomDir: string, bootPath: string): Promise<string> {
    const filePath = expandHomePath(bootPath, roomDir);
    if (!isAbsolute(bootPath) && !bootPath.startsWith("~/") && filePath !== roomDir && !filePath.startsWith(roomDir + "/")) {
      throw new ConfigParseError(name, new Error(`boot path escapes room: ${bootPath}`));
    }

    try {
      return await protectedBootRead(filePath, "utf-8");
    } catch (error) {
      throw new SubstrateNotMountedError(name, error);
    }
  }

  private async readSessionContextFile(
    name: string,
    roomDir: string,
    item: string | { path: string; label?: string; maxChars?: number },
  ): Promise<SessionContextFile> {
    const itemPath = typeof item === "string" ? item : item.path;
    const label = typeof item === "string" ? undefined : item.label;
    const maxChars = typeof item === "string" ? undefined : item.maxChars;
    const filePath = expandHomePath(itemPath, roomDir);
    try {
      const content = await protectedBootRead(filePath, "utf-8");
      return { path: itemPath, label, content, maxChars };
    } catch (error) {
      if (isFileNotFound(error)) {
        await Bun.write(filePath, "");
        this.log("info", "session context file created", { agent: name, path: itemPath });
        return { path: itemPath, label, content: "", maxChars };
      }
      throw new SubstrateNotMountedError(name, error);
    }
  }

  private async readAdditionalSessionContext(
    name: string,
    roomDir: string,
    config: RoomConfig,
  ): Promise<SessionContextFile[] | undefined> {
    const items = config.boot.additionalSessionContext ?? [];
    if (items.length === 0) {
      return undefined;
    }

    const files: SessionContextFile[] = [];
    for (const item of items) {
      try {
        files.push(await this.readSessionContextFile(name, roomDir, item));
      } catch (error) {
        if (error instanceof SubstrateNotMountedError && isMissingPath(error.cause)) {
          this.log("warn", "additional session context missing, skipping", { agent: name, path: item });
          continue;
        }
        throw error;
      }
    }
    return files.length > 0 ? files : undefined;
  }

  private async runExtraActions(config: RoomConfig, roomDir: string): Promise<ExtraActionResult[] | undefined> {
    const actions = config.boot.extraActions ?? [];
    if (actions.length === 0) {
      return undefined;
    }

    const results: ExtraActionResult[] = [];
    for (const action of actions) {
      results.push(await runExtraAction(action.label, action.run, roomDir));
    }
    return results;
  }

  private async loadMemoryAdapter(name: string, roomDir: string, config: RoomConfig): Promise<MemoryAdapter> {
    const type = config.memory?.type ?? "module";

    if (type === "custom") {
      if (!config.memory?.entityScript) {
        this.log("warn", "custom memory type requested but entityScript missing, using null", { agent: name });
        return new NullMemoryAdapter();
      }
      return new CustomMemoryAdapter({
        entityScript: config.memory.entityScript,
        substrateDir: config.memory.substrateDir,
        defaultMode: config.memory.recallMode,
        fallback: config.memory.fallback,
      });
    }

    if (type === "shared") {
      return SharedMemoryAdapter.open(join(this.roomsDir, "_shared", "memory.db"));
    }

    const adapterModule = config.memory?.adapterModule ?? "memory-adapter.js";
    const adapterPath = join(roomDir, adapterModule);

    try {
      const mod = await import(adapterPath);
      const defaultExport = mod?.default ?? mod;

      if (isValidAdapter(defaultExport)) {
        this.log("info", "memory adapter loaded", { agent: name, module: adapterModule });
        return defaultExport as MemoryAdapter;
      }

      this.log("warn", "memory adapter invalid export, using null", { agent: name, module: adapterModule });
      return new NullMemoryAdapter();
    } catch {
      // NullMemoryAdapter is expected when no adapter module is mounted yet — not an error
      this.log("info", "no memory adapter found, using null", { agent: name, module: adapterModule });
      return new NullMemoryAdapter();
    }
  }
}

/**
 * Load invariants.json from an agent's substrate (1_EGO/ directory).
 * Returns null if the file doesn't exist.
 */
export function loadInvariantsFromSubstrate(roomDir: string): InvariantsFile | null {
  const egoDir = join(roomDir, "1_EGO");
  const invariantsPath = join(egoDir, "invariants.json");
  if (!existsSync(invariantsPath)) {
    return null;
  }
  try {
    return loadInvariants(invariantsPath);
  } catch {
    return null;
  }
}

/**
 * Format invariants context for injection into session system prompt.
 * Returns empty string if no invariants.json exists.
 */
export function formatInvariantsContext(roomDir: string): string {
  const invariants = loadInvariantsFromSubstrate(roomDir);
  if (!invariants || invariants.held_positions.length === 0) {
    return "";
  }

  const sections: string[] = ["[Identity Invariants]"];
  for (const pos of invariants.held_positions) {
    sections.push(`- [${pos.category}] ${pos.title}: ${pos.statement}`);
  }

  return sections.join("\n");
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileNotFound(error: unknown): boolean {
  return isMissingPath(error);
}

function isValidAdapter(value: unknown): value is MemoryAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MemoryAdapter).store === "function" &&
    typeof (value as MemoryAdapter).recall === "function"
  );
}

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

function structuredLog(level: "info" | "warn", msg: string, fields: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({ level, ts: new Date().toISOString(), msg, ...fields }),
  );
}

export function expandHomePath(p: string, roomDir: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  if (isAbsolute(p)) {
    return p;
  }
  return resolve(roomDir, p);
}

/**
 * Extra-action stdout goes straight into the agent's prompt, so an action that misbehaves floods
 * every turn (one boot recall printed 636K characters because a metadata field had grown without
 * bound). ~40K characters is roughly 10K tokens — room for a real recall, not for a runaway.
 */
export const EXTRA_ACTION_MAX_STDOUT_CHARS = 40_000;

export function capExtraActionOutput(stdout: string, max: number = EXTRA_ACTION_MAX_STDOUT_CHARS): string {
  if (stdout.length <= max) return stdout;
  return `${stdout.slice(0, max)}\n[output truncated: ${stdout.length - max} more characters]`;
}

async function runExtraAction(label: string, run: string, roomDir: string): Promise<ExtraActionResult> {
  const proc = Bun.spawn(sandboxToolCommand(["bash", "-c", run], roomDir), {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...(sandboxToolEnvironment() ?? process.env), ANIMA_ROOM_DIR: roomDir },
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, 15_000);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const cappedStdout = capExtraActionOutput(stdout);
    if (cappedStdout !== stdout) {
      structuredLog("warn", "extra action output truncated", { label, chars: stdout.length, max: EXTRA_ACTION_MAX_STDOUT_CHARS });
    }

    return {
      label,
      stdout: cappedStdout,
      stderr: timedOut ? `${stderr}\nTimed out after 15s.`.trim() : stderr,
      exitCode,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function protectedBootRead(path: string, encoding: "utf-8"): Promise<string> {
  const boundary = currentToolBoundary();
  if (boundary && !boundary.fileAllowed(path)) throw Error("private bridge/source path denied at boot");
  return readFile(path, encoding);
}
