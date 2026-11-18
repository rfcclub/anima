export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  isDeleted?: boolean;
  symlinkTarget?: string;
}

export interface IsolatedGit {
  env: Record<string, string>;
  args: string[];
}

export function isolatedGit(opts: {
  gitDir: string;
  indexFile: string;
  tree: string;
  emptyHooksDir: string;
}): IsolatedGit {
  const paths = [opts.gitDir, opts.indexFile, opts.tree, opts.emptyHooksDir];
  for (const path of paths) {
    if (!path || !path.startsWith("/") || /[\0\r\n]/.test(path)) {
      throw new Error("Git isolation paths must be non-empty absolute paths without NUL or newline");
    }
  }
  return {
    env: {
      GIT_DIR: opts.gitDir,
      GIT_INDEX_FILE: opts.indexFile,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
    args: [
      "-c", "core.fsmonitor=false",
      "-c", `core.hooksPath=${opts.emptyHooksDir}`,
      "-c", "core.attributesFile=",
      "-c", "diff.external=",
      "-c", "core.autocrlf=false",
      "-c", "core.symlinks=true",
      "--work-tree", opts.tree,
    ],
  };
}

function malformed(format: string, length: number): never {
  throw new Error(`Malformed ${format} record (length ${length})`);
}

function records(out: string): string[] {
  if (out === "") return [];
  const parts = out.split("\0");
  if (parts[parts.length - 1] !== "") malformed("NUL-delimited", parts[parts.length - 1]!.length);
  parts.pop();
  return parts;
}

export function parseNumstatZ(out: string): Array<{ path: string; added: number; deleted: number; binary: boolean }> {
  const parts = records(out);
  const result: Array<{ path: string; added: number; deleted: number; binary: boolean }> = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]!;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) malformed("numstat", record.length);
    const addedText = record.slice(0, firstTab);
    const deletedText = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    let added: number;
    let deleted: number;
    const binary = addedText === "-" && deletedText === "-";
    if (binary) {
      added = 0;
      deleted = 0;
    } else if (/^(0|[1-9][0-9]*)$/.test(addedText!) && /^(0|[1-9][0-9]*)$/.test(deletedText!)) {
      added = Number(addedText);
      deleted = Number(deletedText);
      if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted)) malformed("numstat", record.length);
    } else {
      malformed("numstat", record.length);
    }
    if (path === "") {
      if (i + 2 >= parts.length || parts[i + 1] === "" || parts[i + 2] === "") malformed("numstat rename", record.length);
      result.push({ path: parts[i + 2]!, added, deleted, binary });
      i += 2;
    } else {
      result.push({ path, added, deleted, binary });
    }
  }
  return result;
}

export function parseNameStatusZ(out: string): Array<{ status: string; path: string; from?: string }> {
  const parts = records(out);
  const result: Array<{ status: string; path: string; from?: string }> = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i]!;
    const statusLength = status.length;
    if (!/^(?:[ADMTUXB]|[RC](?:0[0-9]{2}|100))$/.test(status)) malformed("name-status", statusLength);
    if (i + 1 >= parts.length || parts[i + 1] === "") malformed("name-status", statusLength);
    if (status[0] === "R" || status[0] === "C") {
      if (i + 2 >= parts.length || parts[i + 2] === "") malformed("name-status rename", statusLength);
      result.push({ status, path: parts[i + 2]!, from: parts[i + 1]! });
      i += 3;
    } else {
      result.push({ status, path: parts[i + 1]! });
      i += 2;
    }
  }
  return result;
}

export const GENERATED_EXCLUDES: readonly string[] = ["**/.orca-verify.json"];

export function snapshotChange(
  run: (iso: IsolatedGit, args: string[]) => string,
  iso: IsolatedGit,
  base: string,
  options: { exclude?: readonly string[] } = {},
): { treeHash: string; files: ChangedFile[] } {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("Invalid base hash");
  const exclude = options.exclude ?? [];
  for (const pattern of exclude) {
    if (typeof pattern !== "string" || pattern === "" || /[\0\r\n]/.test(pattern) || pattern.startsWith(":")) {
      throw new Error("Invalid exclude pattern");
    }
  }
  run(iso, ["read-tree", base]);
  run(iso, ["add", "-A", "--", ".", ...exclude.map((pattern) => `:(exclude,glob)${pattern}`)]);
  const treeHash = run(iso, ["write-tree"]).trim();
  if (!/^[0-9a-f]{40}$/.test(treeHash)) throw new Error("Invalid tree hash");
  const numstat = parseNumstatZ(run(iso, ["diff", "--cached", "--numstat", "-z", "--no-renames", base]));
  const statuses = parseNameStatusZ(run(iso, ["diff", "--cached", "--name-status", "-z", "--no-renames", base]));

  const numstatByPath = new Map(numstat.map((item) => [item.path, item]));
  const byPath = new Map<string, ChangedFile>();
  for (const item of statuses) {
    const counts = numstatByPath.get(item.path);
    byPath.set(item.path, {
      path: item.path,
      added: counts?.added ?? 0,
      deleted: counts?.deleted ?? 0,
      binary: counts?.binary ?? false,
      ...(item.status === "D" ? { isDeleted: true } : {}),
    });
  }
  for (const item of numstat) {
    if (!byPath.has(item.path)) byPath.set(item.path, { ...item });
  }

  const changedPaths = new Set(byPath.keys());
  if (changedPaths.size > 0) {
    const entries = records(run(iso, ["ls-files", "--stage", "-z"]));
    const symlinks = new Map<string, string>();
    for (const entry of entries) {
      const match = /^(100644|100755|120000|160000) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match) malformed("ls-files", entry.length);
      if (match[1] === "120000" && changedPaths.has(match[4]!)) symlinks.set(match[4]!, match[2]!);
    }
    for (const [path, sha] of symlinks) {
      byPath.get(path)!.symlinkTarget = run(iso, ["cat-file", "blob", sha]);
    }
  }
  return { treeHash, files: [...byPath.values()] };
}
