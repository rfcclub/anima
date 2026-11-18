import { test, expect } from "bun:test";
import { buildToolDefinitions } from "../../src/tools/definitions";
import { executeTool } from "../../src/tools/executor";

const call = (args: Record<string, unknown>) => ({ id: "t1", name: "anima_github", arguments: JSON.stringify(args) });

test("SC wiring: anima_github is offered only when allowed", () => {
  expect(buildToolDefinitions(["anima_github"]).map((d) => d.name)).toEqual(["anima_github"]);
  expect(buildToolDefinitions(["read"]).some((d) => d.name === "anima_github")).toBe(false);
});

test("SC wiring: executeTool routes to the tool and refuses without allowedTools", async () => {
  const out = await executeTool(call({ action: "issue_create", repo: "rfcclub/anima", title: "t", body: "b" }), {
    cwd: "/tmp",
    agentName: "finn",
    policy: { allowedTools: ["read"] },
  });
  expect(out).toContain("not in allowedTools");
});

test("SC wiring: executeTool refuses an unknown agent", async () => {
  const out = await executeTool(call({ action: "issue_create" }), { cwd: "/tmp", agentName: "mallory", policy: { allowedTools: ["anima_github"] } });
  expect(out).toContain("unknown agent identity");
});
