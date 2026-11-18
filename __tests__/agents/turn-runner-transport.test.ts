import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
for (const scenario of ["initial-error", "query-error", "execution-error", "initial-usage", "later-usage"]) {
  test(`CLI process contract: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "anima-transport-")), receipt = join(root, "receipt.json");
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/turn-runner-transport.ts"), scenario, root, receipt], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), TZ: "UTC", NODE_ENV: "test",
          ANIMA_HOME: root, ANIMA_SESSIONS_DB: join(root, "sessions.db"), ANIMA_COST_DB: ":memory:",
          ANIMA_SHARED_CONVERSATIONS: "0", ANIMA_ACTIVATION: "off", ANIMA_UI_ENABLED: "false" },
        stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), 10_000);
      let exit: number, stdout: string, stderr: string;
      try { [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]); }
      finally { clearTimeout(timer); }
      expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
      const actual = JSON.parse(readFileSync(receipt, "utf8"));
      const initialFailure = scenario === "initial-error", executionFailure = scenario === "execution-error";
      expect(actual.queries).toBe(initialFailure || executionFailure ? 1 : 2);
      expect(actual.providerSessions.every(Boolean)).toBe(true);
      expect(actual.errorIdentity).toBe(initialFailure || executionFailure);
      expect(actual.error).toBe(initialFailure || executionFailure ? "fixture failure" : null);
      expect(actual.execution).toEqual(initialFailure ? [] : [{ cwd: true, agent: "transport-fixture", policy: true, memory: true, sessionId: null, signal: null, webChatClient: null }]);
      expect(actual.turns).toEqual(initialFailure ? [] : executionFailure ? [["user", "start"]] : [["user", "start"], ["assistant", scenario === "query-error" ? "[anima_recall] output" : "final"]]);
      expect(actual.stdout).toBe(initialFailure || executionFailure ? "" : scenario === "query-error" ? "[anima_recall] output\n" : "final\n");
      expect(actual.stderr).toBe(scenario === "query-error" ? "[talk] round 1 failed: fixture failure\n" : "");
      // appendTurn checks after each persisted turn; initial usage adds one explicit CLI check.
      expect(actual.compactions).toBe(initialFailure ? 0 : executionFailure ? 1 : scenario === "initial-usage" ? 3 : 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
}
