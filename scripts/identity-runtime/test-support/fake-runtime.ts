export interface FakeRuntime {
  url: string;
  /** Every request seen, as "METHOD /path". */
  requests: string[];
  /** Parsed JSON bodies of join requests, in order. */
  bodies: Array<Record<string, unknown>>;
  stop(): void;
}

export type JoinHandler = (tenant: string, body: Record<string, unknown>) => Response | Promise<Response>;

export const okJoin: JoinHandler = (tenant) => Response.json({ projection: `# identity of ${tenant}\n` });

/** A stand-in identity-runtime on an ephemeral port that records every request it receives. */
export function startFakeRuntime(handler: JoinHandler = okJoin): FakeRuntime {
  const requests: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      requests.push(`${req.method} ${pathname}`);
      const match = /^\/identity-runtime\/([^/]+)\/join$/.exec(pathname);
      if (!match || req.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
      const body = (await req.json()) as Record<string, unknown>;
      bodies.push(body);
      return handler(match[1]!, body);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, bodies, stop: () => server.stop(true) };
}
