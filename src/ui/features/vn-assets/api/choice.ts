import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "../../../../session/manager";
import { getSessionStore, defaultRoomsDir } from "../../../services/session-store";
import { json } from "../../../utils/http";
import type { UIServerDeps } from "../../../types";

export async function handleVNChoice(req: Request, deps?: UIServerDeps): Promise<Response> {
  let body: { choice?: string; value?: string; label?: string; choiceIndex?: number; sessionId?: string; branchId?: number; turnId?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }
  if (!body.choice || !body.sessionId) {
    return json({ error: "choice_and_sessionId_required" }, 400);
  }

  const sessionStore = getSessionStore();
  const choiceId = crypto.randomUUID();

  // Resolve the turn this choice anchors to BEFORE creating any branch —
  // narrative_choices.turn_id is a NOT NULL FK to turns(id), so a missing
  // turnId must fall back to the session's latest turn (not 0, which
  // violates the FK after the branch was already created).
  let anchorTurnId = body.turnId ?? null;
  if (anchorTurnId == null) {
    const sessionTurns = sessionStore.getTurns(body.sessionId);
    anchorTurnId = sessionTurns.length > 0 ? sessionTurns[sessionTurns.length - 1].id : null;
  }
  if (anchorTurnId == null) {
    return json({ error: "no_turns_in_session" }, 400);
  }

  // Get active branch for this session
  const branch = sessionStore.getActiveBranch(body.sessionId);
  const currentBranchId = body.branchId ?? branch?.id ?? null;

  // Auto-branching: first choice on current branch → create named branch
  let branchId = currentBranchId;
  let branchCreated = false;
  let branchName = "";

  if (currentBranchId) {
    const existingChoices = sessionStore.getChoicesForBranch(currentBranchId);
    if (existingChoices.length === 0) {
      // First choice on this branch — auto-create a named branch
      const existingBranches = sessionStore.getBranches(body.sessionId);
      const existingNames = existingBranches.map((b) => b.name);

      // Dynamic import branch-namer (avoid top-level TS issues)
      const { deriveBranchName } = await import("../../../../api/vn/branch-namer.ts");
      branchName = deriveBranchName({
        value: body.value || body.choice,
        label: body.label || body.choice,
        existingNames,
      });

      // Fork new branch from current lineage
      const newBranch = sessionStore.createBranch(
        body.sessionId,
        branchName,
        currentBranchId, // parent
        anchorTurnId, // fork from the resolved anchor turn
      );
      sessionStore.setActiveBranch(body.sessionId, newBranch.id);
      branchId = newBranch.id;
      branchCreated = true;
    }
  }

  sessionStore.recordChoice({
    id: choiceId,
    sessionId: body.sessionId,
    branchId,
    parentBranchId: branchCreated ? currentBranchId : (branch?.parentBranchId ?? null),
    turnId: anchorTurnId,
    label: body.label ?? body.choice,
    value: body.value ?? body.choice,
    choiceIndex: body.choiceIndex ?? 0,
  });

  return json({
    ok: true,
    choiceId,
    branchId,
    branchCreated,
    branchName: branchName || undefined,
  });
}

export async function handleVNChoices(agentName: string, deps?: UIServerDeps): Promise<Response> {
  const sessionStore = getSessionStore();
  const mgr = new SessionManager({ store: sessionStore });
  const session = mgr.openSession(agentName, "ui");
  const choices = sessionStore.getNarrativeChoices(session.id);

  // Also return available branches
  const branches = sessionStore.getBranches(session.id);
  const activeBranch = sessionStore.getActiveBranch(session.id);

  return json({
    agent: agentName,
    sessionId: session.id,
    choices,
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      parentBranchId: b.parentBranchId,
      forkFromTurnId: b.forkFromTurnId,
      isActive: activeBranch?.id === b.id,
    })),
  });
}

export async function handleVNBranchSwitch(req: Request, deps?: UIServerDeps): Promise<Response> {
  let body: { sessionId?: string; branchId?: number; confirmed?: boolean; agentId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }
  if (!body.sessionId || !body.branchId) {
    return json({ error: "sessionId_and_branchId_required" }, 400);
  }

  const sessionStore = getSessionStore();
  const targetBranch = sessionStore.getBranches(body.sessionId).find((b) => b.id === body.branchId);
  if (!targetBranch) return json({ error: "branch_not_found" }, 404);

  // Check for unsaved narrative choices on current branch — warn if any
  const activeBranch = sessionStore.getActiveBranch(body.sessionId);
  if (!body.confirmed) {
    const currentChoices = activeBranch
      ? sessionStore.getChoicesForBranch(activeBranch.id)
      : [];
    if (currentChoices.length > 0) {
      return json({
        warning: true,
        message: `Switching from branch "${activeBranch?.name ?? 'main'}" will discard ${currentChoices.length} narrative choice(s) on the current branch. Reply with confirmed: true to proceed.`,
        currentBranch: activeBranch?.name,
        currentBranchId: activeBranch?.id,
        targetBranch: targetBranch.name,
        targetBranchId: targetBranch.id,
        currentChoices: currentChoices.length,
      });
    }
  }

  // Execute switch
  sessionStore.setActiveBranch(body.sessionId, body.branchId);

  // Reconcile stage state: return the target branch's saved snapshot if agentId is provided.
  let stageSnapshot: Record<string, unknown> | null = null;
  if (body.agentId && /^[a-zA-Z0-9_-]+$/.test(body.agentId)) {
    const stateDir = join(defaultRoomsDir(), "_shared", "vn", "state");
    const branchStatePath = resolve(join(stateDir, `${body.agentId}_${body.branchId}.json`));
    if (existsSync(branchStatePath)) {
      try {
        stageSnapshot = JSON.parse(readFileSync(branchStatePath, "utf-8")) as Record<string, unknown>;
      } catch {
        stageSnapshot = null;
      }
    }
  }

  return json({
    ok: true,
    switched: true,
    targetBranch: targetBranch.name,
    targetBranchId: targetBranch.id,
    message: `Switched to branch "${targetBranch.name}".`,
    stageSnapshot,
  });
}
