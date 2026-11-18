import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TRUST_DOMAINS, TrustSystem, type TrustFile } from "../../src/evaluation/trust-system";

let tempDir: string;
let roomsDir: string;
let current: Date;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roomsDir = join(tempDir, "rooms");
  mkdirSync(join(roomsDir, "cleo"), { recursive: true });
  current = new Date("2026-05-19T00:00:00.000Z");
});

test("initializes every trust domain at neutral score", async () => {
  const trust = system();
  const file = await trust.initialize("cleo");

  expect(Object.keys(file.domains).sort()).toEqual([...TRUST_DOMAINS].sort());
  for (const domain of TRUST_DOMAINS) {
    expect(file.domains[domain].score).toBe(0.5);
    expect(file.domains[domain].samples).toBe(0);
  }
});

test("confirm uses sigmoid accumulation and increments samples", async () => {
  const trust = system();

  const first = await trust.confirm("cleo", "code_review");
  const second = await trust.confirm("cleo", "code_review");

  expect(first.score).toBeCloseTo(0.51, 6);
  expect(second.score).toBeCloseTo(0.5198, 6);
  expect(second.samples).toBe(2);
});

test("penalty drops sharply and recovery remains gradual", async () => {
  const trust = system();

  await trust.confirm("cleo", "architecture");
  const penalized = await trust.penalize("cleo", "architecture");
  const recovered = await trust.confirm("cleo", "architecture");

  expect(penalized.score).toBeCloseTo(0.36, 6);
  expect(recovered.score).toBeCloseTo(0.3728, 6);
  expect(recovered.samples).toBe(3);
});

test("weekly decay runs on read", async () => {
  writeTrust("cleo", {
    version: 1,
    domains: Object.fromEntries(TRUST_DOMAINS.map((domain) => [
      domain,
      { score: 0.8, samples: 3, lastUpdated: "2026-05-05T00:00:00.000Z" },
    ])) as TrustFile["domains"],
  });

  const trust = system();
  const file = await trust.read("cleo");

  expect(file.domains.code_review.score).toBeCloseTo(0.8 * 0.99 * 0.99, 6);
  expect(file.domains.code_review.lastUpdated).toBe("2026-05-19T00:00:00.000Z");
});

test("scores clamp to floor and ceiling", async () => {
  const trust = system();

  for (let i = 0; i < 10; i++) {
    await trust.penalize("cleo", "external_action");
  }
  const low = await trust.get("cleo", "external_action");
  expect(low.score).toBe(0.1);

  writeTrust("cleo", {
    version: 1,
    domains: Object.fromEntries(TRUST_DOMAINS.map((domain) => [
      domain,
      { score: domain === "private_mode" ? 0.999 : 0.5, samples: 0, lastUpdated: current.toISOString() },
    ])) as TrustFile["domains"],
  });
  const high = await trust.confirm("cleo", "private_mode");
  expect(high.score).toBeLessThanOrEqual(1);
});

test("classifies domains from action type and paths", () => {
  const trust = system();

  expect(trust.classifyDomain({ path: "rooms/bruno/substrate/fact.md" })).toBe("memory_write");
  expect(trust.classifyDomain({ path: "src/session/lifecycle.ts" })).toBe("code_review");
  expect(trust.classifyDomain({ actionType: "telegram_send" })).toBe("communication");
  expect(trust.classifyDomain({ actionType: "spawn_legio" })).toBe("architecture");
  expect(trust.classifyDomain({ actionType: "external_api_write" })).toBe("external_action");
  expect(trust.classifyDomain({ actionType: "private_mode_boundary" })).toBe("private_mode");
});

function system(): TrustSystem {
  return new TrustSystem({ roomsDir, now: () => current });
}

function writeTrust(agentId: string, file: TrustFile): void {
  writeFileSync(join(roomsDir, agentId, "trust.json"), JSON.stringify(file, null, 2), "utf-8");
}

function readTrust(agentId: string): TrustFile {
  return JSON.parse(readFileSync(join(roomsDir, agentId, "trust.json"), "utf-8")) as TrustFile;
}
