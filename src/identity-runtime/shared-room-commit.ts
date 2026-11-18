import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SharedTurnCoordinator, SharedTurnCancelledError } from "../conversation/coordinator";
import { createConversationService, type ConversationService } from "../conversation/service";
import { SessionStore } from "../memory/session-store";
import { getSharedNarrativeStore } from "../narrative/shared-store";
import {
  assertRoomCommitInput, RoomCommitRejectedError,
  type SharedRoomCommitInput, type SharedRoomCommitResult,
} from "./contract/remote-continuity.ts";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createSharedRoomCommitter(options: {
  store: SessionStore;
  conversationService: ConversationService;
  enabled: () => boolean;
  maySpeak: (callerId: string) => boolean;
}) {
  const coordinator = new SharedTurnCoordinator(options.store);
  return async (callerId: string, input: SharedRoomCommitInput, signal?: AbortSignal,
    authorizeGrant?: () => void): Promise<SharedRoomCommitResult> => {
    assertRoomCommitInput(input);
    // Snapshot primitives before the first await, including the idempotency fingerprint.
    const { placeId, conversationId, requestKey, text } = input;
    const key = `external-shared:${digest([callerId, requestKey])}`;
    const inputHash = digest([callerId, placeId, conversationId, text]);
    const authorize = () => {
      authorizeGrant?.();
      if (!options.enabled()) throw new RoomCommitRejectedError("shared room commit is disabled");
      if (!options.maySpeak(callerId)) throw new RoomCommitRejectedError("shared room speech denied");
      let current;
      try { current = options.conversationService.getAmbientForRead(placeId); }
      catch { throw new RoomCommitRejectedError("shared room epoch is unavailable"); }
      if (!current || current.sessionId !== conversationId || current.closedAt
        || current.vacancyVersion !== options.store.getPlaceVacancyVersion(placeId)) {
        throw new RoomCommitRejectedError("shared room epoch is unavailable");
      }
      if (!options.conversationService.authorizeSpeak(callerId, conversationId)) {
        throw new RoomCommitRejectedError("shared room speech denied");
      }
      const prior = options.store.getSharedRequest(key);
      if (prior && (prior.conversationId !== conversationId || prior.inputHash !== inputHash)) {
        throw new RoomCommitRejectedError("shared room request key conflicts");
      }
    };
    authorize();
    let rows;
    try {
      rows = await coordinator.submit({
        conversationId, requestKey: key, inputHash, userId: "@external", speakerId: callerId,
        userText: "", source: "ui", sourceId: "pi-soffio", omitInputUtterance: true, signal, authorize,
      }, async () => text);
    } catch (error) {
      if (error instanceof SharedTurnCancelledError) throw new RoomCommitRejectedError("shared room commit cancelled");
      throw error; // SQL/transport failure cannot prove that no turn landed.
    }
    const row = rows.find(row => row.role === "assistant" && row.speakerId === callerId);
    if (!row) throw new RoomCommitRejectedError("shared room request is terminal without speech");
    return { status: "committed", placeId, conversationId, requestKey, speakerId: callerId, turnId: row.turnId };
  };
}

/** Default-off composition root, sharing the existing canonical process writer. */
export async function commitExternalSharedRoom(options: {
  roomsDir: string; knownAgentIds: string[];
}, callerId: string, input: SharedRoomCommitInput, signal?: AbortSignal,
  authorizeGrant?: () => void): Promise<SharedRoomCommitResult> {
  const enabled = () => Bun.env.ANIMA_EXTERNAL_SHARED_COMMITS === "1" && Bun.env.ANIMA_SHARED_CONVERSATIONS === "1";
  const maySpeak = (id: string) => (Bun.env.ANIMA_EXTERNAL_SHARED_SPEAKERS ?? "")
    .split(",").map(value => value.trim()).filter(Boolean).includes(id);
  if (!enabled()) throw new RoomCommitRejectedError("shared room commit is disabled");
  if (!maySpeak(callerId)) throw new RoomCommitRejectedError("shared room speech denied");
  const dbPath = Bun.env.ANIMA_SESSIONS_DB
    ?? join(Bun.env.ANIMA_UI_STATE_DIR ?? join(process.env.HOME ?? "~", ".anima"), "sessions.db");
  const narrativePath = join(options.roomsDir, "_shared", "memory.db");
  if (!existsSync(dbPath) || !existsSync(narrativePath)) throw new RoomCommitRejectedError("shared room epoch is unavailable");
  const store = new SessionStore(dbPath);
  try {
    const conversationService = createConversationService({
      store, operatorId: "owner", narrativeStore: getSharedNarrativeStore(narrativePath),
      listColonyAgentIds: () => options.knownAgentIds,
    });
    return await createSharedRoomCommitter({ store, conversationService, enabled, maySpeak })(callerId, input, signal, authorizeGrant);
  } finally { store.close(); }
}
