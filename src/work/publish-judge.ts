import type { ChangedFile } from "./publish-snapshot";
import { checkChange, partitionGenerated, type CheckName } from "./publish-checks";
import { redactSecrets } from "./publish-secrets";
import type { TestOutcome } from "./publish-tests";

export interface JudgeDeps {
  /**
   * The change against the base from the host's own Git directory (snapshotChange bound to it). Called twice.
   * The `treeHash` and the file list MUST be computed with the generated files excluded (the wiring binds
   * `snapshotChange` with `{ exclude: GENERATED_EXCLUDES }`, rfcclub/anima#386); the judge compares the hash as given.
   * `partitionGenerated` below is defence in depth for a snapshot that still lists them.
   */
  snapshot: () => { treeHash: string; files: ChangedFile[] };
  readText: (path: string) => string | undefined;
  /** The test argv the host derived (deriveTestCommand bound to the issue text and the tree), or null. */
  testCommand: (files: ChangedFile[]) => string[] | null;
  runTests: (argv: string[]) => Promise<TestOutcome>;
}

export type JudgeFailure = CheckName | "no-tests" | "tests-failed" | "tests-timeout" | "tree-changed";

export type JudgeOutcome =
  | { ok: true; treeHash: string; files: ChangedFile[]; generated: ChangedFile[]; testOutput: string }
  | { ok: false; check: JudgeFailure; detail: string };

/** The one detail a failed test run carries: the output is never copied, because it comes from model-written code. */
const TESTS_DID_NOT_PASS = "the derived tests did not pass";

/** Decide whether the host may publish this work tree: checks, then the derived tests, then a second snapshot. */
export async function judgeWorkTree(deps: JudgeDeps): Promise<JudgeOutcome> {
  const first = deps.snapshot();
  const { kept, generated } = partitionGenerated(first.files);

  const checked = checkChange(kept, deps.readText);
  if (!checked.ok) return { ok: false, check: checked.check, detail: checked.detail };

  const argv = deps.testCommand(kept);
  if (argv === null) return { ok: false, check: "no-tests", detail: "no test command could be derived" };

  const outcome = await deps.runTests(argv);
  if (!outcome.ok) return { ok: false, check: outcome.check, detail: TESTS_DID_NOT_PASS };

  const second = deps.snapshot();
  if (second.treeHash !== first.treeHash) {
    return { ok: false, check: "tree-changed", detail: "the work tree changed while the tests ran" };
  }

  return {
    ok: true,
    treeHash: first.treeHash,
    files: kept,
    generated,
    testOutput: redactSecrets(outcome.output),
  };
}
