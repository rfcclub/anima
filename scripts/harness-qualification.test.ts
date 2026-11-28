import { describe, expect, test } from "bun:test";
import {
  REQUIRED_STEPS,
  decideHarness,
  evaluateQualification,
  loadRuns,
  renderReport,
  type QualificationRun,
  type StepId,
} from "./harness-qualification";

function step(id: StepId, over: Partial<QualificationRun["steps"][number]> = {}) {
  return { id, output: `pi: ${id} ok\n`, exitCode: 0, sessionId: "sess-1", ...over };
}

function run(over: Partial<QualificationRun> = {}): QualificationRun {
  return {
    platform: "mac-mini",
    harness: "pi",
    version: "1.1.0",
    isolatedProfile: "/home/user/harness-qualify/profile",
    globalProfile: "/home/user/.pi",
    steps: REQUIRED_STEPS.filter((id) => id !== "global-install-unchanged").map((id) => step(id)),
    globalInstallDigestBefore: "sha256:aaa",
    globalInstallDigestAfter: "sha256:aaa",
    ...over,
  };
}

describe("evaluateQualification", () => {
  test("HQ-1 a complete Pi 1.1.x run on an isolated profile passes", () => {
    expect(evaluateQualification(run())).toEqual({ pass: true, failures: [] });
  });

  test("HQ-2 a pass without output does not count", () => {
    const result = evaluateQualification(run({ steps: run().steps.map((s) => (s.id === "prompt" ? { ...s, output: "  \n" } : s)) }));
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(["prompt: a pass without output does not count"]);
  });

  test("HQ-3 a non-zero exit code fails that step and is quoted", () => {
    const result = evaluateQualification(run({ steps: run().steps.map((s) => (s.id === "resume" ? { ...s, exitCode: 7 } : s)) }));
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(["resume: exited 7"]);
  });

  test("HQ-4 a missing exit code fails: an unrecorded result is not a pass", () => {
    const result = evaluateQualification(run({ steps: run().steps.map((s) => (s.id === "cancellation" ? { ...s, exitCode: null } : s)) }));
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(["cancellation: no exit code recorded"]);
  });

  test("HQ-5 every required step must be present", () => {
    const result = evaluateQualification(run({ steps: run().steps.filter((s) => s.id !== "codemode-load-after-resume") }));
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(["codemode-load-after-resume: missing"]);
  });

  test("HQ-6 an earlier Pi version is not qualified", () => {
    const result = evaluateQualification(run({ version: "1.0.1" }));
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(["version 1.0.1 is not 1.1.x"]);
  });

  test("HQ-7 the isolated profile must not be the global install or inside it", () => {
    expect(evaluateQualification(run({ isolatedProfile: "/home/user/.pi" })).failures).toEqual([
      "isolated profile is the global install",
    ]);
    expect(evaluateQualification(run({ isolatedProfile: "/home/user/.pi/qualify" })).failures).toEqual([
      "isolated profile is inside the global install",
    ]);
    expect(evaluateQualification(run({ isolatedProfile: "relative/profile" })).failures).toEqual([
      "isolated profile must be an absolute path",
    ]);
  });

  test("HQ-8 the lifecycle steps must report one session ID", () => {
    const steps = run().steps.map((s) => (s.id === "revision-2" ? { ...s, sessionId: "sess-2" } : s));
    expect(evaluateQualification(run({ steps })).failures).toEqual([
      "revision-2: session sess-2, expected sess-1",
    ]);
  });

  test("HQ-9 a step that names no session fails a lifecycle check", () => {
    const steps = run().steps.map((s) => (s.id === "launch" ? { ...s, sessionId: undefined } : s));
    expect(evaluateQualification(run({ steps })).failures).toEqual(["launch: no session ID recorded"]);
  });

  test("HQ-10 a credential in the output fails the run without being repeated", () => {
    const token = "ghp_" + "b".repeat(36);
    const steps = run().steps.map((s) => (s.id === "strong-model" ? { ...s, output: `provider said ${token}\n` } : s));
    const result = evaluateQualification(run({ steps }));
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(["strong-model: output contains a credential (github-token)"]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test("HQ-11 the global install must be byte-identical afterwards", () => {
    expect(evaluateQualification(run({ globalInstallDigestAfter: "sha256:bbb" })).failures).toEqual([
      "global install changed: sha256:aaa -> sha256:bbb",
    ]);
    expect(evaluateQualification(run({ globalInstallDigestBefore: undefined })).failures).toEqual([
      "global install digest was not recorded",
    ]);
  });

  test("HQ-12 the global-install step, when recorded, is judged like any other", () => {
    const steps = [...run().steps, step("global-install-unchanged", { output: "digest sha256:aaa\n" })];
    expect(evaluateQualification(run({ steps })).pass).toBe(true);
  });
});

describe("decideHarness", () => {
  const windows = (over: Partial<QualificationRun> = {}) => run({ platform: "windows", ...over });

  test("HQ-13 a passing Pi run on both platforms decides Pi", () => {
    const decision = decideHarness([run(), windows()]);
    expect(decision.harness).toBe("pi");
    expect(decision.reasons).toEqual(["mac-mini: pi 1.1.0 passed 13 checks", "windows: pi 1.1.0 passed 13 checks"]);
  });

  test("HQ-14 a Mac failure falls back to Crush with the failures named", () => {
    const decision = decideHarness([run({ version: "1.0.1" }), windows()]);
    expect(decision.harness).toBe("crush");
    expect(decision.reasons).toContain("mac-mini: version 1.0.1 is not 1.1.x");
  });

  test("HQ-15 a Windows check that fails with its output recorded is not blocking", () => {
    const steps = windows().steps.map((s) => (s.id === "codemode-load-after-resume" ? { ...s, exitCode: 1 } : s));
    const decision = decideHarness([run(), windows({ steps })]);
    expect(decision.harness).toBe("pi");
    expect(decision.reasons).toContain("windows: codemode-load-after-resume exited 1, recorded");
  });

  test("HQ-16 a Windows failure with no output is blocking", () => {
    const steps = windows().steps.map((s) => (s.id === "tool-denial" ? { ...s, exitCode: 1, output: "" } : s));
    const decision = decideHarness([run(), windows({ steps })]);
    expect(decision.harness).toBe("crush");
    expect(decision.reasons).toContain("windows: tool-denial: a pass without output does not count");
  });

  test("HQ-17 with no Windows run at all the decision stays on Pi, unqualified for Windows", () => {
    const decision = decideHarness([run()]);
    expect(decision.harness).toBe("pi");
    expect(decision.reasons).toEqual(["mac-mini: pi 1.1.0 passed 13 checks", "windows: not run"]);
  });

  test("HQ-18 a run of the fallback harness never decides Pi", () => {
    expect(decideHarness([run({ harness: "crush" })]).harness).toBe("crush");
  });
});

describe("renderReport", () => {
  test("HQ-19 the report lists each step with its exit code and never a secret", () => {
    const token = "ghp_" + "c".repeat(36);
    const steps = run().steps.map((s) => (s.id === "prompt" ? { ...s, output: `ok ${token}\n` } : s));
    const report = renderReport([run({ steps })]);
    expect(report).toContain("| step | exit | output |");
    expect(report).toContain("| launch | 0 |");
    expect(report).not.toContain(token);
    expect(report).toContain("[redacted]");
  });

  test("HQ-20 the report records the decision and its reasons", () => {
    const report = renderReport([run()]);
    expect(report).toContain("decision: pi");
    expect(report).toContain("mac-mini: pi 1.1.0 passed 13 checks");
  });
});

describe("loadRuns", () => {
  test("HQ-21 evidence is read back as runs", () => {
    const text = JSON.stringify({ runs: [run()] });
    expect(loadRuns(text)).toEqual([run()]);
  });

  test("HQ-22 evidence that is not a run list is refused, not judged as a pass", () => {
    expect(() => loadRuns("{}")).toThrow("evidence has no runs array");
    expect(() => loadRuns("[1]")).toThrow("evidence has no runs array");
    expect(() => loadRuns("{not json")).toThrow("evidence is not JSON");
  });

  test("HQ-23 a run without the fields the judgement needs is refused by name", () => {
    const { platform, ...rest } = run();
    expect(() => loadRuns(JSON.stringify({ runs: [rest] }))).toThrow("run 0 has no platform");
    expect(() => loadRuns(JSON.stringify({ runs: [{ ...run(), steps: [null] }] }))).toThrow("run 0 has no steps");
  });

  test("HQ-24 a run without the strings the judgement reads is refused before it can crash", () => {
    for (const field of ["version", "isolatedProfile", "globalProfile", "harness"] as const) {
      const { [field]: _dropped, ...rest } = run();
      expect(() => loadRuns(JSON.stringify({ runs: [rest] }))).toThrow(`run 0 has no ${field}`);
    }
  });
});
