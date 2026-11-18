import { join } from "node:path";
import { TelegramMeetingSession } from "../../src/channels/telegram-session";
import { TelegramChannel } from "../../src/channels/telegram";
import { SessionLifecycle, type SessionLifecycleContext } from "../../src/session/lifecycle";
import type { Store } from "../../src/memory/jsonl-store";

export function createSessionFixture(chatId: string, root: string, refuseInbound = false, defaultAgent?: string) {
  const opened: string[] = [], closed: string[] = [];
  const observed: Array<{ agent: string; text: string }> = [];
  const inbound: Array<{ chat: string; text: string; agents: string[] }> = [];
  const store: Store = { append() {}, readDate: () => [], readRecent: () => [], recover: () => null };
  class FixtureLifecycle extends SessionLifecycle {
    override async onOpen(agentId: string, channelId: string): Promise<SessionLifecycleContext> {
      opened.push(agentId);
      return { agentId, channelId, sessionId: `fixture:${channelId}:${agentId}`, systemContext: "", openedAt: "2026-01-01T00:00:00Z" };
    }
    override async onClose(agentId: string): Promise<void> { closed.push(agentId); }
  }
  const lifecycle = new FixtureLifecycle({ store });
  const channel = {
    parseMention: TelegramChannel.prototype.parseMention,
    parseCommand: TelegramChannel.prototype.parseCommand,
    observe(agent: string, _chat: string, text: string) { observed.push({ agent, text }); },
    async handleInbound(chat: string, text: string, agents: Set<string>) {
      inbound.push({ chat, text, agents: [...agents] });
      if (refuseInbound) throw Error("fixture inbound refused; no provider");
      return { text: "fixture response", agentNames: [...agents], isObservation: false };
    },
  };
  const session = new TelegramMeetingSession(chatId, { roomsDir: join(root, "rooms"), lifecycle, channel, defaultAgent });
  return { session, lifecycle, channel, opened, closed, observed, inbound };
}
