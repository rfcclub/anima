import { useEffect, useRef, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { COMMON_ROOM_SPRITES } from "../../castle/lib/map-sprites";
import { PUBLIC_SPRITE_TO_PLACE } from "../../castle/lib/place-labels";
import { occupantsForSprite, placesForSprite } from "../../castle/lib/public-places";
import { usePresenceWithActivity } from "../../castle/lib/use-presence";
import { usePixiStage } from "../../castle/engine/use-pixi-stage";
import { renderRoomBackground, renderRoomCharacters, removeRoomCharacter, OWNER_PORTRAIT_XALIGN, type RoomCharacter } from "../../castle/engine/room-stage";
import { CASTLE } from "../../castle/lib/castle-style";
import { hasBackground } from "../../../lib/vn-assets";
import { matchPulseAnimaTickByIntegrateAndDream, matchPulseAnimaTickByIntegrate, animaComboFileName } from "../../../../narrative/pulse-anima-ticks";
import { roomSceneFileName } from "../../../../narrative/room-scene-key";

const AGENT_COLORS: Record<string, string> = { bruno: "#e94560", eli: "#00d2ff", cleo: "#3fb950", lena: "#ffd700", milo: "#bb86fc", sam: "#f0883e", "abel": "#79c0ff", finn: "#ff6b6b", gus: "#56d4dd", hana: "#ffab70", nora: "#d2a8ff", pia: "#7ee787", rhea: "#f778ba", ivan: "#8b949e" };

interface RoomLogEntry { agentName?: string; content: string; ts: string }

/** Full date+time down to the second, in the viewer's local time (day, month,
 *  year, hour, minute, second). */
function formatLogTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function truncate(text: string, max = 160): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** How long an empty room keeps narrating its last visitors before settling
 *  into ambient description (after 1-2 hours). */
const EMPTY_ROOM_AMBIENT_AFTER_MS = 60 * 60 * 1000;

/** One physical detail per common room, for the ambient idle description. */
const ROOM_AMBIENT_DETAIL: Record<string, string> = {
  hall: "The council table is bare, the chairs lined up neatly around it.",
  library: "Bookshelves stand in neat rows in the corner of the room, the scent of old paper still lingering.",
  observatory: "The telescope points up at the glass ceiling, no one is there to watch the stars.",
  forge: "The anvil and hammer lie still on the workbench, the ashes in the furnace have gone cold.",
  bodega: "The bar is empty of customers, a few glasses still left on the table.",
  bridge: "The compass lies still on the map, wind slipping through the window frame.",
};

function ambientRoomText(roomId: string, atMs: number): string {
  const detail = ROOM_AMBIENT_DETAIL[roomId] ?? "Everything is still, not a soul in sight.";
  const hour = new Date(atMs).getHours();
  const sky = hour >= 6 && hour < 18 ? "The sky outside the window is bright." : "The sky outside the window has gone dark, the lamplight flickering faintly.";
  return `The room is dead silent — ${detail} ${sky}`;
}

/** Resolves which background to show for a common room's current occupants:
 *  1. Library matching one of the 4 pulse-anima ticks (pulse-anima-ticks.ts)
 *     → its dedicated anima_batchN.png — never touched by dynamic blending,
 *     no dynamic generation here, even if more agents come in (no blending of
 *     5 people).
 *  2. A dedicated integrate+dream combo image (anima_<integrate>_<dream>.png,
 *     12 of these cover every cross-tick pairing) when the exact same-tick pairing isn't available.
 *  3. A cached dynamic-blend background for this exact occupant combination
 *     (room-scene-key.ts's "<placeId>_<sorted_agents>" convention) — these
 *     are generated server-side by RoomSceneDispatcher (continuity/
 *     room-scene-dispatcher.ts), not by this page; the page only looks for
 *     one that already exists in `backgrounds`.
 *  4. Otherwise the room's plain default background (placeId itself) —
 *     used when pulse anima isn't running, and the
 *     same applies generically while quota is exhausted or no combo file
 *     exists yet. */
function resolveRoomScene(
  placeId: string,
  occupants: string[],
  isLibrary: boolean,
  backgrounds: string[],
  integrateAgent: string | null,
  dreamAgent: string | null,
): string {
  if (occupants.length === 0) return placeId;
  if (isLibrary) {
    // Exact integrate+dream pairing (same original tick) is the best match —
    // all 4 roles' faces are correct in that batch image.
    const exactTick = matchPulseAnimaTickByIntegrateAndDream(integrateAgent, dreamAgent);
    if (exactTick !== null) return `anima_batch${exactTick}`;
    // Cross-tick pairing: integrate and dream drifted onto different ticks,
    // but a dedicated combo image exists for every such pairing —
    // better art than falling straight back to integrate-alone's batch
    // image (whose dream-role face wouldn't match who's actually dreaming).
    const combo = animaComboFileName(integrateAgent, dreamAgent);
    if (combo && hasBackground(combo, backgrounds)) return combo;
    // Neither exact nor combo matched (e.g. dreamAgent unknown) — integrate
    // alone always resolves to *a* tick once integrateAgent is one of the 4
    // known values, so a batch image still shows instead of falling through
    // to the plain default.
    const integrateTick = matchPulseAnimaTickByIntegrate(integrateAgent);
    if (integrateTick !== null) return `anima_batch${integrateTick}`;
  }
  const roomCombo = roomSceneFileName(placeId, occupants);
  return hasBackground(roomCombo, backgrounds) ? roomCombo : placeId;
}

/** Build the stage list for renderRoomCharacters — same chaining contract
 *  RoomScreen.tsx uses (agents[0] anchors, each next agent chains off the
 *  previous one), just without an "owner" concept: common rooms have no
 *  fixed occupant, so order is whatever usePresence returns this poll. */
function toStageAgents(occupants: string[]): RoomCharacter[] {
  return occupants.map((agentId, i) => ({
    agentId,
    position: i === 0 ? "center" : "right",
    emotion: "neutral",
  }));
}

/** Common rooms are shared spaces, not owned — no host, no default roster.
 *  Who's "here" comes from live presence (usePresence); the room starts
 *  empty and only shows agents that have actually moved there. Occupants
 *  are staged on the real Pixi'VN canvas (room-stage.ts) — the same engine
 *  and portrait/background asset pipeline /rooms/:agent uses — not a flat
 *  CSS background with small corner icons (those were too small
 *  next to full-screen room art).
 *  No agent chat from this surface — occupancy + room activity log only.
 *  Exit goes back to the castle map the room was entered from — not Town. */
export function PublicRoomPage() {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const roomId = params?.room || location.pathname.replace("/", "") || "hall";
  const room = COMMON_ROOM_SPRITES.find((s) => s.id === roomId) ?? COMMON_ROOM_SPRITES[0];
  const placeId = PUBLIC_SPRITE_TO_PLACE[room.id];

  const { presence, activityByAgent } = usePresenceWithActivity();
  // Occupants come from the sprite's WHOLE place set, via the same helper the
  // map badges use (lib/public-places.ts) — never a lone single-place lookup.
  // Regression: the Bridge marker showed an occupant while
  // /bridge rendered nobody, because the map folds gate_world + gate_machine
  // into one sprite but this page read only gate_world, while many
  // wanders land on gate_machine. `placeId` stays the
  // primary/first place for the background scene + room-log scope.
  const occupants = occupantsForSprite(room.id, presence);
  // Which present occupant, if any, is currently the pulse-anima "integrate"
  // stage agent — the one stable anchor for picking a batch image once the
  // 4 stages have drifted out of lockstep (matchPulseAnimaTickByIntegrate).
  const integrateAgent = occupants.find((id) => activityByAgent[id] === "pulse:integrate") ?? null;
  // Second anchor — see resolveRoomScene's docstring for why checking
  // dream too (exact same-tick pairing, or the dedicated combo image)
  // beats integrate alone.
  const dreamAgent = occupants.find((id) => activityByAgent[id] === "pulse:dream") ?? null;

  // Pulse-anima's 4 stage-agents gather in Library — lined up from the left
  // (like the chamber default) with one of the 4 group-scene backgrounds,
  // instead of the wide centered layout other common rooms use.
  const isLibrary = room.id === "library";
  const firstXAlign = isLibrary ? OWNER_PORTRAIT_XALIGN : 0.5;
  // Chamber-sized (62%-height, bottom-anchored) portraits duplicate the
  // group already painted into the anima_batch backgrounds and crowd the
  // screen with 4 of them side by side — so they are shrunk to small
  // thumbnails at the top. Common
  // rooms show a roster, not a single dialogue partner, so a small
  // top-anchored strip fits any occupant count without competing with the
  // background art.
  const characterHeightFactor = 0.1;
  const characterYFactor = 0.14;

  const [entries, setEntries] = useState<RoomLogEntry[]>([]);
  const latestEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const [logCollapsed, setLogCollapsed] = useState(true);
  const bootedRef = useRef(false);
  const stagedRef = useRef<string[]>([]);
  const sceneRef = useRef<string | null>(null);
  // Same race as RoomScreen.tsx: canvas.add() throws before usePixiStage's
  // Game.init resolves — the boot effect below draws independently of
  // usePixiStage (called further down with the full `ui` tree), so it must
  // wait for this instead of firing unconditionally on `[placeId]`.
  const [canvasReady, setCanvasReady] = useState(false);

  // Drives the empty-room narration from "just left" to "ambient" over time
  // without needing a new log event to trigger the re-render.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // The list of existing background files — used to detect a dynamic-blend
  // combo file (RoomSceneDispatcher generates these server-side, up to a
  // couple minutes after occupants change) without this page ever calling
  // any generation itself. Re-checked on the same 60s cadence as nowTick so
  // a newly-generated file appears without needing a fresh presence change.
  const [backgrounds, setBackgrounds] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/vn/assets")
      .then((res) => res.json())
      .then((data: { backgrounds?: string[] }) => setBackgrounds(data.backgrounds ?? []))
      .catch(() => { /* keep the previous list — a fetch hiccup shouldn't blank the scene */ });
  }, [nowTick]);

  // The center overlay always describes the room's current state — occupied
  // (latest work), just-vacated (who was here, what happened), or long-idle
  // (ambient description) — from ONE source (live presence + the room log),
  // never a stale log entry shown regardless of who's actually here (a stale
  // log entry must not claim agents are present while presence already
  // reports the room empty; two independent sources would disagree).
  const msSinceLastEntry = latestEntry ? nowTick - new Date(latestEntry.ts).getTime() : Infinity;
  const overlay =
    occupants.length > 0 && latestEntry
      ? {
          header: latestEntry.agentName?.toUpperCase(),
          body: latestEntry.content,
          footer: formatLogTimestamp(latestEntry.ts),
        }
      : latestEntry && msSinceLastEntry < EMPTY_ROOM_AMBIENT_AFTER_MS
        ? {
            header: undefined,
            body: `${latestEntry.agentName ? `${latestEntry.agentName.toUpperCase()} was here — ` : ""}${truncate(latestEntry.content)} — has left.`,
            footer: formatLogTimestamp(latestEntry.ts),
          }
        : { header: undefined, body: ambientRoomText(room.id, nowTick), footer: undefined };

  // Room chat log — scoped to this room only, distinct from the colony-wide
  // Timeline.
  useEffect(() => {
    setEntries([]);
    // Every place this marker stands for, not just the primary one — the
    // Bridge's log has to carry what happened at the Machine Gate too, or the
    // room reads empty (and stale) while the map badge says someone is there.
    const scoped = placesForSprite(room.id);
    if (scoped.length === 0) return;
    const query = scoped.map((p) => `placeId=${encodeURIComponent(p)}`).join("&");
    const es = new EventSource(`/api/castle/room-log?${query}`);
    es.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data) as { ts: string; entry: Omit<RoomLogEntry, "ts"> };
        setEntries((prev) => [...prev, { ...frame.entry, ts: frame.ts }]);
      } catch { /* ignore malformed frame */ }
    };
    return () => es.close();
  }, [placeId]);

  // Boot: background once the canvas is up, then the current occupants.
  useEffect(() => {
    if (!placeId || !canvasReady || bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      const scene = resolveRoomScene(placeId, occupants, isLibrary, backgrounds, integrateAgent, dreamAgent);
      sceneRef.current = scene;
      await renderRoomBackground(scene);
      const stage = toStageAgents(occupants);
      await renderRoomCharacters(stage, firstXAlign, characterHeightFactor, characterYFactor);
      stagedRef.current = occupants;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId, canvasReady]);

  // Re-stage on every presence change (5s poll) — remove exactly who left,
  // redraw the current set. Departures matter a lot more here than in a
  // 1-owner chamber (wander turns rooms over constantly), so this tracks
  // the previous roster explicitly rather than RoomScreen.tsx's "remove
  // today's list, then re-add it" shape (which never removes a sprite for
  // someone no longer present at all).
  useEffect(() => {
    if (!bootedRef.current) return;
    const prev = stagedRef.current;
    const left = prev.filter((id) => !occupants.includes(id));
    for (const id of left) removeRoomCharacter(id);
    void renderRoomCharacters(toStageAgents(occupants), firstXAlign, characterHeightFactor, characterYFactor);
    stagedRef.current = occupants;

    // The background tracks whichever pulse-anima tick, cached dynamic-blend
    // combo, or plain default the live occupants currently resolve to —
    // re-render only when it actually changes scene, not on every 5s
    // presence poll or 60s backgrounds-list refresh.
    const scene = resolveRoomScene(placeId, occupants, isLibrary, backgrounds, integrateAgent, dreamAgent);
    if (scene !== sceneRef.current) {
      sceneRef.current = scene;
      void renderRoomBackground(scene);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occupants.join(","), backgrounds.join(",")]);

  const { canvasHostRef, uiHostRef } = usePixiStage(
    <>
      <a
        href="/castle"
        data-testid="public-room-exit"
        className="pointer-events-auto fixed z-20 flex items-center gap-2 rounded-md border-2 px-5 py-4 text-2xl tracking-wide"
        style={{
          left: 24,
          top: "50%",
          transform: "translateY(-50%)",
          borderColor: CASTLE.cream,
          background: CASTLE.bgTranslucent,
          color: CASTLE.cream,
        }}
      >
        ◂ Castle
      </a>

      <div
        className="pointer-events-none"
        style={{ position: "absolute", top: 16, left: 24, display: "flex", alignItems: "center", gap: 12 }}
      >
        <span style={{ fontSize: 28 }}>{room.icon}</span>
        <div>
          <h1 style={{ fontSize: 20, color: CASTLE.cream, fontWeight: 600, margin: 0 }}>{room.label}</h1>
          <div style={{ fontSize: 11, color: "#7a5c30" }}>{room.desc}</div>
        </div>
      </div>

      <button
        type="button"
        data-testid="public-room-log-toggle"
        onClick={() => setLogCollapsed((c) => !c)}
        className="pointer-events-auto"
        style={{
          position: "absolute",
          top: 16,
          right: 24,
          fontSize: 11,
          color: CASTLE.cream,
          border: "1px solid #3a2e1e",
          borderRadius: 4,
          padding: "4px 10px",
          background: CASTLE.bgTranslucent,
          cursor: "pointer",
        }}
      >
        {logCollapsed ? "Log ▾" : "Log ▴"}
      </button>

      {/* Center status overlay — always describes the room's current state
          (occupied / just-vacated / long-idle ambient), one source of truth
          driven by live presence + the room log. Also saved into the room
          log below (same `entries` list) so it can be reviewed later. */}
      <div
        data-testid="public-room-status"
        className="pointer-events-none"
        style={{
          position: "absolute",
          top: "70%",
          left: "50%",
          transform: "translate(-50%, 0)",
          maxWidth: 760,
          width: "min(92%, 760px)",
          background: "#2a2218b3",
          border: `1px solid ${CASTLE.cream}`,
          borderRadius: 10,
          padding: "10px 18px",
          textAlign: "center",
        }}
      >
        {overlay.header && (
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.05em",
              color: AGENT_COLORS[overlay.header.toLowerCase()] || CASTLE.cream,
              marginBottom: 2,
            }}
          >
            {overlay.header}
          </div>
        )}
        <div style={{ fontSize: 14, color: CASTLE.cream, whiteSpace: "pre-wrap" }}>{overlay.body}</div>
        {overlay.footer && <div style={{ fontSize: 10, color: "#8a7a54", marginTop: 4 }}>{overlay.footer}</div>}
      </div>

      {!logCollapsed && (
        <div
          data-testid="public-room-app-dialog"
          className="pointer-events-auto"
          style={{
            position: "absolute",
            bottom: 16,
            left: 24,
            right: 24,
            height: 320,
            overflowY: "auto",
            background: "#2a2218aa",
            border: "1px solid #3a2e1e",
            borderRadius: 8,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {entries.length === 0 && (
            <div style={{ color: "#6a5e48", fontSize: 14, textAlign: "center", padding: "32px 0", fontStyle: "italic" }}>
              No log in this room yet.
            </div>
          )}
          {entries.map((m, i) => (
            <div
              key={i}
              style={{ alignSelf: "flex-start", maxWidth: "70%", background: "#2a2218", border: "1px solid #3a2e1e", borderRadius: 8, padding: "6px 12px", fontSize: 13 }}
            >
              {m.agentName && (
                <div style={{ fontSize: 9, letterSpacing: "0.05em", marginBottom: 2, fontWeight: 600, color: AGENT_COLORS[m.agentName] || "#c9a84c" }}>
                  {m.agentName.toUpperCase()}
                </div>
              )}
              <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              <div style={{ fontSize: 9, color: "#6a5e48", marginTop: 4 }}>{formatLogTimestamp(m.ts)}</div>
            </div>
          ))}
        </div>
      )}
    </>,
    navigate,
    () => setCanvasReady(true),
  );

  return (
    <div className="relative w-full h-screen" style={{ position: "relative", width: "100%", height: "100vh", background: CASTLE.bg }}>
      <div ref={canvasHostRef} className="absolute inset-0" style={{ position: "absolute", inset: 0 }} />
      <div ref={uiHostRef} className="absolute inset-0" style={{ position: "absolute", inset: 0 }} />
    </div>
  );
}
