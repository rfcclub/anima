import { expect, test } from "bun:test";
import { formatPendingList, formatAbandoned, runRecoverMutations, usage } from "./recover-mutations.ts";

test("formatPendingList reports a clean tenant", () => {
  expect(formatPendingList("bruno", [], 10_000)).toEqual(["no pending mutations for bruno"]);
});

test("formatPendingList reports age in seconds for each stuck row", () => {
  const rows = [{ leaseId: "l1", operation: "remember", idempotencyKey: "k1", createdAt: 5_000 }];
  expect(formatPendingList("bruno", rows, 65_000)).toEqual([
    "bruno lease=l1 operation=remember idempotencyKey=k1 age=60s",
  ]);
});

test("formatAbandoned names the row and the retry contract", () => {
  expect(formatAbandoned("bruno", "l1", "remember", "k1")).toContain("abandoned: bruno lease=l1 operation=remember idempotencyKey=k1");
  expect(formatAbandoned("bruno", "l1", "remember", "k1")).toContain("safely retry");
});

test("runRecoverMutations list calls outbox.pending and formats the result", () => {
  const outbox = { pending: () => [{ leaseId: "l1", operation: "remember", idempotencyKey: "k1", createdAt: 0 }], abandon: () => {} };
  const output = runRecoverMutations(["list", "bruno"], { outbox, now: () => 1_000 });
  expect(output).toBe("bruno lease=l1 operation=remember idempotencyKey=k1 age=1s");
});

test("runRecoverMutations abandon calls outbox.abandon with the given row", () => {
  const calls: unknown[] = [];
  const outbox = { pending: () => [], abandon: (...args: unknown[]) => { calls.push(args); } };
  const output = runRecoverMutations(["abandon", "bruno", "l1", "remember", "k1"], { outbox });
  expect(calls).toEqual([["bruno", "l1", "remember", "k1"]]);
  expect(output).toContain("abandoned: bruno lease=l1");
});

test("runRecoverMutations throws usage for an unrecognized command", () => {
  const outbox = { pending: () => [], abandon: () => {} };
  expect(() => runRecoverMutations([], { outbox })).toThrow(usage());
  expect(() => runRecoverMutations(["abandon", "bruno"], { outbox })).toThrow(usage());
});
