import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserProcess } from "../../src/web-chat/browser-process";
import { fixtureAdapter } from "../../src/web-chat/adapters";
test("WB-7: a dead browser child rejects later calls promptly and shutdown is shared", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-crash-"));
  const html = readFileSync(
    join(import.meta.dir, "fixtures/chat.html"),
    "utf8",
  );
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(html, { headers: { "content-type": "text/html" } }),
  });
  const manager = new BrowserProcess({
    root,
    accounts: [{ id: "a", service: "chatgpt" }],
    headless: true,
    fixture: {
      url: `http://127.0.0.1:${server.port}/`,
      adapter: fixtureAdapter,
    },
  });
  const conversation = {
    id: "c",
    createdAt: Date.now(),
    owner: { agent: "a", session: "s" },
    account: "a",
    service: "chatgpt" as const,
    closed: false,
    blocked: false,
  };
  try {
    expect(
      (
        await manager.run(
          conversation,
          "first",
          AbortSignal.timeout(5000),
          () => {},
        )
      ).text,
    ).toBe("OK");
    const child = (manager as any).child;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    await expect(
      Promise.race([
        manager.run(
          conversation,
          "second",
          AbortSignal.timeout(1000),
          () => {},
        ),
        Bun.sleep(500).then(() => {
          throw Error("HUNG_AFTER_EXIT");
        }),
      ]),
    ).rejects.toThrow("browser child exited");
    await Promise.all([manager.shutdown(), manager.shutdown()]);
  } finally {
    await manager.shutdown();
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("WB-7: concurrent page closes await the same browser action", async () => {
  const { BrowserManager } = await import("../../src/web-chat/browser");
  const root = mkdtempSync(join(tmpdir(), "webchat-close-"));
  const manager = new BrowserManager({ root, accounts: [] });
  let release!: () => void,
    settled = false;
  (manager as any).pages.set("c", {
    close: () =>
      new Promise<void>((r) => {
        release = r;
      }),
  });
  try {
    const first = manager.close("c"),
      second = manager.close("c").then(() => {
        settled = true;
      });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(settled).toBe(true);
  } finally {
    release?.();
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
