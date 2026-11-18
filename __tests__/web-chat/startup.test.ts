import { seatbeltTest } from "../helpers/seatbelt";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startWebChatFromEnv } from "../../src/web-chat/host";
import { currentToolBoundary, denyNativeCarrier } from "../../src/web-chat/tool-boundary";
seatbeltTest("WB-1/WB-4: server startup defaults off and activation fails closed; unauthorized private access and native carriers are forbidden", async () => {
  expect(await startWebChatFromEnv({})).toBeUndefined();
  expect(currentToolBoundary()).toBeUndefined();
  const root = mkdtempSync(join(tmpdir(), "webchat-startup-"));
  try {
    await expect(
      startWebChatFromEnv({ ANIMA_WEB_CHAT: "on", ANIMA_WEB_CHAT_ROOT: root }),
    ).rejects.toThrow();
    expect(currentToolBoundary()).toBeUndefined();
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ accounts: [], privateSources: [] }),
      { mode: 0o600 },
    );
    const host = await startWebChatFromEnv({
      ANIMA_WEB_CHAT: "on",
      ANIMA_WEB_CHAT_ROOT: root,
    });
    try {
      expect(
        await host!.client.call(
          { agent: "a", session: "s" },
          { operation: "list" },
        ),
      ).toEqual([]);
      expect(() => denyNativeCarrier()).toThrow("native tool carriers unavailable");
      expect(
        currentToolBoundary()!.fileAllowed(
          join(homedir(), ".anima/secrets/a"),
        ),
      ).toBe(false);
    } finally {
      await host!.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
