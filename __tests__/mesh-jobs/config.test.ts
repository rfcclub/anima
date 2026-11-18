import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMeshJobsConfig } from "../../src/mesh-jobs/config";

const CAP = "cap-SECRET-0123456789";
let dir: string;
let path: string;

function write(value: unknown, mode = 0o600): void {
  writeFileSync(path, JSON.stringify(value));
  chmodSync(path, mode);
}

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayUrl: "http://127.0.0.1:1526",
    workers: [{ agent: "jade" }],
    ...overrides,
  };
}

function errorOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("expected a throw");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mesh-jobs-config-"));
  path = join(dir, "mesh-jobs.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadMeshJobsConfig", () => {
  test("no config file → null", () => {
    expect(loadMeshJobsConfig(path)).toBeNull();
  });

  test("config readable by others → throws, without the capability", () => {
    write(valid(), 0o644);
    const message = errorOf(() => loadMeshJobsConfig(path));
    expect(message).toContain("mesh jobs config must be mode 0600");
    expect(message).not.toContain(CAP);
  });

  test("invalid config → throws naming the field", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [valid({ gatewayUrl: "http://10.0.0.5:1526" }), "gatewayUrl"],
      [valid({ intervalMs: 500 }), "intervalMs"],
      [valid({ workers: [] }), "workers"],
      [valid({ workers: [{ agent: "../x" }] }), "agent"],
    ];
    for (const [value, field] of cases) {
      write(value);
      expect(errorOf(() => loadMeshJobsConfig(path))).toContain(field);
    }
  });

  // AJ-16: the worker follows the agent's mesh enrollment, so a static
  // address or capability is a leftover from the role-address era.
  test("a worker with an address or a capability → throws asking to remove it, without the value", () => {
    for (const worker of [{ agent: "finn", address: "finn@anima" }, { agent: "finn", capability: CAP }, { agent: "finn", address: "finn@anima", capability: CAP }]) {
      write(valid({ workers: [worker] }));
      const message = errorOf(() => loadMeshJobsConfig(path));
      expect(message).toContain("remove");
      expect(message).not.toContain(CAP);
      expect(message).not.toContain("finn@anima");
    }
  });

  test("valid config → defaults and the worker's agent", () => {
    write(valid());
    const config = loadMeshJobsConfig(path)!;
    expect(config.gatewayUrl).toBe("http://127.0.0.1:1526");
    expect(config.intervalMs).toBe(60_000);
    expect(config.heartbeatMs).toBe(60_000);
    expect(config.turnTimeoutMs).toBe(600_000);
    expect(config.workers).toEqual([{ agent: "jade" }]);
  });

  test("WM-1/WM-2 a worker may name a review provider and model; without them it loads as before", () => {
    write(valid({ workers: [
      { agent: "finn", provider: "hypercharm", model: "prism" },
      { agent: "jade" },
    ] }));
    const config = loadMeshJobsConfig(path)!;
    expect(config.workers[0]).toEqual({ agent: "finn", provider: "hypercharm", model: "prism" });
    expect(config.workers[1]).toEqual({ agent: "jade" });
  });

  test("WM-3 a half pair or a non-string value is rejected without the value", () => {
    for (const extra of [{ provider: "hypercharm" }, { model: "prism" }, { provider: "", model: "prism" }, { provider: "hypercharm", model: 7 }]) {
      write(valid({ workers: [{ agent: "finn", ...extra }] }));
      const message = errorOf(() => loadMeshJobsConfig(path));
      expect(message).toMatch(/^mesh jobs worker 0: invalid (provider|model)$/);
      expect(message).not.toMatch(/hypercharm|prism/);
    }
  });

  describe("work.externalReviewers", () => {
    const work = (extra: Record<string, unknown> = {}) => valid({
      workers: [{ agent: "finn" }, { agent: "jade" }],
      work: {
        enabled: true, author: "finn", authorActor: "finn-gotako[bot]", authorMeshId: "finn@anima", enqueuer: "finn",
        base: "master", reviewers: [{ agent: "cleo", meshId: "cleo@anima", login: "cleo-gotako[bot]" }], ...extra,
      },
    });

    test("absent means empty", () => {
      write(work());
      expect(loadMeshJobsConfig(path)!.work!.externalReviewers).toEqual([]);
    });

    test("a list of logins is accepted and kept", () => {
      write(work({ externalReviewers: ["review-bot[bot]", "rfcclub"] }));
      expect(loadMeshJobsConfig(path)!.work!.externalReviewers).toEqual(["review-bot[bot]", "rfcclub"]);
    });

    test.each([
      ["a bad login", ["not a login!"]],
      ["a duplicate (any case)", ["rfcclub", "RFCclub"]],
      ["eleven entries", Array.from({ length: 11 }, (_, i) => `user${i}`)],
      ["the author actor", ["finn-gotako[bot]"]],
      ["a non-array", "rfcclub"],
      ["a non-string entry", [7]],
    ])("%s is rejected", (_name, value) => {
      write(work({ externalReviewers: value }));
      expect(errorOf(() => loadMeshJobsConfig(path))).toMatch(/invalid work\.externalReviewers/);
    });
  });
});
