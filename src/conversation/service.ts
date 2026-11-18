import type { SharedConversationRecord, SharedConversationVisibility } from "./types";
import { SessionStore } from "../memory/session-store";

export interface ResolvedSharedPlace {
  placeId: string;
  visibility: SharedConversationVisibility;
  occupants: string[];
}

export interface ConversationServiceOptions {
  store: SessionStore;
  operatorId: string;
  resolvePlace(placeId: string): ResolvedSharedPlace | null;
  isKnownColonyPrincipal(principalId: string): boolean;
  listKnownColonyPrincipals?(): string[];
}

export class ConversationService {
  constructor(private readonly options: ConversationServiceOptions) {}

  /**
   * Resolve the currently readable ambient epoch without opening one. A room
   * page may observe an empty room, but observation must never create a
   * conversation or expose the prior epoch after its audience changed.
   */
  getAmbientForRead(placeId: string): SharedConversationRecord | null {
    const place = this.options.resolvePlace(placeId);
    if (!place) throw new Error("unknown shared place");
    const current = this.options.store.getOpenAmbientConversation(placeId);
    if (!current) return null;
    const readers = this.readersFor(place);
    return current.visibility === "colony" || this.sameIds(current.readerIds, readers)
      ? current
      : null;
  }

  getOrCreateAmbientForSpeech(placeId: string, expectedConversationId?: string): {
    conversation: SharedConversationRecord;
    changed: boolean;
  } {
    const place = this.options.resolvePlace(placeId);
    if (!place) throw new Error("unknown shared place");
    const readers = this.readersFor(place);
    const currentVacancyVersion = this.options.store.getPlaceVacancyVersion(placeId);
    const current = this.options.store.getOpenAmbientConversation(placeId);
    if (!current) return { conversation: this.createAmbient(place, readers, undefined, currentVacancyVersion), changed: false };
    if (expectedConversationId && current.sessionId !== expectedConversationId) throw new Error("conversation_changed");

    const wasVacant = current.vacancyVersion !== currentVacancyVersion;
    if (wasVacant) {
      // The room was fully empty since this epoch opened — always a fresh,
      // non-inherited root, regardless of vote: this is not a "new occupant
      // joined an active room" case, it is "no one was here to vote."
      this.options.store.closeSharedConversation(current.sessionId);
      return { conversation: this.createAmbient(place, readers, undefined, currentVacancyVersion), changed: true };
    }

    if (place.visibility === "colony" || this.sameIds(current.readerIds, readers)) {
      return { conversation: current, changed: false };
    }
    const agentReaders = current.readerIds.filter((id) => id !== this.options.operatorId);
    const newReader = readers.find((id) => !current.readerIds.includes(id));
    const inherit = newReader && this.voteHistorySharing(agentReaders, newReader) === "share";
    this.options.store.closeSharedConversation(current.sessionId);
    return { conversation: this.createAmbient(place, readers, inherit ? current.sessionId : undefined, currentVacancyVersion), changed: true };
  }

  authorizeRead(principalId: string, conversationId: string): boolean {
    const conversation = this.options.store.getSharedConversation(conversationId);
    return !!conversation && (conversation.readerIds.includes(principalId) || (conversation.visibility === "colony" && this.options.isKnownColonyPrincipal(principalId)));
  }

  authorizeSpeak(principalId: string, conversationId: string): boolean {
    return this.authorizeRead(principalId, conversationId);
  }

  resetAmbient(principalId: string, conversationId: string): void {
    if (principalId !== this.options.operatorId) throw new Error("only the operator may reset a shared ambient epoch");
    const conversation = this.options.store.getSharedConversation(conversationId);
    if (!conversation || conversation.kind !== "ambient") throw new Error("ambient conversation not found");
    this.options.store.closeSharedConversation(conversationId);
  }

  voteHistorySharing(existingAgentReaders: string[], newPrincipalId: string): "share" | "deny" {
    if (!this.options.isKnownColonyPrincipal(newPrincipalId)) return "deny";
    const voters = existingAgentReaders.filter((id) => id !== this.options.operatorId);
    return voters.length > 0 ? "share" : "deny";
  }

  private createAmbient(place: ResolvedSharedPlace, readerIds: string[], inheritedFromConversationId?: string, vacancyVersion?: number): SharedConversationRecord {
    return this.options.store.createSharedConversation({ kind: "ambient", placeId: place.placeId, visibility: place.visibility, readerIds, inheritedFromConversationId, vacancyVersion });
  }

  private readersFor(place: ResolvedSharedPlace): string[] {
    if (place.visibility === "colony") return this.sortUnique([...(this.options.listKnownColonyPrincipals?.() ?? place.occupants), this.options.operatorId]);
    return this.sortUnique([...place.occupants, this.options.operatorId]);
  }

  private sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((id, index) => id === b[index]);
  }

  private sortUnique(ids: string[]): string[] {
    return [...new Set(ids)].sort();
  }
}

// ── Production wiring ───────────────────────────────────────────────────────

/** Narrow slice of `SharedNarrativeStore` this factory depends on — avoids
 *  importing the full concrete class just to read place/presence facts. */
export interface PlacePresenceSource {
  getPlace(id: string): { id: string; kind: string } | null;
  listPresence(): Array<{ agentId: string; placeId: string }>;
}

export interface ConversationServiceProductionOptions {
  store: SessionStore;
  operatorId: string;
  narrativeStore: PlacePresenceSource;
  /** Colony roster (`data/colony.json` agent ids), loaded by the caller —
   *  this module does not read colony.json itself (dev vs prod path differs,
   *  see CLAUDE.md); the caller already loads it once at composition root. */
  listColonyAgentIds: () => string[];
}

/** `place.kind === "chamber"` is a private agent room (members visibility); every other kind (hall/garden/workshop/gate_*) is a
 *  common space (colony visibility). */
function visibilityForPlaceKind(kind: string): SharedConversationVisibility {
  return kind === "chamber" ? "members" : "colony";
}

export function createConversationService(opts: ConversationServiceProductionOptions): ConversationService {
  return new ConversationService({
    store: opts.store,
    operatorId: opts.operatorId,
    resolvePlace: (placeId) => {
      const place = opts.narrativeStore.getPlace(placeId);
      if (!place) return null;
      const occupants = opts.narrativeStore.listPresence()
        .filter((p) => p.placeId === placeId)
        .map((p) => p.agentId);
      return { placeId, visibility: visibilityForPlaceKind(place.kind), occupants };
    },
    isKnownColonyPrincipal: (id) => opts.listColonyAgentIds().includes(id),
    listKnownColonyPrincipals: () => opts.listColonyAgentIds(),
  });
}
