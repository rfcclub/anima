import { checkRequest, guardConfig, type GuardConfig } from "./ui/app/origin-guard";

type CoreHandler = (req: Request) => Response | Promise<Response>;
type CoreEnv = Record<string, string | undefined>;

export function coreGuardConfig(port: number, env: CoreEnv): GuardConfig {
  return guardConfig(port, { ANIMA_UI_ALLOWED_ORIGINS: env.ANIMA_CORE_ALLOWED_ORIGINS });
}

export function withCoreGuard(handler: CoreHandler, config: GuardConfig): CoreHandler {
  return (req) => checkRequest(req, config) ?? handler(req);
}

/** HTTP composition only: no schedulers, provider calls or room initialization. */
export function startCoreHttpServer(
  handler: CoreHandler,
  { port = Number(Bun.env.PORT ?? 3700), env = Bun.env }: { port?: number; env?: CoreEnv } = {},
): ReturnType<typeof Bun.serve> {
  let guarded: CoreHandler | undefined;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port,
    hostname: env.ANIMA_CORE_HOST?.trim() || "127.0.0.1",
    // Preserve the existing bounded wait for slow provider replies and body limit.
    idleTimeout: 255,
    maxRequestBodySize: 1024 * 1024,
    fetch(req) {
      guarded ??= withCoreGuard(handler, coreGuardConfig(server.port ?? port, env));
      return guarded(req);
    },
  });
  return server;
}
