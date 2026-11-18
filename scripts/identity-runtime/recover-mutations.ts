#!/usr/bin/env bun
/**
 * Recovery command for stuck identity-runtime mutations.
 *
 * A remember whose outcome is unknown (transport/store failure after the
 * mutation was claimed) leaves a "pending" row in identity_runtime_mutations
 * on purpose, and every join for that tenant is refused until it is resolved
 * (see tenant-runtime.ts). Before this command, resolving it meant editing
 * the sqlite file by hand. Now: `list` shows the stuck rows and their age,
 * `abandon` releases one so join works again.
 *
 * Safe by construction, not by luck: every remember composition root
 * (idempotent-remember.ts) dedupes on the same idempotencyKey before writing,
 * so if the original client still holds that key it can retry after
 * abandoning and never produce a duplicate — for stores that implement
 * findByTag. BrunoEntityAdapter does not yet (its remember is a fire-and-forget
 * inbox write with no reliable read-back); abandoning an Bruno "remember" row
 * and retrying can duplicate that one memory. This is a named gap, not a
 * silent one.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { RuntimeEventStore } from "../../src/identity-runtime/contract/runtime-events.ts";
import { TenantMutationOutbox } from "../../packages/identity-runtime/src/tenant-mutation-outbox.ts";

export interface PendingMutationRow {
  leaseId: string;
  operation: string;
  idempotencyKey: string;
  createdAt: number;
}

export function defaultDbPath(): string {
  return Bun.env.IDENTITY_RUNTIME_DB ?? join(homedir(), ".anima", "identity-runtime", "identity-runtime.db");
}

export function usage(): string {
  return [
    "Usage:",
    "  bun scripts/identity-runtime/recover-mutations.ts list <agentId>",
    "  bun scripts/identity-runtime/recover-mutations.ts abandon <agentId> <leaseId> <operation> <idempotencyKey>",
  ].join("\n");
}

export function formatPendingRow(agentId: string, row: PendingMutationRow, now: number): string {
  const ageSeconds = Math.max(0, Math.round((now - row.createdAt) / 1000));
  return `${agentId} lease=${row.leaseId} operation=${row.operation} idempotencyKey=${row.idempotencyKey} age=${ageSeconds}s`;
}

export function formatPendingList(agentId: string, rows: PendingMutationRow[], now: number): string[] {
  if (rows.length === 0) return [`no pending mutations for ${agentId}`];
  return rows.map((row) => formatPendingRow(agentId, row, now));
}

export function formatAbandoned(agentId: string, leaseId: string, operation: string, idempotencyKey: string): string {
  return `abandoned: ${agentId} lease=${leaseId} operation=${operation} idempotencyKey=${idempotencyKey}. `
    + "Join is unblocked. If the original client still holds this idempotencyKey it can safely retry "
    + "the remember for stores with dedupe (findByTag) — Bruno's store does not have it yet, so a retry there may duplicate.";
}

export interface RecoverDeps {
  outbox: Pick<TenantMutationOutbox, "pending" | "abandon">;
  now?: () => number;
}

export function runRecoverMutations(argv: string[], deps: RecoverDeps): string {
  const [command, agentId, leaseId, operation, idempotencyKey] = argv;
  const now = deps.now ?? Date.now;
  if (command === "list" && agentId) {
    return formatPendingList(agentId, deps.outbox.pending(agentId), now()).join("\n");
  }
  if (command === "abandon" && agentId && leaseId && operation && idempotencyKey) {
    deps.outbox.abandon(agentId, leaseId, operation, idempotencyKey);
    return formatAbandoned(agentId, leaseId, operation, idempotencyKey);
  }
  throw new Error(usage());
}

if (import.meta.main) {
  const events = new RuntimeEventStore(defaultDbPath());
  const outbox = new TenantMutationOutbox(events);
  try {
    console.log(runRecoverMutations(Bun.argv.slice(2), { outbox }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    events.close();
  }
}
