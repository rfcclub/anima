/**
 * cartridge-worker-dispatch: a work sandbox whose only network is one loopback port
 * (the session gateway's). Runs real `sandbox-exec` children against real listeners; skipped where the binary is absent.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProfile, probeLoopbackOnly, sandboxCommand, SANDBOX_BINARY } from "../../src/work/sandbox";

const sbx = existsSync(SANDBOX_BINARY) ? describe : describe.skip;

let base: string;
let root: string;
const servers: Array<{ stop(force?: boolean): void }> = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "work-loop-")));
  root = join(base, "workroot");
  mkdirSync(root, { recursive: true });
});
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

function listen(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  servers.push(server);
  return server.port!;
}

async function curl(port: number, args: string[]): Promise<number> {
  const child = Bun.spawn(sandboxCommand({ writableRoots: [root], allowLoopbackPort: port }, ["/usr/bin/curl", "-s", "-m", "3", "-o", "/dev/null", ...args]), {
    cwd: root, env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore",
  });
  return await child.exited;
}

describe("loopback-only profile (cartridge-worker-dispatch S2)", () => {
  test("profile-text: network is denied except outbound to the one loopback port", () => {
    const text = buildProfile({ writableRoots: [root], allowLoopbackPort: 47811 });
    const deny = text.indexOf("(deny network*)");
    const allow = text.indexOf('(allow network-outbound (remote ip "localhost:47811"))');
    expect(deny).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(deny);
    expect(() => buildProfile({ writableRoots: [root], allowLoopbackPort: 0 })).toThrow(RangeError);
    expect(() => buildProfile({ writableRoots: [root], allowLoopbackPort: 70000 })).toThrow(RangeError);
    expect(() => buildProfile({ writableRoots: [root], allowLoopbackPort: 1.5 })).toThrow(RangeError);
    expect(() => buildProfile({ writableRoots: [root], allowLoopbackPort: 47811, allowNetwork: true })).toThrow(RangeError);
  });
});

sbx("loopback-only boundary (cartridge-worker-dispatch S2)", () => {
  test("loopback-only: the granted port connects; another loopback port, a Unix socket and the internet are refused", async () => {
    const granted = listen();
    const other = listen();
    const socketPath = join(base, "s.sock");
    servers.push(Bun.serve({ unix: socketPath, fetch: () => new Response("ok") }));
    expect(await curl(granted, [`http://127.0.0.1:${granted}/`])).toBe(0);
    expect(await curl(granted, [`http://127.0.0.1:${other}/`])).not.toBe(0);
    expect(await curl(granted, ["--unix-socket", socketPath, "http://localhost/"])).not.toBe(0);
    expect(await curl(granted, ["http://1.1.1.1/"])).not.toBe(0);
  });

  test("probe: probeLoopbackOnly passes on this host and names what failed otherwise", async () => {
    expect(typeof probeLoopbackOnly).toBe("function");
    expect(await probeLoopbackOnly()).toEqual({ ok: true });
    expect(await probeLoopbackOnly({ binary: join(base, "missing-sandbox-exec") })).toEqual({ ok: false, reason: expect.stringContaining("isolation unavailable") });
  });
});
