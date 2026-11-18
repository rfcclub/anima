import { createHash } from "node:crypto";
import { lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { TreeRead } from "./stops";

type Entry = { mode: string; oid: string; path: string };

/** Only fixed, host-authored messages of this type may be shown to the operator. */
export class RecoveryTreeError extends Error {}

function records(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function entries(output: string, kind: "index" | "head"): Map<string, Entry> {
  const result = new Map<string, Entry>();
  for (const line of records(output)) {
    const match = kind === "index"
      ? /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/.exec(line)
      : /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(line);
    if (!match) throw new RecoveryTreeError("unreadable Git tree entries");
    const mode = match[1]!;
    const oid = kind === "index" ? match[2]! : match[3]!;
    const path = match[4]!;
    if ((kind === "index" && match[3] !== "0") ||
        !["100644", "100755", "120000"].includes(mode) ||
        (kind === "head" && match[2] !== "blob") ||
        path.includes("\ufffd") || path.split("/").some((part) => !part || part === "." || part === "..") ||
        result.has(path)) {
      throw new RecoveryTreeError("unsupported Git tree entry (for example, a submodule or conflict)");
    }
    result.set(path, { mode, oid, path });
  }
  return result;
}

/**
 * Compare HEAD, the index and the actual tracked bytes without trusting Git's stat cache or clean filters.
 * Regular-file hashes run through sandboxed Git with --no-filters; symlink contents are read as links.
 * Ignored untracked files also block recovery because the stop record does not establish their contents.
 */
export function verifyRecoveryTree(tree: string, head: string, read: TreeRead): void {
  const flags = records(read(tree, ["ls-files", "-v", "-z"]));
  if (flags.some((entry) => !entry.startsWith("H "))) throw new RecoveryTreeError("Git index flags may hide tracked changes");
  const index = entries(read(tree, ["ls-files", "--stage", "-z"]), "index");
  const committed = entries(read(tree, ["ls-tree", "-r", "-z", "--full-tree", head]), "head");
  if (index.size !== committed.size) throw new RecoveryTreeError("Git index differs from the checkpoint");
  if (records(read(tree, ["ls-files", "--others", "-z"])).length) {
    throw new RecoveryTreeError("work tree has untracked files, including ignored files");
  }

  const tracked = [...index.values()];
  for (let start = 0; start < tracked.length;) {
    const paths: string[] = [];
    let bytes = 0;
    while (start < tracked.length && paths.length < 64) {
      const path = tracked[start]!.path;
      const size = Buffer.byteLength(path) + 1;
      if (paths.length && bytes + size > 16_000) break;
      if (size > 16_000) throw new RecoveryTreeError("tracked path is too long to verify");
      paths.push(path);
      bytes += size;
      start++;
    }
    const output = read(tree, ["check-attr", "-z", "--all", "--", ...paths]);
    const attrs = output === "" ? [] : output.split("\0").slice(0, -1);
    if (attrs.length % 3 !== 0) throw new RecoveryTreeError("Git attributes cannot be verified");
    for (let i = 0; i < attrs.length; i += 3) {
      // --all distinguishes an attribute literally named "unspecified" from no attribute.
      if (attrs[i + 1] === "filter") throw new RecoveryTreeError("tracked file has a Git filter attribute");
    }
  }

  const regular: Entry[] = [];
  for (const entry of index.values()) {
    const expected = committed.get(entry.path);
    if (!expected || expected.mode !== entry.mode || expected.oid !== entry.oid) {
      throw new RecoveryTreeError("Git index differs from the checkpoint");
    }
    const parts = entry.path.split("/");
    let parent = tree;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new RecoveryTreeError("tracked path has a redirected parent");
    }
    const path = join(parent, parts[parts.length - 1]!);
    const info = lstatSync(path);
    if (entry.mode === "120000") {
      if (!info.isSymbolicLink()) throw new RecoveryTreeError("tracked symlink has changed");
      const target = readlinkSync(path, { encoding: "buffer" });
      const hash = createHash(entry.oid.length === 40 ? "sha1" : "sha256")
        .update(`blob ${target.length}\0`).update(target).digest("hex");
      if (hash !== entry.oid) throw new RecoveryTreeError("tracked symlink has changed");
    } else {
      if (!info.isFile() || info.isSymbolicLink() ||
          ((info.mode & 0o111) !== 0) !== (entry.mode === "100755")) {
        throw new RecoveryTreeError("tracked file type or mode has changed");
      }
      regular.push(entry);
    }
  }

  // Bounded argv batches avoid shell parsing and keep filenames with whitespace or newlines intact.
  for (let start = 0; start < regular.length;) {
    const batch: Entry[] = [];
    let bytes = 0;
    while (start < regular.length && batch.length < 64) {
      const entry = regular[start]!;
      const size = Buffer.byteLength(entry.path) + 1;
      if (batch.length && bytes + size > 16_000) break;
      if (size > 16_000) throw new RecoveryTreeError("tracked path is too long to verify");
      batch.push(entry);
      bytes += size;
      start++;
    }
    const hashes = read(tree, ["hash-object", "--no-filters", "--", ...batch.map((entry) => entry.path)]).split("\n");
    if (hashes.length !== batch.length || batch.some((entry, i) => hashes[i] !== entry.oid)) {
      throw new RecoveryTreeError("tracked file contents differ from the checkpoint");
    }
  }
}
