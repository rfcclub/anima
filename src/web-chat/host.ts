import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { WebChatClient } from "./client";
import { readConfig } from "./config";
import { createToolBoundary, installToolBoundary } from "./tool-boundary";
let runtime: WebChatClient | undefined;
export function webChatRuntime() {
  return runtime;
}
/** Relay only bounded, allowlisted worker diagnostics to the host operator. */
export function relayCapacityDiagnostics(
  stderr: import("node:stream").Readable,
) {
  // Forward only the fixed, content-free capacity diagnostic. Never relay raw
  // browser/site stderr. Bound even an unterminated/untrusted diagnostic line.
  let diagnostic = "";
  stderr.on("data", (chunk: Buffer) => {
    for (const char of chunk.toString("utf8")) {
      if (char !== "\n") {
        if (diagnostic.length <= 256) diagnostic += char;
        continue;
      }
      const match =
        /^\{"event":"web_chat_private_registry_capacity","entries":(\d{5}),"limit":80000\}$/.exec(
          diagnostic,
        );
      if (match && Number(match[1]) > 40_000 && Number(match[1]) <= 80_000)
        console.warn(
          JSON.stringify({
            event: "web_chat_private_registry_capacity",
            entries: Number(match[1]),
            limit: 80_000,
          }),
        );
      diagnostic = "";
    }
  });
}
/** Trusted host startup only. The capability travels on fd 3, never disk/environment/argv. */
export async function startWebChatHost(
  root: string,
  privatePaths: string[] = [],
) {
  if (runtime) throw Error("web chat host already started");
  const config = readConfig(root),
    boundary = await createToolBoundary(
      [
        root,
        join(homedir(), ".anima/secrets"),
        ...[
          ".ssh",
          ".config/gh",
          ".aws",
          ".gnupg",
          ".netrc",
          "Library/Keychains",
        ].map((path) => join(homedir(), path)),
        ...privatePaths,
        ...config.privateSources,
      ],
      [resolve(import.meta.dir, "../..")],
    );
  const key = randomBytes(32),
    entry = existsSync(join(import.meta.dir, "worker.ts"))
      ? join(import.meta.dir, "worker.ts")
      : join(import.meta.dir, "web-chat-worker.js");
  const child = spawn(process.execPath, [entry, root], {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    detached: true,
  });
  const capability = child.stdio[3] as import("node:stream").Writable;
  capability.end(key);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  relayCapacityDiagnostics(child.stderr!);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("bridge startup timeout")),
        10_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      child.once("error", finish);
      child.once("exit", () => finish(Error("bridge startup failed")));
      child.stdout!.once("data", (chunk) =>
        finish(
          String(chunk).trim() === "ready"
            ? undefined
            : Error("invalid bridge handshake"),
        ),
      );
    });
  } catch (e) {
    child.kill("SIGKILL");
    await exited;
    key.fill(0);
    throw e;
  }
  const client = new WebChatClient(join(root, "bridge.sock"), key);
  runtime = client;
  installToolBoundary(boundary);
  let stopped = false;
  child.once("exit", () => {
    if (runtime === client)
      runtime =
        undefined; /* Keep isolation until explicit stop, even after a crash. */
  });
  return {
    client,
    pid: child.pid!,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (runtime === client) runtime = undefined;
      (child.stdio[4] as import("node:stream").Writable).end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 5_000);
      await exited;
      clearTimeout(timer);
      key.fill(0);
      installToolBoundary(undefined);
    },
  };
}
/** Called by the composition root before starting any gateway or agent. */
export async function startWebChatFromEnv(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.ANIMA_WEB_CHAT !== "on") return undefined;
  const home = env.ANIMA_HOME ?? join(homedir(), ".anima");
  return startWebChatHost(env.ANIMA_WEB_CHAT_ROOT ?? join(home, "web-chat"), [
    join(home, "secrets"),
  ]);
}
