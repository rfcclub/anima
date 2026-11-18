import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, isStale, writeCacheAtomic } from "./fetch-identity-cache.ts";

test("parseArgs requires --tenant", () => {
  expect(() => parseArgs([])).toThrow("--tenant is required");
});

test("parseArgs defaults clientId/surfaceId/targetPath from tenant", () => {
  const args = parseArgs(["--tenant", "lena"]);
  expect(args.clientId).toBe("lena");
  expect(args.surfaceId).toBe("lena-cache");
  expect(args.targetPath).toContain("lena/CORE_IDENTITY.md");
  expect(args.force).toBe(false);
});

test("parseArgs honors explicit overrides", () => {
  const args = parseArgs([
    "--tenant", "eli",
    "--client-id", "codex",
    "--surface-id", "codex-eli",
    "--target-path", "/tmp/x/CORE_IDENTITY.md",
    "--force",
  ]);
  expect(args).toEqual({
    tenant: "eli",
    clientId: "codex",
    surfaceId: "codex-eli",
    targetPath: "/tmp/x/CORE_IDENTITY.md",
    force: true,
  });
});

test("isStale reports stale when the file is missing", () => {
  expect(isStale(join(mkdtempSync(join(tmpdir(), "fic-")), "missing.md"), Date.now(), false)).toEqual({ stale: true });
});

test("isStale reports fresh for a recently written file", () => {
  const dir = mkdtempSync(join(tmpdir(), "fic-"));
  const path = join(dir, "CORE_IDENTITY.md");
  writeFileSync(path, "hi");
  const result = isStale(path, Date.now(), false);
  expect(result.stale).toBe(false);
  expect(result.cacheAgeMs).toBeLessThan(1000);
});

test("isStale reports fresh at 29 minutes and stale at 31 minutes", () => {
  const dir = mkdtempSync(join(tmpdir(), "fic-"));
  const path = join(dir, "CORE_IDENTITY.md");
  writeFileSync(path, "hi");
  const minutesAgo = (minutes: number) => (Date.now() - minutes * 60 * 1000) / 1000;
  utimesSync(path, minutesAgo(29), minutesAgo(29));
  expect(isStale(path, Date.now(), false).stale).toBe(false);
  utimesSync(path, minutesAgo(31), minutesAgo(31));
  expect(isStale(path, Date.now(), false).stale).toBe(true);
});

test("isStale reports stale for a zero-byte file even when it is brand new", () => {
  const dir = mkdtempSync(join(tmpdir(), "fic-"));
  const path = join(dir, "CORE_IDENTITY.md");
  writeFileSync(path, "");
  expect(isStale(path, Date.now(), false)).toEqual({ stale: true });
});

test("writeCacheAtomic creates parent directories and leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "fic-"));
  const path = join(dir, "nested", "CORE_IDENTITY.md");
  writeCacheAtomic(path, "first");
  writeCacheAtomic(path, "second");
  expect(readFileSync(path, "utf8")).toBe("second");
  expect(readdirSync(join(dir, "nested"))).toEqual(["CORE_IDENTITY.md"]);
});

test("writeCacheAtomic keeps the previous file and cleans up when the write fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "fic-"));
  const path = join(dir, "CORE_IDENTITY.md");
  writeFileSync(path, "KEEP");
  expect(() => writeCacheAtomic(path, { not: "a string" } as unknown as string)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("KEEP");
  expect(readdirSync(dir)).toEqual(["CORE_IDENTITY.md"]);
  expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
});

test("isStale always reports stale when force is set, even for a fresh file", () => {
  const dir = mkdtempSync(join(tmpdir(), "fic-"));
  const path = join(dir, "CORE_IDENTITY.md");
  writeFileSync(path, "hi");
  expect(isStale(path, Date.now(), true)).toEqual({ stale: true });
});
