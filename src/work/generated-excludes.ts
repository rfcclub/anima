import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TreeGit } from "./complete";

/** Apply the same host-owned policy when staging and checking a low worker's tree. */
export function gitWithGeneratedExcludes(git: TreeGit, tree: string, args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "anima-host-excludes-"));
  try {
    const excludes = join(dir, "excludes");
    writeFileSync(excludes, "__pycache__/\n*.pyc\nnode_modules/\n.venv/\n.DS_Store\n", { mode: 0o600 });
    return git(tree, ["-c", `core.excludesFile=${excludes}`, ...args]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
