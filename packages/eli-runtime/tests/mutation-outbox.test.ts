import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeEventStore } from "../../../src/identity-runtime/contract/runtime-events.ts";
import { MutationOutbox } from "../src/mutation-outbox.ts";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

test("persists pending and completed mutations across an outbox restart", () => {
  root = mkdtempSync(join(tmpdir(), "eli-outbox-"));
  const path = join(root, "runtime.db");
  const firstStore = new RuntimeEventStore(path);
  const first = new MutationOutbox(firstStore, "eli");
  expect(first.claim("lease", "remember", "key")).toBe("claimed");
  expect(first.hasPending()).toBe(true);
  firstStore.close();

  const secondStore = new RuntimeEventStore(path);
  const second = new MutationOutbox(secondStore, "eli");
  expect(second.claim("lease", "remember", "key")).toBe("pending");
  second.complete("lease", "remember", "key", { id: "memory", createdAt: "now" });
  expect(second.claim("lease", "remember", "key")).toEqual({ result: { id: "memory", createdAt: "now" } });
  secondStore.close();
});
