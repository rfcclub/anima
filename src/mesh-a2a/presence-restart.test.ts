import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a killed process leaves its retry unknown after a real restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "presence-restart-"));
  const script = `
    import { AnimaMeshPresence } from "./src/mesh-a2a/agent-presence";
    const fetcher = async (input, init) => {
      const request = typeof input === "string" ? new Request(input, init) : input;
      const path = new URL(request.url).pathname;
      if (path.endsWith("/join")) return Response.json({
        leaseId: "lease", sessionToken: "session", meshEnrollment: {
          status: "enrolled", meshId: "fixture-anima@local", heartbeatCredential: "credential"
        }
      });
      if (path.endsWith("/heartbeat")) return new Response(null, { status: process.env.FIXTURE_MODE === "retry" ? 503 : 200 });
      return Response.json({ status: "offline" });
    };
    const presence = new AnimaMeshPresence({
      agents: ["fixture"], animaHome: process.env.FIXTURE_HOME, fetch: fetcher,
      identityUrl: "http://identity.test", meshUrl: "http://mesh.test", heartbeatIntervalMs: 10,
      log: (_level, message, fields) => {
        if (message === "mesh presence incident") console.log(JSON.stringify(fields));
      }
    });
    await presence.start();
    if (process.env.FIXTURE_MODE === "retry") await Bun.sleep(60000);
    else { await Bun.sleep(80); await presence.stop(); }
  `;
  const spawn = (mode: string) => Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(), env: { ...process.env, FIXTURE_HOME: home, FIXTURE_MODE: mode }, stdout: "pipe", stderr: "pipe",
  });
  const first = spawn("retry");
  try {
    let signalOpened: (value: Record<string, unknown> | null) => void = () => {};
    const opened = new Promise<Record<string, unknown> | null>((resolve) => { signalOpened = resolve; });
    const collect = (async () => {
      let pending = "";
      const reader = first.stdout.getReader();
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        pending += new TextDecoder().decode(chunk);
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (value.phase === "retrying") signalOpened(value);
        }
      }
      signalOpened(null);
    })();
    const event = await Promise.race([opened, Bun.sleep(1500).then(() => null)]);
    first.kill("SIGKILL");
    await first.exited;
    await collect;
    expect(event === null).toBe(false);
    expect(event).toMatchObject({ phase: "retrying", result: "unknown", cause: "unknown" });

    const second = spawn("healthy");
    const [exit, stdout, stderr] = await Promise.all([
      second.exited, new Response(second.stdout).text(), new Response(second.stderr).text(),
    ]);
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
  } finally {
    if (first.exitCode === null) first.kill("SIGKILL");
    await first.exited;
    rmSync(home, { recursive: true, force: true });
  }
});
