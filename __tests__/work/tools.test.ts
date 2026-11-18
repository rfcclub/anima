/**
 * castle-work-loop: the model's tools, each run as a supervised child under the write
 * boundary. Real `sandbox-exec` children; skipped with a printed reason where the binary is absent.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkTools, type WorkTools } from "../../src/work/tools";
import { SANDBOX_BINARY } from "../../src/work/sandbox";

const available = existsSync(SANDBOX_BINARY);
if (!available) console.warn(`work tool tests skipped: ${SANDBOX_BINARY} is not present on this platform`);
const sbx = available ? describe : describe.skip;

let base: string;
let root: string;
let tree: string;
let outside: string;
let tools: WorkTools;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "work-tools-")));
  root = join(base, "root");
  tree = join(root, "tree");
  outside = join(base, "outside");
  for (const d of [tree, join(root, "tmp"), join(root, "home"), outside]) mkdirSync(d, { recursive: true });
  tools = createWorkTools({
    root, tree, tmp: join(root, "tmp"), home: join(root, "home"), denyReadRoots: [], perCallMs: 5_000, parentEnv: { PATH: process.env.PATH, GH_TOKEN: "ghp_PARENT_SECRET", ANIMA_X: "y" },
  });
});
afterEach(async () => { await tools.stopAll(); });

const run = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
  tools.execute({ id: "t", name, arguments: JSON.stringify(args) }, signal);

describe("definitions", () => {
  test("the model is offered bash, read, write and edit with required parameters", () => {
    expect(tools.definitions.map((d) => d.name)).toEqual(["bash", "read", "write", "edit"]);
    const req = Object.fromEntries(tools.definitions.map((d) => [d.name, (d.parameters as { required: string[] }).required]));
    expect(req).toEqual({ bash: ["command"], read: ["path"], write: ["path", "content"], edit: ["path", "old_string", "new_string"] });
  });
});

sbx("bash", () => {
  test("runs in the tree, returns combined output and the exit code", async () => {
    const out = await run("bash", { command: "pwd; echo to-stderr 1>&2; exit 3" });
    expect(out).toContain(tree);
    expect(out).toContain("to-stderr");
    expect(out).toContain("[exit code 3]");
  });

  test("cannot write outside the work root, and says so", async () => {
    const out = await run("bash", { command: `echo x > ${outside}/leak.txt` });
    expect(out).toMatch(/not permitted|denied/i);
    expect(existsSync(join(outside, "leak.txt"))).toBe(false);
  });

  test("does not see the parent's tokens or ANIMA variables", async () => {
    const out = await run("bash", { command: "env" });
    expect(out).not.toContain("ghp_PARENT_SECRET");
    expect(out).not.toContain("ANIMA_X");
    expect(out).toContain(`HOME=${join(root, "home")}`);
  });

  test("output is capped", async () => {
    const out = await run("bash", { command: "yes x | head -c 300000" });
    expect(out.length).toBeLessThan(80_000);
    expect(out).toContain("truncated");
  });

  test("a command that outlives the per-call limit is killed with its children and reported as timed out", async () => {
    // a short limit, so the test fits Bun's default 5 s test timeout
    const short = createWorkTools({ root, tree, tmp: join(root, "tmp"), home: join(root, "home"), denyReadRoots: [], perCallMs: 800, parentEnv: { PATH: process.env.PATH } });
    const t0 = Date.now();
    const out = await short.execute({ id: "t", name: "bash", arguments: JSON.stringify({ command: "(sleep 30 &) ; sleep 30" }) });
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(out).toContain("timed out");
    const stop = await short.stopAll();
    expect(stop.proven).toBe(true);
  });

  test("an abort signal stops a running command", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const t0 = Date.now();
    const out = await run("bash", { command: "sleep 30" }, controller.signal);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(out).toMatch(/aborted|stopped/i);
  });
});

sbx("write and read", () => {
  test("write creates a file, with parent directories, inside the tree", async () => {
    const out = await run("write", { path: "src/new/file.txt", content: "hello\nworld\n" });
    expect(out).toContain("wrote 12 bytes");
    expect(readFileSync(join(tree, "src/new/file.txt"), "utf-8")).toBe("hello\nworld\n");
  });

  test("write outside the tree fails, however the path is spelled", async () => {
    for (const path of [`${outside}/abs.txt`, "../../outside/rel.txt", `${tree}/../../outside/mix.txt`]) {
      const out = await run("write", { path, content: "x" });
      expect(out).toMatch(/error|not permitted|denied/i);
    }
    expect(existsSync(join(outside, "abs.txt"))).toBe(false);
    expect(existsSync(join(outside, "rel.txt"))).toBe(false);
    expect(existsSync(join(outside, "mix.txt"))).toBe(false);
  });

  test("write does not treat content as shell", async () => {
    await run("write", { path: "x.txt", content: "$(touch pwned); `touch pwned2`\n" });
    expect(existsSync(join(tree, "pwned"))).toBe(false);
    expect(readFileSync(join(tree, "x.txt"), "utf-8")).toContain("$(touch pwned)");
  });

  test("read returns the file, a line window, and an error for a missing file", async () => {
    writeFileSync(join(tree, "a.txt"), "1\n2\n3\n4\n5\n");
    expect(await run("read", { path: "a.txt" })).toBe("1\n2\n3\n4\n5\n");
    expect(await run("read", { path: "a.txt", offset: 2, limit: 2 })).toBe("2\n3\n");
    expect(await run("read", { path: "nope.txt" })).toMatch(/error|no such file/i);
  });

  test("a path with spaces, quotes and a leading dash is a file name, not an option or code", async () => {
    await run("write", { path: "-odd name's.txt", content: "ok" });
    expect(readFileSync(join(tree, "-odd name's.txt"), "utf-8")).toBe("ok");
    expect(await run("read", { path: "-odd name's.txt" })).toBe("ok");
  });

  test("a denied read root cannot be read through the read tool", async () => {
    const secrets = join(base, "secrets");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "key"), "SECRET\n");
    const guarded = createWorkTools({ root, tree, tmp: join(root, "tmp"), home: join(root, "home"), denyReadRoots: [secrets], perCallMs: 5_000, parentEnv: { PATH: process.env.PATH } });
    const out = await guarded.execute({ id: "t", name: "read", arguments: JSON.stringify({ path: join(secrets, "key") }) });
    expect(out).not.toContain("SECRET");
    await guarded.stopAll();
  });
});

sbx("edit", () => {
  test("replaces the first occurrence", async () => {
    writeFileSync(join(tree, "e.txt"), "one two one\n");
    const out = await run("edit", { path: "e.txt", old_string: "one", new_string: "1" });
    expect(out).toContain("replaced");
    expect(readFileSync(join(tree, "e.txt"), "utf-8")).toBe("1 two one\n");
  });

  test("reports when the text is not there and leaves the file alone", async () => {
    writeFileSync(join(tree, "e.txt"), "abc\n");
    const out = await run("edit", { path: "e.txt", old_string: "zzz", new_string: "y" });
    expect(out).toMatch(/not found/i);
    expect(readFileSync(join(tree, "e.txt"), "utf-8")).toBe("abc\n");
  });

  test("cannot edit a file outside the tree", async () => {
    writeFileSync(join(outside, "o.txt"), "keep\n");
    const out = await run("edit", { path: `${outside}/o.txt`, old_string: "keep", new_string: "gone" });
    expect(out).toMatch(/error|not permitted|denied/i);
    expect(readFileSync(join(outside, "o.txt"), "utf-8")).toBe("keep\n");
  });
});

describe("bad calls never throw", () => {
  test("an unknown tool and unreadable arguments come back as error text", async () => {
    expect(await run("rm_everything", {})).toMatch(/unknown tool/i);
    expect(await tools.execute({ id: "t", name: "bash", arguments: "{not json" })).toMatch(/invalid arguments/i);
    expect(await run("bash", {})).toMatch(/command/i);
    expect(await run("write", { path: "a" })).toMatch(/content/i);
  });
});
