import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../../src/tools/executor";
import type { ToolPolicy } from "../../src/config/types";

// The suite runs against a throwaway HOME so a failing (RED) run can never read or print a real key.
let fakeHome: string;
let realHome: string | undefined;
let secrets: string;
let key: string;

beforeAll(() => {
  realHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "secrets-path-")));
  process.env.HOME = fakeHome;
  secrets = join(fakeHome, ".anima", "secrets");
  key = join(secrets, "example-app.private-key.pem");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(key, "FAKE-KEY-FOR-TESTS");
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown>) => ({ id: "t1", name, arguments: JSON.stringify(args) });
const policies = (): Array<[string, ToolPolicy | null]> => [
  ["warn", { allowedRoots: [fakeHome], enforce: "warn" }],
  ["off", { allowedRoots: [fakeHome], enforce: "off" }],
  ["none", null],
];

describe("secrets-path rule", () => {
  for (const label of ["warn", "off", "none"]) {
    const pick = () => policies().find(([l]) => l === label)![1];
    test(`read of a key is denied with enforce=${label}`, async () => {
      const out = await executeTool(call("read", { path: key }), { cwd: fakeHome, agentName: "cleo", policy: pick() });
      expect(out).toContain("secrets-path");
    });
    test(`write and edit in the secrets dir are denied with enforce=${label}`, async () => {
      const w = await executeTool(call("write", { path: join(secrets, "x.txt"), content: "x" }), { cwd: fakeHome, agentName: "cleo", policy: pick() });
      expect(w).toContain("secrets-path");
      const e = await executeTool(call("edit", { path: key, old_string: "a", new_string: "b" }), { cwd: fakeHome, agentName: "cleo", policy: pick() });
      expect(e).toContain("secrets-path");
    });
    test(`recursive tools on an ancestor are denied with enforce=${label}`, async () => {
      const g = await executeTool(call("glob", { pattern: "**/*", cwd: join(fakeHome, ".anima") }), { cwd: fakeHome, agentName: "cleo", policy: pick() });
      expect(g).toContain("secrets-path");
      const r = await executeTool(call("grep", { pattern: "BEGIN", path: join(fakeHome, ".anima") }), { cwd: fakeHome, agentName: "cleo", policy: pick() });
      expect(r).toContain("secrets-path");
    });
    test(`bash naming the secrets dir is denied with enforce=${label}`, async () => {
      for (const command of [`cat ${key}`, "cat ~/.anima/secrets/*.pem", "ls $HOME/.anima/secrets", "cat .anima/secrets/x"]) {
        const out = await executeTool(call("bash", { command }), { cwd: fakeHome, agentName: "cleo", policy: pick() });
        expect(out).toContain("secrets-path");
      }
    });
  }

  test("unrelated paths and commands are not denied by this rule", async () => {
    const out = await executeTool(call("bash", { command: "echo hello" }), { cwd: fakeHome, agentName: "cleo", policy: null });
    expect(out).not.toContain("secrets-path");
  });
});
