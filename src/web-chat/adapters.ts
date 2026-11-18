import { SERVICES, type ChatService } from "./types";
export interface Adapter {
  editor: string;
  send: string;
  user: string;
  assistant: string;
  answer: string;
  completed: string;
  generating: string;
  login: string;
  verification: string;
  rateLimit: string;
}
/** Candidate DOM contracts, deliberately UNVERIFIED. Operator validation is version-bound; drift fails closed.
 * Completion requires a per-response lifecycle attribute, never a copy button or text-length guess. */
export const ADAPTERS: Record<ChatService, Adapter> = {
  claude: {
    editor: '.ProseMirror[contenteditable="true"]',
    send: 'button[aria-label="Send message"]',
    user: '[data-testid="user-message"]',
    assistant: '[data-testid="assistant-message"]',
    answer: ".font-claude-response",
    completed: '[data-message-status="complete"]',
    generating:
      '[data-is-streaming="true"], [data-message-status="generating"]',
    login: 'a[href*="/login"], input[type="email"]',
    verification: 'iframe[src*="challenges.cloudflare.com"]',
    rateLimit: '[data-testid="rate-limit-message"]',
  },
  chatgpt: {
    editor: "#prompt-textarea",
    send: 'button[data-testid="send-button"]',
    user: '[data-message-author-role="user"]',
    assistant: '[data-message-author-role="assistant"]',
    answer: ".markdown",
    completed:
      '[data-message-status="complete"], [aria-busy="false"][data-message-id]',
    generating: '[data-message-status="generating"], [aria-busy="true"]',
    login: 'button[data-testid="login-button"]',
    verification: 'iframe[src*="challenges.cloudflare.com"]',
    rateLimit: '[data-testid="rate-limit-message"]',
  },
  gemini: {
    editor: 'rich-textarea [contenteditable="true"]',
    send: "button.send-button",
    user: "user-query",
    assistant: "model-response",
    answer: ".model-response-text",
    completed: '[data-response-status="complete"]',
    generating: '[data-response-status="generating"], [aria-busy="true"]',
    login: 'a[href*="accounts.google.com/ServiceLogin"]',
    verification: 'iframe[src*="recaptcha"]',
    rateLimit: '[data-test-id="rate-limit"]',
  },
  grok: {
    editor: "textarea",
    send: 'button[type="submit"]',
    user: '[data-role="user"]',
    assistant: '[data-role="assistant"]',
    answer: '[data-testid="message-content"]',
    completed: '[data-message-status="complete"]',
    generating: '[data-message-status="generating"], [aria-busy="true"]',
    login: 'a[href*="accounts.x.ai"], input[type="password"]',
    verification: 'iframe[src*="challenges.cloudflare.com"]',
    rateLimit: '[data-testid="rate-limit-message"]',
  },
};
export function allowedPage(
  service: ChatService,
  url: string,
  login = false,
): boolean {
  try {
    const u = new URL(url),
      base = new URL(SERVICES[service]);
    return (
      u.protocol === "https:" &&
      (u.hostname === base.hostname ||
        (login && service === "gemini" && u.hostname === "accounts.google.com"))
    );
  } catch {
    return false;
  }
}

export const fixtureAdapter: Adapter = {
  editor: "#editor",
  send: "#send",
  user: ".user",
  assistant: ".assistant",
  answer: ".answer",
  completed: '[data-state="completed"]',
  generating: '[data-state="generating"]',
  login: ".needs-login",
  verification: ".needs-verification",
  rateLimit: ".rate-limit",
};
