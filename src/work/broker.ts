/**
 * Host identity broker (anima #135, WL-10 and the publish half of WL-4).
 *
 * The session's tools hold no GitHub credential. They ask this broker, over a Unix socket, to do
 * the few things publishing needs, and the broker checks every request before it asks the writer:
 *
 *  - the session token (a capability for this session only; the fence below is the real limit),
 *  - the operation, from a short allow-list: push, pr.open, pr.update-body, comment,
 *  - the claim id and generation against the work's current ones (a released claim or a newer
 *    generation is stale),
 *  - the scope: this repository, this base, this work branch, this issue or this work's PR.
 *
 * Merge, review approval, label and issue edits, force pushes and anything unknown are refused
 * without reaching the writer. The author's GitHub token comes from `githubTokenFor` (the trusted
 * authors map), per call; it goes to the writer and nowhere else.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";

export interface BrokerScope {
  repo: string;
  base: string;
  /** `work/<issue>-<workId>` */
  branch: string;
  /** Logical author whose GitHub identity publishes. */
  author: string;
  issue: number;
}

export interface WriterInput {
  args: Record<string, unknown>;
  githubToken: string;
  scope: BrokerScope;
}

export interface GitHubWriter {
  push(input: WriterInput): Promise<{ head: string }>;
  openPr(input: WriterInput): Promise<{ number: number; url: string; head: string }>;
  updatePrBody(input: WriterInput): Promise<Record<string, unknown>>;
  comment(input: WriterInput): Promise<Record<string, unknown>>;
}

export interface CurrentClaim {
  claimId: string;
  generation: number;
  active: boolean;
}

export interface BrokerOptions {
  socketPath: string;
  /** Capability for this session; compared in constant time. */
  token: string;
  scope: BrokerScope;
  /** Read at each request, and again right before the writer is called. */
  current: () => CurrentClaim;
  writer: GitHubWriter;
  /** The author's GitHub token from the trusted authors map, never from the ambient CLI login. */
  githubTokenFor: (author: string) => Promise<string>;
  log?: (event: Record<string, unknown>) => void;
}

export interface BrokerRequest {
  token?: string;
  op: string;
  args?: Record<string, unknown>;
  claimId?: string;
  generation?: number;
}

export type BrokerResponse = { ok: true; result: unknown } | { ok: false; error: string; message?: string };

export interface Broker {
  close(): Promise<void>;
}

const ALLOWED = new Set(["push", "pr.open", "pr.update-body", "comment"]);
const MAX_TEXT = 65_536;
const MAX_TITLE = 256;

const digest = (text: string) => createHash("sha256").update(text).digest();

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  return timingSafeEqual(digest(given), digest(expected));
}

const refuse = (error: string, message?: string): BrokerResponse => ({ ok: false, error, ...(message ? { message } : {}) });

function str(value: unknown, fallback: string): string | null {
  const v = value === undefined ? fallback : value;
  return typeof v === "string" ? v : null;
}

export async function createBroker(options: BrokerOptions): Promise<Broker> {
  const { scope } = options;
  const log = options.log ?? (() => {});
  let prNumber: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const stale = (req: BrokerRequest): boolean => {
    const now = options.current();
    return !now.active || req.claimId !== now.claimId || req.generation !== now.generation;
  };

  async function handle(raw: string): Promise<BrokerResponse> {
    let req: BrokerRequest;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refuse("malformed");
      req = parsed as BrokerRequest;
    } catch {
      return refuse("malformed");
    }
    if (!sameToken(req.token, options.token)) return refuse("unauthorized");
    if (typeof req.op !== "string" || !ALLOWED.has(req.op)) {
      log({ event: "broker-refused", op: String(req.op), reason: "operation" });
      return refuse("operation", `operation not allowed: ${String(req.op).slice(0, 40)}`);
    }
    if (stale(req)) {
      log({ event: "broker-refused", op: req.op, reason: "stale" });
      return refuse("stale");
    }
    const args = req.args && typeof req.args === "object" && !Array.isArray(req.args) ? req.args : {};
    const scoped = checkScope(req.op, args);
    if (scoped) return scoped;

    let githubToken: string;
    try {
      githubToken = await options.githubTokenFor(scope.author);
    } catch (error) {
      return refuse("no-identity", error instanceof Error ? error.message : "no GitHub identity for the author");
    }
    // The claim may have been released or replaced while the token was fetched.
    if (stale(req)) return refuse("stale");

    const input: WriterInput = { args, githubToken, scope };
    try {
      switch (req.op) {
        case "push":
          return { ok: true, result: await options.writer.push(input) };
        case "pr.open": {
          const result = await options.writer.openPr(input);
          prNumber = result.number;
          return { ok: true, result };
        }
        case "pr.update-body":
          return { ok: true, result: await options.writer.updatePrBody(input) };
        default:
          return { ok: true, result: await options.writer.comment(input) };
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split(githubToken).join("<token>");
      return refuse("writer-failed", message.slice(0, 500));
    }
  }

  function checkScope(op: string, args: Record<string, unknown>): BrokerResponse | null {
    const bad = (why: string) => {
      log({ event: "broker-refused", op, reason: "scope", why });
      return refuse("scope", why);
    };
    const repo = str(args.repo, scope.repo);
    if (repo !== scope.repo) return bad("repository");
    switch (op) {
      case "push":
        return str(args.branch, scope.branch) === scope.branch ? null : bad("branch");
      case "pr.open": {
        if (str(args.base, scope.base) !== scope.base) return bad("base");
        if (str(args.head, scope.branch) !== scope.branch) return bad("head");
        if (typeof args.title !== "string" || args.title.length === 0 || args.title.length > MAX_TITLE) return bad("title");
        if (typeof args.body !== "string" || args.body.length > MAX_TEXT) return bad("body");
        return prNumber === null ? null : bad("a pull request is already open for this work");
      }
      case "pr.update-body":
        if (prNumber === null || args.number !== prNumber) return bad("number");
        return typeof args.body === "string" && args.body.length <= MAX_TEXT ? null : bad("body");
      default:
        if (args.number !== scope.issue && (prNumber === null || args.number !== prNumber)) return bad("number");
        return typeof args.body === "string" && args.body.length > 0 && args.body.length <= MAX_TEXT ? null : bad("body");
    }
  }

  if (existsSync(options.socketPath)) unlinkSync(options.socketPath);
  const server = Bun.listen<{ buffer: string }>({
    unix: options.socketPath,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (socket.data.buffer.length > 4 * MAX_TEXT) {
          socket.end(JSON.stringify(refuse("too-large")) + "\n");
          return;
        }
        let newline: number;
        while ((newline = socket.data.buffer.indexOf("\n")) >= 0) {
          const line = socket.data.buffer.slice(0, newline);
          socket.data.buffer = socket.data.buffer.slice(newline + 1);
          // One request at a time: the fence is checked again inside, but publishing is not interleaved.
          chain = chain.then(() => handle(line)).then((response) => { socket.write(JSON.stringify(response) + "\n"); });
        }
      },
      close() {},
      error() {},
    },
  });
  chmodSync(options.socketPath, 0o600);

  return {
    async close() {
      server.stop(true);
      await chain.catch(() => {});
      if (existsSync(options.socketPath)) unlinkSync(options.socketPath);
    },
  };
}

/** One request, one answer. Used by the session's tool shim and by tests. */
export function brokerCall(socketPath: string, request: BrokerRequest, timeoutMs = 10_000): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => finish(() => reject(new Error("broker call timed out"))), timeoutMs);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) { socket.write(JSON.stringify(request) + "\n"); },
        data(socket, chunk) {
          buffer += chunk.toString();
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          finish(() => { try { resolve(JSON.parse(line) as BrokerResponse); } catch { reject(new Error("broker sent an unreadable answer")); } });
          socket.end();
        },
        close() { finish(() => reject(new Error("broker closed the connection"))); },
        error(_socket, error) { finish(() => reject(error)); },
      },
    }).catch((error) => finish(() => reject(error)));
  });
}
