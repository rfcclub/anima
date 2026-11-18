import { describe, expect, test } from "bun:test";
import {
  GENERATED_EXCLUDES, isolatedGit, parseNameStatusZ, parseNumstatZ, snapshotChange,
  type IsolatedGit,
} from "../../src/work/publish-snapshot";

const iso = isolatedGit({
  gitDir: "/host/git", indexFile: "/host/index", tree: "/work/tree", emptyHooksDir: "/host/empty-hooks",
});
const base = "a".repeat(40);
const head = "b".repeat(40);

describe("isolatedGit", () => {
  test("SC-032 returns an invocation isolated from the work tree's Git directory and config", () => {
    expect(iso.env).toEqual({
      GIT_DIR: "/host/git",
      GIT_INDEX_FILE: "/host/index",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    });
    expect(Object.keys(iso.env).filter((key) => key.startsWith("GIT_"))).toHaveLength(8);
    expect(iso.env.GIT_DIR).not.toBe("/work/tree/.git");
    expect(iso.args).toEqual([
      "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/host/empty-hooks",
      "-c", "core.attributesFile=", "-c", "diff.external=", "-c", "core.autocrlf=false",
      "-c", "core.symlinks=true", "--work-tree", "/work/tree",
    ]);
  });

  test("rejects empty, relative, NUL and newline paths in every path option", () => {
    const keys = ["gitDir", "indexFile", "tree", "emptyHooksDir"] as const;
    for (const key of keys) {
      for (const value of ["", "relative/path", "/x\0y", "/x\ny"]) {
        const opts = { gitDir: "/g", indexFile: "/i", tree: "/t", emptyHooksDir: "/h" };
        opts[key] = value;
        expect(() => isolatedGit(opts)).toThrow();
      }
    }
  });
});

describe("Git -z parsers", () => {
  test("parses text, binary and rename numstat records", () => {
    expect(parseNumstatZ("3\t1\ttext.txt\0-\t-\timage.bin\0" + "0\t0\t\0old.txt\0new.txt\0")).toEqual([
      { path: "text.txt", added: 3, deleted: 1, binary: false },
      { path: "image.bin", added: 0, deleted: 0, binary: true },
      { path: "new.txt", added: 0, deleted: 0, binary: false },
    ]);
  });

  test("rejects malformed numstat without disclosing the path", () => {
    expect(() => parseNumstatZ("nope\t1\tprivate-name\0")).toThrow(/numstat.*length/i);
    try { parseNumstatZ("nope\t1\tprivate-name\0"); } catch (error) {
      expect(String(error)).not.toContain("private-name");
    }
  });

  test("SC-033 parses file statuses and valid three-digit rename and copy scores", () => {
    expect(parseNameStatusZ(
      "M\0a.txt\0A\0b.txt\0D\0c.txt\0R074\0old-r.txt\0new-r.txt\0C074\0old-c.txt\0new-c.txt\0R100\0old-full.txt\0new-full.txt\0",
    )).toEqual([
      { status: "M", path: "a.txt" }, { status: "A", path: "b.txt" }, { status: "D", path: "c.txt" },
      { status: "R074", path: "new-r.txt", from: "old-r.txt" },
      { status: "C074", path: "new-c.txt", from: "old-c.txt" },
      { status: "R100", path: "new-full.txt", from: "old-full.txt" },
    ]);
  });

  test("SC-033 rejects missing and out-of-range rename/copy similarity scores", () => {
    for (const out of ["C\0old.txt\0new.txt\0", "R\0old.txt\0new.txt\0", "R101\0old.txt\0new.txt\0", "C999\0old.txt\0new.txt\0"]) {
      expect(() => parseNameStatusZ(out)).toThrow(/name-status.*length/i);
    }
  });
});

describe("snapshotChange", () => {
  test("SC-031 hashes an unchanged fake tree consistently and changes hash when its file changes", () => {
    let workTreeContent = "same";
    let stagedContent = "";
    const invoke = (received: IsolatedGit, args: string[]) => {
      expect(received).toBe(iso);
      expect(received.env).toBe(iso.env);
      expect(received.args).toBe(iso.args);
      if (args[0] === "add") stagedContent = workTreeContent;
      if (args[0] === "write-tree") return stagedContent === "same" ? `${head}\n` : `${"c".repeat(40)}\n`;
      return "";
    };
    const originalHash = snapshotChange(invoke, iso, base).treeHash;
    expect(snapshotChange(invoke, iso, base).treeHash).toBe(originalHash);
    workTreeContent = "changed";
    expect(snapshotChange(invoke, iso, base).treeHash).not.toBe(originalHash);
  });

  test("SC-033 merges status and numstat, marks deletions, and reads a changed symlink target", () => {
    const calls: string[][] = [];
    const run = (received: IsolatedGit, args: string[]) => {
      expect(received).toBe(iso);
      expect(received.env).toBe(iso.env);
      expect(received.args).toBe(iso.args);
      calls.push(args);
      switch (args[0]) {
        case "read-tree": return "";
        case "add": return "";
        case "write-tree": return `${head}\n`;
        case "diff":
          return args[2] === "--numstat" ? "2\t0\tfile.txt\0" + "0\t0\tlink\0" : "M\0file.txt\0D\0gone.txt\0A\0link\0";
        case "ls-files": return `120000 ${"d".repeat(40)} 0\tlink\0`;
        case "cat-file": return "target/path";
        default: throw new Error(`unexpected ${args[0]}`);
      }
    };
    expect(snapshotChange(run, iso, base)).toEqual({
      treeHash: head,
      files: [
        { path: "file.txt", added: 2, deleted: 0, binary: false },
        { path: "gone.txt", added: 0, deleted: 0, binary: false, isDeleted: true },
        { path: "link", added: 0, deleted: 0, binary: false, symlinkTarget: "target/path" },
      ],
    });
    expect(calls.slice(0, 5)).toEqual([
      ["read-tree", base], ["add", "-A", "--", "."], ["write-tree"],
      ["diff", "--cached", "--numstat", "-z", "--no-renames", base],
      ["diff", "--cached", "--name-status", "-z", "--no-renames", base],
    ]);
    expect(calls[5]).toEqual(["ls-files", "--stage", "-z"]);
    expect(calls[6]).toEqual(["cat-file", "blob", "d".repeat(40)]);
  });

  test("uses exactly the required five calls in order when there are no changes", () => {
    const calls: string[][] = [];
    const run = (_received: IsolatedGit, args: string[]) => {
      calls.push(args);
      return args[0] === "write-tree" ? head : "";
    };
    snapshotChange(run, iso, base);
    expect(calls).toEqual([
      ["read-tree", base], ["add", "-A", "--", "."], ["write-tree"],
      ["diff", "--cached", "--numstat", "-z", "--no-renames", base],
      ["diff", "--cached", "--name-status", "-z", "--no-renames", base],
    ]);
  });

  test("keeps a tracked ignored file in the snapshot instead of reporting it deleted", () => {
    const snapshotWithReadTree = (skipReadTree: boolean) => {
      let indexHasTrackedIgnoredFile = false;
      const run = (_received: IsolatedGit, args: string[]) => {
        // Git's add -A skips ignored files not already present in the index.
        if (args[0] === "read-tree" && !skipReadTree) indexHasTrackedIgnoredFile = true;
        if (args[0] === "write-tree") return indexHasTrackedIgnoredFile ? head : "c".repeat(40);
        if (args[0] === "diff" && args[2] === "--numstat") return "0\t0\tignored/file.txt\0";
        if (args[0] === "diff") return `${indexHasTrackedIgnoredFile ? "M" : "D"}\0ignored/file.txt\0`;
        return "";
      };
      return snapshotChange(run, iso, base);
    };

    const withBase = snapshotWithReadTree(false);
    expect(withBase.treeHash).toBe(head);
    expect(withBase.files).toEqual([
      { path: "ignored/file.txt", added: 0, deleted: 0, binary: false },
    ]);

    const withoutBase = snapshotWithReadTree(true);
    expect(withoutBase.files).toEqual([
      { path: "ignored/file.txt", added: 0, deleted: 0, binary: false, isDeleted: true },
    ]);
  });

  test("rejects an invalid base and invalid tree hash before returning a snapshot", () => {
    const run = (_received: IsolatedGit, args: string[]) => args[0] === "write-tree" ? "not-a-hash" : "";
    expect(() => snapshotChange(run, iso, "bad")).toThrow(/base/i);
    expect(() => snapshotChange(run, iso, base)).toThrow(/tree/i);
  });

  test("G-3 excludes generated files from the staged tree and leaves the other four calls unchanged", () => {
    const record = () => {
      const calls: string[][] = [];
      const run = (_received: IsolatedGit, args: string[]) => {
        calls.push(args);
        return args[0] === "write-tree" ? head : "";
      };
      return { calls, run };
    };

    const excluded = record();
    snapshotChange(excluded.run, iso, base, { exclude: GENERATED_EXCLUDES });
    expect(excluded.calls).toEqual([
      ["read-tree", base],
      ["add", "-A", "--", ".", ":(exclude,glob)**/.orca-verify.json"],
      ["write-tree"],
      ["diff", "--cached", "--numstat", "-z", "--no-renames", base],
      ["diff", "--cached", "--name-status", "-z", "--no-renames", base],
    ]);

    for (const options of [undefined, { exclude: [] as readonly string[] }]) {
      const plain = record();
      snapshotChange(plain.run, iso, base, options);
      expect(plain.calls).toEqual([
        ["read-tree", base], ["add", "-A", "--", "."], ["write-tree"],
        ["diff", "--cached", "--numstat", "-z", "--no-renames", base],
        ["diff", "--cached", "--name-status", "-z", "--no-renames", base],
      ]);
    }
  });

  test("rejects an invalid exclude pattern before calling run without disclosing it", () => {
    for (const pattern of ["", "a\0b", "a\nb", ":(top)x"]) {
      let called = false;
      const run = (_received: IsolatedGit, _args: string[]) => {
        called = true;
        return "";
      };
      const message = () => {
        try {
          snapshotChange(run, iso, base, { exclude: [pattern] });
        } catch (error) {
          return String(error);
        }
        return "";
      };
      expect(message()).toBe("Error: Invalid exclude pattern");
      if (pattern !== "") expect(message()).not.toContain(pattern);
      expect(called).toBe(false);
    }
  });

  test("GENERATED_EXCLUDES names the tool-generated verification files", () => {
    expect(GENERATED_EXCLUDES).toEqual(["**/.orca-verify.json"]);
  });
});
