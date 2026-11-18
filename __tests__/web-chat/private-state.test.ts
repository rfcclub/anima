import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateDirectory, privateFile } from "../../src/web-chat/private-fs";
test("WB-4: unsafe preexisting private paths are rejected without changing their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-private-"));
  try {
    const target = join(root, "target"),
      alias = join(root, "alias"),
      hard = join(root, "hard"),
      publicDir = join(root, "public");
    writeFileSync(target, "unchanged", { mode: 0o600 });
    symlinkSync(target, alias);
    expect(() => privateFile(alias)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("unchanged");
    linkSync(target, hard);
    expect(() => privateFile(hard)).toThrow("unsafe");
    mkdirSync(publicDir, { mode: 0o755 });
    expect(() => privateDirectory(publicDir)).toThrow("unsafe");
    const dirAlias = join(root, "dir-alias");
    symlinkSync(root, dirAlias);
    expect(() => privateDirectory(dirAlias)).toThrow("unsafe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
