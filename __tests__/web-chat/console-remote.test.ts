import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleAuth } from "../../src/web-chat/console-auth";
import { startConsole } from "../../src/web-chat/console";
import { acquireBridgeLock } from "../../src/web-chat/config";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "console-remote-"));
  roots.push(path);
  writeFileSync(
    join(path, "config.json"),
    JSON.stringify({
      accounts: [{ id: "claude", service: "claude" }],
      privateSources: [],
    }),
    { mode: 0o600 },
  );
  return path;
}
function freePort() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = server.port!;
  server.stop(true);
  return port;
}

test("TS-1/TS-2: remote origins require explicit opt-in and exact HTTP shape", () => {
  const path = root();
  const origin = "http://100.64.1.2:3080";
  expect(() => new ConsoleAuth({ root: path, origin })).toThrow();
  expect(
    () => new ConsoleAuth({ root: path, origin, allowRemote: true }),
  ).not.toThrow();
  for (const invalid of [
    "http://0.0.0.0:3080",
    "http://[::]:3080",
    "http://100.64.1.2:3080/path",
    "http://user@100.64.1.2:3080",
    "http://100.64.1.2:3080?x=1",
    "http://100.64.1.2:3080#x",
  ])
    expect(
      () => new ConsoleAuth({ root: path, origin: invalid, allowRemote: true }),
    ).toThrow();
});

test("TS-1/TS-2: wildcard listener pins remote origin and keeps API auth, Host, Origin and CSRF checks", async () => {
  const path = root(),
    port = freePort(),
    origin = `http://console.tail.test:${port}`;
  const call = (path: string, options: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      headers: { host: new URL(origin).host, ...options.headers },
      signal: AbortSignal.timeout(3000),
    });
  const console = await startConsole({
    root: path,
    port,
    host: "0.0.0.0",
    origin,
  });
  try {
    expect(console.url).toBe(origin);
    expect((await call("/")).status).toBe(200);
    expect((await call("/api/accounts")).status).toBe(401);
    const token = readFileSync(join(path, "operator-token"), "utf8").trim();
    const login = await call("/api/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!,
      { csrf } = await login.json();
    expect((await call("/api/accounts", { headers: { cookie } })).status).toBe(
      200,
    );
    for (const headers of [
      { host: "evil.test" },
      { origin: "http://evil.test" },
    ])
      expect(
        (await call("/api/accounts", { headers: { cookie, ...headers } }))
          .status,
      ).toBe(403);
    expect(
      (
        await call("/api/logout", {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/api/logout", {
          method: "POST",
          headers: {
            cookie,
            origin,
            "x-console-csrf": csrf,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(200);
  } finally {
    await console.close();
  }
});

test("TS-1: unsafe or ambiguous remote configuration is refused without acquiring root", async () => {
  const path = root();
  for (const options of [
    { host: "0.0.0.0", port: 3080 },
    { host: "0.0.0.0", port: 0, origin: "http://100.64.1.2:3080" },
    { host: "0.0.0.0", port: 3080, origin: "http://100.64.1.2:3081" },
    { host: "evil.test", port: 3080, origin: "http://100.64.1.2:3080" },
  ]) {
    let console: Awaited<ReturnType<typeof startConsole>> | undefined;
    try {
      await expect(
        startConsole({ root: path, ...options }).then((c) => (console = c)),
      ).rejects.toThrow();
    } finally {
      await console?.close();
    }
    const release = acquireBridgeLock(path);
    release();
  }
});

test("TS-4: real CLI honors wildcard host and advertised origin and releases ownership on SIGTERM", async () => {
  const path = root(),
    origin = `http://console.tail.test:${freePort()}`;
  const connect = `http://127.0.0.1:${new URL(origin).port}`;
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../src/web-chat/cli.ts"),
      "console",
      "--root",
      path,
      "--host",
      "0.0.0.0",
      "--port",
      new URL(origin).port,
      "--origin",
      origin,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      (async () => {
        let text = "";
        for await (const bytes of child.stdout) {
          text += new TextDecoder().decode(bytes);
          if (text.includes("ANIMA Chat / Connect:")) return text;
        }
        throw Error("CLI exited before readiness");
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("startup timeout")), 10_000);
      }),
    ]);
    expect(output).toContain(origin);
    expect(output).not.toContain(
      readFileSync(join(path, "operator-token"), "utf8").trim(),
    );
    expect(
      (
        await fetch(connect + "/api/accounts", {
          headers: { host: new URL(origin).host },
          signal: AbortSignal.timeout(3000),
        })
      ).status,
    ).toBe(401);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const release = acquireBridgeLock(path);
    release();
    await expect(fetch(connect)).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
}, 15_000);
