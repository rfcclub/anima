import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HindsightLog } from "./hindsight-adapter";

/**
 * The end-of-session wrap-up as one Hindsight document (rfcclub/anima#674).
 *
 * A raw transcript is retained per turn and extracted in `concise` mode, so what survives is
 * decided by compression rather than by the agent. A wrap-up is the opposite: the agent chooses
 * the decisions, their reasons and the open work, and writes them once, with a fixed shape.
 *
 * The document id is derived from the session id, so writing the wrap-up again for the same
 * session replaces the first write instead of adding a second one.
 */

/** Fixed section headings, in the order the document states them. */
export const WRAPUP_SECTIONS = [
  "## Decisions made and why",
  "## What shipped",
  "## Open work",
  "## Owner corrections",
  "## Claims needing verification",
] as const;

/** The plugin's own tag namespace; a wrap-up is a document, not a fact about a file. */
export const WRAPUP_TAG = "wrapup";

const DEFAULT_CONFIG_PATH = join(homedir(), ".hindsight", "coding-agent.json");
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DOC_ID = /^wrapup-[A-Za-z0-9_-]{1,128}$/;

interface HindsightConfig {
  apiUrl: string;
  apiToken: string;
}

/**
 * `wrapup-<session>`, keeping the session id verbatim.
 *
 * Folding or lowercasing would collide two real sessions onto one document (`sess-a_b` and
 * `sess-a-b`), so a second session's wrap-up would silently replace the first. The id is
 * refused rather than sanitised when it is not a plain identifier: empty or traversal-shaped
 * text would key a document on something the server cannot keep stable.
 */
export function wrapupDocumentId(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`wrap-up: invalid session id (${SESSION_ID})`);
  const id = `wrapup-${sessionId}`;
  if (!DOC_ID.test(id)) throw new Error("wrap-up: session id does not form a document id");
  return id;
}

export interface WrapupInput {
  sessionId: string;
  content: string;
}

export interface WrapupDocument {
  documentId: string;
  content: string;
  tags: string[];
}

/** The body under one fixed heading: everything up to the next `##` heading, trimmed; "" when absent. */
function sectionBody(content: string, heading: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+/.test(line.trim()));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * Refuses a wrap-up that does not carry every fixed section with something in it. A partial
 * record is worse than none: it reads as "the agent checked and found nothing" when in fact
 * the section was never written.
 */
export function buildWrapupDocument(input: WrapupInput): WrapupDocument {
  const documentId = wrapupDocumentId(input.sessionId);
  for (const heading of WRAPUP_SECTIONS) {
    if (!sectionBody(input.content, heading)) throw new Error(`wrap-up: missing or empty section "${heading}"`);
  }
  return { documentId, content: input.content.trim(), tags: [WRAPUP_TAG] };
}

export interface RetainWrapupOptions extends WrapupInput {
  bank: string;
  /** Hindsight client config holding apiUrl and apiToken. Read on every call. */
  configPath?: string;
  fetchFn?: typeof fetch;
  log?: HindsightLog;
}

export interface RetainWrapupResult {
  outcome: "ok" | "error";
  documentId: string;
  reason?: string;
}

function readConfig(path: string): HindsightConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<HindsightConfig>;
    if (typeof parsed.apiUrl === "string" && typeof parsed.apiToken === "string" && parsed.apiUrl && parsed.apiToken) {
      return { apiUrl: parsed.apiUrl, apiToken: parsed.apiToken };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ingest the wrap-up through the bank's memories endpoint, the same write the plugin's
 * `hindsight_ingest_document` performs (`context: "ingested document"`, `strategy: "document"`).
 *
 * Never throws: the caller is an agent ending a session, and a failed memory write must not
 * fail the session. It throws only on a wrap-up that cannot be built at all.
 */
export async function retainWrapup(options: RetainWrapupOptions): Promise<RetainWrapupResult> {
  const document = buildWrapupDocument(options);
  const log = options.log ?? (() => {});
  const done = (outcome: "ok" | "error", reason?: string): RetainWrapupResult => {
    log(outcome === "ok" ? "info" : "error", "hindsight wrapup retain", {
      bank: options.bank,
      outcome,
      ...(reason ? { reason } : {}),
    });
    return { outcome, documentId: document.documentId, ...(reason ? { reason } : {}) };
  };

  const config = readConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  if (!config) return done("error", "config-unavailable");

  const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/default/banks/${encodeURIComponent(options.bank)}/memories`;
  try {
    const res = await (options.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            content: document.content,
            context: "ingested document",
            document_id: document.documentId,
            tags: document.tags,
            strategy: "document",
          },
        ],
        async: true,
      }),
    });
    if (!res.ok) return done("error", `status-${res.status}`);
    return done("ok");
  } catch (error) {
    return done("error", error instanceof Error ? error.name : "unknown");
  }
}
