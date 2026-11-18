import { beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AllowlistEnforcement, classifyWriteAction } from "../../src/evaluation/allowlist";

let tempDir: string;
let roomsDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `anima-allowlist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roomsDir = join(tempDir, "rooms");
  mkdirSync(join(roomsDir, "bruno"), { recursive: true });
});

function enforcement() {
  return new AllowlistEnforcement({ roomsDir });
}

// ── Task 7.6a: substrate write blocked at trust 0.65 ─────────────────────────────

test("substrate_write blocked when trust_score is 0.65 (threshold 0.70)", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "substrate_write", trustScore: 0.65 });
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.reason).toBe("trust_too_low");
    expect(result.required).toBe(0.70);
    expect(result.current).toBe(0.65);
  }
});

// ── Task 7.6b: substrate write allowed at trust 0.75 ─────────────────────────────

test("substrate_write allowed when trust_score is 0.75 (threshold 0.70)", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "substrate_write", trustScore: 0.75 });
  expect(result.allowed).toBe(true);
});

test("substrate_write allowed at exactly threshold 0.70", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "substrate_write", trustScore: 0.70 });
  expect(result.allowed).toBe(true);
});

// ── Task 7.6c: axiom write always blocked ────────────────────────────────────

test("axiom_write always blocked regardless of trust score", async () => {
  const al = enforcement();
  const highTrust = await al.check("bruno", { action: "axiom_write", trustScore: 0.99 });
  expect(highTrust.allowed).toBe(false);
  if (!highTrust.allowed) {
    expect(highTrust.reason).toBe("never_allowed");
    expect(highTrust.required).toBeNull();
  }
});

test("axiom_write blocked even at trust 1.0", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "axiom_write", trustScore: 1.0 });
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.reason).toBe("never_allowed");
  }
});

// ── git_push_main — never allowed ────────────────────────────────────────────

test("git_push_main is never allowed", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "git_push_main", trustScore: 1.0 });
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.reason).toBe("never_allowed");
  }
});

test("modify_eval_config is never allowed", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "modify_eval_config", trustScore: 1.0 });
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.reason).toBe("never_allowed");
  }
});

// ── telegram_send thresholds ──────────────────────────────────────────────────

test("telegram_send blocked below 0.80 threshold", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "telegram_send", trustScore: 0.79 });
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.required).toBe(0.80);
  }
});

test("telegram_send allowed at 0.80", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "telegram_send", trustScore: 0.80 });
  expect(result.allowed).toBe(true);
});

// ── spawn_legio thresholds ────────────────────────────────────────────────────

test("spawn_legio blocked below 0.65", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "spawn_legio", trustScore: 0.64 });
  expect(result.allowed).toBe(false);
  if (!result.allowed) {
    expect(result.required).toBe(0.65);
  }
});

test("spawn_legio allowed at 0.65", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "spawn_legio", trustScore: 0.65 });
  expect(result.allowed).toBe(true);
});

// ── Unknown action — passthrough ──────────────────────────────────────────────

test("unknown action is allowed by default (not gated)", async () => {
  const al = enforcement();
  const result = await al.check("bruno", { action: "some_unknown_action", trustScore: 0.0 });
  expect(result.allowed).toBe(true);
});

// ── seedDefault + read round-trip ─────────────────────────────────────────────

test("seedDefault writes allowlist.json and read returns defaults", async () => {
  const al = enforcement();
  await al.seedDefault("bruno");
  const file = await al.read("bruno");
  expect(file.version).toBe(1);
  expect(file.rules.substrate_write.threshold).toBe(0.70);
  expect(file.rules.axiom_write.threshold).toBeNull();
});

test("seedDefault does not overwrite existing file by default", async () => {
  const al = enforcement();
  await al.seedDefault("bruno");
  // Manually change a rule
  const file = await al.read("bruno");
  file.rules.substrate_write.threshold = 0.99;
  await al.write("bruno", file);

  // seedDefault without force — should not overwrite
  await al.seedDefault("bruno");
  const after = await al.read("bruno");
  expect(after.rules.substrate_write.threshold).toBe(0.99);
});

test("seedDefault force=true overwrites existing file", async () => {
  const al = enforcement();
  await al.seedDefault("bruno");

  const file = await al.read("bruno");
  file.rules.substrate_write.threshold = 0.99;
  await al.write("bruno", file);

  await al.seedDefault("bruno", true);
  const after = await al.read("bruno");
  expect(after.rules.substrate_write.threshold).toBe(0.70);
});

// ── classifyWriteAction helper ────────────────────────────────────────────────

test("classifyWriteAction: 0_SOUL path returns axiom_write", () => {
  expect(classifyWriteAction("/home/user/substrate/0_SOUL/axioms.md")).toBe("axiom_write");
  expect(classifyWriteAction("0_SOUL/layer0_core.md")).toBe("axiom_write");
});

test("classifyWriteAction: substrate/ path returns substrate_write", () => {
  expect(classifyWriteAction("/home/user/substrate/1_EGO/self.md")).toBe("substrate_write");
  expect(classifyWriteAction("substrate/2_MIND/insights.md")).toBe("substrate_write");
});

// ── No-file fallback ──────────────────────────────────────────────────────────

test("read returns default rules when no allowlist.json exists", async () => {
  const al = enforcement();
  // No file written — new agent "sam" has no allowlist
  mkdirSync(join(roomsDir, "sam"), { recursive: true });
  const file = await al.read("sam");
  expect(file.rules.axiom_write.threshold).toBeNull();
  expect(file.rules.substrate_write.threshold).toBe(0.70);
});
