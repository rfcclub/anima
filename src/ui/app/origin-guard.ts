import { json } from "../utils/http";

export interface GuardConfig {
  /** Normalized origins (scheme, hostname, effective port) that may call the API. */
  allowedOrigins: string[];
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The loopback origins of this server, plus each parsable `ANIMA_UI_ALLOWED_ORIGINS` entry. */
export function guardConfig(port: number, env: Record<string, string | undefined>): GuardConfig {
  const allowedOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  for (const entry of (env.ANIMA_UI_ALLOWED_ORIGINS ?? "").split(",")) {
    try {
      const origin = new URL(entry.trim()).origin;
      if (origin !== "null") allowedOrigins.push(origin);
    } catch { /* not a URL: ignore */ }
  }
  return { allowedOrigins };
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseHost(req: Request): URL | null {
  const header = req.headers.get("host");
  if (!header) return null;
  try {
    return new URL(`http://${header}`);
  } catch {
    return null;
  }
}

/** A Host is trusted when it is a loopback name on any port (SSH tunnels and desktop forwards
 *  pick a random local port) or names the hostname and port of an allowed origin. A DNS-rebinding
 *  hostname is neither. */
function hostIsTrusted(host: URL, config: GuardConfig): boolean {
  if (LOOPBACK_HOSTNAMES.has(host.hostname)) return true;
  return config.allowedOrigins.some((origin) => {
    const allowed = new URL(origin);
    if (allowed.hostname !== host.hostname) return false;
    // A Host without a port names the default port of the scheme in use, which is not known here.
    return host.port ? host.port === effectivePort(allowed) : effectivePort(allowed) === "80" || effectivePort(allowed) === "443";
  });
}

/** Returns a refusal, or null when the request may go on to the routes. */
export function checkRequest(req: Request, config: GuardConfig): Response | null {
  const host = parseHost(req);
  if (!host || !hostIsTrusted(host, config)) return json({ error: "untrusted_host" }, 403);
  if (SAFE_METHODS.has(req.method)) return null;

  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (origin === "null") return json({ error: "origin_null" }, 403);
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      return json({ error: "origin_malformed" }, 400);
    }
    // Allowed by list, or (loopback only) the page was served by this very Host: an SSH tunnel or
    // desktop forward on a random local port. A configured remote origin keeps its exact scheme.
    const ownLoopbackOrigin = LOOPBACK_HOSTNAMES.has(host.hostname) && normalized === `http://${host.host}`;
    return config.allowedOrigins.includes(normalized) || ownLoopbackOrigin ? null : json({ error: "origin_not_allowed" }, 403);
  }

  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return json({ error: "cross_site_request" }, 403);
  return null;
}
