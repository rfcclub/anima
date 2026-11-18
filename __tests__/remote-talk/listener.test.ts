import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRemoteTalkListener } from "../../src/remote-talk/listener";

let dir: string;
let configPath: string;
let errors: Array<{ message: string; fields?: Record<string, unknown> }>;
const servers: Array<{ stop: (force?: boolean) => void }> = [];

const log = (level: "info" | "error", message: string, fields?: Record<string, unknown>) => {
  if (level === "error") errors.push({ message, fields });
};

function writeConfig(port: number): void {
  writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port,
    grants: [{ tokenSha256: "a".repeat(64), agent: "jade", caller: "jade@grok", expiresAt: "2026-10-17T04:00:00Z" }],
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-remote-listener-"));
  configPath = join(dir, "remote-talk.json");
  errors = [];
});

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("when the config file is absent, startRemoteTalkListener returns null, and nothing is bound (no error logged)", () => {
  expect(startRemoteTalkListener({ configPath, roomsDir: dir, log })).toBeNull();
  expect(errors).toHaveLength(0);
});

test("binds only the configured host; unknown path → 404 over real HTTP", async () => {
  writeConfig(0);
  const server = startRemoteTalkListener({ configPath, roomsDir: dir, log });
  expect(server).not.toBeNull();
  servers.push(server!);
  expect(server!.hostname).toBe("127.0.0.1");
  const response = await fetch(`http://127.0.0.1:${server!.port}/nope`, { method: "POST" });
  expect(response.status).toBe(404);
  const unauthorized = await fetch(`http://127.0.0.1:${server!.port}/talk`, { method: "POST", body: "{}" });
  expect(unauthorized.status).toBe(401);
});

test("port already in use → null and one logged error, no throw", () => {
  writeConfig(0);
  const first = startRemoteTalkListener({ configPath, roomsDir: dir, log });
  servers.push(first!);
  writeConfig(first!.port);
  const second = startRemoteTalkListener({ configPath, roomsDir: dir, log });
  expect(second).toBeNull();
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toContain("remote talk listener failed");
});

test("invalid config (wildcard host) → null and one logged error, no throw", () => {
  writeFileSync(configPath, JSON.stringify({ host: "0.0.0.0", port: 0, grants: [] }));
  expect(startRemoteTalkListener({ configPath, roomsDir: dir, log })).toBeNull();
  expect(errors).toHaveLength(1);
});
