import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  test("missing SCENT directory is an input error, not a false clean run", () => {
    rmSync(scent, { recursive: true, force: true });

    const result = run({ SCENT_DIR: join(root, "agora/familia/abel/BLADE/NOPE") });

    expect(result.code).toBe(2);
    expect(result.err).toContain("SCENT");
    expect(result.report).toBe("");
  });

  test("SCENT path that is a file is an input error", () => {
    const notADir = join(blade, "SCENT-is-a-file.md");
    writeFileSync(notADir, "# voice: held em stance\n", "utf-8");

    const result = run({ SCENT_DIR: notADir });

    expect(result.code).toBe(2);
    expect(result.err).toContain("SCENT");
  });

  test("a residue must not pass on a substring of the memory entry", () => {
    writeFileSync(join(scent, "2026-05-01.md"), "# deploy: done\n", "utf-8");
    writeFileSync(memory, "# MEMORY\n\n- deploy: not done\n", "utf-8");

    const result = run();

    expect(result.code).toBe(1);
    expect(result.report).toContain("Mismatches: 1");
    expect(result.report).toContain("diverged");
    expect(result.report).toContain("not done");
  });

  test("a residue matching a later duplicate topic entry is consistent", () => {
    writeFileSync(join(scent, "2026-05-01.md"), "# mood: steady\n", "utf-8");
    writeFileSync(memory, "# MEMORY\n\n- mood: restless\n- mood: steady\n", "utf-8");

    const result = run();

    expect(result.code).toBe(0);
    expect(result.report).toContain("Mismatches: 0");
  });

  test("duplicate topics are still checked when none of them match", () => {
    writeFileSync(join(scent, "2026-05-01.md"), "# mood: steady\n", "utf-8");
    writeFileSync(memory, "# MEMORY\n\n- mood: restless\n- mood: frayed\n", "utf-8");

    const result = run();

    expect(result.code).toBe(1);
    expect(result.report).toContain("diverged");
    expect(result.report).toContain("frayed");
  });

  test("refuses a report destination that is the memory input", () => {
    const original = "# MEMORY\n\n- voice: held em stance\n";
    writeFileSync(join(scent, "2026-05-01.md"), "# voice: held em stance\n", "utf-8");
    writeFileSync(memory, original, "utf-8");

    const result = run({ REPORT_FILE: memory });

    expect(result.code).toBe(2);
    expect(result.err).toContain("MEMORY.md");
    expect(readFileSync(memory, "utf-8")).toBe(original);
  });

  test("refuses a report destination symlinked to the memory input", () => {
    const original = "# MEMORY\n\n- voice: held em stance\n";
    writeFileSync(join(scent, "2026-05-01.md"), "# voice: held em stance\n", "utf-8");
    writeFileSync(memory, original, "utf-8");
    const link = join(blade, "sneaky-report.md");
    symlinkSync(memory, link);

    const result = run({ REPORT_FILE: link });

    expect(result.code).toBe(2);
    expect(result.err).toContain("MEMORY.md");
    expect(readFileSync(memory, "utf-8")).toBe(original);
  });

  test("refuses a report destination hard-linked to the memory input", () => {
    const original = "# MEMORY\n\n- voice: held em stance\n";
    writeFileSync(join(scent, "2026-05-01.md"), "# voice: held em stance\n", "utf-8");
    writeFileSync(memory, original, "utf-8");
    const link = join(blade, "hard-report.md");
    linkSync(memory, link);

    const result = run({ REPORT_FILE: link });

    expect(result.code).toBe(2);
    expect(result.err).toContain("MEMORY.md");
    expect(readFileSync(memory, "utf-8")).toBe(original);
    expect(readFileSync(link, "utf-8")).toBe(original);
  });

  test("refuses a report destination hard-linked to a SCENT residue", () => {
    const original = "# voice: held em stance\n";
    const residueFile = join(scent, "2026-05-01.md");
    writeFileSync(residueFile, original, "utf-8");
    writeFileSync(memory, "# MEMORY\n\n- voice: held em stance\n", "utf-8");
    const link = join(blade, "hard-report.md");
    linkSync(residueFile, link);

    const result = run({ REPORT_FILE: link });

    expect(result.code).toBe(2);
    expect(result.err).toContain("SCENT");
    expect(readFileSync(residueFile, "utf-8")).toBe(original);
    expect(readFileSync(link, "utf-8")).toBe(original);
  });

  test("refuses a report destination inside the SCENT directory", () => {
    const original = "# voice: held em stance\n";
    writeFileSync(join(scent, "2026-05-01.md"), original, "utf-8");
    writeFileSync(memory, "# MEMORY\n\n- voice: held em stance\n", "utf-8");

    const result = run({ REPORT_FILE: join(scent, "consistency-report.md") });

    expect(result.code).toBe(2);
    expect(result.err).toContain("SCENT");
    expect(readFileSync(join(scent, "2026-05-01.md"), "utf-8")).toBe(original);
  });
});
