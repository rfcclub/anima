import { loadRemoteTalkConfig } from "./config";
import { createRemoteTalkHandler } from "./handler";
import { remoteAgentStream } from "./stream";

export interface StartRemoteTalkListenerOptions {
  configPath: string;
  roomsDir: string;
  log: (level: "info" | "error", message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Starts the remote talk listener when its config file exists. Never throws:
 * at boot, the VPN daemon may not hold the listen address yet, and a
 * throw here would crash-loop the whole ANIMA process.
 */
export function startRemoteTalkListener(options: StartRemoteTalkListenerOptions): ReturnType<typeof Bun.serve> | null {
  const { configPath, roomsDir, log } = options;
  try {
    const config = loadRemoteTalkConfig(configPath);
    if (!config) return null;

    const handler = createRemoteTalkHandler({
      grants: config.grants,
      log: (line) => log("info", "remote talk request", line),
      talk: ({ agent, caller, message }) => remoteAgentStream({ agentName: agent, caller, message, roomsDir }),
    });

    const server = Bun.serve({
      hostname: config.host,
      port: config.port,
      // Replies stream over SSE and can go quiet between provider chunks; 255s is Bun's max.
      idleTimeout: 255,
      // Only small JSON messages are accepted here.
      maxRequestBodySize: 64 * 1024,
      async fetch(req) {
        try {
          return await handler(req);
        } catch (error) {
          log("error", "remote talk request failed", { error: error instanceof Error ? error.message : String(error) });
          return new Response(null, { status: 500 });
        }
      },
    });
    log("info", "remote talk listener started", { host: config.host, port: server.port, grants: config.grants.length });
    return server;
  } catch (error) {
    log("error", "remote talk listener failed — non-fatal", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
