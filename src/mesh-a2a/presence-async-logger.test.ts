import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a rejecting async logger does not terminate presence", async () => {
  const home = mkdtempSync(join(tmpdir(), "presence-async-log-"));
  try {
    const script = `
      import { AnimaMeshPresence } from "./src/mesh-a2a/agent-presence";
      const fetcher = async (input, init) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        if (new URL(request.url).pathname.endsWith("/join")) return Response.json({
          leaseId: "lease", sessionToken: "session", meshEnrollment: {
            status: "enrolled", meshId: "fixture-anima@local", heartbeatCredential: "credential"
          }
        });
        if (new URL(request.url).pathname.endsWith("/heartbeat")) return new Response(null, { status: 503 });
        return Response.json({ status: "offline" });
      };
      const presence = new AnimaMeshPresence({
        agents: ["fixture"], animaHome: process.env.FIXTURE_HOME, fetch: fetcher,
        identityUrl: "http://identity.test", meshUrl: "http://mesh.test", heartbeatIntervalMs: 10,
        log: async () => { throw new Error("fixture logger rejection"); }
      });
      await presence.start();
      await Bun.sleep(60);
      await presence.stop();
      console.log("completed");
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(), env: { ...process.env, FIXTURE_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "completed\n", stderr: "" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
