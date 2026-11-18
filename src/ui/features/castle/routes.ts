import { join } from "node:path";
import { handleStatus } from "./api/status";
import { createCastleFeedStream } from "./castle-feed";
import { createRoomLogStream } from "./castle-room-log";
import { createCastleReplayStream } from "./castle-replay";
import { getSharedNarrativeStore } from "../../../narrative/shared-store";
import { defaultRoomsDir } from "../../services/session-store";
import { json } from "../../utils/http";
import type { UIServerDeps } from "../../types";

export async function routes(req: Request, pathname: string, deps?: UIServerDeps): Promise<Response | null> {
  if (pathname === "/api/status" && req.method === "GET") {
    return handleStatus(deps?.roomsDir ?? defaultRoomsDir());
  }
  if (pathname === "/api/castle/feed" && req.method === "GET") {
    const url = new URL(req.url);
    const since = url.searchParams.get("since") ?? undefined;
    const stream = createCastleFeedStream({ roomsDir: deps?.roomsDir ?? defaultRoomsDir(), since });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
  if (pathname === "/api/castle/room-log" && req.method === "GET") {
    const url = new URL(req.url);
    // Repeatable: ?placeId=gate_world&placeId=gate_machine scopes a room whose
    // marker stands for more than one place (Bridge covers both gates). A single param behaves exactly as before.
    const placeIds = url.searchParams.getAll("placeId");
    if (placeIds.length === 0) {
      return json({ error: "placeId query param is required" }, 400);
    }
    const since = url.searchParams.get("since") ?? undefined;
    const stream = createRoomLogStream({ roomsDir: deps?.roomsDir ?? defaultRoomsDir(), placeId: placeIds, since });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
  if (pathname === "/api/castle/replay" && req.method === "GET") {
    const url = new URL(req.url);
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    const speed = url.searchParams.has("speed")
      ? Number(url.searchParams.get("speed"))
      : 0;
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from > to ||
      !Number.isFinite(speed) ||
      speed < 0
    ) {
      return json(
        { error: "invalid replay params: need from<=to (epoch ms), speed>=0" },
        400,
      );
    }
    const stream = createCastleReplayStream({
      from,
      to,
      speed,
      roomsDir: deps?.roomsDir ?? defaultRoomsDir(),
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
  if (pathname === "/api/castle/presence" && req.method === "GET") {
    const store = getSharedNarrativeStore(
      join(deps?.roomsDir ?? defaultRoomsDir(), "_shared", "memory.db"),
    );
    // The human user ("owner") gets their own presence row on room enter
    // (see /presence/enter below) so server-side room-case logic can see
    // them — but this endpoint feeds the map and public-room occupant
    // displays, which are agent-presence surfaces. The user is not a
    // colony agent and must never render as one here.
    const all = store.listPresence()
      .filter((p) => p.agentId !== "owner")
      .map((p) => ({
        agentId: p.agentId,
        placeId: p.placeId,
        activity: p.activity ?? null,
      }));
    return json({ agents: all });
  }
  // Room-scoped chat log — NOT per-agent (/api/turns/:agent), which only
  // ever shows one agent's own session and is wrong whenever the room's
  // active speaker differs from the URL owner (case 5, or after any
  // addressee/ordered exchange). Reads the shared room transcript
  // (src/narrative/room-transcript.ts) keyed by the room owner, so it
  // reflects who ACTUALLY spoke regardless of whose session the reply
  // also landed in. Requirement: the chat log is the room chat log,
  // not the agent chat log, to avoid a dependency.
  const roomTurnsMatch = pathname.match(/^\/api\/castle\/room-turns\/([a-zA-Z0-9_-]+)$/);
  if (roomTurnsMatch && req.method === "GET") {
    const { readTranscript } = await import("../../../narrative/room-transcript.ts");
    const transcriptsDir = join(deps?.roomsDir ?? defaultRoomsDir(), "_shared", "transcripts");
    const turns = readTranscript(roomTurnsMatch[1], transcriptsDir).map((t) => ({
      role: t.role === "narrator" ? ("assistant" as const) : t.role,
      content: t.content,
      speaker: t.role === "user" ? undefined : t.speaker,
      ts: t.ts,
    }));
    return json({ turns });
  }
  // User presence enter/leave (Fable rework): entering a room writes a
  // presence row for the user (owner in chamber_<owner>), making the user
  // a first-class occupant — case 2 vs case 5 resolvable server-side.
  // Leaving removes the row. The user id is "owner" for v1 (single-user).
  if ((pathname === "/api/castle/presence/enter" || pathname === "/api/castle/presence/leave") && req.method === "POST") {
    const store = getSharedNarrativeStore(
      join(deps?.roomsDir ?? defaultRoomsDir(), "_shared", "memory.db"),
    );
    try {
      const body = (await req.json()) as { placeId: string };
      if (!body.placeId) return json({ error: "placeId_required" }, 400);
      const userId = "owner";
      if (pathname.endsWith("/enter")) {
        // Ensure the place exists (chamber places are seeded by roster;
        // user presence reuses them).
        if (store.getPlace(body.placeId)) {
          store.setPresence({ agentId: userId, placeId: body.placeId, since: Date.now() });
        }
      } else {
        store.removePresence(userId);
      }
      return json({ ok: true });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
  return null;
}
