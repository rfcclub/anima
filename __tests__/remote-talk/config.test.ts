import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRemoteTalkConfig } from "../../src/remote-talk/config";

let dir: string;
let path: string;

const DIGEST = "a".repeat(64);
const grant = { tokenSha256: DIGEST, agent: "jade", caller: "jade@grok", expiresAt: "2026-10-17T04:00:00Z" };

function writeConfig(value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  dir = join(tmpdir(), `remote-talk-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  path = join(dir, "remote-talk.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("absent config file → null", () => {
  expect(loadRemoteTalkConfig(path)).toBeNull();
});

test("valid config is parsed, expiry as epoch ms", () => {
  writeConfig({ host: "192.0.2.10", port: 3710, grants: [grant] });
  expect(loadRemoteTalkConfig(path)).toEqual({
    host: "192.0.2.10",
    port: 3710,
    grants: [{ tokenSha256: DIGEST, agent: "jade", caller: "jade@grok", expiresAt: Date.parse("2026-10-17T04:00:00Z") }],
  });
});

for (const host of ["0.0.0.0", "::", "*", ""]) {
  test(`wildcard host ${JSON.stringify(host)} is refused`, () => {
    writeConfig({ host, port: 3710, grants: [grant] });
    expect(() => loadRemoteTalkConfig(path)).toThrow("explicit host");
  });
}

for (const port of [70000, -1, 1.5, "3710"]) {
  test(`invalid port ${JSON.stringify(port)} is refused`, () => {
    writeConfig({ host: "127.0.0.1", port, grants: [grant] });
    expect(() => loadRemoteTalkConfig(path)).toThrow("port");
  });
}

const badGrants: Array<[string, Record<string, unknown>]> = [
  ["short digest", { ...grant, tokenSha256: "a".repeat(63) }],
  ["non-hex digest", { ...grant, tokenSha256: "z".repeat(64) }],
  ["path-like agent", { ...grant, agent: "../x" }],
  ["caller without platform", { ...grant, caller: "jade" }],
  ["unparseable expiry", { ...grant, expiresAt: "soon" }],
];

for (const [name, bad] of badGrants) {
  test(`grant with ${name} is refused`, () => {
    writeConfig({ host: "127.0.0.1", port: 3710, grants: [bad] });
    expect(() => loadRemoteTalkConfig(path)).toThrow("grant");
  });
}

test("config without grants is refused", () => {
  writeConfig({ host: "127.0.0.1", port: 3710, grants: [] });
  expect(() => loadRemoteTalkConfig(path)).toThrow("grant");
});
