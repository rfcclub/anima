import type { TenantIdentityRuntime, RuntimeDrainResult } from "./tenant-runtime.ts";

/** Signals belong to the standalone entrypoint, never to library constructors. */
export function installRuntimeShutdown(options: {
  runtime: TenantIdentityRuntime;
  server: Pick<ReturnType<typeof Bun.serve>, "stop">;
  closeResources?: () => void;
  timeoutMs?: number;
}): () => void {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const timeoutMs = options.timeoutMs ?? 10000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Calling drain synchronously closes admission before stopping the listener.
      const drained = options.runtime.drain(timeoutMs);
      const stopped = options.server.stop(false);
      const result = await Promise.race([
        Promise.all([drained, stopped]).then(([result]) => result),
        new Promise<RuntimeDrainResult>(resolve => {
          timer = setTimeout(async () => {
            const result = await drained;
            resolve({ ...result, outcome: "timed_out" });
          }, timeoutMs);
        }),
      ]);
      // Bun's stop promise can await an unresolved fetch handler even with
      // closeActiveConnections=true. The deadline must not await that promise.
      void options.server.stop(true).catch(() => {});
      if (result.outcome === "drained") options.closeResources?.();
      console.log(JSON.stringify({ event: "identity-runtime-shutdown", signal, ...result }));
      process.exit(result.outcome === "drained" ? 0 : 1);
    } catch {
      // No exception messages: upstream errors may carry memory or credentials.
      console.error(JSON.stringify({ event: "identity-runtime-shutdown", signal, outcome: "failed" }));
      process.exit(1);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const term = () => { void shutdown("SIGTERM"); };
  const interrupt = () => { void shutdown("SIGINT"); };
  process.on("SIGTERM", term);
  process.on("SIGINT", interrupt);
  return () => { process.off("SIGTERM", term); process.off("SIGINT", interrupt); };
}
