import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";

test("WB-11 runtime spike: Bun persistent profile survives close/relaunch without a real account", async () => {
  const profile = mkdtempSync(join(tmpdir(), "anima-webchat-runtime-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("<!doctype html><title>Local profile fixture</title>"),
  });
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      timeout: 15000,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(server.url.href, { timeout: 5000 });
    await page.evaluate(() =>
      localStorage.setItem("fixture-login", "test-only-not-a-credential"),
    );
    await context.close();
    context = undefined;
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      timeout: 15000,
    });
    const again = context.pages()[0] ?? (await context.newPage());
    await again.goto(server.url.href, { timeout: 5000 });
    expect(
      await again.evaluate(() => localStorage.getItem("fixture-login")),
    ).toBe("test-only-not-a-credential");
    expect(context.browser()?.isConnected()).toBe(true);
  } finally {
    await context?.close();
    await server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}, 40000);
