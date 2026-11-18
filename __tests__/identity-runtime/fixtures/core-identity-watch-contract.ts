// Child-local watch and clock ports; the production watcher is unchanged.
import { mock } from "bun:test";
import * as fs from "node:fs";
import { isAbsolute, basename } from "node:path";
const [scenario, root] = process.argv.slice(2);
if (!root || !isAbsolute(root) || !basename(root).startsWith("anima-watch-contract-") ||
    process.env.HOME !== root || process.env.ANIMA_HOME !== root) {
  throw Error("unsafe fixture root");
}
if (process.env.WATCH_PARENT_CANARY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
  throw Error("unsafe fixture environment");
}
globalThis.fetch = (() => { throw Error("watch fixture network forbidden"); }) as unknown as typeof fetch;
const subscriptions: { path: string; callback: () => void; closes: number }[] = [];
mock.module("node:fs", () => ({ ...fs, watch: (path: string, callback: () => void) => {
  const entry = { path, callback, closes: 0 };
  subscriptions.push(entry);
  return { close() { entry.closes++; } };
} }));
let now = 0, nextId = 0;
const pending = new Map<number, { at: number; callback: () => void }>();
globalThis.setTimeout = ((callback: () => void, ms = 0) => {
  const id = ++nextId;
  pending.set(id, { at: now + ms, callback });
  return id;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id: number) => { pending.delete(id); }) as unknown as typeof clearTimeout;
function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const next = [...pending].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    pending.delete(next[0]);
    now = next[1].at;
    next[1].callback();
  }
  now = end;
}
const { startCoreIdentityWatcher } = await import("../../../src/identity-runtime/core-identity-watcher");
const paths = { agoraRoot: root, cacheDir: `${root}/cache` };
const calls: { at: number; paths: typeof paths; owner: string }[] = [];
const compile = async (input: typeof paths) => { calls.push({ at: now, paths: input, owner: "first" }); };
const first = startCoreIdentityWatcher(paths, { ...(scenario === "default-delay" ? {} : { debounceMs: 20 }), compile });
const samples: number[] = [];
if (scenario === "subscriptions") {
  for (const subscription of subscriptions) { subscription.callback(); advance(20); }
} else if (scenario === "burst") {
  subscriptions[0].callback(); subscriptions[3].callback(); subscriptions[0].callback();
  advance(19); samples.push(calls.length); advance(1); samples.push(calls.length); advance(100);
} else if (scenario === "reset") {
  subscriptions[0].callback(); advance(19); subscriptions[3].callback();
  advance(1); samples.push(calls.length); advance(18); samples.push(calls.length);
  advance(1); samples.push(calls.length);
} else if (scenario === "cancel") {
  subscriptions[0].callback(); first.close(); advance(100);
} else if (scenario === "independent") {
  const second = startCoreIdentityWatcher(paths, { debounceMs: 20, compile: async (input) => {
    calls.push({ at: now, paths: input, owner: "second" });
  } });
  subscriptions[0].callback(); subscriptions[5].callback(); first.close(); advance(20); second.close();
} else if (scenario === "default-delay") {
  subscriptions[0].callback(); advance(999); samples.push(calls.length); advance(1); samples.push(calls.length);
} else throw Error("unknown fixture scenario");
if (scenario !== "cancel" && scenario !== "independent") first.close();
console.log(JSON.stringify({
  subscriptions: subscriptions.map(({ path, closes }) => ({ path, closes })),
  calls, samples, pending: pending.size,
}));
