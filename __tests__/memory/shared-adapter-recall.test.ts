import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedMemoryAdapter } from "../../src/memory/shared-adapter";

function makeAdapter() {
  return new SharedMemoryAdapter(join(tmpdir(), `test-shared-recall-${Date.now()}-${Math.random()}.db`));
}

async function seed(a: SharedMemoryAdapter) {
  const ts = "2026-10-27T00:00:00.000Z";
  await a.store({ namespace: "bruno", content: "decided to ship the dream cron", type: "observation", timestamp: ts });
  await a.store({ namespace: "bruno", content: "unrelated gardening note", type: "observation", timestamp: ts });
  await a.store({ namespace: "eli", content: "dream cron belongs to eli", type: "observation", timestamp: ts });
}

describe("SharedMemoryAdapter.recall", () => {
  test("a 600-word query does not throw and still finds a matching row", async () => {
    const a = makeAdapter();
    await seed(a);
    const filler = Array.from({ length: 600 }, (_, i) => `zzfiller${i}`).join(" ");
    const rows = await a.recall(`dream ${filler}`, { namespace: "bruno" });
    expect(rows.map((r) => r.content)).toEqual(["decided to ship the dream cron"]);
  });

  test("short query: any-word match, namespace filter, topK", async () => {
    const a = makeAdapter();
    await seed(a);
    const rows = await a.recall("dream gardening", { namespace: "bruno", topK: 5 });
    expect(rows.map((r) => r.content).sort()).toEqual(["decided to ship the dream cron", "unrelated gardening note"]);
    expect((await a.recall("dream", { namespace: "bruno", topK: 1 })).length).toBe(1);
  });

  test("repeated words add no terms and return no duplicate rows", async () => {
    const a = makeAdapter();
    await seed(a);
    const rows = await a.recall(Array(800).fill("dream").join(" "), { namespace: "bruno" });
    expect(rows.length).toBe(1);
  });
});
