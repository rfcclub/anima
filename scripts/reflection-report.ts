/**
 * Reflection Report CLI
 *
 * Usage:
 *   bun scripts/reflection-report.ts                 # all agents, last 48h
 *   bun scripts/reflection-report.ts --agent bruno    # single agent
 *   bun scripts/reflection-report.ts --hours 24    # custom window
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { ObservationStore } from "../src/continuity/reflection-engine";
import { ActivationStore } from "../src/continuity/activation-store";
import { parseActivationMode } from "../src/continuity/activation-config";

const args = process.argv.slice(2);
const agentFlag = args.indexOf("--agent");
const hoursFlag = args.indexOf("--hours");
const agentFilter = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
const hours = hoursFlag >= 0 ? Number(args[hoursFlag + 1]) : 48;
const windowMs = (isNaN(hours) ? 48 : hours) * 3600_000;

const roomsDir = process.env.ANIMA_ROOMS_DIR ?? join(homedir(), ".anima", "rooms");
const store = new ObservationStore(roomsDir);

const summaries = store.getAllSummaries(windowMs);
const ids = agentFilter ? [agentFilter] : Object.keys(summaries).sort();

console.log(`# Reflection Report — last ${hours}h\n`);

const activationDb = join(roomsDir, "_shared", "memory.db");
if (existsSync(activationDb)) {
  const activation = new ActivationStore(activationDb);
  try {
    const status = activation.operationalStatus(Date.now());
    const broker = activation.getBrokerStatus();
    console.log("## Activation broker");
    console.log(`- mode: ${broker?.mode ?? parseActivationMode(process.env.ANIMA_ACTIVATION_MODE)}`);
    console.log(`- next due: ${broker?.nextDueAt === null || broker?.nextDueAt === undefined ? "none" : new Date(broker.nextDueAt).toISOString()}`);
    console.log(`- queued/due: ${broker?.pendingCount ?? 0}/${broker?.dueCount ?? 0}`);
    console.log(`- suppressions: ${broker ? Object.entries(broker.suppressedByReason).map(([reason, count]) => `${reason}=${count}`).join(", ") || "none" : "none"}`);
    console.log(`- active leases: ${status.activeLeases}`);
    console.log(`- due attention: ${status.dueAttention}`);
    console.log(`- next lease expiry: ${status.nextLeaseExpiry === null ? "none" : new Date(status.nextLeaseExpiry).toISOString()}`);
    console.log(`- budget rows: ${status.budgets.length}`);
    for (const budget of status.budgets) {
      console.log(`  - ${budget.scope}:${budget.scopeId} ${budget.day} spent=${budget.spentUnits} reserved=${budget.reservedUnits}`);
    }
    console.log(`- fairness service ages: ${status.serviceAges.map((service) => `${service.agentId}=${service.ageMs}ms/${service.serviceCount}`).join(", ") || "none"}`);
    console.log();
  } finally {
    activation.close();
  }
}

for (const id of ids) {
  const s = summaries[id];
  if (!s) {
    console.log(`## ${id}\n(no observations)\n`);
    continue;
  }

  console.log(`## ${id}`);
  console.log(`- ticks: ${s.ticks}`);
  console.log(`- avg urgency: ${s.avgUrgency.toFixed(2)}`);
  console.log(`- inbox-triggered ticks: ${s.inboxTriggered}`);
  console.log(`- actions:`);
  for (const [action, count] of Object.entries(s.actions).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${action}: ${count}`);
  }

  const recent = store.getRecent(id, 3);
  if (recent.length > 0) {
    console.log(`- recent ticks:`);
    for (const row of recent) {
      const ts = new Date(row.ts as number).toISOString();
      console.log(
        `  - [${ts}] inbox=${row.inbox_count} score=${row.urgency_score}/${row.threshold} decision=${row.decision_type} | ${row.observation}`,
      );
    }
  }
  console.log();
}
