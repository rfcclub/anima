#!/usr/bin/env bun
/**
 * Deploy guard: a dirty working tree
 * used to deploy silently — `git describe --always --dirty` just recorded
 * "-dirty" in the stamp, so a deploy could carry unrelated uncommitted work
 * (src/server.ts, scripts/deploy.sh itself have both done this) with no
 * warning at all. This makes that a conscious choice instead of a default.
 */

export interface GitCleanCheck {
  clean: boolean;
  dirtyFiles: string[];
}

/** Parses `git status --porcelain` output (already captured by the caller — no git calls here, so this is pure and testable). */
export function checkGitClean(porcelainOutput: string): GitCleanCheck {
  // Porcelain lines are fixed-width ("XY path"); the leading status chars can
  // themselves be spaces (e.g. " M" = modified, not staged), so trimming the
  // line first — before slicing off the 3-char prefix — eats part of the path.
  const dirtyFiles = porcelainOutput
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
  return { clean: dirtyFiles.length === 0, dirtyFiles };
}

export function formatDirtyWarning(check: GitCleanCheck): string {
  return [
    "refusing to deploy: working tree is not commit-clean",
    ...check.dirtyFiles.map((file) => `  ${file}`),
    "Commit or stash these first, or re-run with ALLOW_DIRTY=1 to deploy anyway.",
  ].join("\n");
}

if (import.meta.main) {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { stdout: "pipe" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  const check = checkGitClean(output);
  if (!check.clean && Bun.env.ALLOW_DIRTY !== "1") {
    console.error(formatDirtyWarning(check));
    process.exit(1);
  }
  if (!check.clean) {
    console.error(`deploying dirty (ALLOW_DIRTY=1): ${check.dirtyFiles.length} uncommitted file(s)`);
  }
}
