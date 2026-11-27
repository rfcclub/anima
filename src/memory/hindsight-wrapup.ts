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
 * session sends the same id instead of a second one. Whether the server treats that as a replace
 * is its own behaviour: the client cannot prove it from here, so the docs record it as evidence
 * still to gather.
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

/**
 * Session ids the runtime really produces: `channel-<channelId>-<agentId>-<uuid>`, where the
 * channel can be `work:<workId>`, `remote:<caller>`, `ambient:<placeId>` or a Telegram chat id.
 * `.` and `:` are part of those ids, so they are allowed; path separators and `..` are not.
 */
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const DOC_ID = /^wrapup-[A-Za-z0-9_.:-]{1,128}$/;

/** A retain that has not come back by then is treated as failed; session end must not hang. */
export const DEFAULT_RETAIN_TIMEOUT_MS = 10_000;

interface HindsightConfig {
  apiUrl: string;
  apiToken: string;
}

/**
 * `wrapup-<session>`, keeping the session id verbatim.
 *
 * Folding or lowercasing would collide two real sessions onto one document (`sess-a_b` and
 * `sess-a-b`), so a second session's wrap-up would silently replace the first. The id is
 * refused rather than sanitised when it is traversal-shaped: text like `../../etc/passwd` would
 * key a document on something the server cannot keep stable.
 */
export function wrapupDocumentId(sessionId: string): string {
  if (!SESSION_ID.test(sessionId) || sessionId.includes("..")) {
    throw new Error(`wrap-up: invalid session id (${SESSION_ID})`);
  }
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
 * Refuses a wrap-up that does not carry every fixed section, in the documented order, with
 * something in it. A partial record is worse than none: it reads as "the agent checked and found
 * nothing" when in fact the section was never written. Out-of-order sections break the reading
 * of a diff between two sessions, so they are refused too.
 */
export function buildWrapupDocument(input: WrapupInput): WrapupDocument {
  const documentId = wrapupDocumentId(input.sessionId);
  const lines = input.content.split("\n");
  let previous = -1;
  for (const heading of WRAPUP_SECTIONS) {
    const at = lines.findIndex((line) => line.trim() === heading);
    if (at >= 0 && at < previous) throw new Error(`wrap-up: section "${heading}" is out of order`);
    if (at >= 0) previous = at;
    if (!sectionBody(input.content, heading)) throw new Error(`wrap-up: missing or empty section "${heading}"`);
  }
  return { documentId, content: input.content.trim(), tags: [WRAPUP_TAG] };
}

export interface RetainWrapupOptions extends WrapupInput {
  bank: string;
  /** Hindsight client config holding apiUrl and apiToken. Read on every call. */
  configPath?: string;
  /** Finite deadline for the write; session end must not wait on a stalled service. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  log?: HindsightLog;
}

/**
 * `ok` means the server answered the retain itself, with a body saying it processed the document:
 * a success status, or Hindsight 1.2.0's sync body (`success: true` with a non-null `items_count`).
 * `queued` means it accepted the write without confirming it (a 202, an operation id, a pending
 * status, `async: true`): the document is not yet known to exist, so it must not be counted as
 * retained until that operation reports success. A body that cannot be read, that does not count
 * the stored item, or that confirms neither way is `error`: it is no evidence of a stored
 * document.
 */
export interface RetainWrapupResult {
  outcome: "ok" | "queued" | "error";
  documentId?: string;
  operationId?: string;
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

interface RetainResponse {
  operation_id?: unknown;
  operationId?: unknown;
  status?: unknown;
  success?: unknown;
  /** True when the server accepted the work instead of processing it in this request. */
  async?: unknown;
  items_count?: unknown;
}

const QUEUED_STATUSES = new Set(["queued", "pending", "processing", "in_progress", "in-progress", "running"]);

/** Read the operation id out of a retain response; "" when it answered synchronously. */
function operationIdOf(body: RetainResponse | null): string {
  const raw = body?.operation_id ?? body?.operationId;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return "";
}

/**
 * Ingest the wrap-up through the bank's memories endpoint, the same write the plugin's
 * `hindsight_ingest_document` performs (`context: "ingested document"`, `strategy: "document"`).
 *
 * It asks for completion-aware retention (`async: false`) and bounds the wait, so `ok` means the
 * server processed the document rather than merely queueing it. A 202, or any answer naming an
 * operation, a pending status or `async: true`, yields `queued` (with the id when there is one),
 * never `ok`. A body that cannot be read, that says `success: false`, or that confirms neither way
 * is `error`: it is no evidence of a stored document, and a count of retained wrap-ups must not
 * include one that may not exist. `ok` needs a stored item, so `success: true` alone is not enough:
 * Hindsight 1.2.0's sync body names one (`success: true`, `items_count: 1`, no `status`), and a
 * numeric `items_count` of at least one is what makes it `ok`.
 *
 * Never throws: the caller is an agent ending a session, and a failed or malformed memory write
 * must not fail the session. A wrap-up that cannot be built comes back as `outcome: "error"` with
 * a `reason`, before any request is made.
 */
export async function retainWrapup(options: RetainWrapupOptions): Promise<RetainWrapupResult> {
  const log = options.log ?? (() => {});
  const done = (outcome: "ok" | "queued" | "error", extra: { documentId?: string; operationId?: string; reason?: string } = {}) => {
    log(outcome === "ok" ? "info" : "error", "hindsight wrapup retain", {
      bank: options.bank,
      outcome,
      ...(extra.documentId ? { documentId: extra.documentId } : {}),
      ...(extra.operationId ? { operationId: extra.operationId } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    });
    return {
      outcome,
      ...(extra.documentId ? { documentId: extra.documentId } : {}),
      ...(extra.operationId ? { operationId: extra.operationId } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    };
  };

  let document: WrapupDocument;
  try {
    document = buildWrapupDocument(options);
  } catch (error) {
    return done("error", { reason: `invalid-wrapup: ${error instanceof Error ? error.message : "unknown"}` });
  }
  const documentId = document.documentId;

  const config = readConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  if (!config) return done("error", { documentId, reason: "config-unavailable" });

  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_RETAIN_TIMEOUT_MS;

  const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/default/banks/${encodeURIComponent(options.bank)}/memories`;
  const controller = new AbortController();
  // Race the request against the abort so a `fetchFn` that ignores the signal (a stub, or a host
  // that keeps the socket open) still cannot hold session end past the deadline.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("retain deadline exceeded", "AbortError"));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([(options.fetchFn ?? fetch)(url, {
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
        async: false,
      }),
      signal: controller.signal,
    }), deadline]);
    if (!res.ok) return done("error", { documentId, reason: `status-${res.status}` });

    // Read the body as text first so an empty body, a non-JSON body and a stalled body each get
    // their own reason instead of all collapsing into "no status, therefore retained".
    let body: RetainResponse | null = null;
    let bodyError: "timeout" | "unreadable-body" | null = null;
    try {
      const text = (await Promise.race([res.text(), deadline])) as string;
      const parsed: unknown = text.trim() ? JSON.parse(text) : null;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as RetainResponse;
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      bodyError = aborted ? "timeout" : "unreadable-body";
    }

    const operationId = operationIdOf(body);
    const status = typeof body?.status === "string" ? body.status.toLowerCase() : "";
    // A 202 is the server saying "accepted, not done", whatever its body holds (including none):
    // that is `queued`, never `ok`. So is any body that names an operation, a pending status or
    // `async: true` — the server took the work and did not report it done, and `success: true`
    // alongside it says only that the request was accepted, not that an item was stored.
    if (res.status === 202 || operationId || QUEUED_STATUSES.has(status) || body?.async === true) {
      return done("queued", { documentId, ...(operationId ? { operationId } : {}), reason: "not-confirmed" });
    }
    // Without a readable body carrying a status there is no evidence the document was processed,
    // so it is not counted as retained.
    if (!body) return done("error", { documentId, reason: bodyError ?? "unreadable-body" });
    if (status && status !== "ok" && status !== "completed" && status !== "succeeded" && status !== "success") {
      return done("error", { documentId, reason: `status-${status}` });
    }
    // Hindsight 1.2.0 answers a synchronous retain with
    // `{"success":true,"bank_id":…,"items_count":1,"async":false,"operation_id":null}`: no
    // `status` at all. That body names the item it stored, so it is `ok`. Without a numeric
    // `items_count` of at least one there is no evidence anything was stored: `{"success":true}`
    // alone says the request succeeded, not that the document exists, so it is `error`.
    if (body.success === true) {
      const stored = typeof body.items_count === "number" ? body.items_count : Number.NaN;
      if (!Number.isFinite(stored)) return done("error", { documentId, reason: "no-item-count" });
      if (stored < 1) return done("error", { documentId, reason: "no-items" });
      return done("ok", { documentId });
    }
    if (body.success === false) return done("error", { documentId, reason: "success-false" });
    if (!status) return done("error", { documentId, reason: "unconfirmed" });
    return done("ok", { documentId });
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    return done("error", { documentId, reason: aborted ? "timeout" : error instanceof Error ? error.name : "unknown" });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
