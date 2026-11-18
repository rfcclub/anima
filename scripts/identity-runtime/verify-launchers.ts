/**
 * On-demand check that the real launchers in ~/scripts inject an identity the way the
 * loader contract requires. They live outside the repo, so this cannot run in CI:
 * it runs each real launcher against a stub vendor binary and fails if the argv is wrong.
 *
 * Usage: bun scripts/identity-runtime/verify-launchers.ts   (AGENT_LOADER_LAUNCH_DIR overrides ~/scripts)
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const launchDir = process.env.AGENT_LOADER_LAUNCH_DIR ?? join(homedir(), "scripts");
const root = mkdtempSync(join(tmpdir(), "verify-launchers-"));
const binDir = join(root, "bin");
const out = join(root, "argv.out");
const identity = join(root, "CORE_IDENTITY.md");
const identityText = "# Test identity\nsecond line\n";
writeFileSync(identity, identityText);

const STUB = `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "\${STUB_OUT:?}"\n`;
function stub(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, STUB);
  chmodSync(path, 0o755);
  return path;
}
stub(join(binDir, "claude"));
stub(join(binDir, "omp"));
const codexStub = stub(join(root, "codex-stub"));

function launch(command: string[], env: Record<string, string>, cwd: string = root): { code: number; argv: string[] | undefined } {
  if (existsSync(out)) writeFileSync(out, "");
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(command, {
      cwd,
      env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: process.env.HOME ?? root, STUB_OUT: out, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { code: 127, argv: undefined };
  }
  const raw = existsSync(out) ? readFileSync(out, "utf8") : "";
  const argv = raw === "" ? undefined : raw.split("\0").slice(0, -1);
  return { code: proc.exitCode ?? 1, argv };
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures.push(name);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// HL-10 — claudia → claude --append-system-prompt-file <identity>
{
  const result = launch([join(launchDir, "claude", "claudia"), "new"], { AGENT_NAME: "lena", AGENT_IDENTITY_FILE: identity });
  const at = result.argv?.indexOf("--append-system-prompt-file") ?? -1;
  check("HL-10 claudia passes --append-system-prompt-file <identity>", result.code === 0 && at >= 0 && result.argv![at + 1] === identity, JSON.stringify(result));
}

// HL-09 — codexia → codex -c developer_instructions = '''<identity>'''
{
  const result = launch([join(launchDir, "codex", "codexia"), identity, "--foo", "bar baz"], { CODEXIA_BIN: codexStub });
  check(
    "HL-09 codexia passes developer_instructions then the host arguments",
    result.code === 0 && same(result.argv, ["-c", `developer_instructions = '''${identityText}'''`, "--foo", "bar baz"]),
    JSON.stringify(result),
  );
  const tripleQuote = join(root, "triple.md");
  writeFileSync(tripleQuote, "has ''' inside\n");
  const rejected = launch([join(launchDir, "codex", "codexia"), tripleQuote], { CODEXIA_BIN: codexStub });
  check("HL-09 codexia rejects a projection containing ''' and starts nothing", rejected.code === 1 && rejected.argv === undefined, JSON.stringify(rejected));
  const unreadable = launch([join(launchDir, "codex", "codexia"), join(root, "missing.md")], { CODEXIA_BIN: codexStub });
  check("HL-09 codexia rejects an unreadable identity file and starts nothing", unreadable.code === 1 && unreadable.argv === undefined, JSON.stringify(unreadable));
}

// HL-15 — omp-agent → omp --append-system-prompt <identity> --cwd <cwd> …
{
  const workDir = realpathSync(mkdtempSync(join(root, "cwd-")));
  const withArgs = launch([join(launchDir, "omp", "omp-agent"), workDir, "--", "--model", "x"], { AGENT_IDENTITY_FILE: identity });
  check(
    "HL-15 omp-agent passes identity, --cwd and trailing omp arguments",
    withArgs.code === 0 && same(withArgs.argv, ["--append-system-prompt", identity, "--cwd", workDir, "--model", "x"]),
    JSON.stringify(withArgs),
  );
  const bare = launch([join(launchDir, "omp", "omp-agent")], { AGENT_IDENTITY_FILE: identity }, workDir);
  check(
    "HL-15 omp-agent with no arguments defaults --cwd to the current directory",
    bare.code === 0 && bare.argv?.length === 4 && realpathSync(bare.argv[3]!) === workDir,
    JSON.stringify(bare),
  );
  const empty = join(root, "empty.md");
  writeFileSync(empty, "");
  for (const [label, env] of [["unset", {}], ["empty", { AGENT_IDENTITY_FILE: empty }], ["missing", { AGENT_IDENTITY_FILE: join(root, "nope.md") }]] as const) {
    const result = launch([join(launchDir, "omp", "omp-agent")], env);
    check(`HL-15 omp-agent refuses to start when the identity file is ${label}`, result.code === 1 && result.argv === undefined, JSON.stringify(result));
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} launcher check(s) failed`);
  process.exit(1);
}
console.log("\nall launcher checks passed");
