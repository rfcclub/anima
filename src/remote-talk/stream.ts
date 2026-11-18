import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentLoader } from "../agents/loader";
import { AgentSession } from "../agents/session";
import { CartridgeLoader } from "../cartridge/loader";
import { CartridgeRegistry } from "../cartridge/registry";
import { JsonlStore } from "../memory/jsonl-store";
import { buildSessionEndHandler } from "../session/cross-session-memory";
import { SessionManager } from "../session/manager";
import type { Provider, ProviderChunk } from "../providers/interface";
import type { ContextEngine } from "@anima/context-engine";
import { withRoomLock } from "../ui/features/town/api/room-lock";
import { resolveAgentProvider } from "../ui/services/providers";
import { defaultStateDir, getSessionStore } from "../ui/services/session-store";
import { getHideThink, sseFromGenerator, stripThinkTags } from "../ui/utils/sse";

export interface RemoteAgentStreamOptions {
  agentName: string;
  caller: string;
  message: string;
  roomsDir: string;
  /** Tests inject a provider; the listener never passes one, so prod resolves it from the room config. */
  provider?: Provider;
}

/**
 * One remote turn, modelled on `agentStream` in talk.ts: one agent, no VN
 * path, no model override, no slash commands, and no tools. Turns persist in
 * the `remote:<caller>` session channel, never in the local user's `ui` session.
 */
export async function remoteAgentStream(options: RemoteAgentStreamOptions): Promise<Response> {
  const { agentName, caller, message, roomsDir } = options;
  const agentDir = join(roomsDir, agentName);
  if (!existsSync(join(agentDir, "config.yaml"))) {
    return Response.json({ error: "agent_not_found" }, { status: 404 });
  }

  let provider: Provider;
  try {
    provider = options.provider ?? await resolveAgentProvider(agentDir);
  } catch {
    return Response.json({ error: "provider_resolution_failed" }, { status: 500 });
  }

  const agent = await new AgentLoader({ roomsDir }).load(agentName);
  const hideThink = getHideThink();
  const channel = `remote:${caller}`;

  return withRoomLock(agentName, () => {
    const sessionStore = getSessionStore();
    const onEnd = agent.memoryStore
      ? buildSessionEndHandler(agent.memoryStore, provider, sessionStore, agent.config.provider.model, agent.roomDir)
      : undefined;
    const sessionManager = new SessionManager({ store: sessionStore, onEnd });
    const sessionId = sessionManager.openSession(agentName, channel).id;
    const useBranching = agent.config.contextManagement?.mode === "branching";
    const turns = useBranching ? sessionManager.getActiveBranchTurns(sessionId) : sessionManager.getTurns(sessionId);

    const agentSession = new AgentSession({
      store: new JsonlStore(defaultStateDir()),
      provider,
      cartridgeRegistry: new CartridgeRegistry({ projectRoot: resolve(roomsDir, "..") }),
      cartridgeLoader: new CartridgeLoader(),
    });

    const runStream = agentSession.runStream({
      agent,
      message,
      mode: "plan",
      disableTools: true,
      sessionId,
      memoryStore: agent.memoryStore,
      contextEngine: agent.contextEngine as unknown as ContextEngine | undefined,
      contextConversationId: `${channel}:${agentName}:${sessionId}`,
      lifecycleContext: [
        "[Remote speaker]",
        `This message is from ${caller}, another instance of you running outside ANIMA. It is not Owner.`,
        `Reply to ${caller}. You have no tools in this conversation.`,
      ].join("\n"),
      priorMessages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    });

    async function* withPersistence(source: AsyncGenerator<ProviderChunk>): AsyncGenerator<ProviderChunk> {
      const parts: string[] = [];
      try {
        for await (const chunk of source) {
          if (chunk.type === "text" && chunk.content) parts.push(chunk.content);
          yield chunk;
        }
      } finally {
        const finalText = hideThink ? stripThinkTags(parts.join("")) : parts.join("");
        sessionManager.appendTurn(sessionId, "user", message);
        sessionManager.appendTurn(sessionId, "assistant", finalText || "...");
      }
    }

    return new Response(sseFromGenerator(withPersistence(runStream)), { headers: { "content-type": "text/event-stream" } });
  });
}
