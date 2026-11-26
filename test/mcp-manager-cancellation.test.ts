import { expect, test } from "bun:test";
import { McpManager } from "../src/mcp/manager";

for (const pause of ["start", "discovery"] as const) {
  test(`SC-11 abort during ${pause} stops the first MCP client and starts no later client`, async () => {
    const controller = new AbortController();
    let entered = () => {};
    let release = () => {};
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    const stopped: string[] = [];
    const manager = new McpManager([
      { name: "first", command: "unused", args: [] },
      { name: "second", command: "unused", args: [] },
    ], {
      clientFactory: ({ name }) => ({
        async start() {
          started.push(name);
          if (name === "first" && pause === "start") { entered(); await gate; }
          return true;
        },
        async listTools() {
          if (name === "first" && pause === "discovery") { entered(); await gate; }
          return [];
        },
        async stop() { stopped.push(name); },
        async callTool() { return {}; },
      }),
    });
    const pending = manager.start(controller.signal).then(() => "resolved", (error) => error.name);
    try {
      await waiting;
      controller.abort();
      const stoppedBeforeRelease = [...stopped];
      release();
      const outcome = await pending;
      expect({ outcome, started, stopped, stoppedBeforeRelease }).toEqual({
        outcome: "AbortError", started: ["first"], stopped: ["first"], stoppedBeforeRelease: ["first"],
      });
    } finally {
      release();
      await manager.stop();
    }
  });
}

test("abort inside the client factory does not start the new client", async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const manager = new McpManager([{ name: "first", command: "unused", args: [] }], {
    clientFactory: ({ name }) => {
      controller.abort();
      return {
        async start() { started.push(name); return true; },
        async listTools() { return []; },
        async stop() {},
        async callTool() { return {}; },
      };
    },
  });
  const outcome = await manager.start(controller.signal).then(() => "resolved", (error) => error.name);
  expect({ outcome, started }).toEqual({ outcome: "AbortError", started: [] });
});
