export type SharedConversationKind = "ambient" | "meeting";
export type SharedConversationVisibility = "members" | "colony";
export type SharedUtteranceSource = "ui" | "encounter" | "meeting";

export interface SharedConversationRecord {
  sessionId: string;
  rootBranchId: number;
  kind: SharedConversationKind;
  placeId: string;
  meetingId: string | null;
  visibility: SharedConversationVisibility;
  readerIds: string[];
  inheritedFromConversationId: string | null;
  closedAt: string | null;
  vacancyVersion: number;
}

export interface CreateSharedConversationInput {
  kind: SharedConversationKind;
  placeId: string;
  meetingId?: string;
  visibility: SharedConversationVisibility;
  readerIds: string[];
  vacancyVersion?: number;
  inheritedFromConversationId?: string;
}

export interface SharedUtteranceRecord {
  turnId: number;
  conversationId: string;
  utteranceKey: string;
  requestId: string;
  speakerId: string;
  role: "user" | "assistant";
  content: string;
  source: SharedUtteranceSource;
  sourceId: string | null;
  meetingId: string | null;
  publicPayload: string | null;
  ts: string;
}

export interface AppendSharedUtteranceInput {
  conversationId: string;
  role: "user" | "assistant";
  speakerId: string;
  content: string;
  utteranceKey: string;
  requestId: string;
  source: SharedUtteranceSource;
  sourceId?: string;
  meetingId?: string;
  publicPayload?: string;
}

export interface SharedRequestRecord {
  requestKey: string;
  conversationId: string;
  inputHash: string;
  status: "running" | "complete" | "failed" | "interrupted";
  completedSpeakers: string[];
  errorCode: string | null;
}
