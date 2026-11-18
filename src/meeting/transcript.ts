import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const writeLocks = new Map<string, Promise<void>>();

export function safeTopic(topic: string): string {
  const slug = topic.trim().toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("meeting topic resolves to empty slug");
  return slug;
}

export function transcriptRelPath(topic: string, now = new Date()): string {
  return join("_meeting", safeTopic(topic), `${now.toISOString().slice(0, 10)}.md`);
}

export async function appendMeetingTurn(opts: {
  roomsDir: string;
  topic: string;
  agentName: string;
  content: string;
  participants?: string[];
  now?: Date;
}): Promise<string> {
  const now = opts.now ?? new Date();
  const slug = safeTopic(opts.topic);
  const rel = transcriptRelPath(opts.topic, now);
  const path = join(opts.roomsDir, rel);
  const dir = join(opts.roomsDir, "_meeting", slug);

  const prev = writeLocks.get(slug) ?? Promise.resolve();
  const next = prev.then(() => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let body = existsSync(path) ? readFileSync(path, "utf-8") : [
      `# Meeting: ${opts.topic}`,
      `Date: ${now.toISOString().slice(0, 10)}`,
      `Participants: ${(opts.participants ?? []).join(", ")}`,
      "",
    ].join("\n");
    body += [
      `**${opts.agentName}** — ${now.toISOString()}`,
      "",
      opts.content.trim(),
      "",
      "---",
      "",
    ].join("\n");
    writeFileSync(path, body, "utf-8");
  });
  writeLocks.set(slug, next.catch(() => {}));
  await next;
  return rel;
}

/** Read the last N turn blocks' text (clipped) for ORIENT attending context. */
export function readRecentTurns(
  roomsDir: string,
  topic: string,
  count: number,
): string[] {
  const slug = safeTopic(topic);
  const dir = join(roomsDir, "_meeting", slug);
  if (!existsSync(dir)) return [];
  // read the newest day file
  const { readdirSync } = require("node:fs");
  const files = (readdirSync(dir) as string[]).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) return [];
  const body = readFileSync(join(dir, files[files.length - 1]), "utf-8");
  // turn blocks are separated by "---"
  const blocks = body.split(/^---\s*$/m).map((b) => b.trim()).filter((b) => b.length > 0 && !b.startsWith("# Meeting"));
  return blocks.slice(-count);
}
