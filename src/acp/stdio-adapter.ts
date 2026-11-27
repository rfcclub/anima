/**
 * Throwaway Agent Client Protocol (ACP) stdio adapter, for the evaluation in
 * rfcclub/anima#672. It is protocol only: it never reads the substrate, never
 * touches the file system and never runs a turn itself. A host supplies the
 * room-turn behaviour, so the same adapter can be pointed at an ANIMA turn or
 * at a test double.
 *
 * Guarantees that the evaluation depends on:
 * - no client-visible path: the `cwd` a client sends is never used or echoed,
 *   and a `cwd` that names a substrate, secrets or credentials directory is
 *   refused instead of being mapped to anything;
 * - no client file-system or terminal methods: `fs/*` and `terminal/*` are
 *   answered with "method not found", so the client is never told this agent
 *   can read or write local files;
 * - a permission prompt is a request to the client with no default; the host
 *   decides what to do with the answer.
 */

/** One `session/update` payload. The prototype emits text chunks and tool calls. */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpPermissionRequest {
  toolCall: { toolCallId: string; title: string; kind?: string; [key: string]: unknown };
  options: AcpPermissionOption[];
}

/** The client's answer to `session/request_permission`, passed through unchanged. */
export interface AcpPermissionOutcome {
  outcome: { outcome: string; optionId?: string };
}

/** The prompt a client sent, flattened to text. Non-text blocks are dropped. */
export interface AcpTurnRequest {
  sessionId: string;
  prompt: string;
  signal: AbortSignal;
  onUpdate(update: AcpSessionUpdate): void;
  requestPermission(request: AcpPermissionRequest): Promise<AcpPermissionOutcome>;
}

export interface AcpHost {
  /** Start a session for the one agent this flag names. The client cannot choose the agent. */
  newSession(): Promise<{ sessionId: string }>;
  /** Run one room turn. `stopReason` is an ACP stop reason such as `end_turn`. */
  prompt(request: AcpTurnRequest): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void> | void;
}

export interface AcpStdioAdapterOptions {
  host: AcpHost;
  /** One JSON-RPC message per line, without the newline. */
  write(line: string): void;
  /** Request ids this adapter sends when it asks the client something. */
  nextRequestId?: () => number;
}

export const ACP_PROTOCOL_VERSION = 1;

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INVALID_REQUEST = -32600;
const PARSE_ERROR = -32700;
const INTERNAL_ERROR = -32603;

/** Client methods that are refused rather than implemented. */
const REFUSED_CLIENT_METHODS = new Set([
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/wait_for_exit",
  "terminal/kill",
  "terminal/release",
  "session/load",
]);

/**
 * Path segments that must never be mapped into a session: substrate contents,
 * credentials and the runtime home. A client that asks for one is refused so a
 * harness cannot use the adapter to discover or address them.
 */
const PROTECTED_SEGMENTS = new Set(["substrate", "secrets", "credentials", "providers.d", ".ssh", ".anima", ".config"]);

function protectedSegment(path: string): string | undefined {
  return path.split(/[\\/]+/).find((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()));
}

/** Prompt content blocks to plain text. Only `text` blocks are used; others are ignored. */
function promptText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const parts = blocks
    .map((block) => (block as { type?: unknown; text?: unknown } | null))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block!.text as string);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

interface Session {
  id: string;
  controller?: AbortController;
}

/** One JSON-RPC message, in or out. Only the fields the prototype uses. */
interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class AcpStdioAdapter {
  private readonly host: AcpHost;
  private readonly write: (line: string) => void;
  private readonly nextRequestId: () => number;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<number | string, (message: RpcMessage) => void>();

  constructor(options: AcpStdioAdapterOptions) {
    this.host = options.host;
    this.write = options.write;
    let requestId = 0;
    this.nextRequestId = options.nextRequestId ?? (() => ++requestId);
  }

  /** Handle one line of client input. Resolves when the answer has been written. */
  async handleLine(line: string): Promise<void> {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.writeError(null, PARSE_ERROR, "invalid JSON");
      return;
    }
    if (typeof message !== "object" || message === null) {
      this.writeError(null, INVALID_REQUEST, "invalid request");
      return;
    }
    // A message without a method is the client answering a request of ours.
    if (message.method === undefined) {
      this.settle(message);
      return;
    }
    await this.handleRequest(message);
  }

  private settle(message: RpcMessage): void {
    if (message.id === undefined || message.id === null) return;
    const resolve = this.pending.get(message.id);
    if (!resolve) return;
    this.pending.delete(message.id);
    resolve(message);
  }

  private async handleRequest(message: RpcMessage): Promise<void> {
    const method = message.method as string;
    const isNotification = message.id === undefined || message.id === null;

    if (REFUSED_CLIENT_METHODS.has(method)) {
      // Never echo params: they can contain the path the client asked about.
      if (!isNotification) this.writeError(message.id ?? null, METHOD_NOT_FOUND, "method not supported");
      return;
    }

    switch (method) {
      case "initialize": {
        this.writeResult(message.id ?? null, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
        });
        return;
      }
      case "authenticate": {
        // The agent identity comes from the flag and its config, never from the client.
        this.writeResult(message.id ?? null, {});
        return;
      }
      case "session/new": {
        await this.newSession(message);
        return;
      }
      case "session/prompt": {
        await this.prompt(message);
        return;
      }
      case "session/cancel": {
        await this.cancel(message);
        return;
      }
      default: {
        if (!isNotification) this.writeError(message.id ?? null, METHOD_NOT_FOUND, "method not supported");
      }
    }
  }

  private async newSession(message: RpcMessage): Promise<void> {
    const params = (message.params ?? {}) as { cwd?: unknown; mcpServers?: unknown };
    if (typeof params.cwd === "string") {
      const segment = protectedSegment(params.cwd);
      if (segment !== undefined) {
        // Refuse without naming the segment: the client sent it, we do not repeat it.
        this.writeError(message.id ?? null, INVALID_PARAMS, "working directory not allowed");
        return;
      }
    }
    try {
      const { sessionId } = await this.host.newSession();
      this.sessions.set(sessionId, { id: sessionId });
      // `mcpServers` is ignored: the prototype starts no client-supplied servers.
      this.writeResult(message.id ?? null, { sessionId });
    } catch {
      this.writeError(message.id ?? null, INTERNAL_ERROR, "session could not be created");
    }
  }

  private async prompt(message: RpcMessage): Promise<void> {
    const id = message.id ?? null;
    const params = (message.params ?? {}) as { sessionId?: unknown; prompt?: unknown };
    const session = typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
    if (!session) {
      this.writeError(id, INVALID_PARAMS, "unknown session");
      return;
    }
    const prompt = promptText(params.prompt);
    if (prompt === undefined) {
      this.writeError(id, INVALID_PARAMS, "a text prompt is required");
      return;
    }
    if (session.controller) {
      this.writeError(id, INVALID_REQUEST, "a turn is already running for this session");
      return;
    }

    const controller = new AbortController();
    session.controller = controller;
    try {
      const { stopReason } = await this.host.prompt({
        sessionId: session.id,
        prompt,
        signal: controller.signal,
        onUpdate: (update) => this.writeNotification("session/update", { sessionId: session.id, update }),
        requestPermission: (request) => this.requestPermission(session.id, request),
      });
      this.writeResult(id, { stopReason });
    } catch {
      this.writeError(id, INTERNAL_ERROR, "the turn failed");
    } finally {
      session.controller = undefined;
    }
  }

  private async cancel(message: RpcMessage): Promise<void> {
    const params = (message.params ?? {}) as { sessionId?: unknown };
    const session = typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
    if (!session) return;
    session.controller?.abort();
    await this.host.cancel(session.id);
    // `session/cancel` is a notification in ACP; it has no reply even when it carries an id.
  }

  private requestPermission(sessionId: string, request: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const id = this.nextRequestId();
    return new Promise<AcpPermissionOutcome>((resolve) => {
      this.pending.set(id, (message) => {
        const result = message.result as AcpPermissionOutcome | undefined;
        resolve(result ?? { outcome: { outcome: "cancelled" } });
      });
      this.writeNotification("session/request_permission", { sessionId, ...request }, id);
    });
  }

  private writeResult(id: number | string | null, result: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private writeError(id: number | string | null, code: number, message: string): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  private writeNotification(method: string, params: unknown, id?: number): void {
    const message = id === undefined
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id, method, params };
    this.write(JSON.stringify(message));
  }
}

/** The adapter is off unless the flag names one agent. A path-like value is not an agent. */
export function acpEnabled(env: Record<string, string | undefined>): boolean {
  const agent = env.ANIMA_ACP_AGENT;
  return typeof agent === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(agent);
}
