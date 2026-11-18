import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSidecarSocket } from "colony-mesh/a2a/mesh-sidecar-socket";
import { buildToolDefinitions } from "../tools/definitions";
import { executeTool } from "../tools/executor";
import { presenceSocketPath } from "./agent-presence";

/** rfcclub/anima#103 slice 3: agents send by mesh ID through their own socket, served by the ANIMA server. */
const cleanups: Array<() => void> = [];
const previousHome = process.env.ANIMA_HOME;
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  if (previousHome === undefined) delete process.env.ANIMA_HOME; else process.env.ANIMA_HOME = previousHome;
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "at-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  process.env.ANIMA_HOME = dir;
  return dir;
}

function serveAgent(animaHome: string, agent: string) {
  const sends: Array<{ target: string; content: string }> = [];
  const served = serveSidecarSocket({
    path: presenceSocketPath(animaHome, agent),
    list: async () => ({ status: 200, body: { "jade-anima-1a2b3c4d@m": { cwd: "/h", harness: "anima", status: "online" } } }),
    send: async (input) => { sends.push({ target: input.target, content: input.content }); return { status: 200, body: { results: { [input.target]: { status: "accepted", conversationId: "c-1" } } } }; },
  });
  cleanups.push(() => served.stop());
  return sends;
}

const call = (name: string, args: Record<string, unknown>) => executeTool({ id: "t1", name, arguments: JSON.stringify(args) }, { agentName: "finn", policy: null });

describe("mesh tools by mesh ID (AJ-13, AJ-14)", () => {
  test("mesh_send sends as the agent through its socket and returns the per-target status", async () => {
    const sends = serveAgent(home(), "finn");
    const result = await call("mesh_send", { to: "jade-anima-1a2b3c4d@m", content: "hello jade" });
    expect(sends).toEqual([{ target: "jade-anima-1a2b3c4d@m", content: "hello jade" }]);
    expect(JSON.parse(result)).toEqual({ results: { "jade-anima-1a2b3c4d@m": { status: "accepted", conversationId: "c-1" } } });
  });

  test("the agent tool is an alias of mesh_send", async () => {
    const sends = serveAgent(home(), "finn");
    await call("agent", { to: "jade-anima-1a2b3c4d@m", body: "via alias" });
    expect(sends).toEqual([{ target: "jade-anima-1a2b3c4d@m", content: "via alias" }]);
  });

  test("a target without @, or a role address, is refused with a pointer to mesh_agents and nothing is sent", async () => {
    const sends = serveAgent(home(), "finn");
    for (const to of ["jade", "finn@anima", "bruno@claude"]) {
      const result = await call("mesh_send", { to, content: "x" });
      expect(result).toStartWith("Error:");
      expect(result).toContain("mesh_agents");
    }
    expect(sends).toEqual([]);
  });

  test("with no socket the tool says the ANIMA server is not running", async () => {
    home();
    expect(await call("mesh_send", { to: "jade-anima-1a2b3c4d@m", content: "x" })).toBe("Error: agent has no mesh ID: the ANIMA server is not running");
  });

  test("mesh_agents lists the directory through the agent's socket", async () => {
    serveAgent(home(), "finn");
    expect(JSON.parse(await call("mesh_agents", {}))).toEqual({ "jade-anima-1a2b3c4d@m": { cwd: "/h", harness: "anima", status: "online" } });
  });

  test("the mailbox tools are gone and mesh_agents is defined", async () => {
    const removed = ["mesh_peek", "mesh_pull", "mesh_ack", "mesh_status", "mesh_thread", "mesh_subscribe", "mesh_unsubscribe", "mesh_register_recipient", "mesh_unregister_recipient"];
    expect(buildToolDefinitions(removed)).toEqual([]);
    expect(buildToolDefinitions(["mesh_send", "mesh_agents"]).map((tool) => tool.name)).toEqual(["mesh_send", "mesh_agents"]);
    expect(await call("mesh_pull", {})).toBe("Error: unknown tool: mesh_pull");
  });
});
