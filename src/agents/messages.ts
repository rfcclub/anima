import type { SessionContext } from "../session/types";
import type { ProviderMessage } from "../providers/interface";
import type { TurnRecord } from "../memory/session-store";

export function buildSessionMessages(
  context: SessionContext,
  message: string,
  mailContext?: string,
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  if (mailContext) {
    messages.push({ role: "system", content: mailContext });
  }
  if (context.baseline) {
    messages.push({
      role: "user",
      content: `[Previous conversation summary]\n${context.baseline.summary}`,
    });
    messages.push({
      role: "assistant",
      content: "Understood, I'll continue from this context.",
    });
  }
  for (const turn of context.turns) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: "user", content: message });
  return messages;
}

export function buildSessionMessagesFromTurns(
  turns: TurnRecord[],
  message: string,
  mailContext?: string,
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  if (mailContext) {
    messages.push({ role: "system", content: mailContext });
  }
  for (const turn of turns) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: "user", content: message });
  return messages;
}
