import type { Fs, State } from "./types.ts";
import type { IncidentEvent } from "./incidents.ts";
import { createHash } from "node:crypto";

export interface AlertAction { kind: string; label?: string; port?: string }
export interface Message { kind: "open" | "recovered" | "cap" | "last-good-invalid"; key: string; text: string }
export interface Transport { send(text: string): Promise<void> }

const MAX_MESSAGE_LENGTH = 400;
const redact = (value: string): string => value.replace(/[A-Za-z0-9_:-]{30,}/g, "[redacted]");
const safeText = (text: string): string => redact(text).slice(0, MAX_MESSAGE_LENGTH);
const shortId = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8);
// Redaction hides long tokens, but the message still has to name the incident: when part of a key
// is redacted, a short stable hash prefix of the whole key keeps distinct incidents distinct.
const visibleKey = (key: string, limit: number): string => {
  const redacted = redact(key);
  if (redacted === key) return redacted.slice(0, limit);
  const suffix = `#${shortId(key)}`;
  return `${redacted.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
};

export function messagesFor(events: IncidentEvent[], actions: AlertAction[], done: string[]): Message[] {
  const messages: Message[] = [];
  for (const event of events) {
    if (event.kind === "opened") {
      const keyLabel = visibleKey(event.key, 100);
      const prefix = `INCIDENT ${keyLabel}: `;
      const reason = redact(event.reason).slice(0, MAX_MESSAGE_LENGTH - prefix.length);
      const remaining = Math.max(0, MAX_MESSAGE_LENGTH - prefix.length - reason.length);
      const doneText = done.map((item) => `\ndone: ${redact(item)}`).join("").slice(0, remaining);
      const text = `${prefix}${reason}${doneText}`;
      messages.push({ kind: "open", key: event.key, text: safeText(text) });
    } else {
      // Reserve the prefix so the clip cannot cut the short identity off the end of the key.
      const prefix = "RECOVERED ";
      messages.push({
        kind: "recovered",
        key: event.key,
        text: safeText(`${prefix}${visibleKey(event.key, MAX_MESSAGE_LENGTH - prefix.length)}`),
      });
    }
  }
  for (const action of actions) {
    const alert = (kind: "cap" | "crashloop" | "port", value: string, text: string) => {
      const identity = `${kind}|${value}`;
      const key = `${kind}|${createHash("sha256").update(identity).digest("hex")}`;
      messages.push({ kind: kind === "cap" ? "cap" : "open", key, text: safeText(text) });
    };
    if (action.kind === "alert-cap") {
      const label = action.label ?? "unknown";
      alert("cap", label, `restart cap reached for ${label}`);
    } else if (action.kind === "alert-crashloop") {
      const label = action.label ?? "unknown";
      alert("crashloop", label, `crash loop detected for ${label}`);
    } else if (action.kind === "alert-port") {
      const port = action.port ?? "unknown";
      alert("port", port, `port ${port} is unavailable`);
    }
  }
  return messages;
}

export function enqueue(state: State, messages: Message[]): State {
  const queue = [...state.queue];
  for (const original of messages) {
    const message = { ...original, text: safeText(original.text) };
    if (message.kind === "recovered") {
      const unseen = queue.some((queued) => queued.kind === "open" && queued.key === message.key);
      if (unseen) {
        for (let index = queue.length - 1; index >= 0; index--) {
          if (queue[index]?.kind === "open" && queue[index]?.key === message.key) {
            queue.splice(index, 1);
          }
        }
        continue;
      }
    }
    if (!queue.some((queued) => queued.kind === message.kind && queued.key === message.key)) queue.push(message);
  }
  return { ...state, queue };
}

export function readTelegramEnv(fs: Fs, path: string): { token: string; chat: string } | null {
  let contents: string | undefined;
  try { contents = fs.read(path); } catch { return null; }
  if (contents === undefined) return null;
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2] ?? "";
    values[match[1]!] = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  }
  const token = values.TELEGRAM_BOT_TOKEN;
  const chat = values.TELEGRAM_CHAT_ID;
  return token && chat ? { token, chat } : null;
}

export function telegramTransport(creds: { token: string; chat: string }, fetchFn: typeof fetch): Transport {
  return {
    async send(text: string): Promise<void> {
      let response: Response;
      try {
        response = await fetchFn(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: creds.chat, text: safeText(text) }),
        });
      } catch {
        throw new Error("Telegram request failed");
      }
      if (!response.ok) throw new Error(`Telegram answered ${response.status}`);
    },
  };
}

export async function flush(
  state: State,
  transport: Transport | null,
  dryRun: boolean,
): Promise<{ state: State; sent: number; lines: string[] }> {
  if (dryRun) return { state, sent: 0, lines: state.queue.map((message) => `DRY-RUN ${safeText(message.text)}`) };
  if (!transport) return { state, sent: 0, lines: [] };

  const queue = [...state.queue];
  let sent = 0;
  while (queue.length > 0) {
    const message = queue[0]!;
    try {
      await transport.send(safeText(message.text));
    } catch {
      break;
    }
    queue.shift();
    sent++;
  }
  return { state: { ...state, queue }, sent, lines: [] };
}
