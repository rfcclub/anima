import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../../src/tools/executor";

// a slow bash or grep call used to hold the agent's turn until the mesh session's
// 1800 s timeout, and the command kept running after the session ended.
const call = (name: string, args: Record<string, unknown>) => ({ id: "t1", name, arguments: JSON.stringify(args) });

const dirs: string[] = [];
afterEach(() => {
  delete process.env.ANIMA_TOOL_COMMAND_TIMEOUT_MS;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function running(marker: string): Promise<string> {
  return (await Bun.$`pgrep -f ${marker}`.nothrow().text()).trim();
}

describe("bash and grep tool time limit", () => {
  test("SC-1 a command past its limit returns the output so far and a timeout note", async () => {
    const start = Date.now();
    const result = await executeTool(call("bash", { command: "echo started; sleep 30" }), { policy: null, commandTimeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(result).toContain("started");
    expect(result).toContain("[stopped: timed out after 0.3 s]");
  }, 10_000);

  test("SC-2 nothing the command started is left running", async () => {
    const marker = `sleep 30.${process.pid}`;
    await executeTool(call("bash", { command: `${marker} | cat` }), { policy: null, commandTimeoutMs: 300 });
    await Bun.sleep(100);
    expect(await running(marker)).toBe("");
  }, 10_000);

  test("SC-3 a grep that would block returns at its limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grep-fifo-"));
    dirs.push(dir);
    const fifo = join(dir, "never-written");
    await Bun.$`mkfifo ${fifo}`;
    const start = Date.now();
    const result = await executeTool(call("grep", { pattern: "x", path: fifo }), { policy: null, commandTimeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(result).toContain("[stopped: timed out after 0.3 s]");
  }, 10_000);

  test("SC-4 a command that finishes in time is unchanged", async () => {
    expect(await executeTool(call("bash", { command: "echo hi" }), { policy: null, commandTimeoutMs: 5_000 })).toBe("hi\n");
  });

  test("SC-5 an invalid option falls back to the environment value", async () => {
    process.env.ANIMA_TOOL_COMMAND_TIMEOUT_MS = "300";
    for (const commandTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const start = Date.now();
      const result = await executeTool(call("bash", { command: "sleep 30" }), { policy: null, commandTimeoutMs });
      expect(Date.now() - start).toBeLessThan(3_000);
      expect(result).toContain("[stopped: timed out after 0.3 s]");
    }
  }, 20_000);

  test("SC-5 an invalid environment value falls back to the default, so a short command still runs", async () => {
    for (const value of ["-5", "0", "abc", "Infinity"]) {
      process.env.ANIMA_TOOL_COMMAND_TIMEOUT_MS = value;
      expect(await executeTool(call("bash", { command: "sleep 0.3; echo hi" }), { policy: null })).toBe("hi\n");
    }
  }, 10_000);

  test("SC-6 a background child holding the pipes after the shell exits is stopped at the limit", async () => {
    const marker = `sleep 30.${process.pid}6`;
    const start = Date.now();
    const result = await executeTool(call("bash", { command: `${marker} & echo started` }), { policy: null, commandTimeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(result).toContain("started");
    expect(result).toContain("[stopped: timed out after 0.3 s]");
    await Bun.sleep(100);
    expect(await running(marker)).toBe("");
  }, 10_000);

  test("SC-7 a child that ignores SIGTERM is stopped by SIGKILL after the grace period", async () => {
    const marker = `sleep 30.${process.pid}7`;
    const start = Date.now();
    const result = await executeTool(call("bash", { command: `trap '' TERM; echo started; ${marker}` }), { policy: null, commandTimeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(6_000);
    expect(result).toContain("started");
    expect(result).toContain("[stopped: timed out after 0.3 s]");
    await Bun.sleep(100);
    expect(await running(marker)).toBe("");
  }, 15_000);

  test("SC-7 SIGKILL still reaches the group when the leader and the pipes are already gone", async () => {
    const marker = `sleep 30.${process.pid}8`;
    // The child ignores SIGTERM and does not hold the pipes; the shell waits on it, then dies with the group's SIGTERM.
    const result = await executeTool(call("bash", { command: `(trap '' TERM; exec ${marker}) >/dev/null 2>&1 & wait` }), { policy: null, commandTimeoutMs: 300 });
    expect(result).toContain("[stopped: timed out after 0.3 s]");
    await Bun.sleep(2_500);
    expect(await running(marker)).toBe("");
  }, 15_000);

  test("SC-8 the timeout note survives the 110,000-character cut", async () => {
    const result = await executeTool(call("bash", { command: "head -c 120000 /dev/zero | tr '\\0' a; sleep 30" }), { policy: null, commandTimeoutMs: 500 });
    expect(result.startsWith("a".repeat(1000))).toBe(true);
    expect(result.trimEnd().endsWith("[stopped: timed out after 0.5 s]")).toBe(true);
  }, 10_000);
});
