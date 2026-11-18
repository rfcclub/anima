import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const configTypesSource = () => readFileSync("src/config/types.ts", "utf8");

test("config types export McpServerConfig", () => {
  const source = configTypesSource();

  expect(source).toContain("export interface McpServerConfig");
  expect(source).toContain("name: string");
  expect(source).toContain("command: string");
  expect(source).toContain("args: string[]");
  expect(source).toContain("env?: Record<string, string>");
});
