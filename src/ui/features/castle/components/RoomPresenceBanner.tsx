import type { CSSProperties } from "react";
import type { RoomCase, RoomMode } from "../lib/room-presence";
import { placeLabel } from "../lib/place-labels";
import { CASTLE } from "../lib/castle-style";

export interface RoomPresenceBannerProps {
  case: RoomCase;
  ownerId: string;
  visitors: string[];
  /** PlaceId the owner went to, when away (case 5). */
  ownerDestination?: string;
  /** Per-agent activity strings (placeId→activity is wrong; this is
   *  agentId→activity) for the meeting-passive banner. */
  activityByAgent?: Record<string, string | null | undefined>;
  mode: RoomMode;
}

/** Status banner that reflects real room occupancy. Renders one message per
 *  case (see room-presence.ts). Inline-styled — this lives in the detached
 *  Pixi'VN HTML layer where Tailwind is unreliable (same convention as
 *  every other Room component). Sits top-center, below the ◂ Castle button.
 *
 *  The banner is informational only — it never blocks the input. Input
 *  enablement is decided by RoomScreen from the case + mode. */
export function RoomPresenceBanner({
  case: roomCase,
  ownerId,
  visitors,
  ownerDestination,
  activityByAgent,
  mode,
}: RoomPresenceBannerProps) {
  const text = bannerText({ roomCase, ownerId, visitors, ownerDestination, activityByAgent, mode });
  if (!text) return null;

  return (
    <div
      data-testid="room-presence-banner"
      style={{
        position: "absolute",
        top: 56,
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "60%",
        background: CASTLE.bgTranslucent,
        border: `1px solid ${CASTLE.creamFaint}`,
        borderRadius: 8,
        padding: "8px 16px",
        color: CASTLE.parchment,
        fontSize: 15,
        lineHeight: 1.4,
        textAlign: "center",
        pointerEvents: "none",
        zIndex: 9,
      }}
    >
      {text}
    </div>
  );
}

function bannerText({
  roomCase,
  ownerId,
  visitors,
  ownerDestination,
  activityByAgent,
  mode,
}: {
  roomCase: RoomCase;
  ownerId: string;
  visitors: string[];
  ownerDestination?: string;
  activityByAgent?: Record<string, string | null | undefined>;
  mode: RoomMode;
}): string {
  const looks = (agent: string) => {
    const a = activityByAgent?.[agent];
    return a ? `looks ${a}` : "looks idle";
  };

  switch (roomCase) {
    case "normal":
      // Subtle — owner is home alone. No banner needed; returning empty
      // hides the banner entirely so normal chat feels uncluttered.
      return "";
    case "meetingActive":
      return `${cap(ownerId)} and ${list(visitors)} are in the room.`;
    case "meetingPassive": {
      const all = [ownerId, ...visitors];
      const parts = all.map((a) => `${cap(a)} ${looks(a)}`).join(", ");
      return `${cap(ownerId)} and ${list(visitors)} are in the room — ${parts}. Use the chat log to see what the 2 agents did.`;
    }
    case "empty":
      return "The room is empty, nobody is in the room.";
    case "visitorOnly": {
      const where = ownerDestination ? `to ${placeLabel(ownerDestination)}` : "away";
      return `${cap(ownerId)} has gone ${where}, leaving only ${list(visitors)} in the room.`;
    }
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function list(agents: string[]): string {
  if (agents.length === 0) return "";
  if (agents.length === 1) return cap(agents[0]);
  return agents.slice(0, -1).map(cap).join(", ") + " and " + cap(agents[agents.length - 1]);
}

// Re-export the style type for callers that need to position around the banner.
export type { CSSProperties };
