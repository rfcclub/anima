export type SessionRole = "user" | "assistant";

export interface SessionTurn {
  timestamp: string;
  type: "turn";
  sessionId: string;
  role: SessionRole;
  content: string;
}

export type TurnEvent = SessionTurn;

export interface CompactEvent {
  timestamp: string;
  type: "compact";
  sessionId: string;
  summary: string;
  turnCount: number;
  dateRange: {
    from: string;
    to: string;
  };
  model: string;
}

export interface ResetEvent {
  timestamp: string;
  type: "reset";
  sessionId: string;
}

export type SessionEvent = SessionTurn | CompactEvent | ResetEvent;

export interface SessionContext {
  sessionId: string;
  date: string;
  baseline?: CompactEvent;
  turns: SessionTurn[];
}
