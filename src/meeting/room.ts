import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { AgentLoader, type LoadedAgent } from "../agents/loader";
import { buildSystemPrompt } from "../agents/prompter";
import { ProviderRegistry } from "../providers/registry";
import { ModeRouter } from "../providers/router";
import { OpenAIv1ChatProvider } from "../providers/openai-v1-chat";
import { OpenAIv1ResponseProvider } from "../providers/openai-v1-response";
import type { Provider, ProviderRequest, ProviderResponse } from "../providers/interface";
import type { PermissionMode, ProviderDef } from "../config/types";
import type { MeetingOptions } from "./types";
import { meterProvider } from "../cost/meter";

export interface MeetingRoomOptions {
  roomsDir?: string;
  provider?: Provider;
}

const SAFE_TOPIC_RE = /^[a-zA-Z0-9_-]+$/;

function safeTopic(topic: string): string {
  const slug = topic.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("meeting topic resolves to empty slug");
  return slug;
}

export class MeetingRoom {
  private readonly roomsDir: string;
  private readonly loader: AgentLoader;
  private readonly provider?: Provider;
  private readonly writeLocks = new Map<string, Promise<void>>();
  private registry: ProviderRegistry | null = null;

  constructor(options: MeetingRoomOptions = {}) {
    this.roomsDir = resolve(options.roomsDir ?? join(homedir(), ".anima", "rooms"));
    this.loader = new AgentLoader({ roomsDir: this.roomsDir });
    this.provider = options.provider;
  }

  /**
   * Load the provider registry from ~/.anima/providers.d/
   */
  private async getRegistry(): Promise<ProviderRegistry> {
    if (this.registry) return this.registry;
    const providersDir = join(homedir(), ".anima", "providers.d");
    this.registry = await ProviderRegistry.load(providersDir);
    return this.registry;
  }

  /**
   * Resolve a provider for an agent using the registry + router pattern.
   * Falls back to direct OpenAIv1ChatProvider if the agent's provider is
   * not in the registry.
   */
  private async resolveProviderForAgent(
    agent: LoadedAgent,
    providerOverride?: string,
  ): Promise<Provider> {
    // Injected mock provider takes precedence
    if (this.provider) return this.provider;

    const providerType = providerOverride ?? agent.config.provider.type;
    const model = agent.config.provider.model;

    const registry = await this.getRegistry();
    const providerDef = registry.get(providerType);

    if (providerDef) {
      // Found in registry — use the standard factory
      return createProviderFromDef(providerDef);
    }

    // Fallback: if it's a known API type, construct directly
    if (providerType === "claude") {
      const { AnthropicProvider } = await import("../providers/anthropic");
      return meterProvider(new AnthropicProvider({ log: () => {} }), { path: "meeting" });
    }
    if (providerType === "gemini") {
      const { GeminiProvider } = await import("../providers/gemini");
      return meterProvider(new GeminiProvider(), { path: "meeting" });
    }

    throw new Error(`provider not found in registry or known types: ${providerType}`);
  }

  /**
   * Load agents by name, then run a round-robin meeting.
   * Returns the final transcript as a string.
   */
  async run(
    agentNames: string[],
    topic: string,
    opts: MeetingOptions = {},
  ): Promise<string> {
    const agents = await Promise.all(
      agentNames.map((name) => this.loader.load(name)),
    );
    return this.runWithAgents(agents, topic, opts);
  }

  /**
   * Run a round-robin meeting with pre-loaded agents.
   *
   * Each round queries every agent in order. Each agent receives the full
   * transcript so far plus their identity prompt. Turns are flushed to the
   * transcript file immediately.
   */
  async runWithAgents(
    agents: LoadedAgent[],
    topic: string,
    opts: MeetingOptions = {},
  ): Promise<string> {
    const slug = safeTopic(topic);
    const turns = opts.turns ?? 3;
    const today = this.today();
    const transcriptDir = this.getTranscriptDir(slug);
    const transcriptPath = join(transcriptDir, `${today}.md`);

    if (!existsSync(transcriptDir)) {
      mkdirSync(transcriptDir, { recursive: true });
    }

    // Pre-resolve providers for all agents
    const agentProviders = new Map<string, Provider>();
    for (const agent of agents) {
      const provider = await this.resolveProviderForAgent(agent, opts.provider);
      agentProviders.set(agent.name, provider);
    }

    // Build initial transcript content
    let transcript: string;

    if (opts.resume && existsSync(transcriptPath)) {
      transcript = readFileSync(transcriptPath, "utf-8").trimEnd();
      transcript += `\n\n*Resumed at ${this.now()}*\n\n`;
    } else {
      transcript = this.createHeader(topic, agents.map((a) => a.name));
    }

    // Serialize writes on this topic via a per-topic lock chain
    const writeTranscript = (content: string) => {
      const prev = this.writeLocks.get(slug) ?? Promise.resolve();
      const next = prev.then(() => { writeFileSync(transcriptPath, content, "utf-8"); });
      this.writeLocks.set(slug, next.catch(() => {}));
      return next;
    };

    // Round-robin loop
    for (let round = 0; round < turns; round++) {
      for (const agent of agents) {
        const provider = agentProviders.get(agent.name)!;
        const systemPrompt = this.buildMeetingPrompt(agent, transcript, opts.inject);

        const response = await provider.query({
          agent: agent.name,
          mode: "plan" as PermissionMode,
          system: systemPrompt,
          model: agent.config.provider.model,
          messages: [{ role: "user", content: `Round ${round + 1}: contribute to the discussion on "${topic}". If you have nothing to share, return nothing.` }],
        });

        // Handle both streaming and non-streaming
        let content: string;
        if (Symbol.asyncIterator in response) {
          const chunks: string[] = [];
          for await (const chunk of response as AsyncGenerator<import("../providers/interface").ProviderChunk>) {
            if (chunk.type === "text" && chunk.content) {
              chunks.push(chunk.content);
            }
          }
          content = chunks.join("");
        } else {
          const resp = response as ProviderResponse;
          content = typeof resp.message.content === "string"
            ? resp.message.content
            : JSON.stringify(resp.message.content);
        }

        // Skip "return nothing" responses
        const trimmed = content.trim();
        if (trimmed.length === 0 || /^(nothing|no reply|n\/a|i'?m done|return nothing)$/i.test(trimmed)) {
          continue;
        }

        const turn = this.formatTurn(agent.name, content);
        transcript += turn;

        await writeTranscript(transcript);
      }
    }

    return transcript;
  }

  /**
   * List meeting topic directories under rooms/_meeting/.
   */
  async listTopics(): Promise<string[]> {
    const meetingDir = join(this.roomsDir, "_meeting");
    if (!existsSync(meetingDir)) {
      return [];
    }

    const entries = await readdir(meetingDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  /**
   * Read today's transcript for a topic.
   */
  readTranscript(topic: string): string | null {
    const path = join(this.roomsDir, "_meeting", safeTopic(topic), `${this.today()}.md`);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                 */
  /* ---------------------------------------------------------------- */

  private getTranscriptDir(topic: string): string {
    return join(this.roomsDir, "_meeting", topic);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private now(): string {
    return new Date().toISOString();
  }

  private createHeader(topic: string, agentNames: string[]): string {
    const lines: string[] = [
      `# Meeting: ${topic}`,
      `Date: ${this.today()}`,
      `Participants: ${agentNames.join(", ")}`,
      "",
    ];
    return lines.join("\n");
  }

  private formatTurn(agentName: string, content: string): string {
    const lines: string[] = [
      `**${agentName}** — ${this.now()}`,
      "",
      content.trim(),
      "",
      "---",
      "",
    ];
    return lines.join("\n");
  }

  private buildMeetingPrompt(
    agent: LoadedAgent,
    transcript: string,
    inject?: string,
  ): string {
    const { full: base } = buildSystemPrompt(agent, { mode: "plan" });
    const parts: string[] = [base];

    parts.push("## Meeting Transcript");
    parts.push(transcript.trim());

    if (inject) {
      parts.push("## Meeting Directive");
      parts.push(inject);
    }

    return parts.join("\n\n") + "\n";
  }
}

/**
 * Create a Provider from a ProviderDef using the standard factory logic.
 * Supports openai-completions, anthropic-messages, and openai-responses APIs.
 */
function createProviderFromDef(def: ProviderDef): Provider {
  if (def.api === "openai-completions" || def.api === "anthropic-messages") {
    return meterProvider(new OpenAIv1ChatProvider(def), { path: "meeting" });
  }
  if (def.api === "openai-responses") {
    return meterProvider(new OpenAIv1ResponseProvider(def), { path: "meeting" });
  }
  throw new Error(`provider API not supported for meetings: ${def.api}`);
}
