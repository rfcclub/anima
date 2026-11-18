import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const child = join(import.meta.dir, "fixtures/tool-loop-characterization.ts");
for (const surface of ["run", "stream-response", "stream-native", "cli"]) {
  for (const scenario of ["no-tools", "multi", "error", "limit", "guard"]) {
    test(`TC ${surface}/${scenario}: ${scenario === "guard" ? "unauthorized tool refused by auto guard" : "public entrypoint behavior before TurnRunner"}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "anima-loop-characterization-"));
      try {
        const receipt = join(root, "receipt.json");
        // Allowlist: no provider tokens, shell hooks or operator database paths are inherited.
        const proc = Bun.spawn([process.execPath, child, surface, scenario, root, receipt], {
          cwd: root,
          env: {
            PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), TZ: "UTC", NODE_ENV: "test",
            ANIMA_HOME: root, ANIMA_SESSIONS_DB: join(root, "sessions.db"), ANIMA_COST_DB: ":memory:",
            ANIMA_SHARED_CONVERSATIONS: "0", ANIMA_ACTIVATION: "off", ANIMA_UI_ENABLED: "false",
          },
          stdout: "pipe", stderr: "pipe",
        });
        const deadline = setTimeout(() => proc.kill(), 10_000);
        let exit: number, stdout: string, stderr: string;
        try {
          [exit, stdout, stderr] = await Promise.all([
            proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
          ]);
        } finally { clearTimeout(deadline); }
        expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
        const actual = JSON.parse(readFileSync(receipt, "utf8"));
        expect(actual.sentinelExists).toBe(false);
        expect(actual.files).toEqual(["one", "two"]);
        const expectedQueries = scenario === "no-tools" ? 1
          : scenario === "limit" ? (surface === "cli" ? 65 : 64) : 2;
        expect(actual.queries).toBe(expectedQueries);
        if (scenario === "multi") {
          expect(actual.lastMessages.slice(-3).map((m: { role: string }) => m.role)).toEqual(["assistant", "tool", "tool"]);
          expect(actual.lastMessages.slice(-2).map((m: { tool_call_id: string; content: string }) => [m.tool_call_id, m.content]))
            .toEqual([["c1", "1\tone"], ["c2", "1\ttwo"]]);
        }
        if (scenario === "guard") {
          expect(actual.lastMessages.at(-1).content).toContain("Error: tool blocked");
          expect(actual.lastMessages.at(-1).tool_call_id).toBe("c1");
        }
        if (scenario === "error") {
          const results = actual.lastMessages.filter((m: { role: string }) => m.role === "tool");
          expect(results.map((m: { tool_call_id: string }) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
          expect(results[0].content).toBe("Error: could not parse tool arguments: {");
          expect(results[1].content).toStartWith("Error: ENOENT:");
          expect(results[1].content).toContain("missing.txt");
          expect(results[2].content).toBe("1\ttwo");
        }
        if (scenario === "limit") {
          expect(actual.error).toBe(surface === "run" ? "tool loop exceeded 64 iterations" : null);
          expect(actual.lastExecutedIteration).toBe("64");
        } else expect(actual.error).toBeNull();
        expect(actual).toMatchSnapshot();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 15_000);
  }
}
