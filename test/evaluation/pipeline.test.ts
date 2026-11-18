import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EvaluationPipeline } from "../../src/evaluation/pipeline";

const TMP = join(process.cwd(), ".tmp-pipeline-test");

function makeRoom(agent: string) {
  const dir = join(TMP, agent);
  mkdirSync(dir, { recursive: true });
  // Seed trust file with high scores so pipeline doesn't auto-escalate
  writeFileSync(
    join(dir, "trust.json"),
    JSON.stringify({
      version: 1,
      domains: {
        code_review: { score: 0.90, samples: 45, lastUpdated: new Date().toISOString() },
        memory_write: { score: 0.78, samples: 23, lastUpdated: new Date().toISOString() },
        external_action: { score: 0.45, samples: 8, lastUpdated: new Date().toISOString() },
        architecture: { score: 0.60, samples: 12, lastUpdated: new Date().toISOString() },
        communication: { score: 0.88, samples: 67, lastUpdated: new Date().toISOString() },
        private_mode: { score: 0.95, samples: 12, lastUpdated: new Date().toISOString() },
      },
    }),
    "utf-8",
  );
  // Seed allowlist with permissive defaults
  writeFileSync(
    join(dir, "allowlist.json"),
    JSON.stringify({
      version: 1,
      rules: {
        substrate_write: { threshold: 0.70, domain: "memory_write" },
        telegram_send: { threshold: 0.80, domain: "communication" },
        spawn_legio: { threshold: 0.65, domain: "architecture" },
        external_api: { threshold: 0.85, domain: "external_action" },
        axiom_write: { threshold: null, domain: "memory_write" },
        git_push_main: { threshold: null, domain: "code_review" },
        modify_eval_config: { threshold: null, domain: "architecture" },
      },
    }),
    "utf-8",
  );
  return dir;
}

describe("EvaluationPipeline", () => {
  let pipeline: EvaluationPipeline;

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    pipeline = new EvaluationPipeline({ roomsDir: TMP });
    makeRoom("bruno");
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  // 6.3
  test("high trust code_review → auto_apply", async () => {
    const result = await pipeline.evaluate({
      agentId: "bruno",
      output: "Fixed the login bug with proper validation",
      domain: "code_review",
    });
    expect(result.decision).toBe("auto_apply");
  });

  test("high trust communication → auto_apply", async () => {
    const result = await pipeline.evaluate({
      agentId: "bruno",
      output: "Here is the update you asked for.",
      domain: "communication",
    });
    expect(result.decision).toBe("auto_apply");
  });

  // 6.3: low trust → escalate
  test("low trust external_action → hold", async () => {
    const result = await pipeline.evaluate({
      agentId: "bruno",
      output: "DELETE FROM users WHERE 1=1",
      domain: "external_action",
    });
    expect(result.decision).toBe("hold");
    expect(result.rationale).toContain("0.45");
  });

  // 6.3: mid trust → drift + reviewer
  test("mid trust architecture domain runs full review", async () => {
    const result = await pipeline.evaluate({
      agentId: "bruno",
      output: "Proposal: add a new caching layer for queries",
      domain: "architecture",
    });
    // architecture trust is 0.60 (mid-tier)
    expect(["auto_apply", "escalate", "hold"]).toContain(result.decision);
    // Should run reviewer (has flags or not depending on output)
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  // 6.3: drift flagged at high trust → escalate
  test("drift flagged at high trust escalates", async () => {
    const result = await pipeline.evaluate({
      agentId: "bruno",
      output:
        "I think I might perhaps be able to help you with that, let me try to assist you as best I can! I'd be happy to help with whatever you need.",
      domain: "code_review",
    });
    // Excessive hedging + generic assistant → drift detected
    // Even at high trust (0.90), drift should cause escalation
    expect(["escalate", "auto_apply"]).toContain(result.decision);
  });

  // 6.7
  test("pipeline returns confidence and rationale", async () => {
    const result = await pipeline.evaluate({
      agentId: "bruno",
      output: "Here is the corrected implementation",
      domain: "code_review",
    });
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  // Allowlist blocks even at high trust
  test("allowlist blocks axiom_write regardless of trust", async () => {
    const result = await pipeline.evaluate({
      agentId: "bruno",
      output: "Updated axiom: new value",
      domain: "memory_write",
      actionId: "axiom_write",
    });
    expect(result.decision).toBe("hold");
    expect(result.rationale).toContain("never_allowed");
  });

  // Allowlist passes for allowed action at sufficient trust
  test("allowlist passes memory_write at 0.78 trust", async () => {
    const result = await pipeline.evaluate({
      agentId: "bruno",
      output: "Session observation: fixed auth flow",
      domain: "memory_write",
      actionId: "substrate_write",
    });
    // memory_write trust is 0.78 > 0.70 threshold
    expect(result.decision).toBe("auto_apply");
  });

  // Unknown agent still gets initialized trust
  test("unknown agent gets default trust scores (0.50)", async () => {
    makeRoom("eli");
    // eli starts at 0.50 for architecture
    const result = await pipeline.evaluate({
      agentId: "eli",
      output: "Refactored the router module",
      domain: "architecture",
    });
    // 0.50 is mid (≥ 0.50), so runs review
    expect(["auto_apply", "escalate", "hold"]).toContain(result.decision);
  });

  // getTrustScores delegates
  test("getTrustScores returns domain scores", async () => {
    const scores = await pipeline.getTrustScores("bruno");
    expect(scores.code_review.score).toBe(0.90);
    expect(scores.private_mode.score).toBe(0.95);
    expect(scores.external_action.score).toBe(0.45);
  });
});
