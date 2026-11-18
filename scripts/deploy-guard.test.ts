import { expect, test } from "bun:test";
import { checkGitClean, formatDirtyWarning } from "./deploy-guard.ts";

test("checkGitClean reports clean for empty porcelain output", () => {
  expect(checkGitClean("")).toEqual({ clean: true, dirtyFiles: [] });
  expect(checkGitClean("\n")).toEqual({ clean: true, dirtyFiles: [] });
});

test("checkGitClean lists each dirty file with the status prefix stripped", () => {
  const porcelain = " M src/server.ts\n?? scripts/new-thing.ts\nMM test/x.test.ts\n";
  expect(checkGitClean(porcelain)).toEqual({
    clean: false,
    dirtyFiles: ["src/server.ts", "scripts/new-thing.ts", "test/x.test.ts"],
  });
});

test("formatDirtyWarning names every dirty file and the override", () => {
  const message = formatDirtyWarning({ clean: false, dirtyFiles: ["src/server.ts", "scripts/deploy.sh"] });
  expect(message).toContain("src/server.ts");
  expect(message).toContain("scripts/deploy.sh");
  expect(message).toContain("ALLOW_DIRTY=1");
});
