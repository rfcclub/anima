import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentLoader } from "../agents/loader";
import { CrossingManager } from "../continuity/crossing";
import { LightNap, parseBeamEntries } from "../dream/light-nap";
import type { JsonlEvent, Store } from "../memory/jsonl-store";
import { NullMemoryAdapter } from "../memory/null-adapter";
import type { MemoryAdapter } from "../memory/adapter";

type LogFields = Record<string, unknown>;
type LogFn = (level: "info" | "error", msg: string, fields?: LogFields) => void;

export interface TrustContextInitializer {
  initialize(agentId: string): Promise<unknown>;
}

export interface SessionLifecycleOptions {
  loader?: AgentLoader;
  store: Store;
  crossingManager?: CrossingManager;
  lightNap?: LightNap;
  memoryAdapter?: MemoryAdapter;
  trustInitializer?: TrustContextInitializer;
  log?: LogFn;
}

export interface SessionLifecycleContext {
  agentId: string;
  channelId: string;
  sessionId: string;
  systemContext: string;
  openedAt: string;
}

interface ActiveSession extends SessionLifecycleContext {
  roomDir: string;
}

export class SessionLifecycle {
  private readonly loader: AgentLoader;
  private readonly store: Store;
  private readonly crossingManager: CrossingManager;
  private readonly lightNap: LightNap;
  private readonly memoryAdapter: MemoryAdapter;
  private readonly trustInitializer?: TrustContextInitializer;
  private readonly log: LogFn;
  private readonly active = new Map<string, ActiveSession>();
  // Pending LightNap promises — drain() awaits all before process exit
  private readonly pendingLightNaps = new Set<Promise<void>>();

  constructor(options: SessionLifecycleOptions) {
    this.loader = options.loader ?? new AgentLoader();
    this.store = options.store;
    this.crossingManager = options.crossingManager ?? new CrossingManager();
    this.lightNap = options.lightNap ?? new LightNap();
    this.memoryAdapter = options.memoryAdapter ?? new NullMemoryAdapter();
    this.trustInitializer = options.trustInitializer;
    this.log = options.log ?? (() => {});
  }

  async onOpen(agentId: string, channelId: string, intent = ""): Promise<SessionLifecycleContext> {
    const key = this.key(agentId, channelId);
    const existing = this.active.get(key);
    if (existing) return this.toContext(existing);

    const agent = await this.loader.load(agentId);
    const session: ActiveSession = {
      agentId,
      channelId,
      sessionId: `channel-${channelId}-${agentId}-${randomUUID()}`,
      systemContext: "",
      openedAt: new Date().toISOString(),
      roomDir: agent.roomDir,
    };

    const sections: string[] = [];

    // Inject sessionContextFiles (if agent has them)
    if ((agent as any).sessionContextFiles && (agent as any).sessionContextFiles.length > 0) {
      const contextSection = (agent as any).sessionContextFiles
        .map((f: { label?: string; content: string }) =>
          f.label ? `### ${f.label}\n${f.content}` : f.content)
        .join('\n\n');
      if (contextSection) sections.push('[Session Context]\n' + contextSection);
    }

    // Inject additionalSessionContext (if agent has them)
    if ((agent as any).additionalSessionContext && (agent as any).additionalSessionContext.length > 0) {
      const deeperSection = (agent as any).additionalSessionContext
        .map((f: { label?: string; content: string }) =>
          f.label ? `### ${f.label}\n${f.content}` : f.content)
        .join('\n\n');
      if (deeperSection) sections.push('[Additional Context]\n' + deeperSection);
    }

    // Inject extraActionResults (if agent has them)
    if ((agent as any).extraActionResults && (agent as any).extraActionResults.length > 0) {
      const recallSection = (agent as any).extraActionResults
        .filter((r: { exitCode: number; stdout: string }) => r.exitCode === 0 && r.stdout.length > 0)
        .map((r: { label: string; stdout: string }) => `[${r.label}]\n${r.stdout}`)
        .join('\n\n');
      if (recallSection) sections.push('[Memory Recall]\n' + recallSection);
    }

    try {
      const crossing = await this.crossingManager.load(agent.roomDir);
      if (crossing) {
        const crossingInjection = this.crossingManager.buildCrossingInjection(crossing);
        if (crossingInjection) sections.push(crossingInjection);
      }
    } catch (err) {
      this.log("error", "lifecycle crossing load failed", {
        type: "lifecycle_crossing_load_error",
        agent: agentId,
        channelId,
        error: String(err),
      });
    }

    try {
      const beamsDir = join(agent.roomDir, "staging", "beams");
      if (existsSync(beamsDir)) {
        const files = (await readdir(beamsDir))
          .filter((f) => f.endsWith(".md"))
          .sort()
          .slice(-7);
        const summaries: string[] = [];
        for (const file of files) {
          const content = await readFile(join(beamsDir, file), "utf-8");
          const entries = parseBeamEntries(content);
          for (const e of entries) {
            if (e.summary) summaries.push(`[${e.timestamp.slice(0, 10)}] ${e.summary}`);
          }
        }
        if (summaries.length > 0) {
          sections.push("[Dream Context]\n" + summaries.slice(-10).map((s) => `- ${s}`).join("\n"));
        }
      }
    } catch (err) {
      this.log("error", "lifecycle dream beam load failed", {
        type: "lifecycle_dream_load_error",
        agent: agentId,
        channelId,
        error: String(err),
      });
    }

    try {
      const effectiveAdapter = agent.memoryAdapter;
      const recalled = await effectiveAdapter.recall(intent || `session open ${agentId}`, {
        namespace: agentId,
        topK: 5,
      });
      if (recalled.length > 0) {
        sections.push("[Memory Context]\n" + recalled.map((entry) => `- ${entry.content}`).join("\n"));
      }
    } catch (err) {
      this.log("error", "lifecycle entity recall failed", {
        type: "lifecycle_entity_recall_error",
        agent: agentId,
        channelId,
        error: String(err),
      });
    }

    try {
      await this.trustInitializer?.initialize(agentId);
    } catch (err) {
      this.log("error", "lifecycle trust init failed", {
        type: "lifecycle_trust_init_error",
        agent: agentId,
        channelId,
        error: String(err),
      });
    }

    session.systemContext = sections.join("\n\n");
    this.active.set(key, session);
    this.store.append(agentId, {
      timestamp: session.openedAt,
      type: "session_lifecycle_open",
      sessionId: session.sessionId,
      channelId,
    });
    return this.toContext(session);
  }

  async onClose(agentId: string, channelId: string): Promise<void> {
    const key = this.key(agentId, channelId);
    const session = this.active.get(key);
    if (!session) return;
    this.active.delete(key);

    const closedAt = new Date().toISOString();
    const events = this.eventsFor(agentId, session.sessionId);
    this.store.append(agentId, {
      timestamp: closedAt,
      type: "session_lifecycle_close",
      sessionId: session.sessionId,
      channelId,
      eventCount: events.length,
    });

    // Run LightNap after a microtask gap (avoids blocking onClose), but track
    // the promise so drain() can await it before process shutdown.
    const lightNapDone = Promise.resolve().then(() =>
      this.lightNap.run({
        roomDir: session.roomDir,
        agentName: agentId,
        sessionId: session.sessionId,
        sessionEvents: events,
      }).catch((err) => {
        this.log("error", "light nap failed", {
          type: "light_nap_error",
          agent: agentId,
          channelId,
          sessionId: session.sessionId,
          error: String(err),
        });
      }),
    );
    this.pendingLightNaps.add(lightNapDone);
    lightNapDone.finally(() => this.pendingLightNaps.delete(lightNapDone));

    try {
      await this.crossingManager.write(session.roomDir, this.crossingManager.buildEntry(
        session.sessionId,
        [],
        [],
        `Closed ${agentId} on ${channelId} with ${events.length} events.`,
        events.length > 0 ? "partial" : "not_applicable",
      ));
    } catch (err) {
      this.log("error", "lifecycle crossing write failed", {
        type: "lifecycle_crossing_write_error",
        agent: agentId,
        channelId,
        sessionId: session.sessionId,
        error: String(err),
      });
    }

    // Fire-and-forget: write a short session-close entry to daily memory jsonl
    const memScript = new URL("../../scripts/write-daily-memory.mjs", import.meta.url).pathname;
    Bun.spawn(
      ["bun", memScript,
        "--type", "session",
        "--topic", "session-close",
        "--content", `${agentId} session closed with ${events.length} events`,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, ANIMA_ROOM_DIR: session.roomDir },
      },
    );
  }

  getContext(agentId: string, channelId: string): SessionLifecycleContext | null {
    const session = this.active.get(this.key(agentId, channelId));
    return session ? this.toContext(session) : null;
  }

  /** Await all in-flight LightNap runs before process shutdown. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pendingLightNaps]);
  }

  private eventsFor(agentId: string, sessionId: string): JsonlEvent[] {
    const events = this.store.readRecent(agentId, 200);
    return events.filter((event) => event.sessionId === sessionId).reverse();
  }

  private key(agentId: string, channelId: string): string {
    return `${agentId}\u0000${channelId}`;
  }

  private toContext(session: ActiveSession): SessionLifecycleContext {
    return {
      agentId: session.agentId,
      channelId: session.channelId,
      sessionId: session.sessionId,
      systemContext: session.systemContext,
      openedAt: session.openedAt,
    };
  }
}
