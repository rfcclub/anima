import { SessionManager } from "../../../../session/manager";
import { getSessionStore } from "../../../services/session-store";
import { json } from "../../../utils/http";
import type { UIServerDeps, SessionResponse } from "../../../types";

function rejectSharedStorageAlias(agentName: string): Response | null {
  return agentName === "@shared" ? json({ error: "shared_conversation_requires_authorized_api" }, 403) : null;
}

export async function handleSession(
  agentName: string,
  deps?: UIServerDeps,
): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });

  const session = mgr.openSession(agentName, "ui");
  const turns = mgr.getTurns(session.id);

  const resp: SessionResponse = {
    sessionId: session.id,
    turnCount: turns.length,
    estimatedTokens: turns.length * 150,
    hasBaseline: false,
    unreadMailCount: 0,
  };

  return json(resp);
}

export async function handleNew(
  agentName: string,
  deps?: UIServerDeps,
): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });
  const session = mgr.newSession(agentName, "ui");
  return json({ sessionId: session.id });
}

export async function handleTurns(agentName: string, _deps?: UIServerDeps): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });
  const session = mgr.openSession(agentName, "ui");
  const turns = mgr.getTurns(session.id);
  const limit = 100;
  const recent = turns.slice(-limit).map(t => ({ role: t.role, content: t.content, ts: t.ts }));
  return json({ turns: recent });
}

export async function handleHistory(req: Request, agentName: string, deps?: UIServerDeps): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const url = new URL(req.url);
  const n = Math.min(Number(url.searchParams.get("n") ?? "20"), 100);
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });
  const session = mgr.openSession(agentName, "ui");
  const { turns, total } = sessionStore.getPaginatedTurns(session.id, { n, offset });
  return json({ turns, total, hasMore: offset + turns.length < total });
}

export async function handleBranches(agentName: string, deps?: UIServerDeps): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });
  const session = mgr.openSession(agentName, "ui");
  const branches = sessionStore.getBranches(session.id).map((b) => ({
    id: b.id,
    name: b.name,
    forkFromTurnId: b.forkFromTurnId,
    createdAt: b.createdAt,
  }));
  const activeBranch = sessionStore.getActiveBranch(session.id);
  return json({ branches, activeBranchId: activeBranch?.id ?? null });
}

export async function handleBack(agentName: string, deps?: UIServerDeps): Promise<Response> {
  const rejected = rejectSharedStorageAlias(agentName); if (rejected) return rejected;
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });
  const session = mgr.openSession(agentName, "ui");
  const turns = mgr.getTurns(session.id);
  if (turns.length < 2) return json({ error: "not_enough_turns" }, 400);
  sessionStore.popLastTurn(session.id); // assistant
  sessionStore.popLastTurn(session.id); // user
  return json({ ok: true });
}

