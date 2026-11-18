import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSidecarSocket } from "colony-mesh/a2a/mesh-sidecar-socket";
import { checkA2AMail, sendA2AMail } from "../src/cli";
import { presenceSocketPath } from "../src/mesh-a2a/agent-presence";

// `send-mail` sends by mesh ID through the sending agent's socket; the mailbox is retired.
const cleanups: Array<() => void> = [];
const previousHome = process.env.ANIMA_HOME;
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  if (previousHome === undefined) delete process.env.ANIMA_HOME; else process.env.ANIMA_HOME = previousHome;
});

function servedFinn(): Array<{ target: string; content: string }> {
  const home = mkdtempSync(join(tmpdir(), "cli-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  process.env.ANIMA_HOME = home;
  const sends: Array<{ target: string; content: string }> = [];
  const served = serveSidecarSocket({
    path: presenceSocketPath(home, "finn"),
    list: async () => ({ status: 200, body: {} }),
    send: async (input) => { sends.push({ target: input.target, content: input.content }); return { status: 200, body: { results: { [input.target]: { status: "accepted", conversationId: "c-9" } } } }; },
  });
  cleanups.push(() => served.stop());
  return sends;
}

test("sendA2AMail sends the subject and body to a mesh ID as the sending agent", async () => {
  const sends = servedFinn();
  const result = await sendA2AMail({ from: "finn", to: "jade-anima-1a2b3c4d@m", subject: "Review", body: "please look at #107" });
  expect(sends).toEqual([{ target: "jade-anima-1a2b3c4d@m", content: "[Review] please look at #107" }]);
  expect(JSON.parse(result)).toEqual({ results: { "jade-anima-1a2b3c4d@m": { status: "accepted", conversationId: "c-9" } } });
});

test("sendA2AMail to a bare agent name is refused and nothing is sent", async () => {
  const sends = servedFinn();
  const result = await sendA2AMail({ from: "finn", to: "lena", subject: "", body: "hi" });
  expect(result).toContain("mesh_agents");
  expect(sends).toEqual([]);
});

test("sendA2AMail with missing fields returns an error", async () => {
  const result = await sendA2AMail({ from: "finn", to: "", subject: "", body: "" });
  expect(JSON.parse(result).error).toBe("missing_required_fields");
});

test("checkA2AMail says the mailbox is retired", async () => {
  expect(await checkA2AMail({ agent: "finn" })).toBe("finn: the mesh mailbox is retired; requests now arrive in the agent's session through its A2A inbox");
});
