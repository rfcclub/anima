// `anima talk` provider selection and tool loop (rfcclub/anima#97).
import type { ModeMap, ProviderConfig, ProviderDef, TaskMode } from "../config/types";
import type {
  Provider,
  ProviderMessage,
  ProviderPermissionHandler,
  ProviderResponse,
  ProviderToolCall,
} from "../providers/interface";
import type { CircuitBreaker } from "../providers/circuit-breaker";
import type { ProviderRegistry } from "../providers/registry";
import { TurnRunner, type TurnContext } from "./turn-runner";
import { ModeRouter } from "../providers/router";

/** Same cap as AgentSession.runToolLoop's MAX_TOOL_ITERATIONS. */
const MAX_TOOL_ROUNDS = 64;
/** Tool output kept for the fallback reply when the model ends with no text. */
const FALLBACK_SNIPPET_CHARS = 2000;

export interface TalkProviderOptions {
  /** Provider type resolved from `--provider` or the agent's config. */
  providerName: string;
  /** True when `--provider` was given. */
  providerFlag: boolean;
  /** True when `--model` was given. */
  modelFlag: boolean;
  taskMode: TaskMode;
}

export interface TalkProviderDeps {
  registry: ProviderRegistry;
  /** Read only when the router is used, so a direct provider never depends on the global mode map. */
  loadModeMap: () => Promise<ModeMap>;
  createDirect: (providerName: string) => Promise<Provider>;
  createProvider?: (providerId: string, provider: ProviderDef) => Provider;
  breaker?: CircuitBreaker;
}

/**
 * The agent's fallback chain applies unless `--provider` or `--model` picks one
 * provider explicitly (mesh-jobs review workers rely on that).
 */
export async function createTalkProvider(
  config: ProviderConfig,
  options: TalkProviderOptions,
  deps: TalkProviderDeps,
): Promise<Provider> {
  const usesChain = options.providerName === "router" || (
    !options.providerFlag
    && !options.modelFlag
    && (config.fallback?.length ?? 0) > 0
    && deps.registry.get(config.type) !== undefined
  );
  if (!usesChain) return deps.createDirect(options.providerName);

  // The direct provider uses its first registered model when `model` is omitted; keep that primary in the chain.
  const model = config.model ?? deps.registry.get(config.type)?.models[0]?.id;
  const router = new ModeRouter(deps.registry, await deps.loadModeMap(), {
    modeMap: config.modeMap,
    providerConfig: model ? { ...config, model } : config,
    createProvider: deps.createProvider,
    breaker: deps.breaker,
    meter: { path: "talk" },
  });
  return { name: "router", query: (req) => router.query(req, options.taskMode) };
}

interface TalkToolLoopBase {
  first: ProviderResponse;
  messages: ProviderMessage[];
  query: (messages: ProviderMessage[]) => Promise<ProviderResponse>;
  canUseTool?: ProviderPermissionHandler;
  maxRounds?: number;
  onRoundError?: (round: number, error: unknown) => void;
}

/** Production CLI supplies execution context; old callers retain their trusted callback. */
export type TalkToolLoopInput = TalkToolLoopBase & (
  | { runTool: (call: ProviderToolCall) => Promise<string>; execution?: never }
  | { execution: Pick<TurnContext, "cwd" | "agentName" | "policy" | "memoryStore" | "contextEngine">; runTool?: never }
);

export interface TalkToolLoopResult {
  result: ProviderResponse;
  toolOutputs: string[];
}

/** Thin CLI adapter: shared runner owns permission, messages, execution and caps. */
export async function runTalkToolLoop(input: TalkToolLoopInput): Promise<TalkToolLoopResult> {
  const toolOutputs: string[] = [];
  let result = input.first;
  for await (const event of new TurnRunner().run({
    provider: { name: "talk", query: async ({ messages }) => input.query([...messages]) },
    messages: input.messages, tools: [], mode: "edit",
    cwd: input.execution?.cwd ?? "", agentName: input.execution?.agentName ?? "talk",
    policy: input.execution?.policy ?? null, memoryStore: input.execution?.memoryStore,
    contextEngine: input.execution?.contextEngine,
    execute: input.runTool, guard: input.canUseTool,
    limits: { maxIterations: input.maxRounds ?? MAX_TOOL_ROUNDS },
    surface: { kind: "talk", first: input.first, onRoundError: input.onRoundError },
  })) {
    if (event.type === "error") throw event.error;
    if (event.type === "done") result = event.response;
    if (event.type === "tool-result" && !event.blocked) {
      const snippet = event.result.length > FALLBACK_SNIPPET_CHARS
        ? `${event.result.substring(0, FALLBACK_SNIPPET_CHARS)}\n...(truncated)` : event.result;
      toolOutputs.push(`[${event.call.name}] ${snippet}`);
    }
  }
  return { result, toolOutputs };
}
