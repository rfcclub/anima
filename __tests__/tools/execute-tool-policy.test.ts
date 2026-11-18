import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../../src/tools/executor";
import type { ToolPolicy } from "../../src/config/types";

let base: string;
let allowed: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "exec-policy-")));
  allowed = join(base, "allowed");
  outside = join(base, "outside");
  mkdirSync(allowed);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const call = (name: string, args: Record<string, unknown>) => ({
  id: "t1",
  name,
  arguments: JSON.stringify(args),
});

const policyWith = (enforce: ToolPolicy["enforce"]): ToolPolicy => ({ allowedRoots: [allowed], enforce });

describe("executeTool policy enforcement", () => {
  test("SC-12 warn: handler runs, output identical to unenforced, one log record", async () => {
    const logs: unknown[] = [];
    const c = call("read", { path: join(outside, "secret.txt") });
    const baseline = await executeTool(c, { cwd: allowed, agentName: "bruno", policy: null });
    const warned = await executeTool(c, {
      cwd: allowed,
      agentName: "bruno",
      policy: policyWith("warn"),
      logViolation: (v) => logs.push(v),
    });
    expect(warned).toBe(baseline);
    expect(warned).toContain("secret");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "policy_violation", agent: "bruno", tool: "read", rule: "outside-roots" });
  });

  test("SC-12 warn: an allowed call logs nothing", async () => {
    const logs: unknown[] = [];
    await executeTool(call("write", { path: "ok.txt", content: "hi" }), {
      cwd: allowed,
      agentName: "bruno",
      policy: policyWith("warn"),
      logViolation: (v) => logs.push(v),
    });
    expect(logs).toHaveLength(0);
    expect(readFileSync(join(allowed, "ok.txt"), "utf8")).toBe("hi");
  });

  test("SC-13 block: error returned and handler never runs", async () => {
    const target = join(outside, "blocked.txt");
    const logs: unknown[] = [];
    const result = await executeTool(call("write", { path: target, content: "nope" }), {
      cwd: allowed,
      agentName: "bruno",
      policy: policyWith("block"),
      logViolation: (v) => logs.push(v),
    });
    expect(result).toContain("Error: policy violation");
    expect(existsSync(target)).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test("SC-14 off and null policy: no check, no log", async () => {
    const logs: unknown[] = [];
    for (const policy of [policyWith("off"), null]) {
      const out = await executeTool(call("read", { path: join(outside, "secret.txt") }), {
        cwd: allowed,
        agentName: "bruno",
        policy,
        logViolation: (v) => logs.push(v),
      });
      expect(out).toContain("secret");
    }
    expect(logs).toHaveLength(0);
  });

  test("SC-12 default logger writes one structured JSON line", async () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      await executeTool(call("read", { path: join(outside, "secret.txt") }), {
        cwd: allowed,
        agentName: "bruno",
        policy: policyWith("warn"),
      });
    } finally {
      console.warn = orig;
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "policy_violation", tool: "read" });
  });
});
