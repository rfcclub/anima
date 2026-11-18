import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// evaluate-session-traces.sh is the decision layer over the pending session
// traces: it scores every pending trace against the criteria in GATES.md and
// then promotes it (EMBERS.md), prunes it, or leaves it pending when it is
// borderline. Every test runs the real script against a throwaway AGORA_ROOT.

const SCRIPT = join(import.meta.dir, "evaluate-session-traces.sh");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const GATES = `# Kai gates

Criteria are one per line: \`- <metric> <op> <value>\`.

## gate: promote-to-embers

- words >= 20
- sections >= 2
- has_summary == 1
- has_decisions == 1
`;

const body = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
const passing = ["# Session trace", "## Summary", body, "## Decisions", "none"].join("\n") + "\n";
const borderline = ["# Partial", "## Summary", "too short", "## Decisions", "none"].join("\n") + "\n";
const failing = "# empty\nnothing much\n";

function fixture(gates: string | null = GATES) {
  const root = mkdtempSync(join(tmpdir(), "kai-traces-"));
  roots.push(root);
  const kai = join(root, "familia", "kai");
  const traces = join(kai, "session-traces");
  mkdirSync(traces, { recursive: true });
  if (gates !== null) writeFileSync(join(kai, "GATES.md"), gates);
  return { root, kai, traces };
}

function run(root: string, extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bash", SCRIPT], { env: { ...process.env, AGORA_ROOT: root, ...extraEnv } });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function runOk(root: string, extraEnv: Record<string, string> = {}) {
  const result = run(root, extraEnv);
  if (result.code !== 0) throw new Error(result.err);
  return result;
}

function ledger(traces: string) {
  const file = join(traces, "evaluations.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { trace: string; outcome: string; score: number; criteria: number });
}

describe("evaluate-session-traces.sh", () => {
  test("scores pending traces against GATES.md and promotes, prunes or holds per the outcome", () => {
    const { root, kai, traces } = fixture();
    writeFileSync(join(traces, "passing.md"), passing);
    writeFileSync(join(traces, "failing.md"), failing);
    writeFileSync(join(traces, "borderline.md"), borderline);

    runOk(root);

    const embers = readFileSync(join(kai, "EMBERS.md"), "utf8");
    expect(embers).toContain("## passing");
    expect(embers).not.toContain("## failing");
    expect(embers).not.toContain("## borderline");

    // Promotion and pruning both clear the pending set; nothing is deleted.
    expect(readdirSync(traces).filter((name) => name.endsWith(".md"))).toEqual(["borderline.md"]);
    expect(readFileSync(join(traces, "promoted", "passing.md"), "utf8")).toBe(passing);
    expect(readFileSync(join(traces, "pruned", "failing.md"), "utf8")).toBe(failing);

    expect(ledger(traces).sort((a, b) => a.trace.localeCompare(b.trace))).toEqual([
      { trace: "borderline.md", outcome: "borderline", score: 3, criteria: 4 },
      { trace: "failing.md", outcome: "pruned", score: 0, criteria: 4 },
      { trace: "passing.md", outcome: "promoted", score: 4, criteria: 4 },
    ]);
  });

  test("the borderline ratio is pinned by the caller and defaults to three quarters", () => {
    const { root, traces } = fixture(GATES + "- words >= 500\n");
    writeFileSync(join(traces, "four-of-five.md"), passing);

    runOk(root);
    expect(ledger(traces)[0]).toMatchObject({ trace: "four-of-five.md", outcome: "borderline", score: 4, criteria: 5 });

    rmSync(join(traces, "evaluations.jsonl"));
    runOk(root, { KAI_BORDERLINE_RATIO: "0.9" });
    expect(ledger(traces)[0]).toMatchObject({ outcome: "pruned" });
    expect(existsSync(join(traces, "pruned", "four-of-five.md"))).toBe(true);
  });

  test("a second run is idempotent: EMBERS.md and the ledger are not written twice", () => {
    const { root, kai, traces } = fixture();
    writeFileSync(join(traces, "passing.md"), passing);
    runOk(root);
    const embers = readFileSync(join(kai, "EMBERS.md"), "utf8");

    runOk(root);
    expect(readFileSync(join(kai, "EMBERS.md"), "utf8")).toBe(embers);
    expect(ledger(traces)).toHaveLength(1);
  });

  test("no GATES.md or no criteria fails without touching a single trace", () => {
    for (const gates of [null, "# Kai gates\n\nno criteria here\n"]) {
      const { root, kai, traces } = fixture(gates);
      writeFileSync(join(traces, "passing.md"), passing);

      const result = run(root);
      expect(result.code).not.toBe(0);
      expect(result.err).toContain("GATES.md");
      expect(readdirSync(traces)).toEqual(["passing.md"]);
      expect(existsSync(join(kai, "EMBERS.md"))).toBe(false);
    }
  });

  test("an empty pending set is a no-op success", () => {
    const { root, kai, traces } = fixture();
    expect(run(root).code).toBe(0);
    expect(existsSync(join(kai, "EMBERS.md"))).toBe(false);
    expect(existsSync(join(traces, "evaluations.jsonl"))).toBe(false);
  });
});
