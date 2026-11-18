#!/usr/bin/env bun
/**
 * reflection-observe — read-only quality report over reflection-produced data.
 *
 * WHY: castle-vnengine task 6.3-6.6 ask to observe reflection quality, adjust
 * threshold/interval, then roll out. Before adjusting, we need to know what the
 * agents are actually producing. This script reads narrative_threads (the
 * agora/message log) + shared_flags (last-action tracking) and classifies each
 * entry as TEMPLATE (echo of a knock intent, no real thought) vs DYNAMIC (a
 * genuinely composed reflection). The ratio is the quality signal 6.4 tunes on.
 *
 * Usage: bun src/scripts/reflection-observe.ts [--db ~/.anima/rooms/_shared/memory.db]
 * Exit 0 always — this is a report, not a gate.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DB = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : join(process.env.HOME ?? "~", ".anima", "rooms", "_shared", "memory.db");

if (!existsSync(DB)) {
  console.error(`memory.db not found at ${DB}`);
  process.exit(0);
}

interface Thread {
  id: string;
  from_agent: string;
  to_agent: string;
  label: string;
  value: string;
  timestamp: string;
}

const db = new Database(DB, { readonly: true });
const threads = db
  .query(
    `SELECT id, from_agent, to_agent, label, value, timestamp
     FROM narrative_threads
     ORDER BY timestamp ASC`,
  )
  .all() as Thread[];

/** A thread is TEMPLATE when it matches the fallback acknowledgement shape
 *  the reflection engine emits without consulting the LLM (see
 *  reflection-engine.ts decide() — the `{agent} acknowledges a knock: {intent}`
 *  and `{agent} has N pending mesh message(s); reviewing priorities` lines).
 *  Anything else (LLM-composed) is DYNAMIC. */
function classify(t: Thread): "template" | "dynamic" {
  const v = (t.value ?? "").trim();
  if (/^[\w-]+ acknowledges a knock: /.test(v)) return "template";
  if (/^[\w-]+ has \d+ pending mesh message/i.test(v)) return "template";
  return "dynamic";
}

const byAgent = new Map<string, { template: number; dynamic: number; total: number }>();
let template = 0;
let dynamic = 0;
const duplicated = new Map<string, number>(); // value -> count (for spam detection)

for (const t of threads) {
  const kind = classify(t);
  if (kind === "template") template++;
  else dynamic++;
  const a = byAgent.get(t.from_agent) ?? { template: 0, dynamic: 0, total: 0 };
  a[kind]++;
  a.total++;
  byAgent.set(t.from_agent, a);
  const v = (t.value ?? "").trim();
  if (v) duplicated.set(v, (duplicated.get(v) ?? 0) + 1);
}

const spammy = [...duplicated.entries()]
  .filter(([, n]) => n > 1)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5);

const total = threads.length;
const ratio = total > 0 ? (dynamic / total) * 100 : 0;

console.log("═══ Reflection Quality Report ═══");
console.log(`Source:  ${DB}`);
console.log(`Range:   ${threads[0]?.timestamp ?? "n/a"} → ${threads[threads.length - 1]?.timestamp ?? "n/a"}`);
console.log(`Total threads:        ${total}`);
console.log(`  post-agora:         ${threads.filter((t) => t.label === "post-agora").length}`);
console.log(`  message-agent:      ${threads.filter((t) => t.label === "message-agent").length}`);
console.log(`Template (fallback):   ${template}  (${total > 0 ? Math.round((template / total) * 100) : 0}%)`);
console.log(`Dynamic  (LLM-think): ${dynamic}  (${total > 0 ? Math.round((dynamic / total) * 100) : 0}%)`);
console.log(`Quality ratio (dynamic/total): ${ratio.toFixed(1)}%`);
console.log("");
console.log("─── Per agent ───");
const agentRows = [...byAgent.entries()].sort((a, b) => b[1].total - a[1].total);
console.log("  agent        total  tmpl  dyn");
for (const [agent, s] of agentRows) {
  console.log(
    `  ${agent.padEnd(12)} ${String(s.total).padStart(4)}  ${String(s.template).padStart(4)}  ${String(s.dynamic).padStart(3)}`,
  );
}
console.log("");
console.log("─── Most-duplicated posts (spam signal) ───");
if (spammy.length === 0) {
  console.log("  (none — every post is distinct)");
} else {
  for (const [v, n] of spammy) {
    console.log(`  ×${n}  ${v.slice(0, 72)}`);
  }
}
console.log("");
console.log("─── Verdict ───");
if (ratio < 10) {
  console.log("  LOW quality — reflection is emitting fallback templates, not thinking.");
  console.log("  → 6.4 action: knock intent 'move' triggers fallback echo; either raise");
  console.log("    threshold above the move-knock score, or route knocks through");
  console.log("    decideWithProvider so agents compose a real reply.");
} else if (ratio < 40) {
  console.log("  MIXED — some real thought, mostly templated acks.");
} else {
  console.log("  HEALTHY — agents are composing dynamic reflections.");
}
