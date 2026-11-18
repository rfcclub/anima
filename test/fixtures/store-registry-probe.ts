// Standalone subprocess fixture, not a discovered test file. Guard state before
// importing any module that resolves machine-default memory paths.
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { RoomConfig } from "../../src/config/types";
const [root, configJson] = process.argv.slice(2);
if (!root || !isAbsolute(root) || homedir() !== root || process.env.ANIMA_HOME !== root) {
  throw Error("fixture root guard refused before import");
}
const allowed = new Set(["PATH", "TMPDIR", "HOME", "ANIMA_HOME", "ANIMA_COST_DB", "TZ", "NODE_ENV"]);
if (Object.keys(process.env).some((key) => !allowed.has(key))) {
  throw Error("forbidden parent environment before import");
}
globalThis.fetch = Object.assign(
  async () => { throw Error("fixture network forbidden"); },
  { preconnect: () => { throw Error("fixture network forbidden"); } },
);
if (configJson === "fixture-fail") throw Error("intentional fixture failure before import");
const config = JSON.parse(configJson) as RoomConfig;
const { createAgentMemoryStore } = await import("../../src/memory/store-registry");
const { AbelMemBunAdapter } = await import("../../src/memory/abel-mem-bun-adapter");
const { BrunoEntityAdapter } = await import("../../src/memory/bruno-entity-adapter");
const { AnimaEntityStore } = await import("../../src/memory/anima-entity-store");
const { MemoryHealthRegistry } = await import("../../src/memory/health-registry");
const store = await createAgentMemoryStore(config, root);
const type = store === undefined ? "undefined"
  : store instanceof AbelMemBunAdapter ? "AbelMemBunAdapter"
  : store instanceof BrunoEntityAdapter ? "BrunoEntityAdapter"
  : store instanceof AnimaEntityStore ? "AnimaEntityStore" : "unexpected";
console.log(JSON.stringify({
  type,
  home: homedir(),
  parentSecretPresent: Boolean(process.env.ANIMA_FIXTURE_PARENT_SECRET),
  healthRegistered: store !== undefined && MemoryHealthRegistry.getInstance().get(config.identity.name) === store,
}));
