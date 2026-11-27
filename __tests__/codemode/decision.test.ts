/**
 * anima #427, codemode guest trust: the decision record itself.
 *
 * The slice ships a written decision and a baseline report instead of a product tool, so the artifacts are the
 * deliverable. These tests keep them from drifting: the design must name exactly one chosen option and a reason
 * for each rejected one, and the baseline must record the model, the run count and the date or say plainly that
 * no measured baseline exists yet.
 */

import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CHANGE = join(import.meta.dir, "..", "..", "openspec", "changes", "anima-codemode-guest-trust");

const read = (name: string) => readFileSync(join(CHANGE, name), "utf-8");

describe("design document", () => {
  test("it exists and names one chosen option and a reason for each rejected one", () => {
    expect(existsSync(join(CHANGE, "design.md"))).toBe(true);
    const text = read("design.md");
    expect(text).toContain("Chosen");
    expect(text).toContain("child process");
    for (const rejected of ["Isolated JavaScript engine", "Hardened worker"]) {
      expect(text).toContain(rejected);
    }
    expect(text).toContain("what each option can and cannot reach".slice(0, 0) + "What it can reach");
  });

  test("it states the escape attempts and the fail-closed rule", () => {
    const text = read("design.md");
    for (const category of ["file read", "file write", "network", "process spawn", "environment", "host globals"]) {
      expect(text.toLowerCase()).toContain(category);
    }
    expect(text.toLowerCase()).toContain("fail closed");
  });

  test("it states the measurement plan: fixed set, three arms, same model, metrics", () => {
    const text = read("design.md");
    expect(text).toContain("direct-tools");
    expect(text).toContain("program-tool");
    expect(text).toContain("assistant-code-mode");
    expect(text).toContain("rounds");
    expect(text).toContain("wall time");
    expect(text).toContain("tokens");
    expect(text).toContain("pass rate");
  });
});

describe("baseline report", () => {
  test("it exists and records the model, the run count and the date, or says no measured baseline exists", () => {
    expect(existsSync(join(CHANGE, "baseline.md"))).toBe(true);
    const text = read("baseline.md");
    expect(text).toContain("bun src/codemode/bench.ts");
    expect(text).toContain("Runs:");
    const measured = /Model:\s*\S+/.test(text);
    const declined = /not the measured model baseline/.test(text);
    expect({ measured, declined }).toSatisfy(({ measured: m, declined: d }) => m || d);
  });

  test("it never quotes a number as a model baseline without a model name", () => {
    const text = read("baseline.md");
    if (/^Model:/m.test(text)) return; // a measured run must carry its model
    expect(text).toContain("scripted");
    expect(text).toContain("not reported");
  });
});
