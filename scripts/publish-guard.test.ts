import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GuardError, runGuard, secretValues } from "./publish-guard";

const roots: string[] = [];
// Owner and agent names are read from a local file, never from the source: the tests use invented names.
const namesDir = mkdtempSync(join(tmpdir(), "guard-names-"));
roots.push(namesDir);
writeFileSync(join(namesDir, "names.txt"), "# invented names for the tests\nzorblax\nquuxnaut\nfrobnicator\n");
process.env.PUBLISH_GUARD_NAMES_FILE = join(namesDir, "names.txt");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => { const r = spawnSync("git", args, { cwd, env, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };

function repo(files: Record<string, string>, email = "12345+someone@users.noreply.github.com"): string {
  const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  roots.push(dir);
  git(dir, "init", "-q", ".");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", `user.email=${email}`, "commit", "-q", "-m", "c");
  return dir;
}
const rules = (dir: string, opts: { publicMode?: boolean; history?: boolean; secretFiles?: string[] } = {}) =>
  runGuard({ repo: dir, publicMode: opts.publicMode ?? false, history: opts.history ?? false, secretFiles: opts.secretFiles ?? [] }).map((f) => f.rule);

afterAll(() => { /* temp directories are left to the OS */ });

describe("publish guard", () => {
  test("a clean repository passes", () => {
    expect(rules(repo({ "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" }), { publicMode: true, history: true })).toEqual([]);
  });

  test("a commit with a real email address is an error and the address is masked", () => {
    const dir = repo({ "a.txt": "x\n" }, "someone@example.org");
    const found = runGuard({ repo: dir, publicMode: false, history: false, secretFiles: [] });
    expect(found.map((f) => f.rule)).toContain("email");
    expect(JSON.stringify(found)).not.toContain("someone@example.org");
  });

  test("the GitHub noreply forms are accepted", () => {
    for (const email of ["noreply@github.com", "rfcclub@users.noreply.github.com", "99+rfcclub@users.noreply.github.com"]) expect(rules(repo({ "a.txt": "x\n" }, email))).not.toContain("email");
  });

  test("tracked evidence, handoff and credential files are errors", () => {
    const dir = repo({ "openspec/changes/x/.orca-verify.json": "{}", "docs/AGENT_HANDOFF_1.md": "x", "x/.harness/red/a.txt": "x", ".env": "A=b", "node_modules/p/index.js": "x" });
    const found = runGuard({ repo: dir, publicMode: false, history: false, secretFiles: [] }).filter((f) => f.rule === "internal-file").map((f) => f.where);
    expect(found.sort()).toEqual([".env", "docs/AGENT_HANDOFF_1.md", "node_modules/p/index.js", "openspec/changes/x/.orca-verify.json", "x/.harness/red/a.txt"]);
  });

  test("a real user home path is an error but placeholders are not", () => {
    expect(rules(repo({ "a.md": "see /Us" + "ers/jane/work/x\n" }))).toContain("home-path");
    expect(rules(repo({ "a.md": "see /Us" + "ers/user/work/x and /ho" + "me/runner/work and /Us" + "ers/you/x\n" }))).not.toContain("home-path");
  });

  test("secret shapes are errors and the value is never reported", () => {
    const token = "ghp_" + "a1b2c3d4e5".repeat(4);
    const found = runGuard({ repo: repo({ "a.txt": `token = ${token}\n` }), publicMode: false, history: false, secretFiles: [] });
    expect(found.map((f) => f.rule)).toContain("secret-shape");
    expect(JSON.stringify(found)).not.toContain(token);
  });

  test("a value from a local secrets file is found even when it has no known shape", () => {
    const dir = repo({ "notes.txt": "key=Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1\n" });
    const secrets = join(mkdtempSync(join(tmpdir(), "guard-secrets-")), "s.json");
    writeFileSync(secrets, JSON.stringify({ provider: { apiKey: "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1" } }));
    const found = runGuard({ repo: dir, publicMode: false, history: false, secretFiles: [secrets] });
    expect(found.map((f) => f.rule)).toContain("secret-value");
    expect(JSON.stringify(found)).not.toContain("Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1");
  });

  test("history mode finds what an older commit held and a later commit removed", () => {
    const dir = repo({ "a.md": "see /Us" + "ers/jane/x\n" });
    writeFileSync(join(dir, "a.md"), "clean\n");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "commit", "-q", "-m", "clean");
    expect(rules(dir)).not.toContain("home-path");
    expect(rules(dir, { history: true })).toContain("home-path");
  });

  test("public mode rejects non-English text and warns on colony information", () => {
    const dir = repo({ "a.md": "Em ch\u01b0a r\u00f5 \u00fd anh\n", "b.md": "reviewed by Zorblax\n" });
    const found = runGuard({ repo: dir, publicMode: true, history: false, secretFiles: [] });
    expect(found.find((f) => f.rule === "non-english")?.level).toBe("error");
    expect(found.find((f) => f.rule === "colony-info")?.level).toBe("warn");
    expect(rules(dir, { publicMode: false })).toEqual([]);
  });

  test(".publish-guard-allow silences one rule for one path", () => {
    const dir = repo({ "tests/t.ts": "const f = '\u0111\u0103ng-nh\u1eadp.js'\n", ".publish-guard-allow": "non-english tests/t.ts # unicode file name test\n" });
    expect(rules(dir, { publicMode: true })).not.toContain("non-english");
  });
});

describe("secretValues", () => {
  test("keeps key-shaped values and drops ordinary words, urls and short strings", () => {
    const f = join(mkdtempSync(join(tmpdir(), "guard-sv-")), "x.json");
    writeFileSync(f, JSON.stringify({ a: "Zz9Yy8Xx7Ww6Vv5Uu4Tt3", b: "https://example.org/some/long/path/x1", c: "short1", d: "just a sentence with spaces 12345678" }));
    expect(secretValues([f])).toEqual(["Zz9Yy8Xx7Ww6Vv5Uu4Tt3"]);
  });
});

describe("publish guard: review of #400", () => {
  test("a path that is not a repository, or a repository without commits, is a GuardError and never a pass", () => {
    expect(() => runGuard({ repo: join(tmpdir(), "does-not-exist-guard"), publicMode: true, history: true, secretFiles: [] })).toThrow(GuardError);
    const empty = mkdtempSync(join(tmpdir(), "guard-empty-"));
    git(empty, "init", "-q", ".");
    expect(() => runGuard({ repo: empty, publicMode: false, history: false, secretFiles: [] })).toThrow(GuardError);
    const plain = mkdtempSync(join(tmpdir(), "guard-plain-"));
    expect(() => runGuard({ repo: plain, publicMode: false, history: false, secretFiles: [] })).toThrow(GuardError);
  });

  test("commit messages are scanned: a real home path, a token shape and a non-noreply address in a trailer", () => {
    const dir = repo({ "a.txt": "x\n" });
    writeFileSync(join(dir, "a.txt"), "y\n");
    git(dir, "add", "-A");
    const token = "ghp_" + "q1w2e3r4t5".repeat(4);
    git(dir, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "commit", "-q", "-m", `see /Us${"e"}rs/jane/work ${token}\n\nCo-authored-by: Someone <someone@example.org>`);
    const found = runGuard({ repo: dir, publicMode: false, history: false, secretFiles: [] });
    expect(found.filter((f) => f.where.startsWith("commit")).map((f) => f.rule).sort()).toEqual(["email", "home-path", "secret-shape"]);
    expect(JSON.stringify(found)).not.toContain(token);
    expect(JSON.stringify(found)).not.toContain("someone@example.org");
  });

  test("the Claude trailer address is allowed", () => {
    const dir = repo({ "a.txt": "x\n" });
    writeFileSync(join(dir, "a.txt"), "y\n");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "commit", "-q", "-m", "c\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    expect(rules(dir)).not.toContain("email");
  });

  test("an annotated tag with a real tagger address is an error", () => {
    const dir = repo({ "a.txt": "x\n" });
    git(dir, "-c", "user.name=t", "-c", "user.email=tagger@example.org", "tag", "-a", "v1", "-m", "release");
    expect(rules(dir, { history: true })).toContain("email");
  });

  test("sk-proj keys are found", () => {
    expect(rules(repo({ "a.txt": "k = sk-proj-" + "Ab1".repeat(14) + "\n" }))).toContain("secret-shape");
  });

  test("a real path after a placeholder on the same line is still an error", () => {
    expect(rules(repo({ "notes.md": "/Us" + "ers/user/example -> /Us" + "ers/jane/project\n" }))).toContain("home-path");
  });

  test("a secret shape in a file name is reported without the name", () => {
    const token = "ghp_" + "z9y8x7w6v5".repeat(4);
    const found = runGuard({ repo: repo({ [`${token}.txt`]: `${token}\n` }), publicMode: false, history: false, secretFiles: [] });
    expect(found.length).toBeGreaterThan(0);
    expect(JSON.stringify(found)).not.toContain(token);
  });

  test("a model identifier or timestamp in a credentials file is not a secret value, a token under a secret key is", () => {
    const f = join(mkdtempSync(join(tmpdir(), "guard-sv2-")), "x.json");
    writeFileSync(f, JSON.stringify({ model: "claude-sonnet-4-5-20250929", created: "2026-10-15T00:00:00Z", apiKey: "kq93hd8wl2mz0vb7xr41", nested: { token_value: "Aa1Bb2Cc3Dd4Ee5Ff6Gg7" } }));
    expect(secretValues([f]).sort()).toEqual(["Aa1Bb2Cc3Dd4Ee5Ff6Gg7", "kq93hd8wl2mz0vb7xr41"]);
  });

  test("the secrets list is never written to disk", () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("publish-guard-")).length;
    const secrets = join(mkdtempSync(join(tmpdir(), "guard-secrets2-")), "s.json");
    writeFileSync(secrets, JSON.stringify({ apiKey: "kq93hd8wl2mz0vb7xr41" }));
    runGuard({ repo: repo({ "a.txt": "x\n" }), publicMode: false, history: false, secretFiles: [secrets] });
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("publish-guard-")).length).toBe(before);
  });

  test("public mode rejects any non-ASCII letter (Cyrillic, Chinese, accents), not only Vietnamese, and allows symbols", () => {
    for (const text of ["\u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440", "\u4f60\u597d", "caf\u00e9"]) expect(rules(repo({ "a.md": text + "\n" }), { publicMode: true })).toContain("non-english");
    expect(rules(repo({ "a.md": "arrows → and dashes — and ✓\n" }), { publicMode: true })).not.toContain("non-english");
  });

  test("allowlist entries need a reason and no bare wildcard; * stays inside a directory", () => {
    const bad = repo({ "a.md": "\u041f\u0440\u0438\u0432\u0435\u0442\n", ".publish-guard-allow": "non-english * # everything\nnon-english a.md\nnon-english **/*.md # all\n" });
    const found = runGuard({ repo: bad, publicMode: true, history: false, secretFiles: [] });
    expect(found.filter((f) => f.rule === "allowlist")).toHaveLength(3);
    expect(found.map((f) => f.rule)).toContain("non-english");
    const nested = repo({ "docs/deep/a.md": "\u041f\u0440\u0438\u0432\u0435\u0442\n", ".publish-guard-allow": "non-english docs/*.md # one level only\n" });
    expect(rules(nested, { publicMode: true })).toContain("non-english");
  });
});

describe("publish guard: second review of #400", () => {
  test("a secret, email, credential or evidence rule cannot be allowlisted; the finding stays and the entry is an error", () => {
    const token = "ghp_" + "m1n2b3v4c5".repeat(4);
    const dir = repo({ "a.txt": `k = ${token}\n`, ".publish-guard-allow": "secret-shape a.txt # fixture\ninternal-file .env # no\n" });
    const found = runGuard({ repo: dir, publicMode: false, history: false, secretFiles: [] });
    expect(found.filter((f) => f.rule === "allowlist")).toHaveLength(2);
    expect(found.map((f) => f.rule)).toContain("secret-shape");
  });

  test("a malformed allowlist line that holds a secret is redacted in the diagnostic", () => {
    const token = "ghp_" + "p9o8i7u6y5".repeat(4);
    const dir = repo({ ".publish-guard-allow": `non-english ${token} no-reason\n` });
    const found = runGuard({ repo: dir, publicMode: false, history: false, secretFiles: [] });
    expect(found.some((f) => f.rule === "allowlist")).toBe(true);
    expect(JSON.stringify(found)).not.toContain(token);
  });

  test("email addresses in file contents are errors, masked; noreply and reserved example domains are fine", () => {
    const dir = repo({ "README.md": "contact jane.doe" + "@gmail.com or a@example.com or 12+x@users.noreply.github.com\n" });
    const found = runGuard({ repo: dir, publicMode: false, history: false, secretFiles: [] });
    expect(found.filter((f) => f.rule === "email")).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain("jane.doe" + "@gmail.com");
  });

  test("a clone URL is not an email address; placeholder domains are warnings; a real-looking address is an error in any file", () => {
    expect(rules(repo({ "HARNESS.md": "git clone git@github.com:org/repo.git\n" }))).not.toContain("email");
    const found = runGuard({ repo: repo({ "tests/a.test.ts": "const e = 'a@b.com';\n" }), publicMode: false, history: false, secretFiles: [] });
    expect(found.filter((f) => f.rule === "email").map((f) => f.level)).toEqual(["warn"]);
    for (const [path, text] of [["tests/x.test.ts", "jane.doe" + "@gmail.com"], ["fixtures/x.json", "jane.doe" + "@gmail.com"], ["a.md", "contact git" + "@acme-corp.io"], ["b.md", "git" + "@gmail.com is me"]] as const) {
      const hits = runGuard({ repo: repo({ [path]: text + "\n" }), publicMode: false, history: false, secretFiles: [] }).filter((f) => f.rule === "email");
      expect(hits.map((f) => f.level)).toEqual(["error"]);
    }
  });

  test("a clone URL with a path separator and a file name with a scale suffix are not addresses", () => {
    expect(rules(repo({ "package.json": '{"d":"git+ssh://git@github.com/org/repo.git#abc"}\n', "t.json": '{"i":"icons/128x128@2x.png","c":"/run/c/agent-1@m.cursor"}\n' }))).not.toContain("email");
  });

  test("a token in an allowlist line is not printed, not even a truncated part of it", () => {
    const token = "ghp_" + "Ab12Cd34Ef".repeat(4);
    const dir = repo({ "a.txt": "x\n", ".publish-guard-allow": "non-english " + token + " # r\n" });
    expect(JSON.stringify(runGuard({ repo: dir, publicMode: false, history: false, secretFiles: [] }))).not.toContain("ghp_Ab12");
  });

  test("a tag that points to a blob is an error", () => {
    const dir = repo({ "a.txt": "x\n" });
    const blob = git(dir, "hash-object", "-w", "a.txt").trim();
    git(dir, "tag", "blobtag", blob);
    expect(rules(dir)).toContain("tag-target");
  });

  test("a shallow clone is a GuardError, not a pass", () => {
    const src = repo({ "a.txt": "x\n" });
    writeFileSync(join(src, "b.txt"), "y\n");
    git(src, "add", "-A");
    git(src, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "commit", "-q", "-m", "two");
    const dir = mkdtempSync(join(tmpdir(), "guard-shallow-"));
    roots.push(dir);
    git(dir, "clone", "-q", "--depth", "1", "file://" + src, join(dir, "c"));
    expect(() => runGuard({ repo: join(dir, "c"), publicMode: false, history: true, secretFiles: [] })).toThrow(GuardError);
  });

  test("public mode checks every reachable commit, not only the tip", () => {
    const dir = repo({ "leak.txt": "see /Us" + "ers/jane/work\n" });
    git(dir, "rm", "-q", "leak.txt");
    git(dir, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "commit", "-q", "-m", "remove");
    expect(rules(dir, { publicMode: true })).toContain("home-path");
  });

  test("a package name with a version is not an email address", () => {
    expect(rules(repo({ "notes.md": "uses seal-gate@0.5.0-beta.0 and pilotfish@1.6.0\n" }))).not.toContain("email");
  });

  test("a sub-directory of another repository is a GuardError, not a scan of the parent", () => {
    const dir = repo({ "sub/a.txt": "x\n" });
    expect(() => runGuard({ repo: join(dir, "sub"), publicMode: false, history: false, secretFiles: [] })).toThrow(GuardError);
  });

  test("without --history a commit that only a tag points to is still scanned", () => {
    const dir = repo({ "a.txt": "x\n" });
    git(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "leak.txt"), "see /Us" + "ers/jane/work\n");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "commit", "-q", "-m", "side");
    git(dir, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "tag", "-a", "v9", "-m", "release");
    git(dir, "checkout", "-q", "-");
    git(dir, "branch", "-q", "-D", "side");
    expect(rules(dir)).toContain("home-path");
  });
});

describe("publish guard: third review of #400", () => {
  const emails = (dir: string) => runGuard({ repo: dir, publicMode: true, history: true, secretFiles: [] }).filter((f) => f.rule === "email");

  test("a real-looking address on a placeholder-style domain (mail, email, company) is an error, not a warning", () => {
    const dir = repo({ "a.md": "john.smith" + "@mail.com, ceo" + "@company.com, bob" + "@email.com\n" });
    expect(emails(dir).map((f) => f.level)).toEqual(["error", "error", "error"]);
  });

  test("git@host is only a clone URL when a path follows; plain prose with git@ is an address", () => {
    for (const text of ["write to git" + "@acme-corp.io: we reply", "write git" + "@acme-corp.io/ send"]) expect(emails(repo({ "a.md": text + "\n" })).map((f) => f.level)).toEqual(["error"]);
    expect(emails(repo({ "a.md": "git clone git@github.com:org/repo.git and ssh://git@github.com/org/repo.git and git+ssh://git@github.com:22/org/r\n" }))).toEqual([]);
  });

  test("a real top-level domain that looks like a file extension is an address; a scale-suffixed image name is not", () => {
    expect(emails(repo({ "a.md": "alice" + "@realcorp.md ops" + "@acme.json\n" })).map((f) => f.level)).toEqual(["error", "error"]);
    expect(emails(repo({ "a.md": "images/logo@2x.png and /run/agent-1@m.cursor\n" }))).toEqual([]);
  });

  test("a control byte in a commit message cannot hide what follows it", () => {
    const token = "ghp_" + "k1l2m3n4o5".repeat(4);
    for (const sep of ["\x01", "\x02"]) {
      const dir = repo({ "a.txt": "x\n" });
      writeFileSync(join(dir, "a.txt"), "y\n");
      git(dir, "add", "-A");
      git(dir, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "commit", "-q", "-m", `ok${sep} leak /Us${"e"}rs/jane/x ${token} alice` + "@acme-corp.io");
      const found = runGuard({ repo: dir, publicMode: true, history: true, secretFiles: [] });
      expect(found.filter((f) => f.where.startsWith("commit")).map((f) => f.rule).sort()).toEqual(["email", "home-path", "secret-shape"]);
      expect(JSON.stringify(found)).not.toContain(token);
    }
  });

  test("a token or a local secret value inside a binary file is found, and nothing is printed", () => {
    const token = "ghp_" + "d4e5f6g7h8".repeat(4);
    const dir = repo({ "a.txt": "x\n" });
    writeFileSync(join(dir, "app.sqlite"), Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.from("token=" + token + "\0Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1\0")]));
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "commit", "-q", "-m", "binary");
    const secrets = join(mkdtempSync(join(tmpdir(), "guard-secrets3-")), "s.json");
    writeFileSync(secrets, JSON.stringify({ provider: { apiKey: "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1" } }));
    const found = runGuard({ repo: dir, publicMode: false, history: false, secretFiles: [secrets] });
    expect(found.map((f) => f.rule)).toContain("secret-shape");
    expect(found.map((f) => f.rule)).toContain("secret-value");
    expect(found.every((f) => f.where.includes("app.sqlite") || !f.rule.startsWith("secret"))).toBe(true);
    expect(JSON.stringify(found)).not.toContain(token);
    expect(JSON.stringify(found)).not.toContain("Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1");
  });

  test("public mode reports non-English files by name only, so a large repository cannot overflow the output buffer", () => {
    const dir = repo({ "a.md": "caf\u00e9\n", "b.md": "plain\n" });
    const found = runGuard({ repo: dir, publicMode: true, history: false, secretFiles: [] });
    expect(found.filter((f) => f.rule === "non-english").map((f) => f.where)).toEqual(["a.md"]);
  });

  test("public mode flags agent names that need a word boundary (regression: POSIX ERE ignores \\b on macOS)", () => {
    const names = ["Zorblax", "Quuxnaut", "Frobnicator", "ZORBLAX_TWO", "quuxnaut-runtime"];
    const dir = repo(Object.fromEntries(names.map((n, i) => ["n" + i + ".md", "owned by " + n + " today\n"])));
    const found = runGuard({ repo: dir, publicMode: true, history: false, secretFiles: [] });
    expect(found.filter((f) => f.rule === "colony-info").map((f) => f.where).sort()).toEqual(names.map((_, i) => "n" + i + ".md"));
    const plain = repo({ "ok.md": "the variable and a notzorblaxed study\n" });
    const clean = runGuard({ repo: plain, publicMode: true, history: false, secretFiles: [] });
    expect(clean.filter((f) => f.rule === "colony-info")).toEqual([]);
  });

  test("binary files are scanned for emails and home paths, and listed so each one is a decision (review of 67ccb051)", () => {
    const dir = repo({ "a.txt": "x\n" });
    const addr = "jane.doe" + "@gmail.com";
    const home = "/Us" + "ers/jane/secret";
    writeFileSync(join(dir, "app.bin"), Buffer.concat([Buffer.from("BIN\0"), Buffer.from("mail " + addr + " path " + home + "\0\x01\x02")]));
    writeFileSync(join(dir, "clean.bin"), Buffer.from("BIN\0\x01\x02\x03"));
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=noreply@github.com", "commit", "-q", "-m", "binary");
    const found = runGuard({ repo: dir, publicMode: true, history: true, secretFiles: [] });
    const at = (rule: string) => found.filter((f) => f.rule === rule).map((f) => f.where).sort();
    expect(at("email")).toEqual(["app.bin"]);
    expect(at("home-path")).toEqual(["app.bin"]);
    expect(at("binary-file")).toEqual(["app.bin", "clean.bin"]);
    expect(JSON.stringify(found)).not.toContain("jane.doe");
  });
});
