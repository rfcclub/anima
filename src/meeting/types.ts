import yaml from "js-yaml";

// Re-export mesh types for consumers migrating from A2A
export type { MeshMessage, MeshEnvelope, Pattern, Role } from "colony-mesh";

/**
 * Options for configuring a multi-agent meeting session.
 */
export interface MeetingOptions {
  /** Number of round-robin turns per agent (default: 3). */
  turns?: number;
  /** If true, resume today's existing meeting transcript. */
  resume?: boolean;
  /** Directive appended to every agent's prompt each turn. */
  inject?: string;
  /** Provider name override (e.g. "gemini", "claude"). */
  provider?: string;
}

/**
 * An A2A (agent-to-agent) message, stored as a Markdown file with
 * YAML frontmatter in the meeting room (`rooms/_meeting/<topic>/`).
 *
 * Phase 1: schema defined and types implemented. File-based meeting
 * room wiring (writing, polling, wake mechanism) is Phase 2.
 */
export interface A2AMessage {
  /** Sender agent name (e.g. "bruno"). */
  from: string;
  /** Recipient agent name (e.g. "eli"). Use "all" for broadcast. */
  to: string;
  /** ISO 8601 timestamp (e.g. "2026-05-17T12:00:00Z"). */
  timestamp: string;
  /** Topic label, used as subdirectory name in the meeting room. */
  topic: string;
  /** Monotonically increasing turn number within the topic. */
  turn: number;
  /** Markdown body content after the YAML frontmatter. */
  body: string;
}

const REQUIRED_A2A_FIELDS = ["from", "to", "timestamp", "topic", "turn"] as const;

/**
 * Parse a Markdown string with YAML frontmatter into an `A2AMessage`.
 *
 * Expected format:
 * ```markdown
 * ---
 * from: bruno
 * to: eli
 * timestamp: 2026-05-17T12:00:00Z
 * topic: rate-limiter-design
 * turn: 3
 * ---
 *
 * Message body in Markdown...
 * ```
 *
 * Throws `A2AParseError` if the frontmatter is missing, invalid, or
 * lacks required fields.
 */
export function parseA2AMessage(markdown: string): A2AMessage {
  const trimmed = markdown.trimStart();

  if (!trimmed.startsWith("---")) {
    throw new A2AParseError("missing YAML frontmatter delimiter (---)");
  }

  // Find the closing `---` after the opening one
  const endOfFirst = trimmed.indexOf("\n", 3); // skip past the first `---\n`
  if (endOfFirst === -1) {
    throw new A2AParseError("unclosed YAML frontmatter");
  }

  const endDelim = trimmed.indexOf("\n---", endOfFirst + 1);
  if (endDelim === -1) {
    throw new A2AParseError("unclosed YAML frontmatter (missing trailing ---)");
  }

  const yamlBlock = trimmed.slice(endOfFirst + 1, endDelim);
  const bodyStart = endDelim + 4; // skip past `\n---`
  const body = trimmed.slice(bodyStart).trim();

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlBlock);
  } catch (err: unknown) {
    throw new A2AParseError(
      `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new A2AParseError("YAML frontmatter must be an object");
  }

  const record = parsed as Record<string, unknown>;

  // Validate required fields
  for (const field of REQUIRED_A2A_FIELDS) {
    if (record[field] === undefined || record[field] === null) {
      throw new A2AParseError(`missing required field: ${field}`);
    }
  }

  // Type-check each field
  if (typeof record.from !== "string") {
    throw new A2AParseError("field 'from' must be a string");
  }
  if (typeof record.to !== "string") {
    throw new A2AParseError("field 'to' must be a string");
  }
  // js-yaml parses ISO 8601 dates as Date objects; accept both
  const timestamp = record.timestamp instanceof Date
    ? record.timestamp.toISOString()
    : typeof record.timestamp === "string"
      ? record.timestamp
      : null;
  if (!timestamp) {
    throw new A2AParseError("field 'timestamp' must be a string");
  }
  if (typeof record.topic !== "string") {
    throw new A2AParseError("field 'topic' must be a string");
  }
  if (typeof record.turn !== "number" || !Number.isInteger(record.turn)) {
    throw new A2AParseError("field 'turn' must be an integer");
  }

  return {
    from: record.from,
    to: record.to,
    timestamp,
    topic: record.topic,
    turn: record.turn,
    body,
  };
}

/** Error type for A2A message parsing failures. */
export class A2AParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2AParseError";
  }
}
