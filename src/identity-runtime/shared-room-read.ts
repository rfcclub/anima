import { existsSync } from "node:fs";
import { join } from "node:path";
import { recallSharedContext } from "../conversation/context";
import { createConversationService, type ConversationService } from "../conversation/service";
import { SessionStore } from "../memory/session-store";
import { getSharedNarrativeStore } from "../narrative/shared-store";
import type { SharedRoomReadResult } from "./contract/remote-continuity.ts";

export function createSharedRoomReader(options: {
  store: SessionStore;
  conversationService: ConversationService;
  enabled: () => boolean;
}) {
  return (callerId: string, placeId: string, conversationId: string): SharedRoomReadResult => {
    if (!options.enabled()) throw new Error("shared room read is disabled");
    let current;
    try { current = options.conversationService.getAmbientForRead(placeId); }
    catch { throw new Error("shared room epoch is unavailable"); }
    if (!current || current.sessionId !== conversationId || current.closedAt
      || current.vacancyVersion !== options.store.getPlaceVacancyVersion(placeId)) {
      throw new Error("shared room epoch is unavailable");
    }
    if (!options.conversationService.authorizeRead(callerId, conversationId)) {
      throw new Error("shared room read denied");
    }
    const history = recallSharedContext({
      callerId, conversationId,
      authorizeRead: (principal, id) => options.conversationService.authorizeRead(principal, id),
      getUtterances: id => options.store.getSharedUtterances(id),
      providerInputAllowanceTokens: 4096,
    }, "");
    const result = { placeId, conversationId, ...history };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 16384) throw new Error("shared room result exceeds 16 KiB");
    return result;
  };
}

/** Composition root only: canonical UI DB, never the app-server's state DB. */
export function readExternalSharedRoom(options: {
  roomsDir: string; knownAgentIds: string[];
}, callerId: string, placeId: string, conversationId: string): SharedRoomReadResult {
  if (Bun.env.ANIMA_EXTERNAL_SHARED_READS !== "1" || Bun.env.ANIMA_SHARED_CONVERSATIONS !== "1") {
    throw new Error("shared room read is disabled");
  }
  const dbPath = Bun.env.ANIMA_SESSIONS_DB
    ?? join(Bun.env.ANIMA_UI_STATE_DIR ?? join(process.env.HOME ?? "~", ".anima"), "sessions.db");
  const narrativePath = join(options.roomsDir, "_shared", "memory.db");
  if (!existsSync(dbPath) || !existsSync(narrativePath)) throw new Error("shared room epoch is unavailable");
  const store = new SessionStore(dbPath);
  try {
    const conversationService = createConversationService({
      store, operatorId: "owner", narrativeStore: getSharedNarrativeStore(narrativePath),
      listColonyAgentIds: () => options.knownAgentIds,
    });
    return createSharedRoomReader({ store, conversationService, enabled: () => true })(callerId, placeId, conversationId);
  } finally { store.close(); }
}
