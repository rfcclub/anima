import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoader } from "../../src/agents/loader";

describe("configuration-only agent loading", () => {
  test("reads identity and review policy without boot files, actions or memory initialization", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-loader-"));
    const room = join(root, "finn");
    const action = join(root, "action-ran");
    mkdirSync(room);
    writeFileSync(join(room, "config.yaml"), JSON.stringify({
      identity: { name: "Finn", label: "Iron Will", identityAnchor: "PRIVATE_ANCHOR" },
      provider: { type: "fixture", model: "fixture-model" },
      policy: { allowedRoots: [room], allowedTools: ["anima_github"] },
      session: { defaultMode: "auto", autoModeOptIn: true },
      boot: { gene: "missing-AGENTS.md", soul: "missing-SOUL.md", sessionContext: [{ path: "missing-trajectory.md" }], extraActions: [{ label: "action", run: `touch ${action}` }] },
      memory: { type: "custom", crossSessionBootstrap: true, entityScript: "missing-memory" },
    }));
    const loader = new AgentLoader({ roomsDir: root });
    const config = await loader.loadConfig("finn");
    expect(config.identity).toMatchObject({ name: "Finn", label: "Iron Will" });
    expect(config.policy.allowedTools).toEqual(["anima_github"]);
    expect(existsSync(action)).toBe(false);
    expect(await loader.loadIdentity("finn")).toEqual({ name: "Finn", label: "Iron Will" });
  });
});
