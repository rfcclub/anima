#!/usr/bin/env bun
/**
 * Copy a Hindsight bank into an agent's memory.db as neurons (one way).
 *
 * Run: bun scripts/hindsight-neuron-sync.ts --bank <bank> --agent <agent> [--apply] [--db <path>] [--fact-type experience]
 * Dry run by default: nothing is written without --apply.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnimaEntityStore } from "../src/memory/anima-entity-store";
import { syncHindsightBank, HindsightSyncError, type SyncSink } from "../src/memory/hindsight-neuron-sync";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const bank = arg("bank");
const agent = arg("agent");
if (!bank || !agent) {
  console.error("usage: hindsight-neuron-sync.ts --bank <bank> --agent <agent> [--apply] [--db <path>] [--fact-type <t>]");
  process.exit(2);
}
const apply = process.argv.includes("--apply");
const dbPath = arg("db") ?? join(homedir(), ".anima", "agents", agent, "memory.db");

let apiUrl = "http://localhost:8891";
let apiToken: string | undefined;
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), ".hindsight", "coding-agent.json"), "utf8")) as { apiUrl?: string; apiToken?: string };
  if (cfg.apiUrl) apiUrl = cfg.apiUrl;
  apiToken = cfg.apiToken;
} catch {
  // fall back to the local default without a token
}

const store = new AnimaEntityStore(dbPath);
await store.initialize();
const sink: SyncSink = {
  transaction: (fn) => store.transaction(fn),
  flush: () => store.flushEmbeddings(),
  existing: () => {
    const prefix = "hindsight:";
    return new Map([...store.sourceIndex(prefix)].map(([source, id]) => [source.slice(prefix.length), id]));
  },
  addNeuron: (n) => store.addNeuronRecord(n),
  addSynapse: (a, b, type, weight, metadata) => {
    store.addSynapse(a, b, type, weight, metadata);
  },
};

try {
  const report = await syncHindsightBank({ bank, agent, apiUrl, apiToken, sink, apply, factType: arg("fact-type"), fetchFn: fetch });
  console.log(JSON.stringify({ bank, agent, db: dbPath, ...report }));
} catch (err) {
  console.error(err instanceof HindsightSyncError ? err.message : `sync failed: ${err instanceof Error ? err.name : "error"}`);
  process.exitCode = 1;
} finally {
  store.close();
}
