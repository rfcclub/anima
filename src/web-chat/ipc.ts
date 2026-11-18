import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acquireBridgeLock } from "./config";
import type { WebChatService } from "./service";
import type { ChatOwner } from "./types";
export type Operation = { operation: string; [key: string]: unknown };
export function signedHeaders(
  key: Uint8Array,
  body: string,
  at = Date.now(),
  nonce = randomBytes(16).toString("hex"),
) {
  return {
    "content-type": "application/json",
    "x-time": String(at),
    "x-nonce": nonce,
    "x-signature": createHmac("sha256", key)
      .update(`${at}\n${nonce}\n${body}`)
      .digest("hex"),
  };
}
const fields: Record<string, string[]> = {
  register_private: ["content"],
  list: [],
  create: ["account"],
  resume: ["conversationId"],
  send: ["conversationId", "retryKey", "prompt"],
  result: ["requestId", "after"],
  cancel: ["requestId"],
  close: ["conversationId"],
  reconcile: ["requestId"],
};
export async function dispatch(
  service: WebChatService,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("invalid envelope");
  const v = input as Record<string, any>,
    owner = v.owner as ChatOwner;
  if (
    !owner ||
    Object.keys(owner).sort().join(",") !== "agent,session" ||
    typeof owner.agent !== "string" ||
    typeof owner.session !== "string" ||
    !owner.agent ||
    !owner.session
  )
    throw Error("invalid owner");
  const allowed = fields[v.operation];
  if (
    !allowed ||
    Object.keys(v).some(
      (k) => k !== "owner" && k !== "operation" && !allowed.includes(k),
    )
  )
    throw Error("invalid operation/fields");
  for (const name of allowed.filter((x) => x !== "after"))
    if (typeof v[name] !== "string" || !v[name])
      throw Error("missing operation field");
  switch (v.operation) {
    case "register_private":
      service.registerPrivateContent(v.content);
      return { registered: true };
    case "list":
      return service.list();
    case "create":
      return service.create(owner, v.account);
    case "resume":
      return service.resume(owner, v.conversationId);
    case "send":
      return service.send(owner, {
        conversationId: v.conversationId,
        retryKey: v.retryKey,
        prompt: v.prompt,
      });
    case "result":
      return service.result(owner, v.requestId, v.after ?? 0);
    case "cancel":
      return service.cancel(owner, v.requestId);
    case "close":
      return service.close(owner, v.conversationId);
    case "reconcile":
      return service.reconcile(owner, v.requestId, signal);
  }
}
export async function startIpc(opts: {
  root: string;
  key: Uint8Array;
  service: WebChatService;
  release?: () => void;
}) {
  if (opts.key.byteLength !== 32) throw Error("invalid capability");
  const release = opts.release ?? acquireBridgeLock(opts.root),
    socket = join(opts.root, "bridge.sock");
  if (existsSync(socket)) {
    const st = lstatSync(socket);
    if (!st.isSocket() || st.uid !== process.getuid?.()) {
      release();
      throw Error("unsafe stale socket");
    }
    unlinkSync(socket);
  }
  const nonces = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      if (!res.destroyed) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }
    };
    if (req.method !== "POST" || req.url !== "/rpc") {
      respond(404, { error: "not found" });
      return;
    }
    let body = "";
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65_536) {
          respond(413, { error: "body too large" });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      body = Buffer.concat(chunks).toString("utf8");
      const at = Number(req.headers["x-time"]),
        nonce = String(req.headers["x-nonce"] ?? ""),
        signature = String(req.headers["x-signature"] ?? "");
      const expected = signedHeaders(opts.key, body, at, nonce)["x-signature"];
      if (
        !Number.isSafeInteger(at) ||
        Math.abs(Date.now() - at) > 30_000 ||
        !/^[a-f0-9]{32}$/.test(nonce) ||
        !/^[a-f0-9]{64}$/.test(signature) ||
        !timingSafeEqual(
          Buffer.from(expected, "hex"),
          Buffer.from(signature, "hex"),
        )
      ) {
        respond(401, { error: "unauthorized" });
        return;
      }
      const now = Date.now();
      for (const [n, expires] of nonces) if (expires < now) nonces.delete(n);
      if (nonces.has(nonce)) {
        respond(409, { error: "replayed request" });
        return;
      }
      if (nonces.size >= 1024) {
        respond(429, { error: "authentication window full" });
        return;
      }
      nonces.set(nonce, at + 30_000);
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 20_000);
      res.once("close", () => controller.abort());
      try {
        respond(
          200,
          await dispatch(opts.service, JSON.parse(body), controller.signal),
        );
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      respond(400, {
        error: e instanceof Error ? e.message : "invalid request",
      });
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.maxConnections = 32;
  const old = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        chmodSync(socket, 0o600);
        resolve();
      });
    });
  } catch (e) {
    release();
    throw e;
  } finally {
    process.umask(old);
  }
  return {
    socket,
    close: async () => {
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      await opts.service.shutdown();
      try {
        unlinkSync(socket);
      } catch {}
      release();
    },
  };
}
