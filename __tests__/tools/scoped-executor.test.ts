import { test, expect } from "bun:test";
import { join } from "node:path";
import { ScopedExecutor } from "../../src/tools/scoped-executor";

const PROJECT_ROOT = join(__dirname, "..", "..");

function toolCall(name: string, args: Record<string, unknown>) {
  return { id: "tc-1", name, arguments: JSON.stringify(args) };
}

// SC-010: machine scope refuses write/bash
test("SC-010: machine scope refuses write and bash", async () => {
  const exec = new ScopedExecutor({ target: "machine", projectRoot: PROJECT_ROOT });
  expect(exec.canCall("write")).toBe(false);
  expect(exec.canCall("bash")).toBe(false);
  expect(exec.canCall("edit")).toBe(false);
  const result = await exec.call(toolCall("write", { path: "x.txt", content: "hi" }));
  expect(result).toContain("not allowed");
});

// SC-010/011: machine scope allows read/grep/glob, refuses paths outside project root
test("SC-011: machine scope refuses read outside project root", async () => {
  const exec = new ScopedExecutor({ target: "machine", projectRoot: PROJECT_ROOT });
  expect(exec.canCall("read")).toBe(true);
  const result = await exec.call(toolCall("read", { path: "/etc/hosts" }));
  expect(result).toContain("outside machine scope");
});

test("machine scope allows read inside project root", async () => {
  const exec = new ScopedExecutor({ target: "machine", projectRoot: PROJECT_ROOT });
  const result = await exec.call(toolCall("read", { path: "package.json" }));
  expect(result).not.toContain("outside machine scope");
  expect(result).not.toContain("Error:");
});

// SC-012: world scope delegates web_search/web_fetch, refuses read
test("SC-012: world scope allows web_search/web_fetch, refuses read", async () => {
  const exec = new ScopedExecutor({ target: "world", projectRoot: PROJECT_ROOT });
  expect(exec.canCall("web_search")).toBe(true);
  expect(exec.canCall("web_fetch")).toBe(true);
  expect(exec.canCall("read")).toBe(false);
  const result = await exec.call(toolCall("read", { path: "package.json" }));
  expect(result).toContain("not allowed");
});

// SC-021 (structural half): neither scope's allowlist can ever reach a
// memory/substrate-write tool — the only substrate signal for a discovery
// is the MEMORY_PROPOSAL event the dispatcher appends itself.
test("SC-021: no scope's allowlist includes a memory/substrate tool", () => {
  const machine = new ScopedExecutor({ target: "machine", projectRoot: PROJECT_ROOT });
  const world = new ScopedExecutor({ target: "world", projectRoot: PROJECT_ROOT });
  for (const tool of ["anima_remember", "anima_update", "anima_forget", "write", "edit", "bash"]) {
    expect(machine.canCall(tool)).toBe(false);
    expect(world.canCall(tool)).toBe(false);
  }
});
