import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { planGuard, validateRuntime } from "./configguard.ts";
import type { Fs } from "./types.ts";

const key = "public-key-fixture";
const runtime = (issuerPublicKey = key, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ meshService: { issuerPublicKey, ...extra } });
const hash12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

class GuardFs implements Fs {
  files = new Map<string, string>();
  mtimes = new Map<string, number>();
  writes: Array<[string, string]> = [];

  read(path: string): string | undefined { return this.files.get(path); }
  write(path: string, data: string): void { this.writes.push([path, data]); this.files.set(path, data); }
  rename(): void {}
  chmod(): void {}
  stat(): { size: number } | undefined { return undefined; }
  mkdir(): void {}
  readdir(path: string): string[] {
    const prefix = `${path.replace(/\/+$/, "")}/`;
    return [...this.files.keys()].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
  }
  size(): number { return 0; }
  mtimeMs(path: string): number | undefined { return this.mtimes.get(path); }
}

function deps(fs: GuardFs, liveText: string, now = 1234) {
  fs.files.set("/live/a2a-runtime.json", liveText);
  return {
    fs,
    liveFile: "/live/a2a-runtime.json",
    lastGoodDir: "/outside-good",
    signingPublicKey: () => key,
    now: () => now,
  };
}

function addCopy(fs: GuardFs, name: string, text: string, mtime: number | undefined) {
  const path = `/outside-good/${name}`;
  fs.files.set(path, text);
  if (mtime !== undefined) fs.mtimes.set(path, mtime);
}

test("SC-011: valid live runtime is remembered by content hash and then recognized", () => {
  const fs = new GuardFs();
  const text = runtime(key, { port: 1526 });
  const input = deps(fs, text);
  const copy = `/outside-good/runtime-${hash12(text)}.json`;
  expect(planGuard(input, 200)).toEqual({ kind: "remember", copy, hash: hash12(text) });
  fs.files.set(copy, text);
  expect(planGuard(input, 200)).toEqual({ kind: "touch", copy });
});

test("SC-012: 404 with missing meshService restores the newest valid copy", () => {
  const fs = new GuardFs();
  const text = runtime(key, { port: 1526 });
  const name = `runtime-${hash12(text)}.json`;
  addCopy(fs, name, text, 20);
  expect(planGuard(deps(fs, "{}"), 404)).toEqual({
    kind: "restore",
    from: `/outside-good/${name}`,
    backup: "/live/a2a-runtime.json.bak-1234",
    mode: 0o600,
    restart: "colony-meshd",
  });
});

test("SC-013: a last-good copy signed by another key is refused", () => {
  const fs = new GuardFs();
  const text = runtime("different-public-key");
  addCopy(fs, `runtime-${hash12(text)}.json`, text, 20);
  expect(planGuard(deps(fs, "{}"), 404)).toEqual({ kind: "refuse", reason: "no valid last-good copy" });
});

test("SC-014: join 401 takes no action when meshService is missing", () => {
  expect(planGuard(deps(new GuardFs(), "{}"), 401)).toEqual({ kind: "none", reason: "join status is not 404" });
});

test("SC-014: join 401 takes no action even when the live runtime is valid", () => {
  expect(planGuard(deps(new GuardFs(), runtime()), 401)).toEqual({ kind: "none", reason: "join status is not 404" });
});

test("SC-015: unknown join status takes no action", () => {
  expect(planGuard(deps(new GuardFs(), "{}"), null)).toEqual({ kind: "none", reason: "join status unknown" });
});

test("SC-015: unknown join status takes no action even when the live runtime is valid", () => {
  expect(planGuard(deps(new GuardFs(), runtime()), null)).toEqual({ kind: "none", reason: "join status unknown" });
});

test("SC-016: planning never writes files", () => {
  const fs = new GuardFs();
  addCopy(fs, "runtime-ffffffffffff.json", runtime(), 1);
  planGuard(deps(fs, "{}"), 404);
  expect(fs.writes).toEqual([]);
});

test("validateRuntime rejects malformed JSON without including config contents", () => {
  expect(validateRuntime("{not-json-secret", key)).toEqual({ ok: false, reason: "invalid JSON" });
});

test("validateRuntime requires meshService to be an object", () => {
  expect(validateRuntime(JSON.stringify({ meshService: "not-an-object" }), key)).toEqual({
    ok: false,
    reason: "meshService must be an object",
  });
});

test("validateRuntime refuses when signing key is unknown", () => {
  expect(validateRuntime(runtime(), null)).toEqual({ ok: false, reason: "signing key unknown" });
});

test("validateRuntime does not disclose either public key on mismatch", () => {
  const result = validateRuntime(runtime("secret-mismatch"), key);
  expect(result).toEqual({ ok: false, reason: "meshService.issuerPublicKey does not match signing key" });
  expect(JSON.stringify(result)).not.toContain("secret-mismatch");
  expect(JSON.stringify(result)).not.toContain(key);
});

test("SC-012: newest copy wins when its hash sorts lexicographically first", () => {
  const fs = new GuardFs();
  const newest = runtime(key, { port: 2 });
  const older = runtime(key, { port: 1 });
  addCopy(fs, "runtime-000000000000.json", newest, 20);
  addCopy(fs, "runtime-ffffffffffff.json", older, 10);
  expect(planGuard(deps(fs, "{}"), 404)).toMatchObject({ kind: "restore", from: "/outside-good/runtime-000000000000.json" });
});

test("SC-012: equal copy mtimes choose the lexicographically greater file name", () => {
  const fs = new GuardFs();
  addCopy(fs, "runtime-000000000000.json", runtime(key, { port: 1 }), 20);
  addCopy(fs, "runtime-ffffffffffff.json", runtime(key, { port: 2 }), 20);
  expect(planGuard(deps(fs, "{}"), 404)).toMatchObject({ kind: "restore", from: "/outside-good/runtime-ffffffffffff.json" });
});

test("SC-012: a copy with unreadable mtime is skipped", () => {
  const fs = new GuardFs();
  addCopy(fs, "runtime-000000000000.json", runtime(key, { port: 1 }), 10);
  addCopy(fs, "runtime-ffffffffffff.json", runtime(key, { port: 2 }), undefined);
  expect(planGuard(deps(fs, "{}"), 404)).toMatchObject({
    kind: "restore",
    from: "/outside-good/runtime-000000000000.json",
  });
});

test("SC-012: malformed live JSON is not treated as proof meshService is absent", () => {
  const fs = new GuardFs();
  addCopy(fs, "runtime-ffffffffffff.json", runtime(), 20);
  expect(planGuard(deps(fs, "{malformed"), 404)).toEqual({
    kind: "none",
    reason: "live runtime does not establish missing meshService",
  });
});

test("SC-011: reverting to an existing valid runtime refreshes its copy", () => {
  const fs = new GuardFs();
  const a = runtime(key, { port: 1 });
  const b = runtime(key, { port: 2 });
  const input = deps(fs, a);
  const copyA = `/outside-good/runtime-${hash12(a)}.json`;
  const copyB = `/outside-good/runtime-${hash12(b)}.json`;

  expect(planGuard(input, 200)).toEqual({ kind: "remember", copy: copyA, hash: hash12(a) });
  fs.files.set(copyA, a);
  fs.mtimes.set(copyA, 10);
  fs.files.set(input.liveFile, b);
  expect(planGuard(input, 200)).toEqual({ kind: "remember", copy: copyB, hash: hash12(b) });
  fs.files.set(copyB, b);
  fs.mtimes.set(copyB, 20);

  fs.files.set(input.liveFile, a);
  expect(planGuard(input, 200)).toEqual({ kind: "touch", copy: copyA });
  // The runner applies the touch; then the newest valid copy must reflect the revert.
  fs.mtimes.set(copyA, 30);
  fs.files.set(input.liveFile, "{}");
  expect(planGuard(input, 404)).toMatchObject({ kind: "restore", from: copyA });
});

test("SC-012: unreadable live runtime with join 404 restores the newest valid copy", () => {
  const fs = new GuardFs();
  const text = runtime();
  const name = `runtime-${hash12(text)}.json`;
  addCopy(fs, name, text, 20);
  const input = deps(fs, "{}");
  fs.files.delete(input.liveFile);
  expect(planGuard(input, 404)).toMatchObject({ kind: "restore", from: `/outside-good/${name}` });
});

test("SC-012: unreadable live runtime with join 404 refuses without a valid copy", () => {
  const fs = new GuardFs();
  const input = deps(fs, "{}");
  fs.files.delete(input.liveFile);
  expect(planGuard(input, 404)).toEqual({ kind: "refuse", reason: "no valid last-good copy" });
});

test("SC-015: unknown join status with unreadable live runtime reports unreadable", () => {
  const fs = new GuardFs();
  const input = deps(fs, "{}");
  fs.files.delete(input.liveFile);
  expect(planGuard(input, null)).toEqual({ kind: "none", reason: "live runtime unreadable" });
});
