import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const providerInterfaceSource = () => readFileSync("src/providers/interface.ts", "utf8");

test("provider interface exports MCP-compatible ProviderTool", () => {
  const source = providerInterfaceSource();

  expect(source).toMatch(/export interface ProviderTool \{\s+name: string;\s+description: string;\s+input_schema: Record<string, unknown>;\s+\}/);
});

test("provider chunks include tool_use variant", () => {
  const source = providerInterfaceSource();

  expect(source).toContain('type: "text" | "tool_call" | "tool_use" | "error"');
  expect(source).toContain("tool_use?: ProviderToolCall");
});
