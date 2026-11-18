import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "../../src/work/publish-snapshot";
import { checkChange, isGeneratedPath, partitionGenerated } from "../../src/work/publish-checks";

// Fake credential, assembled from parts so no credential-shaped literal sits in this file.
const githubToken = "ghp_" + "a".repeat(36);

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, added: 1, deleted: 0, binary: false, ...overrides };
}

function reader(contents: Record<string, string> = {}) {
  return (path: string): string | undefined => contents[path] ?? "export const clean = 1;\n";
}

/** A tree where nothing can be read: the fail-closed case. */
const unreadable = (_path: string): string | undefined => undefined;

describe("isGeneratedPath", () => {
  test("G-1 treats .orca-verify.json at any depth as generated", () => {
    expect(isGeneratedPath(".orca-verify.json")).toBe(true);
    expect(isGeneratedPath("openspec/changes/some-change/.orca-verify.json")).toBe(true);
    expect(isGeneratedPath("a/b/c/.orca-verify.json")).toBe(true);
  });

  test("G-2 keeps other evidence the worker may change", () => {
    expect(isGeneratedPath(".orca-red.json")).toBe(false);
    expect(isGeneratedPath(".harness/gate-verdicts/x.json")).toBe(false);
    expect(isGeneratedPath("openspec/changes/x/.orca-verify.json.bak")).toBe(false);
    expect(isGeneratedPath("scripts/dr/live-probes.ts")).toBe(false);
    expect(isGeneratedPath("")).toBe(false);
  });
});

describe("partitionGenerated", () => {
  test("G-1 splits a large-changeset shape into 2 kept and 183 generated, preserving order", () => {
    const generatedPaths = Array.from({ length: 183 }, (_, index) => `openspec/changes/c${index}/.orca-verify.json`);
    const files = [file("scripts/dr/live-probes.ts"), ...generatedPaths.map((path) => file(path))];
    files.push(file("__tests__/dr/live-probes.test.ts"));

    const { kept, generated } = partitionGenerated(files);

    expect(kept.map((item) => item.path)).toEqual(["scripts/dr/live-probes.ts", "__tests__/dr/live-probes.test.ts"]);
    expect(generated).toHaveLength(183);
    expect(generated.map((item) => item.path)).toEqual(generatedPaths);
  });

  test("G-2 keeps .orca-red.json and .harness evidence", () => {
    const files = [file(".orca-red.json"), file(".harness/gate-verdicts/x.json")];
    expect(partitionGenerated(files)).toEqual({ kept: files, generated: [] });
  });

  test("does not mutate its input", () => {
    const files = [file("b/.orca-verify.json"), file("a.ts"), file("c/.orca-verify.json")];
    const before = files.map((item) => ({ ...item }));
    partitionGenerated(files);
    expect(files.map((item) => ({ ...item }))).toEqual(before);
    expect(files.map((item) => item.path)).toEqual([
      "b/.orca-verify.json",
      "a.ts",
      "c/.orca-verify.json",
    ]);
  });
});

describe("checkChange", () => {
  test("SC-007 fails an empty change as no-change", () => {
    const outcome = checkChange([], reader());
    expect(outcome).toEqual({ ok: false, check: "no-change", detail: expect.any(String) });
  });

  test("SC-008 fails a symlink to a file outside the tree as outside-repo", () => {
    for (const target of ["../../etc/passwd", "/etc/passwd", "a/../../x"]) {
      const outcome = checkChange([file("link.ts", { symlinkTarget: target })], reader());
      expect(outcome).toEqual({ ok: false, check: "outside-repo", detail: expect.stringContaining("link.ts") });
    }
    expect(checkChange([file("link.ts", { symlinkTarget: "a/b.ts" })], reader())).toEqual({ ok: true });
  });

  test("SC-008 resolves a relative symlink target from the link's parent directory", () => {
    // A link two directories down pointing at a repository-root file stays inside the tree.
    expect(checkChange([file("a/b/link.ts", { symlinkTarget: "../../root.ts" })], reader())).toEqual({ ok: true });
    // One more `..` climbs above the root and is rejected.
    expect(checkChange([file("a/b/link.ts", { symlinkTarget: "../../../etc/passwd" })], reader())).toEqual({
      ok: false, check: "outside-repo", detail: expect.stringContaining("a/b/link.ts"),
    });
    // An absolute target is rejected whatever the link's depth.
    expect(checkChange([file("a/b/link.ts", { symlinkTarget: "/etc/passwd" })], reader())).toEqual({
      ok: false, check: "outside-repo", detail: expect.any(String),
    });
  });

  test("SC-008 rejects Windows absolute and traversal paths and symlink targets", () => {
    for (const path of [
      "C:\\outside\\x.ts",
      "C:/outside/x.ts",
      "C:x.ts",
      "\\server\\share\\x.ts",
      "\\?\\C:\\outside\\x.ts",
      "src\\..\\..\\x.ts",
    ]) {
      expect(checkChange([file(path)], reader())).toEqual({
        ok: false, check: "outside-repo", detail: expect.any(String),
      });
    }
    for (const target of [
      "C:\\outside",
      "C:/outside",
      "\\\\server\\share\\x.ts",
      "..\\..\\outside.ts",
    ]) {
      expect(checkChange([file("link.ts", { symlinkTarget: target })], reader())).toEqual({
        ok: false, check: "outside-repo", detail: expect.any(String),
      });
    }
    // Windows separators resolve like POSIX ones: `a\..\b.ts` is `b.ts`, inside the tree, so it passes.
    // Fail-closed side effect, accepted: a POSIX file name that contains a backslash or starts with `x:` is split or
    // refused (a bare drive-relative path such as `C:x` is rejected above).
    expect(checkChange([file("a\\..\\b.ts")], reader())).toEqual({ ok: true });
  });

  test("SC-009 applies the deny list to the normalised path", () => {
    for (const path of [
      "safe/../.github/workflows/ci.yml",
      "a/b/../../.github/workflows/release.yaml",
      "src/../.env",
      "src/app/../../node_modules/pkg/index.js",
    ]) {
      expect(checkChange([file(path)], reader())).toEqual({
        ok: false, check: "denied-path", detail: expect.any(String),
      });
    }
  });

  test("fails a path that normalises outside the tree as outside-repo", () => {
    expect(checkChange([file("a/../../x")], reader())).toEqual({
      ok: false, check: "outside-repo", detail: expect.any(String),
    });
    expect(checkChange([file("/etc/passwd")], reader())).toEqual({
      ok: false, check: "outside-repo", detail: expect.any(String),
    });
    expect(checkChange([file("a\0b")], reader())).toEqual({
      ok: false, check: "outside-repo", detail: expect.any(String),
    });
    expect(checkChange([file("a/../b.ts")], reader())).toEqual({ ok: true });
  });

  test("SC-009 fails a workflow file as denied-path", () => {
    expect(checkChange([file(".github/workflows/ci.yml")], reader())).toEqual({
      ok: false, check: "denied-path", detail: expect.any(String),
    });
  });

  test.each([
    [".github/workflows/ci.yml"],
    [".github/workflows/release/nightly.yaml"],
    [".env"],
    [".env.local"],
    ["config/.env.production"],
    ["certs/server.pem"],
    ["keys/signing.key"],
    ["secrets/token.txt"],
    [".git/config"],
    [".git"],
    ["node_modules/left-pad/index.js"],
    ["packages/app/node_modules/x/index.js"],
  ])("fails %s as denied-path", (path) => {
    expect(checkChange([file(path)], reader())).toEqual({ ok: false, check: "denied-path", detail: expect.any(String) });
  });

  test.each([["environment.md"], ["src/keymap.ts"], ["secrets.ts"], [".github/ISSUE_TEMPLATE/bug.md"]])(
    "accepts the lookalike path %s",
    (path) => {
      expect(checkChange([file(path)], reader())).toEqual({ ok: true });
    },
  );

  test("SC-010 fails 801 lines, 51 files and a binary file as too-large", () => {
    expect(checkChange([file("a.ts", { added: 800, deleted: 1 })], reader())).toEqual({
      ok: false, check: "too-large", detail: expect.any(String),
    });
    const fiftyOne = Array.from({ length: 51 }, (_, index) => file(`f${index}.ts`));
    expect(checkChange(fiftyOne, reader())).toEqual({ ok: false, check: "too-large", detail: expect.any(String) });
    expect(checkChange([file("image.png", { binary: true })], reader())).toEqual({
      ok: false, check: "too-large", detail: expect.any(String),
    });
  });

  test("SC-010 passes exactly 800 lines and exactly 50 files", () => {
    expect(checkChange([file("a.ts", { added: 700, deleted: 100 })], reader())).toEqual({ ok: true });
    const fifty = Array.from({ length: 50 }, (_, index) => file(`f${index}.ts`));
    expect(checkChange(fifty, reader())).toEqual({ ok: true });
  });

  test("takes the limits it is given", () => {
    expect(checkChange([file("a.ts", { added: 5 })], reader(), { maxLines: 4 })).toEqual({
      ok: false, check: "too-large", detail: expect.any(String),
    });
    expect(checkChange([file("a.ts"), file("b.ts")], reader(), { maxFiles: 1 })).toEqual({
      ok: false, check: "too-large", detail: expect.any(String),
    });
  });

  test("SC-011 fails a new file holding a GitHub token as secret-found without returning it", () => {
    const outcome = checkChange(
      [file("src/new.ts")],
      reader({ "src/new.ts": `export const x = "${githubToken}";\n` }),
    );
    expect(outcome).toMatchObject({ ok: false, check: "secret-found" });
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(githubToken);
    expect(text).not.toContain(githubToken.slice(0, 8));
    expect(outcome.ok ? "" : outcome.detail).toContain("src/new.ts");
  });

  test("SC-011 scans every readable file and passes clean ones", () => {
    const outcome = checkChange(
      [file("a.ts"), file("b.ts")],
      reader({ "a.ts": "export const a = 1;\n", "b.ts": `// ${githubToken}\n` }),
    );
    expect(outcome).toEqual({ ok: false, check: "secret-found", detail: expect.stringContaining("b.ts") });
  });

  test("does not read a deleted file for secrets", () => {
    const read: string[] = [];
    const outcome = checkChange(
      [file("old.ts", { isDeleted: true, added: 0, deleted: 3 }), file("new.ts")],
      (path) => {
        read.push(path);
        return "export const a = 1;\n";
      },
    );
    expect(outcome).toEqual({ ok: true });
    expect(read).toEqual(["new.ts"]);
  });

  test("fails closed as secret-found when a file cannot be read", () => {
    const outcome = checkChange([file("gone.ts")], unreadable);
    expect(outcome).toEqual({ ok: false, check: "secret-found", detail: expect.stringContaining("gone.ts") });
    expect(checkChange([file("gone.ts", { isDeleted: true, added: 0, deleted: 1 })], unreadable)).toEqual({ ok: true });
  });

  test("runs path checks before the size check", () => {
    const files = [file("node_modules/x/index.js", { added: 900 }), file(".github/workflows/ci.yml")];
    for (const large of [false, true]) {
      const change = large ? files : files.map((item) => file(item.path, { added: 0 }));
      expect(checkChange(change, reader())).toEqual({
        ok: false, check: "denied-path", detail: expect.any(String),
      });
    }
  });

  test("reports outside-repo before denied-path in list order", () => {
    const outcome = checkChange([file(".git/config"), file("../escape.ts")], reader());
    expect(outcome).toMatchObject({ ok: false, check: "denied-path" });
    const reversed = checkChange([file("../escape.ts"), file(".git/config")], reader());
    expect(reversed).toMatchObject({ ok: false, check: "outside-repo" });
  });

  test("G-1 passes the kept list of the large-changeset shape", () => {
    const kept = [file("scripts/dr/live-probes.ts", { added: 60 }), file("__tests__/dr/live-probes.test.ts", { added: 80 })];
    const outcome = checkChange(
      kept,
      reader({
        "scripts/dr/live-probes.ts": "export const probes = [];\n",
        "__tests__/dr/live-probes.test.ts": "import { test } from \"bun:test\";\n",
      }),
    );
    expect(outcome).toEqual({ ok: true });
  });
});

describe("follow-ups on publish-checks", () => {
  test("G-1 treats a Windows-separator path to .orca-verify.json as generated", () => {
    expect(isGeneratedPath("openspec\\changes\\x\\.orca-verify.json")).toBe(true);
    const { kept, generated } = partitionGenerated([file("src\\a.ts"), file("openspec\\changes\\x\\.orca-verify.json")]);
    expect(kept.map((item) => item.path)).toEqual(["src\\a.ts"]);
    expect(generated).toHaveLength(1);
  });

  test("a path that is empty or only dots and slashes is not a file inside the tree (fail closed)", () => {
    for (const path of ["", ".", "./", "a/..", "./."]) {
      expect(checkChange([file(path)], reader())).toMatchObject({ ok: false, check: "outside-repo" });
    }
  });

  test("a symlink target goes through the deny list as well as the confinement check", () => {
    const targets: Array<[string, string]> = [
      ["link.ts", ".github/workflows/ci.yml"],
      ["link.ts", ".env"],
      ["a/link", "../node_modules/x/y.js"],
      ["a/link", "../secrets/key.txt"],
    ];
    for (const [path, symlinkTarget] of targets) {
      expect(checkChange([file(path, { symlinkTarget })], reader())).toMatchObject({ ok: false, check: "denied-path" });
    }
    expect(checkChange([file("link.ts", { symlinkTarget: "src/a.ts" })], reader())).toEqual({ ok: true });
    expect(checkChange([file("src/a/link", { symlinkTarget: "../b/file.ts" })], reader())).toEqual({ ok: true });
  });

  test("SC-009 denies .envrc as well as .env and .env.*", () => {
    for (const path of [".envrc", "sub/.envrc", ".env", ".env.local"]) {
      expect(checkChange([file(path)], reader())).toMatchObject({ ok: false, check: "denied-path" });
    }
    expect(checkChange([file("src/environment.ts")], reader())).toEqual({ ok: true });
  });
});
