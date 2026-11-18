import { useState, type CSSProperties } from "react";
import { portraitUrl } from "../../../lib/vn-assets";
import { MAP_HEIGHT, MAP_WIDTH, pct } from "../lib/map-geometry";
import { activeHotspotId, hotspotView, nameplatePosition, nextHotspotFocus, placeOfAgent, type HotspotFocus, type HotspotToken } from "../lib/map-hotspot";
import type { MapSprite } from "../lib/map-sprites";
import type { PresenceMap } from "../lib/use-presence";

export type HotspotKind = "common" | "wing" | "chamber";

export interface HotspotItem {
  sprite: MapSprite;
  /** Presence places this building stands for (a chamber: `chamber_<id>`). */
  placeIds: string[];
  /** Chambers only: the agent whose room this is. */
  ownerId?: string;
  /** Replaces the presence status line (the wing gates summarise a wing). */
  summary?: string;
  /** Overrides the layer's attribute for this item (the wing gates on the main map). */
  attr?: string;
  onClick?: () => void;
}

const KIND_LABEL: Record<HotspotKind, string> = { common: "COMMON ROOM", wing: "CASTLE WING", chamber: "PRIVATE ROOM" };
// Nameplate box in canvas units, for placement only; the box itself sizes to its text.
const NAMEPLATE = { width: 320, height: 240 };

/** Hotspots over a painted castle map. At rest only presence tokens, window
 *  light and empty-room veils are drawn; hover or focus darkens the rest of
 *  the map, pools light on the building and shows a parchment nameplate.
 *  Each hotspot is a real button, so the map works with Tab and Enter. */
export function MapHotspotLayer({
  items,
  attr,
  kind = attr === "data-chamber" ? "chamber" : "common",
  presence,
  activities = {},
}: {
  items: HotspotItem[];
  /** Attribute carrying the sprite id (`data-room`, `data-wing`, `data-chamber`). */
  attr: string;
  kind?: HotspotKind;
  presence: PresenceMap;
  activities?: Record<string, string | null>;
}) {
  const [focusState, setFocusState] = useState<HotspotFocus>({ hover: null, focus: null });
  const activeId = activeHotspotId(focusState);
  const views = items.map((item) => {
    const occupants = item.placeIds.flatMap((p) => presence[p] ?? []);
    const view = hotspotView({
      sprite: item.sprite,
      occupants,
      ownerId: item.ownerId,
      ownerPlaceId: item.ownerId ? placeOfAgent(presence, item.ownerId) : undefined,
      activities,
    });
    const status = item.summary ?? view.status;
    const itemAttr = item.attr ?? attr;
    const itemKind: HotspotKind = itemAttr === "data-wing" ? "wing" : kind;
    return { item, attr: itemAttr, kind: itemKind, view: { ...view, status, label: `${item.sprite.label}, ${item.sprite.desc}. ${status}` } };
  });
  const active = views.find((v) => v.item.sprite.id === activeId) ?? null;

  return (
    <>
      {views.map(({ item, view }) => (
        <div key={`light-${item.sprite.id}`} aria-hidden="true">
          {view.home && <div className="castle-home-glow absolute pointer-events-none" style={pct(item.sprite.rect)} />}
          {view.away && <div className="castle-away-veil absolute pointer-events-none" style={pct(item.sprite.rect)} />}
        </div>
      ))}
      <Spotlight rect={active?.item.sprite.rect ?? null} />
      {views.map(({ item, attr: itemAttr, view }) => (
        <button
          key={item.sprite.id}
          type="button"
          {...{ [itemAttr]: item.sprite.id }}
          aria-label={view.label}
          onClick={item.onClick}
          onMouseEnter={() => setFocusState((s) => nextHotspotFocus(s, { type: "enter", id: item.sprite.id }))}
          onMouseLeave={() => setFocusState((s) => nextHotspotFocus(s, { type: "leave", id: item.sprite.id }))}
          onFocus={() => setFocusState((s) => nextHotspotFocus(s, { type: "focus", id: item.sprite.id }))}
          onBlur={() => setFocusState((s) => nextHotspotFocus(s, { type: "blur", id: item.sprite.id }))}
          className="absolute rounded-3xl border-0 bg-transparent p-0 cursor-pointer pointer-events-auto focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-castle-lantern"
          style={pct(item.sprite.rect)}
        />
      ))}
      {views.map(({ item, view }) =>
        view.tokens.length > 0 ? (
          <PresenceTokens key={`tokens-${item.sprite.id}`} rect={item.sprite.rect} tokens={view.tokens} more={view.more} talking={view.talking} />
        ) : null,
      )}
      {active && <Nameplate kind={active.kind} sprite={active.item.sprite} status={active.view.status} />}
    </>
  );
}

function Spotlight({ rect }: { rect: MapSprite["rect"] | null }) {
  const vars = rect
    ? ({
        "--x": `${((rect.left + rect.width / 2) / MAP_WIDTH) * 100}%`,
        "--y": `${((rect.top + rect.height / 2) / MAP_HEIGHT) * 100}%`,
        "--rx": `${((rect.width * 0.95 + 40) / MAP_WIDTH) * 100}%`,
        "--ry": `${((rect.height * 0.95 + 40) / MAP_HEIGHT) * 100}%`,
      } as CSSProperties)
    : {};
  const opacity = rect ? "opacity-100" : "opacity-0";
  return (
    <>
      <div aria-hidden="true" className={`castle-veil absolute inset-0 pointer-events-none ${opacity}`} style={vars} />
      <div aria-hidden="true" className={`castle-light-pool absolute inset-0 pointer-events-none ${opacity}`} style={vars} />
    </>
  );
}

function PresenceTokens({ rect, tokens, more, talking }: { rect: MapSprite["rect"]; tokens: HotspotToken[]; more: number; talking: boolean }) {
  const anchor = {
    left: `${((rect.left + rect.width * 0.8) / MAP_WIDTH) * 100}%`,
    top: `${((rect.top + rect.height * 0.8) / MAP_HEIGHT) * 100}%`,
  };
  return (
    <div aria-hidden="true" className="absolute flex -translate-x-1/2 -translate-y-full flex-col items-center gap-1 pointer-events-none" style={anchor}>
      {talking && (
        <div className="flex items-center gap-[3px] rounded-full bg-castle-parchment px-2 py-1.5 shadow-md">
          <span className="castle-talk-dot size-[5px] rounded-full bg-castle-bg" />
          <span className="castle-talk-dot size-[5px] rounded-full bg-castle-bg [animation-delay:200ms]" />
          <span className="castle-talk-dot size-[5px] rounded-full bg-castle-bg [animation-delay:400ms]" />
        </div>
      )}
      <div className="flex pl-2">
        {tokens.map((t) => <Token key={t.agentId} token={t} />)}
        {more > 0 && (
          <span className="-ml-2 flex size-10 items-center justify-center rounded-full border-2 border-castle-lantern bg-castle-panel text-xs font-semibold text-castle-parchment shadow-md">
            +{more}
          </span>
        )}
      </div>
    </div>
  );
}

/** A round portrait; the agent's initial when the portrait cannot load.
 *  Gold ring: the owner, or anyone in a common room. Parchment ring: a guest. */
function Token({ token }: { token: HotspotToken }) {
  const [failed, setFailed] = useState(false);
  const ring = token.role === "guest" ? "border-castle-parchment" : "border-castle-lantern";
  return (
    <span data-token={token.agentId} className={`-ml-2 flex size-10 items-center justify-center overflow-hidden rounded-full border-2 ${ring} bg-castle-panel font-serif text-base font-bold text-castle-parchment shadow-md`}>
      {failed ? (
        token.agentId.charAt(0).toUpperCase()
      ) : (
        <img src={portraitUrl(token.agentId, "neutral")} alt="" className="size-full object-cover object-top" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

function Nameplate({ kind, sprite, status }: { kind: HotspotKind; sprite: MapSprite; status: string }) {
  const pos = nameplatePosition(sprite.rect, NAMEPLATE);
  return (
    <div
      aria-hidden="true"
      className="castle-nameplate absolute flex min-w-[240px] flex-col gap-2 rounded bg-castle-parchment px-5 py-4 text-castle-bg shadow-2xl pointer-events-none"
      style={{ left: `${(pos.left / MAP_WIDTH) * 100}%`, top: `${(pos.top / MAP_HEIGHT) * 100}%`, width: `${(NAMEPLATE.width / MAP_WIDTH) * 100}%` }}
    >
      <div className="text-[11px] font-semibold tracking-[0.16em] text-castle-dim">{KIND_LABEL[kind]}</div>
      <div className="font-serif text-[28px] font-bold leading-none">{sprite.label}</div>
      <div className="font-serif text-base italic text-castle-dim">{sprite.desc}</div>
      <div className="h-px bg-castle-cream-faint" />
      <div className="text-sm">{status}</div>
      <div className="text-xs text-castle-dim">Click to enter ↵</div>
    </div>
  );
}
