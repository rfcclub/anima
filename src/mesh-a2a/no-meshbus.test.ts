import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// rfcclub/anima#103 AJ-15: no agent-to-agent path in ANIMA reads or writes the retired MeshBus mailbox.
const root = join(import.meta.dir, "..", "..");
const paths = ["src/server.ts", "src/cli.ts", "src/tools/executor.ts", "src/continuity/reflection-engine.ts", "src/continuity/mesh-session-handlers.ts"];

test("AJ-15 the session, reflection, tool, CLI and server paths contain no MeshBus and no mailbox listener", () => {
  for (const path of paths) {
    const source = readFileSync(join(root, path), "utf8");
    expect({ path, meshBus: /\bMeshBus\b/.test(source), listeners: source.includes("startMeshListeners") }).toEqual({ path, meshBus: false, listeners: false });
  }
  expect(existsSync(join(root, "src/mesh/auto-listen.ts"))).toBe(false);
  expect(existsSync(join(root, "src/mesh/listen.ts"))).toBe(false);
});
