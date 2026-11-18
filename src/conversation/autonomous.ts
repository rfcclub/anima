import { join } from "node:path";
import { SharedTurnCoordinator } from "./coordinator";
import { renderSharedContext } from "./context";
import { buildSharedIdentityText } from "./shared-identity";
import { ConversationService } from "./service";
import { generateSharedSpeech } from "./speech";
import { drainConversationProjection } from "./projections";
import type { SharedConversationRecord, SharedUtteranceRecord } from "./types";
import { SessionStore } from "../memory/session-store";
import { JsonlGardenEventStore } from "../garden/event-store";
import type { Meeting, SharedNarrativeStore } from "../narrative/shared-store";
import type { Provider } from "../providers/interface";
import { AgentLoader } from "../agents/loader";

/** Same graceful-degrade helper as the UI talk path
 *  (src/ui/features/castle/api/conversation.ts) — loads the agent's own
 *  room the way the pre-existing legacy talk.ts path already does,
 *  extracts only SOUL/substrate identity content, degrades to no
 *  identity content rather than failing the turn if the room can't be
 *  loaded. */
async function loadSpeakerIdentityText(speakerId: string, roomsDir: string): Promise<string | null> {
  try {
    const agent = await new AgentLoader({ roomsDir }).load(speakerId);
    return (await buildSharedIdentityText(agent)) ?? null;
  } catch {
    return null;
  }
}

export interface SharedAutonomousConversationAdapterOptions {
  sessionStore: SessionStore;
  conversationService: ConversationService;
  narrativeStore: SharedNarrativeStore;
  operatorId: string;
  providers: Map<string, Provider | Promise<Provider | null>>;
  roomsDir: string;
  now?: () => number;
}

export interface AutonomousEncounterInput {
  encounterId: string;
  speakerId: string;
  colleagueId: string;
  placeId: string;
}

export interface AutonomousMeetingInput {
  meetingId: string;
  speakerId: string;
}

/** The autonomous source adapter deliberately shares the coordinator and
 * canonical rows, but not the UI's request parsing or agent-private runner.
 * It is the narrow bridge that keeps an encounter/meeting from becoming a
 * second transcript system. */
export class SharedAutonomousConversationAdapter {
  private readonly coordinator: SharedTurnCoordinator;

  constructor(private readonly options: SharedAutonomousConversationAdapterOptions) {
    this.coordinator = new SharedTurnCoordinator(options.sessionStore);
  }

  async speakEncounter(input: AutonomousEncounterInput): Promise<SharedUtteranceRecord | null> {
    const target = this.options.conversationService.getOrCreateAmbientForSpeech(input.placeId);
    // An ambient audience transition is a hard fence for autonomous speech:
    // do not let an action selected under the old room membership speak into a
    // fresh epoch. A later tick can decide again with current presence.
    if (target.changed || !target.conversation.readerIds.includes(input.speakerId) || !target.conversation.readerIds.includes(input.colleagueId)) return null;
    return this.submitSpeech({
      conversation: target.conversation,
      speakerId: input.speakerId,
      requestKey: `encounter:${input.encounterId}:${input.speakerId}`,
      source: "encounter",
      sourceId: input.encounterId,
      currentText: `Autonomous encounter: ${input.speakerId} meets ${input.colleagueId} at ${input.placeId}. Say one short in-character exchange line.`,
      instructions: "You are in a brief autonomous encounter. Speak one short sentence only; decline if you have nothing useful to add.",
    });
  }

  async speakMeeting(input: AutonomousMeetingInput): Promise<SharedUtteranceRecord | null> {
    const now = this.now();
    const meeting = this.options.narrativeStore.openMeetings(now).find((candidate) => candidate.id === input.meetingId);
    if (!meeting) throw new Error("meeting is closed");
    if (!this.options.narrativeStore.isAttending(meeting.id, input.speakerId)) throw new Error("speaker is not attending meeting");
    const conversation = this.getOrCreateMeetingConversation(meeting);
    if (!conversation.readerIds.includes(input.speakerId)) throw new Error("speaker is outside frozen meeting reader set");
    const utterance = await this.submitSpeech({
      conversation,
      speakerId: input.speakerId,
      requestKey: `meeting:${meeting.id}:${input.speakerId}:${meeting.turns}`,
      source: "meeting",
      sourceId: meeting.id,
      meetingId: meeting.id,
      currentText: `Autonomous meeting turn. Topic: ${meeting.topic}. Agenda: ${meeting.agenda}. Speak one concise in-character contribution, or decline.`,
      instructions: "You are in a restricted meeting. Stay on the stated agenda. You may decline; do not use tools or private memory.",
    });
    if (!utterance) return null;
    const applied = this.options.narrativeStore.recordMeetingTurn(meeting.id, input.speakerId, now, String(utterance.turnId));
    if (!applied.ok) throw new Error(`meeting turn requires reconciliation: ${applied.reason}`);
    return utterance;
  }

  private getOrCreateMeetingConversation(meeting: Meeting): SharedConversationRecord {
    const bound = this.options.narrativeStore.getMeetingConversation(meeting.id);
    if (bound?.conversationId) {
      const existing = this.options.sessionStore.getSharedConversation(bound.conversationId);
      if (!existing || existing.closedAt) throw new Error("meeting conversation is unavailable");
      return existing;
    }
    if (meeting.visibility === "colony") {
      const ambient = this.options.conversationService.getOrCreateAmbientForSpeech(meeting.placeId);
      if (ambient.changed) throw new Error("room-public meeting closed by ambient audience rotation");
      this.options.narrativeStore.bindMeetingConversation(meeting.id, {
        conversationId: ambient.conversation.sessionId,
        visibility: "colony",
        readerIds: ambient.conversation.readerIds,
      });
      return ambient.conversation;
    }
    const readerIds = [...new Set([...this.options.narrativeStore.initialMeetingReaders(meeting.id), this.options.operatorId])].sort();
    const conversation = this.options.sessionStore.createSharedConversation({
      kind: "meeting",
      meetingId: meeting.id,
      placeId: meeting.placeId,
      visibility: "members",
      readerIds,
    });
    this.options.narrativeStore.bindMeetingConversation(meeting.id, { conversationId: conversation.sessionId, visibility: "members", readerIds });
    return conversation;
  }

  private async submitSpeech(input: {
    conversation: SharedConversationRecord;
    speakerId: string;
    requestKey: string;
    source: "encounter" | "meeting";
    sourceId: string;
    meetingId?: string;
    currentText: string;
    instructions: string;
  }): Promise<SharedUtteranceRecord | null> {
    const provider = await Promise.resolve(this.options.providers.get(input.speakerId));
    if (!provider) throw new Error("shared provider unavailable");
    const rows = await this.coordinator.submit({
      conversationId: input.conversation.sessionId,
      requestKey: input.requestKey,
      inputHash: input.requestKey,
      userId: "@autonomous",
      speakerId: input.speakerId,
      userText: input.currentText,
      source: input.source,
      sourceId: input.sourceId,
      meetingId: input.meetingId,
      omitInputUtterance: true,
    }, async () => {
      const context = renderSharedContext({
        identity: { agentId: input.speakerId, label: input.speakerId, profileText: await loadSpeakerIdentityText(input.speakerId, this.options.roomsDir) },
        instructions: input.instructions,
        agenda: input.meetingId ? `Meeting ID: ${input.meetingId}` : undefined,
        history: this.options.sessionStore.getSharedUtterances(input.conversation.sessionId),
        currentUtterance: { speakerId: "@autonomous", content: input.currentText },
        canDecline: true,
      });
      const outcome = await generateSharedSpeech({
        provider,
        agentId: input.speakerId,
        context,
        invocation: { conversationId: input.conversation.sessionId, branchId: String(input.conversation.rootBranchId), speakerId: input.speakerId, requestId: input.requestKey, beatIndex: 0 },
      });
      if (outcome.kind === "spoken") return outcome.text;
      if (outcome.kind === "declined") return null;
      throw new Error(outcome.reason);
    });
    const utterance = rows.find((row) => row.role === "assistant") ?? null;
    if (utterance) {
      // Canonical storage remains authoritative. This is only the bounded,
      // idempotent display drain so an autonomous line is visible without
      // waiting for a later UI read to repair the projection.
      await drainConversationProjection({
        store: this.options.sessionStore,
        eventStore: new JsonlGardenEventStore(join(this.options.roomsDir, "_shared", "garden", "events.jsonl")),
        conversationId: utterance.conversationId,
      }).catch(() => undefined);
    }
    return utterance;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
