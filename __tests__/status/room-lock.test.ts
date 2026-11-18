import { test, expect } from "bun:test";
import { runExclusive } from "../../src/ui/features/town/api/room-lock";

test("SC-104: lock released after failed pipeline", async () => {
  const order: string[] = [];
  const first = runExclusive("roomA", async () => {
    order.push("first-start");
    throw new Error("boom");
  }).catch(() => { order.push("first-caught"); });
  const second = runExclusive("roomA", async () => {
    order.push("second-start");
    return "ok";
  });
  await first;
  await expect(second).resolves.toBe("ok");
  expect(order).toContain("second-start");
});

test("FIFO: second waits for first to release", async () => {
  let releaseFirst!: () => void;
  const order: string[] = [];
  const first = runExclusive("roomB", () => new Promise<void>((r) => {
    releaseFirst = () => { order.push("first-done"); r(); };
  }));
  let secondStarted = false;
  const second = runExclusive("roomB", async () => {
    secondStarted = true;
    order.push("second-done");
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(secondStarted).toBe(false);
  releaseFirst();
  await first;
  await second;
  expect(order).toEqual(["first-done", "second-done"]);
});

test("different rooms run concurrently", async () => {
  let releaseX!: () => void;
  let releaseY!: () => void;
  const x = runExclusive("roomX", () => new Promise<void>((r) => { releaseX = r; }));
  const y = runExclusive("roomY", () => new Promise<void>((r) => { releaseY = r; }));
  await new Promise((r) => setTimeout(r, 10));
  // both in flight simultaneously — neither blocks the other
  releaseX();
  releaseY();
  await Promise.all([x, y]);
});
