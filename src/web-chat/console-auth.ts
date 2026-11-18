import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { privateDirectory } from "./private-fs";

const COOKIE = "anima_operator";
const TTL = 3_600_000;
const secret = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export interface OperatorSession {
  id: string;
  csrf: string;
  expiresAt: number;
}

export function consoleOrigin(origin: string, allowRemote = false): URL {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    url.origin !== origin ||
    ["0.0.0.0", "[::]"].includes(url.hostname) ||
    (!allowRemote &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw Error(
      "console origin must be an exact HTTP origin; remote access requires explicit opt-in",
    );
  return url;
}

/** Separate from the agent IPC capability; this object has no browser/service access. */
export class ConsoleAuth {
  private readonly token: string;
  private readonly origin: string;
  private readonly host: string;
  private readonly now: () => number;
  private readonly sessions = new Map<string, OperatorSession>();

  constructor(options: {
    root: string;
    origin: string;
    allowRemote?: boolean;
    now?: () => number;
  }) {
    const url = consoleOrigin(options.origin, options.allowRemote);
    this.origin = url.origin;
    this.host = url.host;
    this.now = options.now ?? Date.now;
    const path = join(privateDirectory(options.root), "operator-token");
    let fd: number;
    let created = false;
    try {
      fd = openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.nlink !== 1 ||
        stat.size > 64
      )
        throw Error("unsafe operator token");
      const generated = created ? secret() : undefined;
      if (generated) writeFileSync(fd, generated);
      this.token = generated ?? readFileSync(fd, "utf8").trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(this.token))
        throw Error("invalid operator token");
    } finally {
      closeSync(fd);
    }
  }

  private response(status: number, body: object): Response {
    return Response.json(body, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private boundary(request: Request): Response | undefined {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (
      new URL(request.url).origin !== this.origin ||
      request.headers.get("host") !== this.host ||
      (origin !== null && origin !== this.origin) ||
      (site !== null && site !== "same-origin" && site !== "none")
    )
      return this.response(403, { error: "foreign console request" });
  }

  private prune(): void {
    for (const [id, session] of this.sessions)
      if (session.expiresAt <= this.now()) this.sessions.delete(id);
  }

  async login(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return this.response(405, { error: "POST required" });
    const denied = this.boundary(request);
    if (denied) return denied;
    if (request.headers.get("origin") !== this.origin)
      return this.response(403, { error: "same-origin request required" });
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      return this.response(415, { error: "JSON required" });
    let body: unknown;
    const reader = request.body?.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 4096) {
            await reader.cancel();
            return this.response(413, { error: "login body too large" });
          }
          chunks.push(value);
        }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return this.response(400, { error: "invalid login body" });
    } finally {
      reader?.releaseLock();
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("token" in body) ||
      typeof body.token !== "string"
    )
      return this.response(400, { error: "expected only token" });
    if (!equal(body.token, this.token))
      return this.response(401, { error: "invalid operator token" });
    this.prune();
    if (this.sessions.size >= 8)
      return this.response(429, { error: "operator session limit reached" });
    const session = {
      id: secret(),
      csrf: secret(),
      expiresAt: this.now() + TTL,
    };
    this.sessions.set(session.id, session);
    const response = this.response(200, {
      csrf: session.csrf,
      expiresAt: session.expiresAt,
    });
    response.headers.set(
      "set-cookie",
      `${COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}`,
    );
    return response;
  }

  authorize(request: Request): OperatorSession | Response {
    const denied = this.boundary(request);
    if (denied) return denied;
    this.prune();
    const values = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE}=`));
    const session =
      values.length === 1
        ? this.sessions.get(values[0]!.slice(COOKIE.length + 1))
        : undefined;
    if (!session)
      return this.response(401, { error: "operator login required" });
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      (request.headers.get("origin") !== this.origin ||
        !equal(request.headers.get("x-console-csrf") ?? "", session.csrf))
    )
      return this.response(403, { error: "invalid CSRF token" });
    return session;
  }

  logout(request: Request): Response {
    if (request.method !== "POST")
      return this.response(405, { error: "POST required" });
    const session = this.authorize(request);
    if (session instanceof Response) return session;
    this.sessions.delete(session.id);
    const response = this.response(200, { loggedOut: true });
    response.headers.set(
      "set-cookie",
      `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
    return response;
  }
}
