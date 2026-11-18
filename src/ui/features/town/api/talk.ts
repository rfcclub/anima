import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { AgentLoader } from "../../../../agents/loader";
import { AgentSession } from "../../../../agents/session";
import { buildSessionMessagesFromTurns } from "../../../../agents/messages";
import { buildSystemPrompt, injectIdentityAnchor } from "../../../../agents/prompter";
import { buildToolDefinitions } from "../../../../tools/definitions";
import { executeTool } from "../../../../tools/executor";
import { logTokenUsage } from "../../../../cost/logger";
import { SentinelGate } from "../../../../evaluation/sentinel-gate";
import { attachToKernel } from "../../../../session/attach-client";
import { buildSessionEndHandler } from "../../../../session/cross-session-memory";
import { SessionManager } from "../../../../session/manager";
import type { SessionStore, TurnRecord } from "../../../../memory/session-store";
import { startCastleCompaction } from "../../../../session/castle-compaction";
import { JsonlStore } from "../../../../memory/jsonl-store";
import { CartridgeLoader } from "../../../../cartridge/loader";
import { CartridgeRegistry } from "../../../../cartridge/registry";
import { getSessionStore, defaultRoomsDir, defaultStateDir, VALID_MODES } from "../../../services/session-store";
import { sseFromGenerator, sseText, getHideThink, setHideThink, stripThinkTags } from "../../../utils/sse";
import { collectBeat, streamBeat, tracked } from "./beat-guard";
import type { LockedRun } from "./room-lock";
import { createProviderForType, resolveAgentProvider } from "../../../services/providers";
import { json } from "../../../utils/http";
import { compactCastleNow, compactReply, handleRetry, handleSummary, handleReview } from "./lifecycle";
import type { UIServerDeps } from "../../../types";
import type { PermissionMode } from "../../../../config/types";
import type { ContextEngine } from "@anima/context-engine";
import type { Provider, ProviderChunk, ProviderRequest, ProviderMessage, ProviderResponse } from "../../../../providers/interface";

// ── "All" — bounded abeleat sequential turn-taking ──────────────────
// The room owner's pipeline runs to
// completion first, then (unless declined via the "..." sentinel) the
// guest's. Never parallel, never more than these two beats.
// Kept in this file (not a separate module): by the time
// "all" mode is detected, handleTalk has already built ~10 pieces of
// request-scoped state that a separate module would just have to receive
// as params anyway.
interface AllBeatsParams {
  /** Aborts when the client closes the stream (room-lock.ts); each beat's provider call watches it. */
  signal: AbortSignal;
  /** How long this send waited for the room lock, for the beat log. */
  lockWaitMs: number;
  ownerId: string;
  guestId: string;
  occupants: string[];
  userMessage: string;
  baseLifecycleParts: string[];
  roomsDir: string;
  mode: PermissionMode;
  testProviders?: Map<string, Provider>;
  sessionManager: SessionManager;
  sessionStore: SessionStore;
  ownerAgent: Awaited<ReturnType<AgentLoader["load"]>>;
  ownerProvider: Provider;
  ownerSessionId: string;
  ownerMemoryStore: Awaited<ReturnType<AgentLoader["load"]>>["memoryStore"];
  ownerContextEngine: Awaited<ReturnType<AgentLoader["load"]>>["contextEngine"];
  /** hideThink captured once at request start (SC-407/408) — beats use this,
   *  not the live global, so a mid-sequence /thinktag toggle can't flip
   *  stripping between beats of one in-flight sequence. */
  hideThink: boolean;
}

async function runAllBeats(p: AllBeatsParams): Promise<LockedRun> {
  const { buildPresenceLine, buildGuestFollowupMessage } =
    await import("../../../../narrative/presence-context.ts");
  const { appendTurn: appendRoomTurn } = await import("../../../../narrative/room-transcript.ts");
  const { extractSpokenText, detectDecline } =
    await import("../../../../narrative/vn-response.ts");

  const jsonlStore = new JsonlStore(defaultStateDir());
  const projectRoot = resolve(p.roomsDir, "..");
  const cartridgeRegistry = new CartridgeRegistry({ projectRoot });
  const cartridgeLoader = new CartridgeLoader();

  const enc = new TextEncoder();
  // After the client has left nothing more is written (an enqueue on a cancelled stream throws), and `finished`
  // settles when the pipeline has stopped, so the room lock is freed only then (room-lock.ts).
  let left = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    async start(rawController) {
      const controller = {
        enqueue: (chunk: Uint8Array) => { if (!left) { try { rawController.enqueue(chunk); } catch { left = true; } } },
        close: () => { try { rawController.close(); } catch { /* already closed */ } },
      };
      const sendWordTokens = (agentTag: string, text: string) => {
        const t = text || "...";
        const tokens = t.match(/(\s*\S+\s*)/g) || [t];
        for (const token of tokens) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ agent: agentTag, type: "text", content: token })}\n\n`));
        }
        // Each call is one whole beat; closing it lets the castle show this
        // answer while the next speaker's beat is still running.
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ agent: agentTag, type: "beat_end" })}\n\n`));
      };
      const sendError = (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      };

      // Up-front user-turn persistence (SC-404): the user's message lands in
      // the room transcript BEFORE any beat runs, so a provider failure
      // mid-sequence never loses what the user asked.
      appendRoomTurn(p.ownerId, { speaker: "user", role: "user", content: p.userMessage }, join(p.roomsDir, "_shared", "transcripts"));

      try {
        // ── Beat 1: owner. Told a guest is present and will be asked next
        // (SC-011) so it doesn't try to speak on the guest's behalf. ──
        const ownerPresenceLine = buildPresenceLine({
        ownerId: p.ownerId, speakerId: p.ownerId, occupants: p.occupants, guestWillBeAskedNext: true,
      });
      const ownerLifecycleParts = [...p.baseLifecycleParts];
      if (ownerPresenceLine) ownerLifecycleParts.push(ownerPresenceLine);

      // The owner speaks this beat: compact its session if a trigger fires, then read its turns.
      const ownerBranching = p.ownerAgent.config.contextManagement?.mode === "branching";
      const ownerHistory = startCastleCompaction({
        store: p.sessionStore, sessionId: p.ownerSessionId, agent: p.ownerId, branching: ownerBranching,
        provider: p.ownerProvider, model: p.ownerAgent.config.provider.model, incomingMessage: p.userMessage,
      });
      const ownerTurns = ownerBranching
        ? p.sessionManager.getActiveBranchTurns(p.ownerSessionId)
        : p.sessionManager.getTurns(p.ownerSessionId);
      const ownerSession = new AgentSession({ store: jsonlStore, provider: p.ownerProvider, cartridgeRegistry, cartridgeLoader });
      const ownerRun = (signal: AbortSignal) => ownerSession.runStream({
        signal,
        agent: p.ownerAgent,
        message: p.userMessage,
        mode: p.mode,
        sessionId: p.ownerSessionId,
        memoryStore: p.ownerMemoryStore,
        contextEngine: p.ownerContextEngine as unknown as ContextEngine | undefined,
        contextConversationId: `ui:${p.ownerId}:${p.ownerSessionId}`,
        cartridgeOverride: "visual-novel",
        lifecycleContext: ownerLifecycleParts.length > 0 ? ownerLifecycleParts.join("\n\n") : undefined,
        priorMessages: ownerTurns.map((t) => ({ role: t.role, content: t.content })),
        priorSummary: ownerHistory.summary,
        priorHistoryTokenBudget: ownerHistory.budget,
      });
      const ownerParts = await collectBeat({
        signal: p.signal,
        meta: { room: p.ownerId, speaker: p.ownerId, provider: p.ownerProvider.name, model: p.ownerAgent.config.provider.model ?? "", lockWaitMs: p.lockWaitMs },
        stream: ownerRun,
      });
      const ownerText = (p.hideThink ? stripThinkTags(ownerParts.join("")) : ownerParts.join("")) || "...";
      sendWordTokens(p.ownerId, ownerText);
      p.sessionManager.appendTurn(p.ownerSessionId, "user", p.userMessage);
      p.sessionManager.appendTurn(p.ownerSessionId, "assistant", ownerText);
      // Room-scoped transcript (not per-agent session) — the chat log reads
      // from here, so it reflects who ACTUALLY spoke in this room regardless
      // of which agent's session the reply also landed in. The user turn was
      // already persisted up-front (SC-404); only the assistant turn here.
      appendRoomTurn(p.ownerId, { speaker: p.ownerId, role: "assistant", content: ownerText }, join(p.roomsDir, "_shared", "transcripts"));

      // ── Beat 2: guest. Sees the owner's REAL completed answer (not a
      // summary) plus a content-level (not protocol-level) prompt asking
      // whether it has anything to add — SC-012/013. Buffered (not
      // streamed live) because we need the full text before we know
      // whether it's a decline (SC-014/015). ──
      const guestDir = join(p.roomsDir, p.guestId);
      if (!existsSync(join(guestDir, "config.yaml"))) {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const guestProvider = p.testProviders?.get(p.guestId) ?? await resolveAgentProvider(guestDir);
      const guestLoader = new AgentLoader({ roomsDir: p.roomsDir });
      const guestAgent = await guestLoader.load(p.guestId);
      const guestSessionMeta = p.sessionManager.openSession(p.guestId, "ui");
      const guestUseBranching = guestAgent.config.contextManagement?.mode === "branching";
      const guestHistory = startCastleCompaction({
        store: p.sessionStore, sessionId: guestSessionMeta.id, agent: p.guestId, branching: guestUseBranching,
        provider: guestProvider, model: guestAgent.config.provider.model, incomingMessage: p.userMessage,
      });
      const guestTurns = guestUseBranching
        ? p.sessionManager.getActiveBranchTurns(guestSessionMeta.id)
        : p.sessionManager.getTurns(guestSessionMeta.id);

      const guestMessage = buildGuestFollowupMessage({ ownerId: p.ownerId, userMessage: p.userMessage, ownerSpokenText: extractSpokenText(ownerText) });
      const guestPresenceLine = buildPresenceLine({ ownerId: p.ownerId, speakerId: p.guestId, occupants: p.occupants });
      const guestLifecycleParts = [...p.baseLifecycleParts];
      if (guestPresenceLine) guestLifecycleParts.push(guestPresenceLine);

      const guestSession = new AgentSession({ store: jsonlStore, provider: guestProvider, cartridgeRegistry, cartridgeLoader });
      const guestRun = (signal: AbortSignal) => guestSession.runStream({
        signal,
        agent: guestAgent,
        message: guestMessage,
        mode: p.mode,
        sessionId: guestSessionMeta.id,
        memoryStore: guestAgent.memoryStore,
        contextEngine: guestAgent.contextEngine as unknown as ContextEngine | undefined,
        contextConversationId: `ui:${p.guestId}:${guestSessionMeta.id}`,
        cartridgeOverride: "visual-novel",
        lifecycleContext: guestLifecycleParts.length > 0 ? guestLifecycleParts.join("\n\n") : undefined,
        priorMessages: guestTurns.map((t) => ({ role: t.role, content: t.content })),
        priorSummary: guestHistory.summary,
        priorHistoryTokenBudget: guestHistory.budget,
      });
      const guestParts = await collectBeat({
        signal: p.signal,
        meta: { room: p.ownerId, speaker: p.guestId, provider: guestProvider.name, model: guestAgent.config.provider.model ?? "", lockWaitMs: p.lockWaitMs },
        stream: guestRun,
      });
      const guestTextRaw = p.hideThink ? stripThinkTags(guestParts.join("")) : guestParts.join("");
      const guestDeclined = detectDecline(guestTextRaw);
      if (!guestDeclined) {
        const guestText = guestTextRaw || "...";
        sendWordTokens(p.guestId, guestText);
        p.sessionManager.appendTurn(guestSessionMeta.id, "user", guestMessage);
        p.sessionManager.appendTurn(guestSessionMeta.id, "assistant", guestText);
        // No matching "user" room-transcript entry — the guest's synthesized
        // follow-up prompt is internal scaffolding, not something the human
        // actually said; the human's one real question was already recorded
        // in beat 1.
        appendRoomTurn(p.ownerId, { speaker: p.guestId, role: "assistant", content: guestText }, join(p.roomsDir, "_shared", "transcripts"));
      }
      } catch (e) {
        sendError(e);
      } finally {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
        finish();
      }
    },
    cancel() { left = true; },
  });
  return { response: new Response(stream, { headers: { "content-type": "text/event-stream" } }), finished };
}

// ── Ordered N-way turn-taking (2 or 3 speakers, any leader) ─────────────
// Generalizes runAllBeats: the leader (order[0], may be the owner OR a
// guest) always gives a real answer; every speaker after that gets a
// content-level follow-up prompt (buildFollowupMessage) seeing every
// prior beat's actual text, with the "..." decline sentinel. Bounded to
// at most 3 total speakers per an explicit cap. Left as a separate
// function from runAllBeats (not a refactor of it) so the already-tested
// "all" literal path (SC-007..015) is untouched — the ordered path adds
// reversible/3-way ordering alongside the existing flow.
interface OrderedBeatsParams {
  signal: AbortSignal;
  lockWaitMs: number;
  order: string[]; // 2 or 3 agent ids — order[0] leads
  ownerId: string; // the room's actual owner, for presence-line phrasing
  occupants: string[];
  userMessage: string;
  baseLifecycleParts: string[];
  roomsDir: string;
  mode: PermissionMode;
  testProviders?: Map<string, Provider>;
  sessionManager: SessionManager;
  sessionStore: SessionStore;
  /** hideThink captured once at request start (SC-407/408). */
  hideThink: boolean;
}

async function loadSpeaker(roomsDir: string, id: string, testProviders?: Map<string, Provider>) {
  const dir = join(roomsDir, id);
  if (!existsSync(join(dir, "config.yaml"))) return null;
  const provider = testProviders?.get(id) ?? await resolveAgentProvider(dir);
  const loader = new AgentLoader({ roomsDir });
  const agent = await loader.load(id);
  return { agent, provider };
}

async function runOrderedBeats(p: OrderedBeatsParams): Promise<LockedRun> {
  const { buildPresenceLine, buildFollowupMessage } =
    await import("../../../../narrative/presence-context.ts");
  const { appendTurn: appendRoomTurn } = await import("../../../../narrative/room-transcript.ts");
  const { extractSpokenText, detectDecline } =
    await import("../../../../narrative/vn-response.ts");

  const jsonlStore = new JsonlStore(defaultStateDir());
  const projectRoot = resolve(p.roomsDir, "..");
  const cartridgeRegistry = new CartridgeRegistry({ projectRoot });
  const cartridgeLoader = new CartridgeLoader();
  const enc = new TextEncoder();

  // After the client has left nothing more is written (an enqueue on a cancelled stream throws), and `finished`
  // settles when the pipeline has stopped, so the room lock is freed only then (room-lock.ts).
  let left = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    async start(rawController) {
      const controller = {
        enqueue: (chunk: Uint8Array) => { if (!left) { try { rawController.enqueue(chunk); } catch { left = true; } } },
        close: () => { try { rawController.close(); } catch { /* already closed */ } },
      };
      const sendWordTokens = (agentTag: string, text: string) => {
        const t = text || "...";
        const tokens = t.match(/(\s*\S+\s*)/g) || [t];
        for (const token of tokens) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ agent: agentTag, type: "text", content: token })}\n\n`));
        }
        // Each call is one whole beat; closing it lets the castle show this
        // answer while the next speaker's beat is still running.
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ agent: agentTag, type: "beat_end" })}\n\n`));
      };
      const sendError = (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      };

      // Up-front user-turn persistence (SC-404): the user's message lands in
      // the room transcript BEFORE any beat runs, so a provider failure
      // mid-sequence never loses what the user asked.
      appendRoomTurn(p.ownerId, { speaker: "user", role: "user", content: p.userMessage }, join(p.roomsDir, "_shared", "transcripts"));

      const priorReplies: { speakerId: string; spokenText: string }[] = [];

      try {
        for (let i = 0; i < p.order.length; i++) {
        const speakerId = p.order[i];
        const isLeader = i === 0;
        const loaded = await loadSpeaker(p.roomsDir, speakerId, p.testProviders);
        if (!loaded) continue; // missing agent config — skip, don't break the chain

        const sessionMeta = p.sessionManager.openSession(speakerId, "ui");
        const useBranching = loaded.agent.config.contextManagement?.mode === "branching";
        const history = startCastleCompaction({
          store: p.sessionStore, sessionId: sessionMeta.id, agent: speakerId, branching: useBranching,
          provider: loaded.provider, model: loaded.agent.config.provider.model, incomingMessage: p.userMessage,
        });
        const priorTurns = useBranching
          ? p.sessionManager.getActiveBranchTurns(sessionMeta.id)
          : p.sessionManager.getTurns(sessionMeta.id);

        const presenceLine = buildPresenceLine({
          ownerId: p.ownerId,
          speakerId,
          occupants: p.occupants,
          guestWillBeAskedNext: isLeader && speakerId === p.ownerId && p.order.length > 1,
        });
        const speakerLifecycleParts = [...p.baseLifecycleParts];
        if (presenceLine) speakerLifecycleParts.push(presenceLine);

        const message = isLeader
          ? p.userMessage
          : buildFollowupMessage({ userMessage: p.userMessage, priorReplies });

        const speakerSession = new AgentSession({ store: jsonlStore, provider: loaded.provider, cartridgeRegistry, cartridgeLoader });
        const speakerRun = (signal: AbortSignal) => speakerSession.runStream({
          signal,
          agent: loaded.agent,
          message,
          mode: p.mode,
          sessionId: sessionMeta.id,
          memoryStore: loaded.agent.memoryStore,
          contextEngine: loaded.agent.contextEngine as unknown as ContextEngine | undefined,
          contextConversationId: `ui:${speakerId}:${sessionMeta.id}`,
          cartridgeOverride: "visual-novel",
          lifecycleContext: speakerLifecycleParts.length > 0 ? speakerLifecycleParts.join("\n\n") : undefined,
          priorMessages: priorTurns.map((t) => ({ role: t.role, content: t.content })),
          priorSummary: history.summary,
          priorHistoryTokenBudget: history.budget,
        });
        const parts = await collectBeat({
          signal: p.signal,
          meta: { room: p.ownerId, speaker: speakerId, provider: loaded.provider.name, model: loaded.agent.config.provider.model ?? "", lockWaitMs: p.lockWaitMs },
          stream: speakerRun,
        });
        const rawText = p.hideThink ? stripThinkTags(parts.join("")) : parts.join("");
        const declined = !isLeader && detectDecline(rawText);
        if (declined) continue; // no frame, no persistence, no context for later beats

        const text = rawText || "...";
        sendWordTokens(speakerId, text);
        p.sessionManager.appendTurn(sessionMeta.id, "user", message);
        p.sessionManager.appendTurn(sessionMeta.id, "assistant", text);
        appendRoomTurn(p.ownerId, { speaker: speakerId, role: "assistant", content: text }, join(p.roomsDir, "_shared", "transcripts"));
        priorReplies.push({ speakerId, spokenText: extractSpokenText(text) });
      }
      } catch (e) {
        sendError(e);
      } finally {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
        finish();
      }
    },
    cancel() { left = true; },
  });
  return { response: new Response(stream, { headers: { "content-type": "text/event-stream" } }), finished };
}

export async function handleTalk(
  req: Request,
  agentName: string,
  deps?: UIServerDeps,
): Promise<Response> {
  if (agentName === "@shared") return json({ error: "shared_conversation_requires_authorized_api" }, 403);
  let body: { message?: string; imageData?: string; mode?: string; model?: string; addressee?: string; thinking?: { budget: 'low' | 'medium' | 'high' }; effort?: 'fast' | 'normal' | 'deep' };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }

  if (!body.message && !body.imageData) {
    return json({ error: "message_required" }, 400);
  }

  // Slash command routing — intercept before LLM
  if (body.message!.startsWith('/')) {
    const cmd = body.message!.trim().toLowerCase().split(' ')[0];
    if (cmd === '/new') {
      const store = getSessionStore();
      new SessionManager({ store }).newSession(agentName, "ui");
      return sseText('✓ New session started.');
    }
    if (cmd === '/compact') {
      const result = await compactCastleNow(agentName, deps);
      return sseText(compactReply(result));
    }
    if (cmd === '/back') {
      const store = getSessionStore();
      const mgr = new SessionManager({ store });
      const sess = mgr.openSession(agentName, "ui");
      // In branching mode, pop last 2 from active branch
      const activeBranch = store.getActiveBranch(sess.id);
      if (activeBranch) {
        const branchTurns = mgr.getActiveBranchTurns(sess.id);
        // Find last 2 turns belonging to THIS branch (not ancestor)
        const allBranchTurns = store.getTurnsForBranch(activeBranch.id);
        const lastTwo = allBranchTurns.slice(-2);
        if (lastTwo.length < 2) return sseText('Nothing to undo.');
        // Only allow popping if these are NOT inherited ancestor turns
        // (fork_from_turn_id defines the boundary)
        const branch = store.getBranches(sess.id).find((b) => b.id === activeBranch.id);
        const forkId = branch?.forkFromTurnId ?? -1;
        if (lastTwo[0].id <= forkId) return sseText('Cannot undo inherited turns.');
        store.popLastTurn(sess.id);
        store.popLastTurn(sess.id);
        return sseText('✓ Last exchange removed from current branch.');
      }
      const turns = mgr.getTurns(sess.id);
      if (turns.length < 2) return sseText('Nothing to undo.');
      store.popLastTurn(sess.id);
      store.popLastTurn(sess.id);
      return sseText('✓ Last exchange removed.');
    }
    if (cmd === '/retry') return handleRetry(agentName, deps);
    if (cmd === '/summary') return handleSummary(agentName, deps);
    if (cmd === '/review') return handleReview(agentName, deps);
    if (cmd === '/help') {
      const helpBase = '/new /compact /retry /summary /review /back /thinktag on|off';
      const branchCmds = '/branch list | new <name> | turn <id> <name> | switch <name> | delete <name>';
      // Check if branching mode is active for this agent
      let useBranching = false;
      try {
        const loader = new AgentLoader({ roomsDir: deps?.roomsDir ?? defaultRoomsDir() });
        const agent = await loader.load(agentName);
        useBranching = agent.config.contextManagement?.mode === "branching";
      } catch { /* use defaults */ }
      return sseText(
        useBranching
          ? `Commands: ${helpBase} | Branch: ${branchCmds}`
          : `Commands: ${helpBase}`,
      );
    }
    // ── Branch commands ────────────────────────────────────────────────────
    if (cmd === '/branch') {
      const store = getSessionStore();
      const mgr = new SessionManager({ store });
      const sess = mgr.openSession(agentName, "ui");
      const args = body.message!.trim().split(/\s+/);

      if (args.length < 2) return sseText('Usage: /branch list | switch <name> | delete <name>');

      const sub = args[1].toLowerCase();
      if (sub === 'list') {
        const branches = store.getBranches(sess.id);
        const active = store.getActiveBranch(sess.id);
        const lines = branches.map((b) => {
          const marker = active && b.id === active.id ? ' *' : '';
          return `  ${b.name}${marker}${b.parentBranchId ? ` (forked)` : ''}`;
        });
        return sseText(`Branches:\n${lines.join('\n')}`);
      }

      if (sub === 'new' && args.length >= 3) {
        const name = args.slice(2).join(' ');
        const active = store.getActiveBranch(sess.id);
        const branches = store.getBranches(sess.id);
        if (branches.some((b) => b.name === name)) {
          return sseText(`Branch "${name}" already exists.`);
        }
        // Find the last turn on the active branch to fork from
        const turns = mgr.getActiveBranchTurns(sess.id);
        const lastTurn = turns[turns.length - 1];
        const forkId = lastTurn?.id ?? null;
        const newBranch = store.createBranch(sess.id, name, active?.id ?? null, forkId);
        store.setActiveBranch(sess.id, newBranch.id);
        return sseText(`✓ Created and switched to branch "${name}" (forked from turn ${forkId}).`);
      }

      if (sub === 'turn' && args.length >= 4) {
        const turnId = parseInt(args[2], 10);
        if (Number.isNaN(turnId)) return sseText('Usage: /branch turn <turnId> <name>');
        const name = args.slice(3).join(' ');
        const active = store.getActiveBranch(sess.id);
        const branches = store.getBranches(sess.id);
        if (branches.some((b) => b.name === name)) {
          return sseText(`Branch "${name}" already exists.`);
        }
        // Verify turn exists and belongs to session
        const branchTurns = mgr.getActiveBranchTurns(sess.id);
        const targetTurn = branchTurns.find((t) => t.id === turnId);
        if (!targetTurn) {
          return sseText(`Turn ${turnId} not found in active branch lineage.`);
        }
        const newBranch = store.createBranch(sess.id, name, active?.id ?? null, turnId);
        store.setActiveBranch(sess.id, newBranch.id);
        return sseText(`✓ Created and switched to branch "${name}" at turn ${turnId}.`);
      }

      if (sub === 'switch' && args.length >= 3) {
        const name = args.slice(2).join(' ');
        const branches = store.getBranches(sess.id);
        const target = branches.find((b) => b.name === name);
        if (!target) return sseText(`Branch "${name}" not found.`);
        store.setActiveBranch(sess.id, target.id);
        return sseText(`✓ Switched to branch "${name}".`);
      }

      if (sub === 'delete' && args.length >= 3) {
        const name = args.slice(2).join(' ');
        const branches = store.getBranches(sess.id);
        const target = branches.find((b) => b.name === name);
        if (!target) return sseText(`Branch "${name}" not found.`);
        const active = store.getActiveBranch(sess.id);
        if (active && target.id === active.id) {
          return sseText('Cannot delete the active branch. Switch to another branch first.');
        }
        try {
          store.deleteBranch(target.id);
          return sseText(`✓ Branch "${name}" deleted.`);
        } catch (err) {
          return sseText(`Cannot delete: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return sseText('Usage: /branch list | switch <name> | delete <name>');
    }
    if (cmd === '/thinktag') {
      const arg = body.message!.trim().split(/\s+/)[1]?.toLowerCase();
      if (arg === 'on') { setHideThink(false); return sseText('Think tags visible (on)'); }
      if (arg === 'off') { setHideThink(true); return sseText('Think tags hidden (off)'); }
      return sseText(`Think tags currently: ${getHideThink() ? "hidden" : "visible"}. Usage: /thinktag on|off`);
    }
    return sseText(`Unknown command: ${cmd}. Type /help for available commands.`);
  }

  const mode = body.mode ?? "plan";
  if (!VALID_MODES.has(mode)) {
    return json({ error: `invalid_mode: must be one of ${[...VALID_MODES].join(", ")}` }, 400);
  }

  // Per-room FIFO serialization (SC-101..105): at most one talk pipeline per
  // room at a time, from session turns-snapshot through final persistence
  // (end of the SSE stream). A second concurrent request for the same room
  // queues behind the first. The lock is module-level (room-lock.ts) because
  // SessionManager is built per-request — nothing request-scoped can hold
  // cross-request state. The lock is released when the SSE stream closes
  // (not when the Response object is created), so the full pipeline lifetime
  // is serialized. `withRoomLock` wraps the Response so the lock releases on
  // stream close (or immediately for non-streaming error responses).
  const { withRoomLock } = await import("./room-lock");
  const roomsDir = deps?.roomsDir ?? defaultRoomsDir();

  // Resolve provider: injected mock takes precedence ONLY under the test
  // flag (ANIMA_TEST_PROVIDERS) — in prod the seam is unreachable, so the
  // provider always comes from the agent's config. This gates the mock
  // leak (bug 4): without the flag, deps.providers is ignored entirely.
  const testProviders = process.env.ANIMA_TEST_PROVIDERS === "true" ? deps?.providers : undefined;
  let provider = testProviders?.get(agentName);

  if (!provider) {
    try {
      const agentDir = join(roomsDir, agentName);
      if (!existsSync(join(agentDir, "config.yaml"))) {
        return withRoomLock(agentName, () => json({ error: `agent_not_found: ${agentName}` }, 404));
      }
      provider = await resolveAgentProvider(agentDir);
    } catch (err) {
      return withRoomLock(agentName, () => json({
        error: `provider_resolution_failed: ${agentName}`,
        detail: err instanceof Error ? err.message : String(err),
      }, 500));
    }
  }

  // Load agent and session state
  const loader = new AgentLoader({ roomsDir });
  let agent: Awaited<ReturnType<typeof loader.load>> | undefined;
  try {
    agent = await loader.load(agentName);
  } catch (err) {
    return withRoomLock(agentName, () => json({ error: `agent_load_failed: ${agentName}`, detail: String(err) }, 500));
  }

  const compactThreshold = agent.config.session.compactThreshold;
  let agentMemoryStore = agent.memoryStore;
  let agentModel = agent.config.provider.model;
  let agentContextEngine = agent.contextEngine;
  let useBranching = agent.config.contextManagement?.mode === "branching";

  const sessionStore = getSessionStore();
  const onEnd = agentMemoryStore
    ? buildSessionEndHandler(agentMemoryStore, provider, sessionStore, agentModel, agent.roomDir)
    : undefined;
  const sessionManager = new SessionManager({ store: sessionStore, onEnd });
  const session = sessionManager.openSession(agentName, "ui");
  let sessionId = session.id;

  let turns = useBranching
    ? sessionManager.getActiveBranchTurns(sessionId)
    : sessionManager.getTurns(sessionId);

  // ── Build lifecycleContext (injected after static system prompt, before identity anchor) ──
  const lifecycleParts: string[] = [];

  // Process Attach Protocol: query Kernel for identity state
  let kernelState: Awaited<ReturnType<typeof attachToKernel>> = null;
  try {
    kernelState = await attachToKernel({
      platform: "anima",
      processId: `anima-ui:${agentName}:${sessionId}`,
    });
  } catch {
    // Non-fatal — fall back to cold-load
  }
  if (kernelState?.state) {
    lifecycleParts.push([
      `[Identity State — from Kernel]`,
      `  identityName: ${kernelState.state.identityName}`,
      `  currentMode: ${kernelState.state.currentMode}`,
      `  axiomVersion: ${kernelState.state.axiomVersion}`,
      `  activeProcesses: ${kernelState.state.activeProcesses.length}`,
      `  sessionDelta: ${kernelState.delta}`,
    ].join("\n"));
  }

  // ── VN Surface detection: route through visual-novel cartridge + narrative state ──
  const referer = req.headers.get("Referer") ?? "";
  const isVNSurface = referer.includes("/rooms/") || body.message?.includes("VN:") || false;
  // Capture hideThink once per request (SC-407/408): every beat and the
  // single-speaker persistence path use this value, not the live global, so a
  // mid-sequence /thinktag toggle can't flip stripping between beats.
  const hideThink = getHideThink();
  let cartridgeOverride: string | null | undefined = isVNSurface ? "visual-novel" : undefined;
  // The message actually sent to the LLM — defaults to the raw user text,
  // overridden below (single-speaker cases 1/5 only) with a room-orientation
  // intro ("In room X, there is Y. The user asks: ..."). Session/room-transcript
  // persistence always uses the RAW body.message, never this.
  let effectiveMessage = body.message ?? "";

  if (isVNSurface && agentMemoryStore) {
    try {
      const narrativeEntries = await agentMemoryStore.recall("narrative state current", {
        scopes: ["narrative"],
        topK: 3,
      });
      const narrativeState = narrativeEntries.find((e: any) => e.type === "narrative_state");
      if (narrativeState) {
        let narrativeBlock: string;
        try {
          const parsed = JSON.parse(narrativeState.content);
          narrativeBlock = [
            "[Narrative State]",
            `  Scene: ${parsed.currentScene ?? "unknown"}`,
            `  Characters: ${(parsed.activeCharacters ?? []).join(", ") || "none"}`,
            `  Mood: ${parsed.mood ?? "neutral"}`,
            parsed.flags && Object.keys(parsed.flags).length > 0
              ? `  Flags: ${Object.entries(parsed.flags).map(([k, v]) => `${k}=${v}`).join(", ")}`
              : null,
            parsed.counters && Object.keys(parsed.counters).length > 0
              ? `  Counters: ${Object.entries(parsed.counters).map(([k, v]) => `${k}=${v}`).join(", ")}`
              : null,
            parsed.choiceHistory && parsed.choiceHistory.length > 0
              ? `  Previous choices: ${parsed.choiceHistory.map((c: any) => c.label ?? c.value).join(" → ")}`
              : null,
          ].filter(Boolean).join("\n");
        } catch {
          narrativeBlock = `[Narrative State]\n${narrativeState.content}`;
        }
        lifecycleParts.push(narrativeBlock);
      }
    } catch (err) {
      console.error("[ui] narrative bootstrap failed:", err);
    }

    try {
      const { getSharedNarrativeStore } = await import("../../../../narrative/shared-store.ts");
      const shared = getSharedNarrativeStore("rooms/_shared/memory.db");
      const sharedBootstrap = shared.buildBootstrap(agentName);
      if (sharedBootstrap) lifecycleParts.push(sharedBootstrap);
    } catch {
      // shared narrative store not available — non-fatal
    }
  }

  // ── Speaker resolution (Fable rework): presence routes, it does not
  // multiply. One user message → one speaker, resolved from presence
  // BEFORE any agent is loaded. The absent owner's pipeline never runs
  // (case 5 fixed). Fires only on the VN surface (castle rooms).
  if (isVNSurface) {
    try {
      const { occupantsOf, listRoomPresence, resolveSpeaker, buildPresenceLine, primaryVisitor, buildOrientationLine } =
        await import("../../../../narrative/presence-context.ts");
      const memoryDb = join(roomsDir, "_shared", "memory.db");
      const presenceRows = listRoomPresence(memoryDb);
      // The user ("owner") is a first-class occupant (presence row written
      // on enter), but must never be resolved as a speaker — they're the
      // one talking. Filter them out before speaker resolution.
      const USER_ID = "owner";
      const occupants = occupantsOf(memoryDb, agentName).filter((a) => a !== USER_ID);
      const filteredPresenceRows = presenceRows.filter((r) => r.agentId !== USER_ID);

      // "All" — bounded abeleat sequential flow (owner, then guest).
      // Not routed through resolveSpeaker's single-speaker contract — the client signals the mode directly. Falls through
      // to normal single-speaker resolution below when there's no
      // owner+guest pair to run two beats for (empty room, owner alone, or
      // owner absent) — those degenerate cases reuse the existing,
      // already-tested paths unchanged (SC-009, SC-010, and the owner-away
      // defensive fallback).
      const guestsForAll = occupants.filter((a) => a !== agentName);
      if (body.addressee === "all" && occupants.includes(agentName) && guestsForAll.length > 0) {
        const guestId = primaryVisitor(occupants, agentName, filteredPresenceRows) ?? guestsForAll[0];
        return withRoomLock(agentName, (lock) => runAllBeats({
          signal: lock.signal,
          lockWaitMs: lock.waitedMs,
          ownerId: agentName,
          guestId,
          occupants,
          userMessage: body.message ?? "",
          baseLifecycleParts: [...lifecycleParts],
          roomsDir,
          mode: mode as PermissionMode,
          testProviders,
          sessionManager,
          sessionStore,
          ownerAgent: agent!,
          ownerProvider: provider!,
          ownerSessionId: sessionId,
          ownerMemoryStore: agentMemoryStore,
          ownerContextEngine: agentContextEngine,
          hideThink,
        }), { queued: true });
      }

      // Explicit ordered turn-taking (2 or 3 speakers, any leader) — the
      // client sends a comma-separated list, e.g. "bruno,eli" (guest leads,
      // owner follows) — generalizes "All" beyond the fixed
      // owner-then-primary-guest order. The "All" button becomes
      // {{owner}}-{{guest}} / {{guest}}-{{owner}} pairings, capped at 3 speakers.
      // Falls through to normal resolution if the order isn't fully valid
      // (any name not currently present) rather than erroring.
      if (body.addressee && body.addressee.includes(",")) {
        const order = body.addressee.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
        const orderValid = order.length >= 2 && order.every((id) => occupants.includes(id));
        if (orderValid) {
          return withRoomLock(agentName, (lock) => runOrderedBeats({
            signal: lock.signal,
            lockWaitMs: lock.waitedMs,
            order,
            ownerId: agentName,
            occupants,
            userMessage: body.message ?? "",
            baseLifecycleParts: [...lifecycleParts],
            roomsDir,
            mode: mode as PermissionMode,
            testProviders,
            sessionManager,
            sessionStore,
            hideThink,
          }), { queued: true });
        }
      }

      const resolution = resolveSpeaker({
        ownerId: agentName,
        message: body.message ?? "",
        occupants,
        presenceRows: filteredPresenceRows,
        explicitAddressee: body.addressee && body.addressee !== "all" ? body.addressee : undefined,
      });

      // Case 4: empty room → narrator frame, zero pipelines.
      if (resolution.case === "empty") {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ agent: "narrator", type: "text", content: "The chamber is empty." })}\n\n`));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return withRoomLock(agentName, () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
      }

      // Inject the one-line presence fact (state, not script).
      const presenceLine = buildPresenceLine({
        ownerId: agentName,
        speakerId: resolution.speakerId,
        occupants,
      });
      if (presenceLine) lifecycleParts.push(presenceLine);

      // Room-orientation intro — every single-speaker VN
      // resolution (incl. case 2: owner + guest); the multi-beat flow
      // (runAllBeats/runOrderedBeats) already has its own equivalent via
      // buildFollowupMessage/buildGuestFollowupMessage and isn't touched here.
      effectiveMessage = buildOrientationLine({
        ownerId: agentName,
        occupants,
        userMessage: body.message ?? "",
      });

      // Case 5: speaker is a visitor (owner away). Reload the visitor's
      // agent + provider + SESSION so the absent owner's pipeline + history
      // never run. The visitor sees their own conversation history, not the
      // owner's — otherwise Lena reads Bruno's session turns and gets
      // confused about who she is (the "I am Bruno" bug). Re-derive the
      // per-agent fields read above (they were set from the owner).
      if (resolution.speakerId !== agentName) {
        const speakerId = resolution.speakerId;
        const speakerDir = join(roomsDir, speakerId);
        if (!existsSync(join(speakerDir, "config.yaml"))) {
          return withRoomLock(agentName, () => json({ error: `agent_not_found: ${speakerId}` }, 404));
        }
        provider = (testProviders?.get(speakerId)) ?? await resolveAgentProvider(speakerDir);
        const loader2 = new AgentLoader({ roomsDir });
        agent = await loader2.load(speakerId);
        // Re-open the session for the SPEAKER (not the room owner) so the
        // visitor's turns + history are their own. The session id below
        // now belongs to the speaker.
        const speakerSession = sessionManager.openSession(speakerId, "ui");
        sessionId = speakerSession.id;
        turns = useBranching
          ? sessionManager.getActiveBranchTurns(sessionId)
          : sessionManager.getTurns(sessionId);
        // Refresh the per-agent fields the single-agent path below uses.
        agentMemoryStore = agent.memoryStore;
        agentModel = agent.config.provider.model;
        agentContextEngine = agent.contextEngine;
        useBranching = agent.config.contextManagement?.mode === "branching";
      }
    } catch (err) {
      // Speaker resolution failed — fall through to single-agent (owner) path.
      console.error("[ui] speaker resolution failed, falling back to owner:", err);
    }
  }

  const lifecycleContext = lifecycleParts.length > 0 ? lifecycleParts.join("\n\n") : undefined;

  // ── Run turn through AgentSession (shared engine with Telegram/mesh) ──
  const jsonlStore = new JsonlStore(defaultStateDir());
  const projectRoot = resolve(roomsDir, "..");
  const cartridgeRegistry = new CartridgeRegistry({ projectRoot });
  const cartridgeLoader = new CartridgeLoader();
  const agentSession = new AgentSession({ store: jsonlStore, provider, cartridgeRegistry, cartridgeLoader });

  // The agent actually speaking this turn — agentName (room owner) by
  // default, but a visitor when case 5 reload ran. The conversationId +
  // persistence key off this so the speaker's context engine + turns are
  // their own, not the owner's (otherwise a visiting Bruno sees Eli's
  // conversation history and gets confused about who she is).
  const talkAgent = agent?.config.identity.name ?? agentName;

  const modelOverride = body.model
    ? (body.model.includes("/") ? body.model.split("/").slice(1).join("/") : body.model)
    : undefined;

  // Built inside the room lock (see the factory below), so a send that queued behind another reads the turns after
  // that one has finished, and the compaction runs under the lock too. Speaker resolution above is done first,
  // so an absent owner or an empty room never triggers a compaction.
  const makeRunStream = (signal: AbortSignal) => {
    const history = startCastleCompaction({
      store: sessionStore, sessionId, agent: talkAgent, branching: useBranching,
      provider: provider!, model: agentModel, incomingMessage: body.message ?? "",
    });
    turns = useBranching
      ? sessionManager.getActiveBranchTurns(sessionId)
      : sessionManager.getTurns(sessionId);
    return agentSession.runStream({
      signal,
      agent,
      message: effectiveMessage,
      mode: mode as PermissionMode,
      sessionId,
      modelOverride,
      memoryStore: agentMemoryStore,
      contextEngine: agentContextEngine as unknown as ContextEngine | undefined,
      contextConversationId: `ui:${talkAgent}:${sessionId}`,
      cartridgeOverride,
      imageData: body.imageData,
      lifecycleContext,
      priorMessages: turns.map((t) => ({ role: t.role, content: t.content })),
      priorSummary: history.summary,
      priorHistoryTokenBudget: history.budget,
    });
  };

  const userMessage = body.message!;
  // Wrap generator to persist turns and ingest into context engine after stream completes.
  // We also restore the per-word micro-chunk pacing the UI expects.
  async function* withPersistence(source: AsyncGenerator<ProviderChunk>): AsyncGenerator<ProviderChunk> {
    const parts: string[] = [];
    try {
      for await (const chunk of source) {
        if (chunk.type === "text" && chunk.content) parts.push(chunk.content);
        yield chunk;
      }
    } finally {
      const finalText = hideThink ? stripThinkTags(parts.join("")) : parts.join("");
      sessionManager.appendTurn(sessionId, "user", userMessage);
      sessionManager.appendTurn(sessionId, "assistant", finalText || "...");

      if (isVNSurface) {
        // Room-scoped transcript, not per-agent session — the chat log
        // reads from here so it reflects who ACTUALLY spoke in this room
        // (owner, or a reloaded visitor via case 5 / explicit addressee),
        // never the URL's room owner by default.
        try {
          const { appendTurn: appendRoomTurn } = await import("../../../../narrative/room-transcript.ts");
          const transcriptsDir = join(roomsDir, "_shared", "transcripts");
          appendRoomTurn(agentName, { speaker: "user", role: "user", content: userMessage }, transcriptsDir);
          appendRoomTurn(agentName, { speaker: talkAgent, role: "assistant", content: finalText || "..." }, transcriptsDir);
        } catch {
          // non-fatal
        }
      }

      if (agentContextEngine) {
        const now = new Date().toISOString();
        const convId = `ui:${agentName}:${sessionId}`;
        const baseSeq = turns.length + 1;
        agentContextEngine.ingest(convId, {
          id: `msg-${sessionId}-user-${Date.now()}`,
          seq: baseSeq,
          role: "user",
          content: userMessage,
          created_at: now,
        }).catch(() => { /* non-fatal */ });
        agentContextEngine.ingest(convId, {
          id: `msg-${sessionId}-assistant-${Date.now()}`,
          seq: baseSeq + 1,
          role: "assistant",
          content: finalText,
          created_at: now,
        }).catch(() => { /* non-fatal */ });
      }
    }
  }

  async function* wordChunks(source: AsyncGenerator<ProviderChunk>): AsyncGenerator<ProviderChunk> {
    const buffer: string[] = [];
    for await (const chunk of source) {
      if (chunk.type === "text" && chunk.content) {
        buffer.push(chunk.content);
      } else {
        yield chunk;
      }
    }
    const text = buffer.join("");
    if (!text) {
      yield { type: "text", content: "..." };
      return;
    }
    const tokens = text.match(/(\s*\S+\s*)/g) || [text];
    for (const token of tokens) {
      yield { type: "text", content: token };
    }
  }

  // Tag frames with the resolved speaker on the VN surface only — Town's
  // ChatPanel expects plain-string text frames and doesn't understand the
  // tagged {agent,type,content} shape. Without this, RoomScreen's
  // readBeats (castle lib/beat-stream.ts) never sees a tagged frame and falls back to the
  // URL's room owner, mislabeling (and hiding) visitor/addressee replies.
  //
  // The stream is created INSIDE the withRoomLock factory (not before it)
  // because Bun eagerly starts a ReadableStream on construction — creating it
  // before the lock is held would let the provider query run before
  // serialization. The factory runs only once the lock is held.
  return withRoomLock(agentName, (lock) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const beat = streamBeat({
      signal: lock.signal,
      meta: { room: agentName, speaker: talkAgent, provider: provider!.name, model: agentModel ?? "", lockWaitMs: lock.waitedMs },
      stream: makeRunStream,
    });
    const stream = sseFromGenerator(tracked(wordChunks(withPersistence(beat)), finish), isVNSurface ? talkAgent : undefined);
    return {
      response: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      finished,
    };
  }, { queued: true });
}


export async function agentStream(
  agentName: string,
  userMessage: string,
  deps?: UIServerDeps,
): Promise<Response> {
  if (agentName === "@shared") return json({ error: "shared_conversation_requires_authorized_api" }, 403);
  const roomsDir = deps?.roomsDir ?? defaultRoomsDir();
  // Capture hideThink once per request (SC-407/408).
  const hideThink = getHideThink();
  let provider = deps?.providers?.get(agentName);

  if (!provider) {
    try {
      const agentDir = join(roomsDir, agentName);
      if (!existsSync(join(agentDir, "config.yaml"))) return json({ error: `agent_not_found: ${agentName}` }, 404);
      provider = await resolveAgentProvider(agentDir);
    } catch (err) {
      return json({ error: "provider_resolution_failed", detail: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  const loader = new AgentLoader({ roomsDir });
  let agent: Awaited<ReturnType<typeof loader.load>> | undefined;
  try {
    agent = await loader.load(agentName);
  } catch (err) {
    return json({ error: `agent_load_failed: ${agentName}`, detail: String(err) }, 500);
  }

  const sessionStore = getSessionStore();
  const onEnd = agent.memoryStore
    ? buildSessionEndHandler(agent.memoryStore, provider, sessionStore, agent.config.provider.model, agent.roomDir)
    : undefined;
  const sessionManager = new SessionManager({ store: sessionStore, onEnd });
  const session = sessionManager.openSession(agentName, "ui");
  let sessionId = session.id;
  const useBranching = agent.config.contextManagement?.mode === "branching";
  const history = startCastleCompaction({
    store: sessionStore, sessionId, agent: agentName, branching: useBranching,
    provider, model: agent.config.provider.model, incomingMessage: userMessage,
  });
  let turns = useBranching
    ? sessionManager.getActiveBranchTurns(sessionId)
    : sessionManager.getTurns(sessionId);

  const jsonlStore = new JsonlStore(defaultStateDir());
  const projectRoot = resolve(roomsDir, "..");
  const cartridgeRegistry = new CartridgeRegistry({ projectRoot });
  const cartridgeLoader = new CartridgeLoader();
  const agentSession = new AgentSession({ store: jsonlStore, provider, cartridgeRegistry, cartridgeLoader });

  const runStream = agentSession.runStream({
    agent,
    message: userMessage,
    mode: "plan",
    sessionId,
    memoryStore: agent.memoryStore,
    contextEngine: agent.contextEngine as unknown as ContextEngine | undefined,
    contextConversationId: `ui:${agentName}:${sessionId}`,
    priorMessages: turns.map((t) => ({ role: t.role, content: t.content })),
    priorSummary: history.summary,
    priorHistoryTokenBudget: history.budget,
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
      sessionManager.appendTurn(sessionId, "user", userMessage);
      sessionManager.appendTurn(sessionId, "assistant", finalText || "...");
    }
  }

  return new Response(sseFromGenerator(withPersistence(runStream)), { headers: { "content-type": "text/event-stream" } });
}
