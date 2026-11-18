import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import type { A2AMessage } from "./types";

export interface MailCheckerOptions {
  roomsDir?: string;
}

export class MailChecker {
  private readonly roomsDir: string;

  constructor(options: MailCheckerOptions = {}) {
    this.roomsDir = resolve(options.roomsDir ?? join(process.cwd(), "rooms"));
  }

  async check(agent: string, lastActivity: string): Promise<A2AMessage[]> {
    const meetingDir = join(this.roomsDir, "_meeting");
    if (!existsSync(meetingDir)) {
      return [];
    }

    const messages: A2AMessage[] = [];
    const topics = await readdir(meetingDir, { withFileTypes: true });
    for (const topicEntry of topics) {
      if (!topicEntry.isDirectory()) {
        continue;
      }

      const topicDir = join(meetingDir, topicEntry.name);
      const files = await readdir(topicDir, { withFileTypes: true });
      for (const fileEntry of files) {
        if (!fileEntry.isFile() || !isDatedMarkdown(fileEntry.name)) {
          continue;
        }

        const path = join(topicDir, fileEntry.name);
        const content = await Bun.file(path).text();
        let message: A2AMessage;
        try {
          message = parseMailMessage(content);
        } catch {
          continue;
        }

        if ((message.to === agent || message.to === "all") && isAfter(message.timestamp, lastActivity)) {
          messages.push(message);
        }
      }
    }

    messages.sort((left, right) => {
      const byTimestamp = left.timestamp.localeCompare(right.timestamp);
      if (byTimestamp !== 0) return byTimestamp;
      return left.topic.localeCompare(right.topic);
    });

    if (messages.length > 50) {
      console.warn(`mail circuit breaker: ${agent} has ${messages.length} unread A2A messages; skipping injection`);
      return [];
    }

    return messages;
  }

  async markRead(agent: string, topic: string, timestamp: string): Promise<void> {
    const agentDir = join(this.roomsDir, agent);
    const checkpointPath = join(agentDir, "mail-checkpoint.json");
    await mkdir(agentDir, { recursive: true });

    let checkpoint: Record<string, string> = {};
    if (existsSync(checkpointPath)) {
      try {
        const parsed = await Bun.file(checkpointPath).json();
        if (isStringRecord(parsed)) {
          checkpoint = parsed;
        }
      } catch {
        checkpoint = {};
      }
    }

    checkpoint[topic] = timestamp;
    await Bun.write(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n");
  }

  formatMailContext(messages: A2AMessage[]): string {
    return messages
      .map((message) => [
        `[Unread A2A — from ${message.from} in topic ${message.topic} at ${message.timestamp}]`,
        `${message.from}: ${message.body}`,
      ].join("\n"))
      .join("\n\n");
  }
}

function isDatedMarkdown(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.md$/.test(name);
}

function isAfter(timestamp: string, lastActivity: string): boolean {
  return Date.parse(timestamp) > Date.parse(lastActivity);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function parseMailMessage(markdown: string): A2AMessage {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith("---")) {
    throw new Error("missing YAML frontmatter");
  }

  const firstLineEnd = trimmed.indexOf("\n", 3);
  if (firstLineEnd === -1) {
    throw new Error("unclosed YAML frontmatter");
  }

  const closing = trimmed.indexOf("\n---", firstLineEnd + 1);
  if (closing === -1) {
    throw new Error("unclosed YAML frontmatter");
  }

  const parsed = yaml.load(trimmed.slice(firstLineEnd + 1, closing), {
    schema: yaml.FAILSAFE_SCHEMA,
  });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("frontmatter must be an object");
  }

  const frontmatter = parsed as Record<string, unknown>;
  const timestamp = normalizeTimestamp(frontmatter.timestamp);
  const turn = normalizeTurn(frontmatter.turn);
  if (
    typeof frontmatter.from !== "string" ||
    typeof frontmatter.to !== "string" ||
    typeof frontmatter.topic !== "string" ||
    turn === null ||
    timestamp === null
  ) {
    throw new Error("invalid A2A frontmatter");
  }

  return {
    from: frontmatter.from,
    to: frontmatter.to,
    timestamp,
    topic: frontmatter.topic,
    turn,
    body: trimmed.slice(closing + 4).trim(),
  };
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return null;
}

function normalizeTurn(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}
