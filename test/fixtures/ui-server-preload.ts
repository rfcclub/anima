import { mock } from "bun:test";
import * as os from "node:os";
import { strict as assert } from "node:assert";

const directory = process.env.ELI_TEST_ROOT!;
assert.ok(directory, "UI child needs an owned fixture root");
const fakeOs = { ...os, homedir: () => directory };
mock.module("node:os", () => ({ ...fakeOs, default: fakeOs }));
require("node:os").homedir = fakeOs.homedir;
assert.equal((await import("node:os")).homedir(), directory);
assert.equal(require("node:os").homedir(), directory);
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: "fixture-boundary",
  query() { throw Error("UI fixture forbids native provider calls"); },
}));
