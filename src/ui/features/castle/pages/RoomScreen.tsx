import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { usePixiStage } from "../engine/use-pixi-stage";
import {
  renderRoomBackground,
  renderRoomCharacters,
  removeRoomCharacter,
  setPortraitBreathing,
  type RoomCharacter,
  type ChatTurn,
} from "../engine/room-stage";
import { chamberSceneId } from "../../../lib/vn-assets";
import { navigateAfterClick } from "../lib/navigate";
import { RoomChatLog, RoomChatLogToggle } from "../components/RoomChatLog";
import { RoomBubble } from "../components/RoomBubble";
import { parseVNResponse, renderVNText } from "../lib/parse-vn-response";
import { RoomChoices } from "../components/RoomChoices";
import { RoomInput } from "../components/RoomInput";
import { RoomUserToast } from "../components/RoomUserToast";
import { RoomWaitingBubble } from "../components/RoomWaitingBubble";
import { readBeats } from "../lib/beat-stream";
import { layoutBubbles, nextPendingSpeaker, planSlots } from "../lib/bubble-layout";
import { createStageSync, type StageSync } from "../lib/stage-sync";
import { expectedSpeakers } from "../lib/send-plan";
import { useRailClearance } from "../lib/use-rail-clearance";
import { RoomPresenceBanner } from "../components/RoomPresenceBanner";
import { AddresseeRail } from "../components/AddresseeRail";
import { RoomControls } from "../components/RoomControls";
import { usePresenceWithActivity } from "../lib/use-presence";
import { computeRoomCase } from "../lib/room-presence";
import { CASTLE } from "../lib/castle-style";
import {
  type Addressee,
  selectAddressee,
  selectOrder,
  addresseeField,
  computeSwapOrder,
  reconcileAddressee,
} from "../lib/addressee-selection";

interface RoomConversationSnapshot {
  conversationId: string | null;
  turns: ChatTurn[];
}

function asChatTurns(turns: Array<{ content: string; role: string; speaker?: string; ts?: string | number }>): ChatTurn[] {
  return turns.map((t) => ({
    role: t.role === "user" ? "user" : "assistant",
    content: t.content,
    speaker: t.speaker,
    ts: typeof t.ts === "string" ? Date.parse(t.ts) : t.ts,
  }));
}

/** The room chat log reads the room-scoped transcript (src/narrative/
 * room-transcript.ts) — who actually spoke, in order — the same source
 * Town's own ordered/all-beats talk path writes into. Requirement: reuse Town's
 * existing session — Castle does not run a
 * parallel session/history mechanism of its own. */
async function fetchRoomConversation(agentId: string): Promise<RoomConversationSnapshot> {
  try {
    const res = await fetch(`/api/castle/room-turns/${agentId}`);
    const { turns } = (await res.json()) as { turns?: Array<{ content: string; role: string; speaker?: string; ts?: number }> };
    return { conversationId: null, turns: asChatTurns(turns ?? []) };
  } catch {
    return { conversationId: null, turns: [] };
  }
}


export function RoomScreen() {
  const { agent } = useParams<{ agent: string }>();
  const navigate = useNavigate();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [visitorIds, setVisitorIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(true);
  const [userToast, setUserToast] = useState<{ text: string; key: number }>({ text: "", key: 0 });
  const [sendCount, setSendCount] = useState(0);
  const [sendStartedAt, setSendStartedAt] = useState(0);
  // Who the current (or last) send is expected to hear from, in speaking order; fixes the bubble layout from the start.
  const [sendPlan, setSendPlan] = useState<string[]>([]);
  // The send is waiting behind another one in this room (the server said `queued`).
  const [sendQueued, setSendQueued] = useState(false);
  const bootedRef = useRef(false);
  // Pixi'VN's canvas isn't ready until usePixiStage's Game.init resolves —
  // calling canvas.add() before that throws. The boot effect below draws
  // directly (independent of usePixiStage, which is called further down
  // this component with the full `ui` tree), so it must wait for this
  // instead of firing unconditionally on `[agentId]` — without it the
  // characters sometimes fail to render until a refresh
  // (same race already found & patched for the portrait-breathing ticker).
  const [canvasReady, setCanvasReady] = useState(false);

  // Explicit addressee (click-to-address) — sticky until changed, replaces
  // substring name-detection as the primary way to reach a visiting agent.
  const [addressee, setAddressee] = useState<Addressee>({ kind: "none" });
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const agentId = agent ?? "";

  // Polled presence — same source as the map, so room + map always agree.
  // Activity is needed for the meeting-passive banner ("A looks {{activity}}").
  const { presence, activityByAgent } = usePresenceWithActivity();

  // The user ("owner") is a first-class occupant (presence row written on
  // enter), but must not appear as a sprite or affect case computation —
  // they're the one talking, not a character on stage. Filter them out.
  const USER_ID = "owner";
  const agentPresence = useMemo(() => {
    const filtered: typeof presence = {};
    for (const [place, agents] of Object.entries(presence)) {
      const a = agents.filter((x) => x !== USER_ID);
      if (a.length > 0) filtered[place] = a;
    }
    return filtered;
  }, [presence]);

  // Compute which of the 5 room cases applies. Watch mode is removed
  // (Fable rework) — it's a castle-level surface landing in Step 1. For
  // now every room is interact-mode; case 3 (meetingPassive) won't fire.
  const roomState = useMemo(
    () => computeRoomCase({ ownerId: agentId, presence: agentPresence, mode: "interact" }),
    [agentId, agentPresence],
  );

  // User presence: entering a room writes a presence row for the user
  // (owner in chamber_<owner>), making the user a first-class occupant —
  // this is what makes case 2 vs case 5 resolvable server-side. Leaving
  // (unmount) removes the row. Fire-and-forget; failures don't break chat.
  useEffect(() => {
    if (!agentId) return;
    fetch("/api/castle/presence/enter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ placeId: chamberSceneId(agentId) }),
    }).catch(() => {});
    return () => {
      fetch("/api/castle/presence/leave", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ placeId: chamberSceneId(agentId) }),
      }).catch(() => {});
    };
  }, [agentId]);

  // Input is disabled when the user can't send: an empty room (case 4,
  // no one to talk to). Watch mode is gone; every room is interact.
  const inputDisabled = sending || roomState.case === "empty";

  // The raw occupant list this session (owner first when present, then
  // visitors) — used both for the addressee rail (stable order) and as the
  // base for the swap-reordered stage list below.
  const occupants = useMemo(() => {
    const sceneId = chamberSceneId(agentId);
    const raw = agentPresence[sceneId] ?? [];
    const ownerHere = raw.includes(agentId);
    const visitors = raw.filter((a) => a !== agentId);
    return ownerHere ? [agentId, ...visitors] : visitors;
  }, [agentId, agentPresence]);

  // The ordered agents[] list for the stage. Default order: owner first
  // when present, then visitors — when the owner is away (case 5),
  // visitors lead, the first visitor anchors at OWNER_PORTRAIT_XALIGN and
  // the rest chain off it. Clicking an occupant in the addressee rail
  // swaps them into slot 0 (instant reposition + glow,
  // no tween yet). "All" / no selection reverts to the natural order.
  // renderRoomCharacters chains x = prev.x + 0.82 * prev.width.
  // Reconcile the sticky selection against live occupants (SC-301..305): an
  // ordered member or clicked agent who departed is filtered out, and a
  // selection with <2 surviving speakers resets to none. The stage, waiting
  // bubble, and server all use this reconciled value so they never disagree
  // about who will speak.
  const reconciledAddressee = useMemo(
    () => reconcileAddressee(addressee, occupants),
    [addressee, occupants],
  );
  // Sync the selection state when reconciliation changed it (e.g. a member
  // departed → order trimmed or reset), so the rail reflects the reset.
  useEffect(() => {
    setAddressee((prev) => {
      const next = reconcileAddressee(prev, occupants);
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
  }, [occupants]);

  const stageAgents: RoomCharacter[] = useMemo(() => {
    const order =
      reconciledAddressee.kind === "agent" ? computeSwapOrder(occupants, reconciledAddressee.id)
      : reconciledAddressee.kind === "order" ? reconciledAddressee.order
      : occupants;
    return order.map((id) => ({
      agentId: id,
      position: id === order[0] ? "center" : "right",
      emotion: "neutral",
      highlighted: id === highlightedId,
    }));
  }, [occupants, reconciledAddressee, highlightedId]);

  // Default active agent when nothing is explicitly selected: the owner
  // if present, else the (sole/primary) guest — NEVER the URL owner
  // unconditionally. Fixes a bug: in Bruno's room with
  // Bruno away and only Lena present, the status line (and, before the
  // room-transcript fix above, the chat log) still named the absent owner.
  const defaultActiveId = occupants.includes(agentId) ? agentId : (occupants[0] ?? agentId);

  // Who the waiting-bubble status line ("{active_agent} is lost in thought") should
  // name — the resolved LEADER of whatever's currently selected, falling
  // back to defaultActiveId (not always the room owner).
  const activeSpeakerId =
    reconciledAddressee.kind === "agent" ? reconciledAddressee.id
    : reconciledAddressee.kind === "order" ? reconciledAddressee.order[0]
    : defaultActiveId;

  // Breathing bob on the portrait currently being waited on (a character
  // animation alongside the waiting caption).
  // Stops on unmount too, so a mid-wait navigation away never leaves a
  // ticker running against a torn-down canvas.
  useEffect(() => {
    if (!canvasReady) return;
    setPortraitBreathing(activeSpeakerId, sending);
    return () => setPortraitBreathing(activeSpeakerId, false);
  }, [activeSpeakerId, sending, canvasReady]);

  const handleSelectAddressee = useCallback((id: string) => {
    setAddressee((prev) => selectAddressee(prev, id));
    setHighlightedId(id);
    // Glow is the v1 feedback cue (no tween movement yet).
    setTimeout(() => setHighlightedId((cur) => (cur === id ? null : cur)), 400);
  }, []);

  const handleSelectOrder = useCallback((order: string[]) => {
    setAddressee(selectOrder(order));
    setHighlightedId(order[0] ?? null);
    setTimeout(() => setHighlightedId((cur) => (cur === order[0] ? null : cur)), 400);
  }, []);

  // The stage follows the occupants through one sync (lib/stage-sync.ts): it draws the latest stageAgents once the
  // background is up, whenever they change (including presence that resolves after boot), one draw at a time,
  // and draws a portrait again that failed to load. Replaces the one-shot boot draw that used the stageAgents of
  // the render in which the canvas became ready (castle room-avatar-late-render).
  const stageSyncRef = useRef<StageSync | null>(null);
  const [stageReady, setStageReady] = useState(false);
  useEffect(() => {
    const sync = createStageSync({
      draw: (agents) => renderRoomCharacters(agents),
      clear: (ids) => ids.forEach((id) => removeRoomCharacter(id)),
    });
    stageSyncRef.current = sync;
    return () => {
      sync.dispose();
      if (stageSyncRef.current === sync) stageSyncRef.current = null;
    };
  }, []);
  useEffect(() => {
    stageSyncRef.current?.set(stageAgents);
    setVisitorIds(stageAgents.filter((c) => c.agentId !== agentId).map((c) => c.agentId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageAgents]);
  useEffect(() => {
    if (stageReady) stageSyncRef.current?.setReady();
  }, [stageReady]);

  useEffect(() => {
    if (!agentId || !canvasReady || bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      const sceneId = chamberSceneId(agentId);
      await renderRoomBackground(sceneId);
      setStageReady(true);
      const snapshot = await fetchRoomConversation(agentId);
      setTurns(snapshot.turns);
    })();
    // No per-character cleanup here: usePixiStage's own clearStage() (Game.clear())
    // tears down the whole canvas when this page unmounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, canvasReady]);

  // Poll the room transcript so the chat log picks up turns this tab didn't
  // itself send — another agent's autonomous line, a different tab/session
  // acting on the same room — without a manual refresh (the castle
  // should behave like a live game surface). Same 5s cadence as presence
  // polling (usePresence.ts) — no WebSocket/SSE infra, per castle-vnengine's
  // stated v1 non-goal. Skipped while `sending` so an in-flight optimistic
  // send/reply is never clobbered by a poll that hasn't seen it yet.
  useEffect(() => {
    if (!agentId || sending) return;
    const id = setInterval(() => {
      fetchRoomConversation(agentId).then((snapshot) => setTurns(snapshot.turns));
    }, 5000);
    return () => clearInterval(id);
  }, [agentId, sending]);

  const sendMessage = useCallback(
    async (text: string) => {
      setTurns((prev) => [...prev, { role: "user", content: text }]);
      setUserToast((prev) => ({ text, key: prev.key + 1 }));
      setSendCount((c) => c + 1);
      setSendStartedAt(Date.now());
      setSendPlan(expectedSpeakers(reconciledAddressee, agentId, occupants, defaultActiveId));
      setSending(true);
      setSendQueued(false);
      try {
        // Talk through the agent's own real Town session — the same
        // ordered/all-beats pipeline Town uses (src/ui/features/town/api/
        // talk.ts), with full identity/tools/memory. Castle does not
        // create or maintain a session of its own (requirement: reuse
        // the Town session, no separate Castle session). When another agent visits, their
        // own reply lands in THEIR OWN session (see runOrderedBeats),
        // never a synthetic shared one.
        const addr = addresseeField(addressee);
        const res = await fetch(`/api/talk/${agentId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(addr ? { message: text, addressee: addr } : { message: text }),
        });
        // Sequential speaker protocol: one speaker per beat (tagged
        // frames), or a narrator frame (case 4 empty). Single-agent
        // replies arrive as plain text (fallback). Each beat is appended
        // as soon as it ends, so the first speaker's answer shows while
        // the next speaker is still answering.
        const beats = await readBeats(res, agentId, (beat) => {
          setTurns((prev) => [...prev, { role: "assistant", content: beat.content || "...", speaker: beat.speaker, ts: Date.now() }]);
        }, (status) => setSendQueued(status === "queued"));
        if (beats === 0) {
          setTurns((prev) => [...prev, { role: "assistant", content: "...", speaker: agentId, ts: Date.now() }]);
        }
      } catch {
        setTurns((prev) => [...prev, { role: "assistant", content: "Silence...", speaker: agentId, ts: Date.now() }]);
      } finally {
        setSending(false);
        setSendQueued(false);
      }
    },
    [agentId, addressee, reconciledAddressee, occupants, defaultActiveId],
  );

  // The latest assistant turn(s). Meeting fan-out appends one turn per
  // replying agent in a single batch, so we collect the trailing run of
  // assistant turns as the "current reply group" and render a bubble per
  // speaker. Non-meeting sends leave exactly one — same code path.
  const reversed = [...turns].reverse();
  const latestGroup: ChatTurn[] = [];
  for (const t of reversed) {
    if (t.role !== "assistant") break;
    latestGroup.unshift(t);
  }
  // Choices come from the owner's reply (first in the group) for v1 — a
  // meeting may produce multiple choice sets later, but one is enough now.
  const latestParsed = latestGroup.length > 0 ? parseVNResponse(latestGroup[0].content) : null;

  // Reply bubbles: the text of each reply, then one layout for every planned speaker of the send (answered or
  // still pending), so a bubble that is shown keeps its place when the next one arrives or a speaker declines.
  const bubbleTexts = latestGroup.map((t) => {
    const parsed = parseVNResponse(t.content);
    return parsed ? (renderVNText(parsed) || t.content) : t.content;
  });
  const answeredIds = latestGroup.map((t) => t.speaker ?? agentId);
  const slots = planSlots(sendPlan, answeredIds);
  const { probe: layerProbe, minLeft: bubbleMinLeft } = useRailClearance();
  const bubbleRects = layoutBubbles(
    stageAgents.map((c) => c.agentId),
    slots.map((id) => {
      const at = answeredIds.indexOf(id);
      return at >= 0 ? { speakerId: id, textLength: bubbleTexts[at]!.length } : { speakerId: id, textLength: 0, pending: true };
    }),
    { minLeft: bubbleMinLeft },
  );
  const pendingSpeakerId = sending ? nextPendingSpeaker(slots, answeredIds) : null;
  const waitingRect = pendingSpeakerId ? bubbleRects[slots.indexOf(pendingSpeakerId)] : undefined;

  const { canvasHostRef, uiHostRef } = usePixiStage(
    <>
      <div ref={layerProbe} aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
      <button
        type="button"
        onClick={() => navigateAfterClick("/castle")}
        data-nav="castle"
        className="absolute top-4 left-[24%] rounded-md border-2 border-castle-cream bg-castle-bg-translucent text-castle-cream text-lg tracking-wide px-4 py-1.5 cursor-pointer hover:bg-castle-hover pointer-events-auto z-10"
        style={{
          position: "absolute",
          top: 16,
          left: "24%",
          borderRadius: 6,
          border: `2px solid ${CASTLE.cream}`,
          background: CASTLE.bgTranslucent,
          color: CASTLE.cream,
          fontSize: 18,
          letterSpacing: "0.05em",
          padding: "6px 16px",
          cursor: "pointer",
          zIndex: 10,
        }}
      >
        ◂ Castle
      </button>
      <RoomControls agentId={agentId} />
      <RoomPresenceBanner
        case={roomState.case}
        ownerId={agentId}
        visitors={roomState.visitors}
        ownerDestination={roomState.ownerDestination}
        activityByAgent={activityByAgent}
        mode="interact"
      />
      <AddresseeRail
        occupants={occupants}
        ownerId={agentId}
        addressee={addressee}
        activeSpeakerId={activeSpeakerId}
        onSelect={handleSelectAddressee}
        onSelectOrder={handleSelectOrder}
      />
      {/* Full transcript incl. the current reply — the floating dialogue
          bubble below is suppressed while the log is open, so the log is
          the single source of truth for "what's the latest message" and
          the two surfaces never fight over the same screen space. */}
      <RoomChatLog turns={turns} collapsed={chatCollapsed} />
      <RoomChatLogToggle collapsed={chatCollapsed} onToggle={() => setChatCollapsed((c) => !c)} />
      {chatCollapsed && latestGroup.map((t, i) => {
        const rect = bubbleRects[slots.indexOf(answeredIds[i]!)];
        return rect && bubbleTexts[i] ? (
          <RoomBubble key={`${t.speaker ?? agentId}-${i}`} speaker={t.speaker ?? agentId} text={bubbleTexts[i]!} rect={rect} />
        ) : null;
      })}
      {sending && chatCollapsed && waitingRect && (
        <RoomWaitingBubble rollKey={sendCount} startedAt={sendStartedAt} rect={waitingRect} queued={sendQueued} />
      )}
      <RoomUserToast text={userToast.text} dismissKey={userToast.key} />
      <RoomChoices choices={latestParsed?.choices ?? []} onPick={sendMessage} />
      <RoomInput onSend={sendMessage} disabled={inputDisabled} />
    </>,
    navigate,
    () => setCanvasReady(true),
  );

  return (
    <div className="relative w-full h-screen bg-castle-bg" data-testid="room-screen"
      style={{ position: "relative", width: "100%", height: "100vh", background: CASTLE.bg }}>
      <div ref={canvasHostRef} className="absolute inset-0" style={{ position: "absolute", inset: 0 }} />
      <div ref={uiHostRef} className="absolute inset-0" style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
