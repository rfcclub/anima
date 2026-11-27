/**
 * A work session's bash runs in its own sandbox with HOME inside the work root, outside executeTool.
 * The broad-scan rule and the per-command log apply there too, with ~ meaning the session's own home.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBroadScan } from "../../src/tools/policy-enforcer";
import type { PolicyViolationRecord, ToolCommandRecord } from "../../src/tools/executor";
import { SANDBOX_BINARY } from "../../src/work/sandbox";
import { createWorkTools, type WorkTools } from "../../src/work/tools";

const available = existsSync(SANDBOX_BINARY);
const sbx = available ? describe : describe.skip;

let base: string;
let realHome: string;
let root: string;
let tree: string;
let workHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "work-broad-scan-")));
  realHome = join(base, "users", "owner");
  root = join(base, "roots", "w1");
  tree = join(root, "tree");
  workHome = join(root, "home");
  for (const d of [join(realHome, "Library", "Containers"), tree, workHome, join(root, "tmp")]) mkdirSync(d, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = realHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(base, { recursive: true, force: true });
});

const bash = (command: string, shellHome?: string) =>
  checkBroadScan({ tool: "bash", args: { command }, cwd: tree, ...(shellHome ? { shellHome } : {}) });

describe("checkBroadScan with the session's own home", () => {
  test("~ and $HOME mean the session home, so scanning them is allowed", () => {
    expect(bash("find ~ -name x", workHome).allowed).toBe(true);
    expect(bash("find $HOME -name x", workHome).allowed).toBe(true);
    expect(bash("rg token ~/", workHome).allowed).toBe(true);
  });

  test("a bare cd goes to the session home, not the owner's", () => {
    expect(bash("cd && find . -name x", workHome).allowed).toBe(true);
    expect(bash("cd; du -sh .", workHome).allowed).toBe(true);
  });

  test("absolute broad roots are still refused", () => {
    expect(bash("find / -name x", workHome).allowed).toBe(false);
    expect(bash(`find ${realHome} -name x`, workHome).allowed).toBe(false);
    expect(bash(`find ${join(realHome, "Library")} -name x`, workHome).allowed).toBe(false);
    expect(bash(`cd ${realHome} && grep -r token .`, workHome).allowed).toBe(false);
  });

  test("without shellHome, ~ is still the owner's home", () => {
    expect(bash("find ~ -name x").allowed).toBe(false);
    expect(bash("cd && find . -name x").allowed).toBe(false);
  });
});

sbx("work bash tool", () => {
  let tools: WorkTools;
  let commands: ToolCommandRecord[];
  let violations: PolicyViolationRecord[];

  beforeEach(() => {
    commands = [];
    violations = [];
    tools = createWorkTools({
      root, tree, tmp: join(root, "tmp"), home: workHome, denyReadRoots: [], perCallMs: 5_000,
      parentEnv: { PATH: process.env.PATH }, agent: "cleo",
      logCommand: (r) => commands.push(r), logViolation: (r) => violations.push(r),
    });
  });
  afterEach(async () => { await tools.stopAll(); });

  const run = (command: string) => tools.execute({ id: "t", name: "bash", arguments: JSON.stringify({ command }) });

  test("a broad scan is refused before anything runs, and the refusal is logged", async () => {
    const out = await run("find / -name x");
    expect(out).toStartWith("Error: policy violation (broad-scan):");
    expect(violations).toEqual([expect.objectContaining({ event: "policy_violation", agent: "cleo", tool: "bash", rule: "broad-scan", target: "/", mode: "block" })]);
  });

  test("every bash call is logged with the agent, the tree and the masked command", async () => {
    const out = await run("API_TOKEN=s3cretvalue123 echo ok");
    expect(out).toContain("ok");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ event: "tool_command", agent: "cleo", tool: "bash", cwd: tree });
    expect(commands[0]!.command).not.toContain("s3cretvalue123");
    expect(commands[0]!.command).toContain("echo ok");
  });

  test("a refused command is logged too", async () => {
    await run("du -sh /");
    expect(commands.map((c) => c.command)).toEqual(["du -sh /"]);
  });

  test("scanning the session home runs", async () => {
    const out = await run("find ~ -maxdepth 1 -name nothing-here; echo done");
    expect(out).not.toContain("policy violation");
    expect(out).toContain("done");
  });
});
