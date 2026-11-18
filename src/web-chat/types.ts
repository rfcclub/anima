export const ADAPTER_VERSION = "web-chat-1";
export const SERVICES = {
  claude: "https://claude.ai/new",
  chatgpt: "https://chatgpt.com/",
  grok: "https://grok.com/",
  gemini: "https://gemini.google.com/app",
} as const;
export type ChatService = keyof typeof SERVICES;
export interface ChatOwner {
  agent: string;
  session: string;
}
export interface ChatAccount {
  id: string;
  service: ChatService;
  validatedVersion?: string;
  validatedService?: ChatService;
  planTier?: string;
  deadlineMs?: number;
}
export function hasCurrentValidation(
  account: ChatAccount | undefined,
  version = ADAPTER_VERSION,
): boolean {
  return (
    !!account &&
    account.validatedVersion === version &&
    account.validatedService === account.service
  );
}
export type RequestState =
  | "queued"
  | "sending"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown_submission"
  | "needs_login"
  | "needs_verification"
  | "rate_limited"
  | "unsupported_page";
export interface ChatConversation {
  id: string;
  createdAt: number;
  owner: ChatOwner;
  account: string;
  service: ChatService;
  url?: string;
  blocked: boolean;
  closed: boolean;
}
export interface TurnBaseline {
  userCount: number;
  assistantCount: number;
  url: string;
}
export interface BrowserAnswer {
  text: string;
  turnId: string;
  url: string;
}
export interface ReconcileResult {
  state: "completed" | "still_generating" | "unknown_submission";
  answer?: BrowserAnswer;
}
export interface BrowserRunner {
  run(
    conversation: ChatConversation,
    prompt: string,
    signal: AbortSignal,
    submitted: (turnId: string, url: string, baseline?: TurnBaseline) => void,
    baseline?: (value: TurnBaseline) => void,
  ): Promise<BrowserAnswer>;
  reconcile?(
    conversation: ChatConversation,
    request: ChatRequest,
    signal: AbortSignal,
  ): Promise<ReconcileResult>;
  close(conversationId: string): Promise<void>;
}
export interface SendAudit {
  agent: string;
  session: string;
  conversationId: string;
  account: string;
  service: ChatService;
  promptDigest: string;
  promptLength: number;
  at: number;
}
export interface ChatRequest {
  id: string;
  owner: ChatOwner;
  conversationId: string;
  retryKey: string;
  audit: SendAudit;
  state: RequestState;
  createdAt: number;
  deadlineAt: number;
  updatedAt: number;
  answer?: string;
  truncated: boolean;
  turnId?: string;
  url?: string;
  baseline?: TurnBaseline;
  late: boolean;
  reason?: string;
  usage: null;
}
export interface ChatEvent {
  cursor: number;
  at: number;
  state: RequestState;
}
export interface ChatResult extends ChatRequest {
  events: ChatEvent[];
  cursor: number;
}
export interface ChatLimits {
  global: number;
  queue: number;
  promptChars: number;
  answerChars: number;
  deadlineMs: number;
}
export const DEFAULT_LIMITS: ChatLimits = {
  global: 2,
  queue: 8,
  promptChars: 16_000,
  answerChars: 32_000,
  deadlineMs: 300_000,
};
export class BrowserFailure extends Error {
  constructor(
    public readonly state:
      | "needs_login"
      | "needs_verification"
      | "rate_limited"
      | "unsupported_page",
    public readonly beforeSubmission = true,
  ) {
    super(state);
  }
}
