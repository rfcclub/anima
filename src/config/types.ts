import yaml from "js-yaml";

export type ProviderType = string;
export type PermissionMode = "plan" | "edit" | "auto";
export type TaskMode = "chatting" | "programming" | "image" | "private" | "philosophy" | "creative";
export type ProviderApi = "openai-completions" | "anthropic-messages" | "openai-responses" | "generic";
export type ModelRef = `${string}@${string}`;

export interface ProviderModelDef {
  id: string;
  label?: string;
  extraParams?: Record<string, unknown>;
}

export interface ProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  api: ProviderApi;
  apiKey: string;
  models: ProviderModelDef[];
  endpoint?: string;
  headers?: Record<string, string>;
  extraParams?: Record<string, unknown>;
  /** design.md §5.2: explicit per-endpoint opt-in for the shared-speech
   *  capability. Default false — syntactic OpenAI compatibility alone does
   *  not certify an endpoint's history/session isolation. */
  sharedSafe?: boolean;
}

export type ModeMap = Record<TaskMode, ModelRef[]>;

export interface ProviderConfig {
  type: ProviderType;
  model?: string;
  modeMap?: Partial<ModeMap>;
  /** Retry count for this provider before falling back (default: 3). */
  retry?: number;
  /** Ordered fallback chain — providers to try if this one fails. */
  fallback?: FallbackProviderRef[];
}

/** A fallback provider reference in an agent's provider config. */
export interface FallbackProviderRef {
  model: string;
  type: string;
  retry?: number;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

export interface ToolPolicy {
  allowedRoots: string[];
  readOnlyRoots?: string[];
  allowedTools?: string[];
  deniedPatterns?: string[];
  /** A headless session profile's GitHub action allowlist; absent means the profile restricts nothing extra. */
  githubActions?: string[];
  /** Rollout flag for path/pattern enforcement. Default `warn`: log violations, change nothing. */
  enforce?: PolicyEnforceMode;
}

export type PolicyEnforceMode = "off" | "warn" | "block";

export interface SessionConfig {
  defaultMode: PermissionMode;
  autoModeOptIn: boolean;
  compactThreshold: number;
  idleTimeoutMs?: number;
  maxTokens?: number;
}

export interface BootConfig {
  gene: string;
  soul?: string;
  sessionContext: SessionContextItem[];
  additionalSessionContext?: SessionContextItem[];
  extraActions?: ExtraAction[];
  additional?: string[];
}

export interface SessionContextItem {
  path: string;
  label?: string;
  maxChars?: number;
}

export interface ExtraAction {
  label: string;
  run: string;
}

export type RecallMode = "normal" | "semantic" | "neural";

export interface MemoryConfig {
  type?: "module" | "custom" | "shared";
  adapterModule?: string;
  substrateDir?: string;
  entityScript?: string;
  recallMode?: RecallMode;
  recentDays?: number;
  topK?: number;
  fallback?: boolean;
  /** Enable per-agent cross-session memory bootstrap. Default false. */
  crossSessionBootstrap?: boolean;
  /** Recall scope for per-turn memory recall. "full" | "pin" | "none". Default "full" for cognitive agents. */
  recallScope?: "full" | "pin" | "none";
  /** Pilot: also recall from this Hindsight bank beside the normal adapter. Recall only, never blocks a turn. */
  hindsightBank?: string;
  /** Wait for the Hindsight leg before giving up on it. Default 6000. */
  hindsightTimeoutMs?: number;
  /** Rows the Hindsight leg may add on top of the normal topK rows. Default 2. */
  hindsightTopK?: number;
}

export type GateProfile = "gentle" | "standard" | "full";

export interface GateConfig {
  model?: string;
  fallbackModel?: string;
  threshold: number;
  peerReview: boolean;
  profile: GateProfile;
}

export interface ContextManagementConfig {
  mode: "flat" | "branching";
  tokenBudget?: number;
  protectedWindow?: number;
  summarizeThreshold?: number;
  stubThreshold?: number;
  ftsHotK?: number;
  summaryModel?: string;
}

export interface RoomIdentity {
  name: string;
  label: string;
  /** 1-2 sentence identity anchor injected at the recency boundary to prevent drift. */
  identityAnchor?: string;
}

export interface RoomConfig {
  identity: RoomIdentity;
  provider: ProviderConfig;
  policy: ToolPolicy;
  session: SessionConfig;
  boot: BootConfig;
  gate?: GateConfig;
  memory?: MemoryConfig;
  mcp?: McpConfig;
  contextManagement?: ContextManagementConfig;
  reflection?: ReflectionConfig;
  continuity?: ContinuityConfig;
}

/** Phase 0 (`continuity-ports`): opt-in IncarnationPort.join() call site. Default off. */
export interface ContinuityConfig {
  incarnationPort?: boolean;
  /** Phase 1: use an injected IdentityRuntime only after exact prompt parity passes. */
  identityRuntime?: boolean;
}

export interface ReflectionConfig {
  enabled: boolean;
  intervalMs: number;
  urgencyThreshold?: number;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export function loadRoomConfig(yamlText: string): RoomConfig {
  const parsed = yaml.load(yamlText);
  if (!isRecord(parsed)) {
    throw new ConfigValidationError("config must be a YAML object");
  }

  const identity = requireRecord(parsed, "identity");
  const provider = requireRecord(parsed, "provider");
  const policy = requireRecord(parsed, "policy");
  const session = requireRecord(parsed, "session");
  const boot = requireRecord(parsed, "boot");
  const gate = parsed.gate;
  const memory = parsed.memory;
  const mcp = parsed.mcp;

  const name = requireString(identity, "identity.name");
  const label = requireString(identity, "identity.label");
  const providerType = requireProviderType(provider, "provider.type");
  const allowedRoots = requireStringArray(policy, "policy.allowedRoots");
  const defaultMode = requirePermissionMode(session, "session.defaultMode");
  const gene = requireString(boot, "boot.gene");
  const sessionContext = requireSessionContextArray(boot, "boot.sessionContext");

  const autoModeOptIn = readBoolean(session, "session.autoModeOptIn", false);
  const allowedTools = readStringArray(policy, "policy.allowedTools");
  if (autoModeOptIn && allowedTools === undefined) {
    throw new ConfigValidationError("allowedTools required when autoModeOptIn is true");
  }

  return {
    identity: { name, label, identityAnchor: readString(identity, "identity.identityAnchor") },
    provider: {
      type: providerType,
      model: readString(provider, "provider.model"),
      modeMap: readModeMap(provider, "provider.modeMap"),
      retry: readNumber(provider, "provider.retry"),
      fallback: readFallbackArray(provider, "provider.fallback"),
    },
    policy: {
      allowedRoots,
      readOnlyRoots: readStringArray(policy, "policy.readOnlyRoots") ?? [],
      allowedTools,
      deniedPatterns: readStringArray(policy, "policy.deniedPatterns"),
      enforce: readEnforceMode(policy, "policy.enforce"),
    },
    session: {
      defaultMode,
      autoModeOptIn,
      compactThreshold: readNumber(session, "session.compactThreshold") ?? 60000,
      idleTimeoutMs: readNumber(session, "session.idleTimeoutMs"),
      maxTokens: readNumber(session, "session.maxTokens"),
    },
    boot: {
      gene,
      soul: readString(boot, "boot.soul"),
      sessionContext,
      additionalSessionContext: readSessionContextArray(boot, "boot.additionalSessionContext"),
      extraActions: readExtraActions(boot, "boot.extraActions"),
      additional: readStringArray(boot, "boot.additional"),
    },
    gate: isRecord(gate) ? readGateConfig(gate, "gate") : undefined,
    memory: isRecord(memory)
      ? {
          type: readString(memory, "memory.type") as any,
          adapterModule: readString(memory, "memory.adapterModule"),
          substrateDir: readString(memory, "memory.substrateDir"),
          entityScript: readString(memory, "memory.entityScript"),
          recallMode: readRecallMode(memory, "memory.recallMode"),
          recentDays: readNumber(memory, "memory.recentDays"),
          topK: readNumber(memory, "memory.topK"),
          fallback: readOptionalBoolean(memory, "memory.fallback"),
          crossSessionBootstrap: readOptionalBoolean(memory, "memory.crossSessionBootstrap"),
          recallScope: readRecallScope(memory, "memory.recallScope"),
          hindsightBank: readString(memory, "memory.hindsightBank"),
          hindsightTimeoutMs: readNumber(memory, "memory.hindsightTimeoutMs"),
          hindsightTopK: readNumber(memory, "memory.hindsightTopK"),
        }
      : undefined,
    mcp: isRecord(mcp) ? readMcpConfig(mcp, "mcp") : undefined,
    contextManagement: isRecord(parsed.contextManagement) ? readContextManagementConfig(parsed.contextManagement, "contextManagement") : undefined,
    reflection: isRecord(parsed.reflection)
      ? {
          enabled: readOptionalBoolean(parsed.reflection as Record<string,unknown>, "reflection.enabled") ?? false,
          intervalMs: readNumber(parsed.reflection as Record<string,unknown>, "reflection.intervalMs") ?? 3600000,
          urgencyThreshold: readNumber(parsed.reflection as Record<string,unknown>, "reflection.urgencyThreshold"),
        }
      : undefined,
    continuity: isRecord(parsed.continuity)
      ? {
          incarnationPort: readOptionalBoolean(parsed.continuity as Record<string, unknown>, "continuity.incarnationPort"),
          identityRuntime: readOptionalBoolean(parsed.continuity as Record<string, unknown>, "continuity.identityRuntime"),
        }
      : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(parent: Record<string, unknown>, path: string): Record<string, unknown> {
  const value = parent[path];
  if (!isRecord(value)) {
    throw new ConfigValidationError(`missing required field: ${path}`);
  }
  return value;
}

function requireString(parent: Record<string, unknown>, path: string): string {
  const value = readAtPath(parent, path);
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigValidationError(`missing required field: ${path}`);
  }
  return value;
}

function readString(parent: Record<string, unknown>, path: string): string | undefined {
  const value = readAtPath(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value;
}

function readBoolean(parent: Record<string, unknown>, path: string, defaultValue: boolean): boolean {
  const value = readAtPath(parent, path);
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value;
}

function readOptionalBoolean(parent: Record<string, unknown>, path: string): boolean | undefined {
  const value = readAtPath(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value;
}

function readNumber(parent: Record<string, unknown>, path: string): number | undefined {
  const value = readAtPath(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value;
}

function requireSessionContextArray(parent: Record<string, unknown>, path: string): SessionContextItem[] {
  const value = readSessionContextArray(parent, path);
  if (value === undefined) {
    throw new ConfigValidationError(`missing required field: ${path}`);
  }
  if (value.length === 0) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value;
}

function readSessionContextArray(parent: Record<string, unknown>, path: string): SessionContextItem[] | undefined {
  const value = readAtPath(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value.map((item, index) => readSessionContextItem(item, `${path}.${index}`));
}

function readSessionContextItem(value: unknown, path: string): SessionContextItem {
  if (typeof value === "string") {
    if (value.length === 0) throw new ConfigValidationError(`invalid field: ${path}`);
    return { path: value };
  }
  if (!isRecord(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }

  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new ConfigValidationError(`missing required field: ${path}.path`);
  }
  if (value.label !== undefined && typeof value.label !== "string") {
    throw new ConfigValidationError(`invalid field: ${path}.label`);
  }
  if (value.maxChars !== undefined && typeof value.maxChars !== "number") {
    throw new ConfigValidationError(`invalid field: ${path}.maxChars`);
  }

  return {
    path: value.path,
    label: value.label,
    maxChars: typeof value.maxChars === "number" ? value.maxChars : undefined,
  };
}

function readExtraActions(parent: Record<string, unknown>, path: string): ExtraAction[] | undefined {
  const value = readAtPath(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value.map((item, index) => readExtraAction(item, `${path}.${index}`));
}

function readExtraAction(value: unknown, path: string): ExtraAction {
  if (!isRecord(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }

  // Shorthand: { LabelName: "command" } → { label: "LabelName", run: "command" }
  if (value.label === undefined) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value[keys[0]] === "string") {
      return { label: keys[0], run: value[keys[0]] as string };
    }
  }

  if (typeof value.label !== "string" || value.label.length === 0) {
    throw new ConfigValidationError(`missing required field: ${path}.label`);
  }
  if (typeof value.run !== "string" || value.run.length === 0) {
    throw new ConfigValidationError(`missing required field: ${path}.run`);
  }

  return { label: value.label, run: value.run };
}

function requireStringArray(parent: Record<string, unknown>, path: string): string[] {
  const value = readStringArray(parent, path);
  if (value === undefined) {
    throw new ConfigValidationError(`missing required field: ${path}`);
  }
  return value;
}

function readEnforceMode(parent: Record<string, unknown>, path: string): PolicyEnforceMode {
  const value = readAtPath(parent, path);
  if (value === undefined) return "warn";
  if (value !== "off" && value !== "warn" && value !== "block") {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value;
}

function readStringArray(parent: Record<string, unknown>, path: string): string[] | undefined {
  const value = readAtPath(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value;
}

function requireProviderType(parent: Record<string, unknown>, path: string): ProviderType {
  return requireString(parent, path);
}

function requirePermissionMode(parent: Record<string, unknown>, path: string): PermissionMode {
  const value = requireString(parent, path);
  if (!["plan", "edit", "auto"].includes(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value as PermissionMode;
}

function readGateConfig(parent: Record<string, unknown>, path: string): GateConfig {
  return {
    model: readString(parent, `${path}.model`),
    fallbackModel: readString(parent, `${path}.fallbackModel`),
    threshold: readNumber(parent, `${path}.threshold`) ?? 0.7,
    peerReview: readBoolean(parent, `${path}.peerReview`, false),
    profile: readGateProfile(parent, `${path}.profile`),
  };
}

function readGateProfile(parent: Record<string, unknown>, path: string): GateProfile {
  const value = readString(parent, path) ?? "standard";
  if (!["gentle", "standard", "full"].includes(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value as GateProfile;
}

function readContextManagementConfig(value: Record<string, unknown>, path: string): ContextManagementConfig {
  const mode = readString(value, `${path}.mode`);
  if (mode === undefined) {
    throw new ConfigValidationError(`missing required field: ${path}.mode`);
  }
  if (mode !== "flat" && mode !== "branching") {
    throw new ConfigValidationError(`invalid field: ${path}.mode`);
  }

  return {
    mode: mode as "flat" | "branching",
    tokenBudget: readNumber(value, `${path}.tokenBudget`) ?? 40_000,
    protectedWindow: readNumber(value, `${path}.protectedWindow`) ?? 10,
    summarizeThreshold: readNumber(value, `${path}.summarizeThreshold`) ?? 1500,
    stubThreshold: readNumber(value, `${path}.stubThreshold`) ?? 300,
    ftsHotK: readNumber(value, `${path}.ftsHotK`) ?? 5,
    summaryModel: readString(value, `${path}.summaryModel`),
  };
}

function readRecallMode(parent: Record<string, unknown>, path: string): RecallMode | undefined {
  const value = readString(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (!["normal", "semantic", "neural"].includes(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value as RecallMode;
}

function readRecallScope(parent: Record<string, unknown>, path: string): "full" | "pin" | "none" | undefined {
  const value = readString(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (!["full", "pin", "none"].includes(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value as "full" | "pin" | "none";
}

function readMcpConfig(parent: Record<string, unknown>, path: string): McpConfig {
  const servers = readAtPath(parent, `${path}.servers`);
  if (servers === undefined) {
    throw new ConfigValidationError(`missing required field: ${path}.servers`);
  }
  if (!Array.isArray(servers)) {
    throw new ConfigValidationError(`invalid field: ${path}.servers`);
  }
  return {
    servers: servers.map((server, index) => readMcpServerConfig(server, `${path}.servers.${index}`)),
  };
}

function readMcpServerConfig(value: unknown, path: string): McpServerConfig {
  if (!isRecord(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }

  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new ConfigValidationError(`missing required field: ${path}.name`);
  }
  if (typeof value.command !== "string" || value.command.length === 0) {
    throw new ConfigValidationError(`missing required field: ${path}.command`);
  }
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
    throw new ConfigValidationError(`invalid field: ${path}.args`);
  }
  const env = readStringRecord(value.env, `${path}.env`);

  return { name: value.name, command: value.command, args: value.args, env };
}

function readStringRecord(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value as Record<string, string>;
}

function readModeMap(parent: Record<string, unknown>, path: string): Partial<ModeMap> | undefined {
  const value = readAtPath(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }

  const result: Partial<ModeMap> = {};
  for (const [mode, refs] of Object.entries(value)) {
    if (!isTaskMode(mode) || !Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) {
      throw new ConfigValidationError(`invalid field: ${path}.${mode}`);
    }
    result[mode] = refs as ModelRef[];
  }
  return result;
}

function isTaskMode(value: string): value is TaskMode {
  return ["chatting", "programming", "image", "private", "philosophy", "creative"].includes(value);
}

function readFallbackArray(parent: Record<string, unknown>, path: string): FallbackProviderRef[] | undefined {
  const value = readAtPath(parent, path);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  return value.map((item, index) => readFallbackRef(item, `${path}.${index}`));
}

function readFallbackRef(value: unknown, path: string): FallbackProviderRef {
  if (!isRecord(value)) {
    throw new ConfigValidationError(`invalid field: ${path}`);
  }
  if (typeof value.model !== "string" || value.model.length === 0) {
    throw new ConfigValidationError(`missing required field: ${path}.model`);
  }
  if (typeof value.type !== "string" || value.type.length === 0) {
    throw new ConfigValidationError(`missing required field: ${path}.type`);
  }
  return {
    model: value.model,
    type: value.type,
    ...(typeof value.retry === "number" ? { retry: value.retry } : {}),
  };
}

function readAtPath(parent: Record<string, unknown>, path: string): unknown {
  return path.split(".").slice(1).reduce<unknown>((current, key) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[key];
  }, parent);
}
