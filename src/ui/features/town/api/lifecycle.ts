import { join } from "node:path";
import { AgentLoader } from "../../../../agents/loader";
import { SessionManager } from "../../../../session/manager";
import { startCastleCompactionNow } from "../../../../session/castle-compaction";
import { defaultRoomsDir, getSessionStore } from "../../../services/session-store";
import { resolveAgentProvider } from "../../../services/providers";
import { sseText } from "../../../utils/sse";
import { json } from "../../../utils/http";
import { agentStream } from "./talk";
import type { UIServerDeps } from "../../../types";

function rejectSharedStorageAlias(agentName: string): Response | null {
  return agentName === "@shared" ? json({ error: "shared_conversation_requires_authorized_api" }, 403) : null;
}

/** Manual compaction of the agent's castle session: starts in the background; the kept tail stays. */
export async function compactCastleNow(agentName: string, deps?: UIServerDeps): Promise<ReturnType<typeof startCastleCompactionNow>> {
  const roomsDir = deps?.roomsDir ?? defaultRoomsDir();
  const testProviders = process.env.ANIMA_TEST_PROVIDERS === "true" ? deps?.providers : undefined;
  const provider = testProviders?.get(agentName) ?? await resolveAgentProvider(join(roomsDir, agentName));
  const agent = await new AgentLoader({ roomsDir }).load(agentName);
  const store = getSessionStore();
  const session = new SessionManager({ store }).openSession(agentName, "ui");
  return startCastleCompactionNow({
    store,
    sessionId: session.id,
    agent: agentName,
    branching: agent.config.contextManagement?.mode === "branching",
    provider,
    model: agent.config.provider.model,
  });
}

export function compactReply(result: { status: string; summarizing?: number }): string {
  switch (result.status) {
    case "started": return `✓ Compacting: summarizing ${result.summarizing} earlier messages in the background; the last ones stay as they are.`;
    case "running": return "A compaction is already running for this session.";
    case "nothing": return "Nothing to compact yet.";
    default: return "Compaction is not available for branching rooms yet.";
  }
}

export async function handleCompact(agentName: string, deps?: UIServerDeps): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const { pending: _pending, ...result } = await compactCastleNow(agentName, deps);
  return json({ ok: true, ...result });
}

/** Shared: resolve provider + session + stream a message through the agent pipeline. */

export async function handleRetry(agentName: string, deps?: UIServerDeps): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });
  const session = mgr.openSession(agentName, "ui");
  const turns = mgr.getTurns(session.id);
  // Find last user message
  const lastUserTurn = [...turns].reverse().find(t => t.role === "user");
  if (!lastUserTurn) return json({ error: "no_user_message_to_retry" }, 400);
  // Pop assistant (if last) then user — agentStream will re-append both
  if (turns[turns.length - 1]?.role === "assistant") sessionStore.popLastTurn(session.id);
  if (turns[turns.length - 2]?.role === "user" || turns[turns.length - 1]?.role === "user") {
    sessionStore.popLastTurn(session.id);
  }
  return agentStream(agentName, lastUserTurn.content, deps);
}

export async function handleSummary(agentName: string, deps?: UIServerDeps): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  return agentStream(agentName, "Summarize our conversation so far in 3–5 concise bullets.", deps);
}

export async function handleReview(agentName: string, deps?: UIServerDeps): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });
  const session = mgr.openSession(agentName, "ui");
  const turns = mgr.getTurns(session.id);
  const hasAssistant = turns.some(t => t.role === "assistant");
  if (!hasAssistant) return json({ error: "no_response_to_review" }, 400);
  return agentStream(agentName, "Review your last response: is it accurate, complete, and well-reasoned? If you find issues, state them clearly and provide a corrected version.", deps);
}

export async function handleExport(agentName: string, deps?: UIServerDeps): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });
  const session = mgr.openSession(agentName, "ui");
  const turns = mgr.getTurns(session.id);
  const lines: string[] = [`# ${agentName} — Session Export\n`, `Exported: ${new Date().toISOString()}\n`];
  for (const t of turns) {
    lines.push(`\n## ${t.role === "user" ? "User" : agentName}\n\n${t.content}\n`);
  }
  const md = lines.join("");
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${agentName}-session.md"`,
    },
  });
}
