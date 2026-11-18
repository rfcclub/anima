import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
const [root, mode] = process.argv.slice(2);
if (!root || !isAbsolute(root) || homedir() !== root || process.env.ANIMA_HOME !== join(root, ".anima")) throw Error("fixture root forbidden before imports");
globalThis.fetch = Object.assign(async () => { throw Error("fixture network forbidden"); }, { preconnect: () => { throw Error("fixture network forbidden"); } });
const { TelegramMeetingSession } = await import("../../src/channels/telegram-session");
const { createSessionFixture } = await import("./telegram-session-context");
const fixture = mode === "default" ? undefined : createSessionFixture("fixture-child", root);
const session = mode === "injected" ? fixture!.session
  : new TelegramMeetingSession("fixture-child", {
      roomsDir: join(root, "rooms"),
      ...(mode === "lifecycle-only" ? { lifecycle: fixture!.lifecycle } : {}),
      ...(mode === "channel-only" ? { channel: fixture!.channel } : {}),
    });
try {
  const result = await session.process(mode === "injected" ? "@bruno hello" : "/who");
  console.log(JSON.stringify({ reply: result.reply, defaultDbCreated: existsSync(join(root, ".anima/sessions.db")), inboundCalls: fixture?.inbound.length ?? 0 }));
} finally { await session.end(); if (fixture && fixture.session !== session) await fixture.session.end(); }
