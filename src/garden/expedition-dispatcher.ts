import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Expedition, SharedNarrativeStore } from "../narrative/shared-store";
import type { JsonlGardenEventStore } from "./event-store";
import type { Provider, ProviderMessage, ProviderResponse } from "../providers/interface";
import { createGardenEvent } from "./events";
import { ScopedExecutor } from "../tools/scoped-executor";
import type { ActivationMode } from "../continuity/activation-config";
import type { BudgetGrant } from "../continuity/activation-budget";

export const EXPEDITION_MAX_MS = 15 * 60 * 1000;
export const EXPEDITION_MAX_TOKENS = 10000;
export const EXPEDITION_MAX_ITERATIONS = 20;

export interface ExpeditionDispatcherDeps {
  /** Resolves the Provider to run the session with, for the claiming agent. */
  resolveProvider: (agentId: string) => Promise<Provider | null>;
  store: SharedNarrativeStore;
  eventStore: JsonlGardenEventStore;
  roomsDir: string;
  /** Root directory the `machine` scope's read/grep/glob tools are restricted to. */
  projectRoot: string;
  now: () => number;
  /** Enforce-mode expedition sessions require their own broker-issued T2 grant. */
  activation?: {
    mode: ActivationMode;
    grantForExpedition?(expedition: Expedition): BudgetGrant | undefined;
    settleGrant?(grant: BudgetGrant): void;
  };
}

/** ExpeditionDispatcher — picks the oldest claimed expedition and runs a
 *  bounded, in-process tool-calling session (no CLI engine, no subprocess):
 *  the provider explores via a `ScopedExecutor`-gated read-only tool
 *  allowlist until it replies with plain text or the budget is exceeded.
 *  The single deliverable is ingested as DISCOVERY + MEMORY_PROPOSAL and
 *  the expedition ends. */
export class ExpeditionDispatcher {
  private running = false;
  constructor(private deps: ExpeditionDispatcherDeps) {}

  async tick(): Promise<void> {
    if (this.running) return;
    const claimed = this.deps.store.claimedExpeditions();
    const oldest = claimed[0] ?? null;
    if (!oldest) return;
    const grant = this.expeditionGrant(oldest);
    if (grant === null) return;
    const provider = await this.deps.resolveProvider(oldest.agentId);
    if (!provider) return; // no usable provider for this agent — stays claimed for a later tick
    this.running = true;
    try {
      this.deps.store.startExpedition(oldest.id, this.deps.now());
      await this.runSession(oldest, provider);
    } finally {
      if (grant) this.deps.activation?.settleGrant?.(grant);
      this.running = false;
    }
  }

  private expeditionGrant(expedition: Expedition): BudgetGrant | null | undefined {
    const activation = this.deps.activation;
    if (!activation || activation.mode === "off" || activation.mode === "shadow") return undefined;
    const grant = activation.grantForExpedition?.(expedition);
    return (
      grant &&
      grant.agentId === expedition.agentId &&
      grant.executor === "expedition" &&
      grant.costClass === "T2" &&
      grant.expiresAt > this.deps.now()
    ) ? grant : null;
  }

  private async runSession(exp: Expedition, provider: Provider): Promise<void> {
    const { id, agentId, target } = exp;
    const executor = new ScopedExecutor({ target, projectRoot: this.deps.projectRoot, agentName: agentId });
    const startedAt = this.deps.now();

    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          `Explore the ${target}. Use your tools to find exactly one discovery — a thing you did not know.`,
          `When you are done, reply with plain text (no more tool calls) in this exact shape:`,
          ``,
          `<one-paragraph summary of the discovery>`,
          `Evidence:`,
          `- <file:line or URL ref>`,
          ``,
          `If you found nothing worth reporting, reply with exactly "NO_DISCOVERY".`,
        ].join("\n"),
      },
    ];

    let discovery: { summary: string; evidence: string[] } | null = null;
    let tokensUsed = 0;
    try {
      for (let iteration = 0; iteration < EXPEDITION_MAX_ITERATIONS; iteration++) {
        if (this.deps.now() - startedAt >= EXPEDITION_MAX_MS) break;
        if (tokensUsed >= EXPEDITION_MAX_TOKENS) break;

        const result = await provider.query({
          agent: agentId,
          mode: "plan",
          cwd: this.deps.roomsDir,
          effort: "fast",
          system: `You are ${agentId}, a colony agent on a bounded, read-only ${target} expedition.`,
          tools: executor.toolDefinitions(),
          messages,
        });
        if (isAsyncGenerator(result)) {
          throw new Error("streaming providers are not supported by ExpeditionDispatcher");
        }
        const response = result as ProviderResponse;
        if (response.usage) {
          tokensUsed += response.usage.input_tokens + response.usage.output_tokens;
        }

        if (!response.tool_calls || response.tool_calls.length === 0) {
          const text = responseText(response).trim();
          discovery = text && text.toUpperCase() !== "NO_DISCOVERY" ? parseDiscovery(text) : null;
          break;
        }

        messages.push({
          role: "assistant",
          content: response.message.content ?? null,
          tool_calls: response.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        for (const toolCall of response.tool_calls) {
          const toolResult = await executor.call(toolCall);
          messages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
        }

        if (this.deps.now() - startedAt >= EXPEDITION_MAX_MS) break;
      }
    } catch {
      // fail-open: empty-handed
    }

    await this.teardown(exp, discovery);
  }

  private async teardown(exp: Expedition, discovery: { summary: string; evidence: string[] } | null): Promise<void> {
    const { id, agentId, target } = exp;
    let discoveryRef: string | null = null;

    if (discovery) {
      const outboxDir = join(this.deps.roomsDir, agentId, "outbox");
      if (!existsSync(outboxDir)) mkdirSync(outboxDir, { recursive: true });
      const ref = join(agentId, "outbox", `discovery-${id}.md`);
      const body = [
        `# Discovery (${target})`,
        ``,
        discovery.summary,
        ``,
        `## Evidence`,
        ...discovery.evidence.map((e) => `- ${e}`),
        ``,
      ].join("\n");
      writeFileSync(join(this.deps.roomsDir, ref), body, "utf-8");
      discoveryRef = ref;

      await this.deps.eventStore.append(
        createGardenEvent({
          id: randomUUID(),
          type: "DISCOVERY",
          timestamp: new Date(this.deps.now()).toISOString(),
          agentId,
          instanceId: agentId,
          runtime: "hub",
          project: "castle",
          payload: { expeditionId: id, summary: discovery.summary.slice(0, 500), evidence: discovery.evidence },
        }),
      );
      await this.deps.eventStore.append(
        createGardenEvent({
          id: randomUUID(),
          type: "MEMORY_PROPOSAL",
          timestamp: new Date(this.deps.now()).toISOString(),
          agentId,
          instanceId: agentId,
          runtime: "hub",
          project: "castle",
          payload: { expeditionId: id, summary: discovery.summary.slice(0, 500), ref },
        }),
      );
    }

    this.deps.store.endExpedition(id, discoveryRef, this.deps.now());
    await this.deps.eventStore.append(
      createGardenEvent({
        id: randomUUID(),
        type: "EXPEDITION_ENDED",
        timestamp: new Date(this.deps.now()).toISOString(),
        agentId,
        instanceId: agentId,
        runtime: "hub",
        project: "castle",
        payload: { expeditionId: id, agentId, hadDiscovery: discoveryRef !== null },
      }),
    );
    this.deps.store.setPresence({
      agentId,
      placeId: target === "machine" ? "gate_machine" : "gate_world",
      since: this.deps.now(),
      activity: "idle",
    });
  }
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in (value as object);
}

function responseText(response: ProviderResponse): string {
  const content = (response.message as { content?: string }).content;
  return typeof content === "string" ? content : "";
}

/** Splits a final-turn reply into a summary and its evidence refs. A
 *  discovery without at least one evidence ref does not satisfy the
 *  single-deliverable contract (discovery-flow SC-017) and is treated as
 *  empty-handed. */
function parseDiscovery(text: string): { summary: string; evidence: string[] } | null {
  const match = text.match(/^([\s\S]*?)\n?#{0,2}\s*Evidence:?\s*\n([\s\S]*)$/i);
  if (!match) return null;
  const summary = match[1].trim();
  const evidence = match[2]
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  if (!summary || evidence.length === 0) return null;
  return { summary, evidence };
}
