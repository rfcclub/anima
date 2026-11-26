import { AgentLoader, type LoadedAgent } from "../agents/loader";
import { AgentSession } from "../agents/session";
import { CartridgeLoader } from "../cartridge/loader";
import { CartridgeRegistry } from "../cartridge/registry";
import type { Store } from "../memory/jsonl-store";
import { SqliteStore } from "../memory/sqlite-store";
import { DualStore } from "../memory/dual-store";
import { AnthropicProvider } from "../providers/anthropic";
import { ProviderError, type Provider } from "../providers/interface";
import type { ModeMap, ProviderConfig, ProviderType } from "../config/types";
import { createTalkProvider, type TalkProviderDeps } from "../agents/talk-runtime";
import { ProviderRegistry } from "../providers/registry";
import { OpenAIv1ChatProvider } from "../providers/openai-v1-chat";
import { OpenAIv1ResponseProvider } from "../providers/openai-v1-response";
import type { MemoryAdapter } from "../memory/adapter";
import type { SessionStore } from "../memory/session-store";
import type { ThreadStore } from "../memory/thread-store";
import { SessionManager } from "../session/manager";
import type { SessionLifecycle } from "../session/lifecycle";
import type { ChannelHandler, ChannelMessage, ChannelResponse } from "./types";
import { join, resolve } from "node:path";
import { meterProvider } from "../cost/meter";

export interface AgentSessionChannelOptions {
  roomsDir?: string;
  provider?: Provider;
  memoryAdapter?: MemoryAdapter;
  sessionStore?: SessionStore;
  threadStore?: ThreadStore;
  lifecycle?: SessionLifecycle;
  onEnd?: (sessionId: string, agent: string) => Promise<void>;
  modelOverride?: string;
  /** Test seam for provider selection (registry, direct and chain providers, breaker). */
  providerDeps?: Partial<TalkProviderDeps>;
}

export class AgentSessionChannel implements ChannelHandler {
  private readonly loader: AgentLoader;
  private readonly store: Store;
  private readonly providerOverride?: Provider;
  private readonly providerDeps?: Partial<TalkProviderDeps>;
  private readonly sessionStore?: SessionStore;
  private readonly sessionManager?: SessionManager;
  private readonly threadStore?: ThreadStore;
  private readonly lifecycle?: SessionLifecycle;
  private readonly bootedSessions = new Set<string>();
  private readonly agentCache = new Map<string, LoadedAgent>();
  private readonly cartridgeLoader: CartridgeLoader;
  private readonly cartridgeRegistry: CartridgeRegistry;
  modelOverride?: string;
  providerTypeOverride?: string;

  constructor(options: AgentSessionChannelOptions = {}) {
    this.loader = new AgentLoader({ roomsDir: options.roomsDir });
    this.store = new DualStore(new SqliteStore(), process.env.ANIMA_HOME ?? join(process.env.HOME ?? "~", ".anima"));
    this.providerOverride = options.provider;
    this.providerDeps = options.providerDeps;
    this.sessionStore = options.sessionStore;
    this.sessionManager = options.sessionStore ? new SessionManager({ store: options.sessionStore, onEnd: options.onEnd }) : undefined;
    this.threadStore = options.threadStore;
    this.lifecycle = options.lifecycle;
    this.modelOverride = options.modelOverride;
    this.cartridgeLoader = new CartridgeLoader();
    this.cartridgeRegistry = new CartridgeRegistry({ projectRoot: options.roomsDir ? resolve(options.roomsDir, "..") : process.cwd() });
  }

  async handleMessage(msg: ChannelMessage): Promise<ChannelResponse> {
    let agent = this.agentCache.get(msg.agentName) ?? null;
    if (!agent) {
      agent = await this.loader.load(msg.agentName);
      this.agentCache.set(msg.agentName, agent);
    }
    const providerType = this.providerTypeOverride ?? agent.config.provider.type;
    const provider = this.providerOverride ?? await this.createProvider(agent.config.provider, providerType);
    const lifecycleContext = this.lifecycle?.getContext(msg.agentName, msg.channelId);
    const persistedSession = this.sessionManager?.openSession(msg.agentName, msg.channelId);
    const sessionId = persistedSession?.id ?? lifecycleContext?.sessionId;
    if (persistedSession) {
      this.sessionManager?.appendTurn(persistedSession.id, "user", msg.message);
    }

    const session = new AgentSession({
      store: this.store,
      provider,
      cartridgeLoader: this.cartridgeLoader,
      cartridgeRegistry: this.cartridgeRegistry,
    });

    const bootKey = `${msg.agentName}:${msg.channelId}`;
    const alreadyBooted = this.bootedSessions.has(bootKey);
    if (!alreadyBooted) this.bootedSessions.add(bootKey);
    const bootContext = alreadyBooted ? undefined : lifecycleContext?.systemContext;

    let result: Awaited<ReturnType<typeof session.run>>;
    try {
      result = await session.run({
        agent,
        message: msg.message,
        signal: msg.signal,
        mode: agent.config.session.defaultMode,
        modelOverride: this.modelOverride,
        sessionId,
        channelId: msg.channelId,
        memoryAdapter: agent.memoryAdapter,
        memoryStore: agent.memoryStore,
        sessionStore: this.sessionStore,
        threadStore: this.threadStore,
        lifecycleContext: bootContext,
      });
    } catch (runErr) {
      throw runErr;
    }

    const rawText = typeof result.response.message.content === "string"
      ? result.response.message.content
      : JSON.stringify(result.response.message.content);
    const text = rawText.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    if (persistedSession) {
      this.sessionManager?.appendTurn(persistedSession.id, "assistant", text);
    }

    return { text, channelId: msg.channelId };
  }

  /** Same rule as `anima talk`: the room's fallback chain applies unless a provider type or model is overridden. */
  private async createProvider(config: ProviderConfig, providerType: string): Promise<Provider> {
    const registry = this.providerDeps?.registry ?? await getRegistry();
    const createDirect = this.providerDeps?.createDirect ?? ((name: string) => resolveProvider(name as ProviderType));
    if (!registry) return createDirect(providerType);
    return createTalkProvider(
      config,
      {
        providerName: providerType,
        providerFlag: this.providerTypeOverride !== undefined,
        modelFlag: this.modelOverride !== undefined,
        taskMode: "chatting",
      },
      {
        registry,
        // The chain ignores the mode map; the session path never reads mode-map.yaml.
        loadModeMap: this.providerDeps?.loadModeMap ?? (async () => EMPTY_MODE_MAP),
        createDirect,
        createProvider: this.providerDeps?.createProvider,
        breaker: this.providerDeps?.breaker,
      },
    );
  }
}

const EMPTY_MODE_MAP: ModeMap = { chatting: [], programming: [], image: [], private: [], philosophy: [], creative: [] };

let _registry: ProviderRegistry | null | undefined;
async function getRegistry(): Promise<ProviderRegistry | null> {
  if (_registry !== undefined) return _registry;
  const dir = join(process.env.ANIMA_ROOMS_DIR ?? join(process.cwd(), "rooms"), "..", "providers.d");
  try {
    _registry = await ProviderRegistry.load(dir);
    return _registry;
  } catch (e) {
    _registry = null;
    return null;
  }
}

async function resolveProvider(type: ProviderType): Promise<Provider> {
  const registry = await getRegistry();
  const def = registry?.get(type);
  if (def) {
    return meterProvider(def.api === "openai-responses" ? new OpenAIv1ResponseProvider(def) : new OpenAIv1ChatProvider(def), { path: "channel" });
  }

  if (type === "claude") {
    return meterProvider(new AnthropicProvider({ log: () => {} }), { path: "channel" });
  }
  throw new ProviderError("SERVER_ERROR", "router", `provider not available: ${type}`);
}
