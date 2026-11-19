import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// check-consistency.sh validates abel's SCENT residues against MEMORY.md and
// writes the mismatches to a report. These tests run the real script against a
// throwaway agora tree so the detection rules are checked end to end.

const SCRIPT = join(import.meta.dir, "check-consistency.sh");

let root: string;
let blade: string;
let scent: string;
let memory: string;
let report: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "abel-consistency-"));
  blade = join(root, "agora/familia/abel/BLADE");
  scent = join(blade, "SCENT");
  memory = join(root, "agora/familia/abel/MEMORY.md");
  report = join(blade, "consistency-report.md");
  mkdirSync(scent, { recursive: true });
  writeFileSync(memory, "# MEMORY\n\n", "utf-8");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bash", SCRIPT], {
    env: {
      ...process.env,
      BLADE_DIR: blade,
      MEMORY_FILE: memory,
      REPORT_FILE: report,
      ...env,
    },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    report: (() => {
      try {
        return readFileSync(report, "utf-8");
      } catch {
        return "";
      }
    })(),
  };
}

describe("check-consistency.sh", () => {
  test("reports a residue whose topic MEMORY.md never recorded", () => {
    writeFileSync(join(scent, "2026-05-01.md"), "# voice: held em stance\n", "utf-8");

    const result = run();

    expect(result.code).toBe(1);
    expect(result.report).toContain("Mismatches: 1");
    expect(result.report).toContain("2026-05-01.md:1");
    expect(result.report).toContain("`voice`");
    expect(result.report).toContain("missing");
    expect(result.report).toContain("held em stance");
  });

  test("flags a residue whose MEMORY.md entry says something else", () => {
    writeFileSync(join(scent, "2026-05-01.md"), "# stance: pushed back on the lease design\n", "utf-8");
    writeFileSync(
      memory,
      "# MEMORY\n\n- stance: folded and stopped disagreeing about scheduling\n",
      "utf-8",
    );

    const result = run();

    expect(result.code).toBe(1);
    expect(result.report).toContain("Mismatches: 1");
    expect(result.report).toContain("diverged");
    expect(result.report).toContain("pushed back on the lease design");
    // The hand-checkable half: the MEMORY.md line the residue drifts from.
    expect(result.report).toContain("folded and stopped disagreeing about scheduling");
    expect(result.report).toContain("MEMORY.md:3");
  });

  test("a matching residue is a clean run with no false positives", () => {
    writeFileSync(
      join(scent, "2026-05-01.md"),
      "# voice: held em stance\n# stance: pushed back on the lease design\n",
      "utf-8",
    );
    writeFileSync(
      memory,
      [
        "# MEMORY",
        "",
        "## Residues",
        "- voice: held em stance through the review",
        "- stance: pushed back on the lease design and kept it",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = run();

    expect(result.code).toBe(0);
    expect(result.report).toContain("Mismatches: 0");
    expect(result.report).toContain("No mismatches");
  });

  test("an empty SCENT directory is a clean run", () => {
    const result = run();

    expect(result.code).toBe(0);
    expect(result.report).toContain("Mismatches: 0");
  });

  test("never mutates MEMORY.md", () => {
    const original = "# MEMORY\n\n- voice: something else entirely about scheduling\n";
    writeFileSync(join(scent, "2026-05-01.md"), "# voice: held em stance\n", "utf-8");
    writeFileSync(memory, original, "utf-8");

    const result = run();

    expect(result.code).toBe(1);
    expect(readFileSync(memory, "utf-8")).toBe(original);
  });

  test("missing MEMORY.md is an input error, not a false clean run", () => {
    writeFileSync(join(scent, "2026-05-01.md"), "# voice: held em stance\n", "utf-8");
    rmSync(memory);

    const result = run();

    expect(result.code).toBe(2);
    expect(result.err).toContain("MEMORY.md");
    expect(result.report).toBe("");
  });

  test("each mismatch is listed with the details needed to check it by hand", () => {
    writeFileSync(join(scent, "2026-05-01.md"), "# voice: held em stance\n", "utf-8");
    writeFileSync(join(scent, "2026-05-02.md"), "# presence: felt present in review\n", "utf-8");

    const result = run();

    expect(result.code).toBe(1);
    const listed = result.report.split("\n").filter((line) => line.startsWith("- ["));
    expect(listed).toHaveLength(2);
    expect(result.report).toContain("2026-05-02.md:1");
    expect(result.report).toContain("felt present in review");
  });
});
