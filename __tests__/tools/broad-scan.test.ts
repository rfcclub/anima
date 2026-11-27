import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBroadScan } from "../../src/tools/policy-enforcer";
import { executeTool, redactCommand, type ToolCommandRecord, type PolicyViolationRecord } from "../../src/tools/executor";

let home: string;
let project: string;
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "broad-scan-home-")));
  project = join(home, "work", "proj");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, "Library", "Containers"), { recursive: true });
  process.env.HOME = home;
});
afterAll(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const bash = (command: string, cwd = project) => checkBroadScan({ tool: "bash", args: { command }, cwd });

describe("checkBroadScan: bash", () => {
  test("a recursive scan rooted at the home directory, the filesystem root or Library is blocked", () => {
    for (const command of [
      "find ~ -name '*.md'",
      "find / -name hosts 2>/dev/null | head",
      "find ~/ -maxdepth 6 -name x",
      'find "$HOME" -type f -name x',
      "find ${HOME} -name x",
      "grep -rn token ~",
      "grep -R token /",
      "rg token $HOME",
      "find ~/Library -name '*.plist'",
      "ls -R ~/Library/Containers",
      "du -sh ~/Library/*",
      "echo start; find /Users -name x",
      "cd ~/work && find ~ -name x | head",
      "cd ~ && find . -name x",
      "cd / && find Users -name x",
      "cd && grep -rn token .",
      "find -L ~ -name x",
      "ls -lR ~",
      `find ${home} -name x`,
    ]) {
      const d = bash(command);
      expect({ command, allowed: d.allowed }).toEqual({ command, allowed: false });
      if (!d.allowed) expect(d.rule).toBe("broad-scan");
    }
  });

  test("a scan of the current directory is blocked when the current directory is the home directory or the root", () => {
    for (const command of ["find . -name x", "find Library -name x", "grep -rn token *", "grep -rn token", "rg token", "du -sh", "ls -R", "tree", "fd x"]) {
      const d = bash(command, home);
      expect({ command, allowed: d.allowed }).toEqual({ command, allowed: false });
    }
    expect(bash("grep -rn token .", "/").allowed).toBe(false);
  });

  test("the refusal names the directory, not the command", () => {
    const d = bash(`find ~ -name x; echo API_TOKEN=${FAKE}`);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.target).toBe(home);
      expect(d.target).not.toContain("API_TOKEN");
    }
  });

  test("scoped scans and non-scanning commands are allowed", () => {
    for (const command of [
      "find ~/work/proj -name '*.ts'",
      "find . -name '*.ts'",
      "grep -rn token src",
      "grep token ~/.zshrc",
      "rg token ~/agora",
      "ls ~",
      "ls -la /",
      "echo ~",
      "cat ~/work/proj/README.md",
      "git log --oneline -5",
      "du -sh ~/work",
      "ls -ltr ~",
      "ls -lart /",
      "ls -r ~",
      "rg / src",
      "grep -rn / src",
      "rg -e token src",
      "grep -rn token",
      "rg token",
      "cd ~/work/proj && find . -name x",
      "cd ~ && ls -la",
    ]) {
      const d = bash(command);
      expect({ command, allowed: d.allowed }).toEqual({ command, allowed: true });
    }
  });
});

describe("checkBroadScan: grep and glob tools", () => {
  test("grep or glob over the home directory, the root or Library is blocked", () => {
    for (const [tool, args] of [
      ["grep", { pattern: "x", path: home }],
      ["grep", { pattern: "x", path: "~/Library/Containers" }],
      ["grep", { pattern: "x", path: "/" }],
      ["glob", { pattern: "**/*.md", cwd: home }],
    ] as const) {
      const d = checkBroadScan({ tool, args: args as Record<string, unknown>, cwd: project });
      expect({ tool, args, allowed: d.allowed }).toEqual({ tool, args, allowed: false });
    }
  });

  test("grep without a path over a home cwd is blocked; a project path is allowed", () => {
    expect(checkBroadScan({ tool: "grep", args: { pattern: "x" }, cwd: home }).allowed).toBe(false);
    expect(checkBroadScan({ tool: "grep", args: { pattern: "x", path: project }, cwd: home }).allowed).toBe(true);
    expect(checkBroadScan({ tool: "glob", args: { pattern: "*.ts" }, cwd: project }).allowed).toBe(true);
    expect(checkBroadScan({ tool: "read", args: { path: join(home, ".zshrc") }, cwd: project }).allowed).toBe(true);
  });
});

describe("executeTool", () => {
  test("blocks a broad scan even without a policy and records the violation", async () => {
    const violations: PolicyViolationRecord[] = [];
    const out = await executeTool(
      { id: "t1", name: "bash", arguments: JSON.stringify({ command: "find ~ -name x" }) },
      { agentName: "cleo", policy: null, cwd: project, logViolation: (r) => violations.push(r), logCommand: () => {} },
    );
    expect(out).toStartWith("Error: policy violation (broad-scan)");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ agent: "cleo", tool: "bash", rule: "broad-scan", mode: "block" });
  });

  test("records which agent ran which bash command, truncated", async () => {
    const records: ToolCommandRecord[] = [];
    const long = "echo " + "a".repeat(2000);
    await executeTool(
      { id: "t2", name: "bash", arguments: JSON.stringify({ command: long }) },
      { agentName: "jade", policy: null, cwd: project, logCommand: (r) => records.push(r) },
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: "tool_command", agent: "jade", tool: "bash", cwd: project });
    expect(records[0]!.command.length).toBeLessThanOrEqual(500);
    expect(records[0]!.command).toStartWith("echo aaa");
  });
});

// Fake credentials are assembled at runtime so the source itself carries no secret-shaped literal.
const FAKE = ["very", "secret", "value", "123"].join("");
const FAKE_GH = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123"].join("");

describe("redactCommand", () => {
  test("masks inline credentials and keeps the rest of the command", () => {
    const cases: Array<[string, string]> = [
      [`gh api user --header x ${FAKE_GH}`, FAKE_GH],
      [`GITHUB_TOKEN=${FAKE_GH} gh api user`, FAKE_GH],
      ['curl -H "Authorization: Bearer abc123def" https://example.test/x', "abc123def"],
      ["curl -H 'Authorization: token zzzsecretzzz' https://example.test/x", "zzzsecretzzz"],
      ["mysql -u root -phunter2xx db", "hunter2xx"],
      ["psql --password=s3cr3tpw", "s3cr3tpw"],
      ["git clone https://user:pa55word@example.test/repo.git", "pa55word"],
      ["export MY_API_KEY=shortkey; run", "shortkey"],
    ];
    for (const [command, secret] of cases) {
      const out = redactCommand(command);
      expect({ command, leaked: out.includes(secret) }).toEqual({ command, leaked: false });
    }
    expect(redactCommand("find ~/work -name '*.ts' | head")).toBe("find ~/work -name '*.ts' | head");
  });

  test("neither the command record nor a refusal record carries an inline credential", async () => {
    const records: ToolCommandRecord[] = [];
    const violations: PolicyViolationRecord[] = [];
    for (const command of [`SERVICE_TOKEN=${FAKE} find ~ -name x`, `grep -rn x / # PASSWORD=${FAKE}`]) {
      await executeTool(
        { id: "t3", name: "bash", arguments: JSON.stringify({ command }) },
        { agentName: "cleo", policy: null, cwd: project, logCommand: (r) => records.push(r), logViolation: (r) => violations.push(r) },
      );
    }
    expect(records).toHaveLength(2);
    expect(violations).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain(FAKE);
    expect(JSON.stringify(violations)).not.toContain(FAKE);
  });
});
