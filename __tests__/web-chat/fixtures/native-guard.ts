import { mock } from "bun:test";
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    throw Error("SDK_CALLED_TEST_ONLY");
  },
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: "",
}));
const { AnthropicProvider } = await import("../../../src/providers/anthropic");
const { createToolBoundary, installToolBoundary } = await import(
  "../../../src/web-chat/tool-boundary"
);
installToolBoundary(await createToolBoundary([process.argv[2]!], []));
try {
  await new AnthropicProvider({ log: () => {} }).query({
    agent: "fixture",
    messages: [],
    mode: "plan",
  });
  process.exitCode = 1;
} catch (e) {
  console.log((e as Error).message);
  process.exitCode = (e as Error).message.includes("native tool carriers")
    ? 0
    : 1;
}
