import type { Provider, ProviderChunk, ProviderResponse, WorkCallLink } from "../providers/interface";
import type { SessionStore } from "../memory/session-store";
import type { SessionTurn } from "./types";

const COMPACT_SYSTEM_PROMPT = [
  "Summarize the provided session turns into a compact continuity baseline.",
  "Preserve durable user intent, decisions, unresolved tasks, constraints, and important facts.",
  "Do not invent details. Keep the summary concise but specific enough to resume the session.",
].join("\n");

export interface CompactEvent {
  summary: string;
  turnCount: number;
  dateRange: { from: string; to: string };
  model: string;
}

export interface CompactorOptions {
  provider: Provider;
  store?: SessionStore;
  sessionId: string;
  model?: string;
  /** The castle work this compaction is paid for. */
  work?: WorkCallLink;
}

export class Compactor {
  private readonly provider: Provider;
  private readonly store?: SessionStore;
  private readonly sessionId: string;
  private readonly model?: string;
  private readonly work?: WorkCallLink;

  constructor(options: CompactorOptions) {
    this.provider = options.provider;
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.model = options.model;
    this.work = options.work;
  }

  async summarize(turns: SessionTurn[]): Promise<CompactEvent | undefined> {
    if (turns.length === 0) {
      return undefined;
    }

    const providerResult = await this.provider.query({
      agent: "compactor",
      mode: "plan",
      model: this.model,
      system: COMPACT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: formatTurns(turns) }],
      ...(this.work ? { work: this.work } : {}),
    });
    if (isAsyncGenerator(providerResult)) {
      throw new Error("streaming provider responses are not supported by Compactor");
    }

    const summary = responseContent(providerResult).trim();
    return {
      summary,
      turnCount: turns.length,
      dateRange: {
        from: turns[0].timestamp,
        to: turns[turns.length - 1].timestamp,
      },
      model: this.model ?? this.provider.name,
    };
  }

  async run(turns: SessionTurn[]): Promise<CompactEvent | undefined> {
    return this.summarize(turns);
  }
}

function formatTurns(turns: SessionTurn[]): string {
  return turns.map((turn) => `${turn.role.toUpperCase()}:\n${turn.content}`).join("\n\n");
}

function responseContent(response: ProviderResponse): string {
  return typeof response.message.content === "string" ? response.message.content : JSON.stringify(response.message.content);
}

function isAsyncGenerator(value: ProviderResponse | AsyncGenerator<ProviderChunk>): value is AsyncGenerator<ProviderChunk> {
  return typeof (value as AsyncGenerator<ProviderChunk>)[Symbol.asyncIterator] === "function";
}
