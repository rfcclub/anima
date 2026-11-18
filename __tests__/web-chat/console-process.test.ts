import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startConsole } from "../../src/web-chat/console";
import { acquireBridgeLock } from "../../src/web-chat/config";
import { startWebChatFromEnv } from "../../src/web-chat/host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "console-process-"));
  roots.push(root);
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      accounts: [{ id: "claude", service: "claude" }],
      privateSources: [],
    }),
    { mode: 0o600 },
  );
  return root;
}
test("SC-1/SC-7: standalone console owns root; a real ANIMA worker refuses collision before readiness", async () => {
  const root = setup();
  const console = await startConsole({ root, port: 0 });
  try {
    expect((await fetch(console.url + "/api/accounts")).status).toBe(401);
    expect(() => acquireBridgeLock(root)).toThrow("already owned");
    await expect(
      startWebChatFromEnv({ ANIMA_WEB_CHAT: "on", ANIMA_WEB_CHAT_ROOT: root }),
    ).rejects.toThrow();
    expect(readFileSync(join(root, "owner.lock"), "utf8")).toBe(
      String(process.pid),
    );
    const processProbe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { acquireBridgeLock } from ${JSON.stringify(join(import.meta.dir, "../../src/web-chat/config.ts"))};
       try { acquireBridgeLock(process.argv[1]); process.exit(2); }
       catch (e) { process.stderr.write(e.message); process.exit(1); }`,
        root,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await processProbe.exited).toBe(1);
    const stderr = await new Response(processProbe.stderr).text();
    expect(stderr).toContain("bridge/profile already owned");
    expect(stderr).not.toContain(
      readFileSync(join(root, "operator-token"), "utf8").trim(),
    );
  } finally {
    await console.close();
  }
  const release = acquireBridgeLock(root);
  release();
  await expect(fetch(console.url + "/api/accounts")).rejects.toThrow();
}, 15_000);

test("SC-7: listener startup failure releases root ownership and has no implicit activation", async () => {
  const root = setup();
  const blocker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  try {
    await expect(startConsole({ root, port: blocker.port! })).rejects.toThrow();
    const release = acquireBridgeLock(root);
    release();
  } finally {
    await blocker.stop(true);
  }
  expect(await startWebChatFromEnv({})).toBeUndefined();
});

test("SC-7: CLI console exposes local assets, prints no secret, and releases listener and lock on SIGTERM", async () => {
  const root = setup();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../src/web-chat/cli.ts"),
      "console",
      "--root",
      root,
      "--port",
      "0",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = await Promise.race([
      (async () => {
        for await (const bytes of child.stdout) {
          output += new TextDecoder().decode(bytes);
          const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
          if (match) return match[0];
        }
        throw Error("CLI exited before console URL");
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("CLI console startup timeout")),
          10_000,
        );
      }),
    ]);
    clearTimeout(timer);
    expect(await (await fetch(url)).text()).toContain("Unlock console");
    expect(
      (await fetch(url + "/console.js")).headers.get("content-type"),
    ).toContain("javascript");
    expect(output).not.toContain(
      readFileSync(join(root, "operator-token"), "utf8").trim(),
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const release = acquireBridgeLock(root);
    release();
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
}, 15_000);
