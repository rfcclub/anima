import { seatbeltTest } from "../helpers/seatbelt";
import { expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  startWebChatHost,
  relayCapacityDiagnostics,
} from "../../src/web-chat/host";
import { currentToolBoundary } from "../../src/web-chat/tool-boundary";

test("WB-4: capacity diagnostic relay drops private stderr and bounded malformed lines", () => {
  const stderr = new PassThrough();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    relayCapacityDiagnostics(stderr);
    const valid =
      '{"event":"web_chat_private_registry_capacity","entries":40001,"limit":80000}';
    stderr.write("PRIVATE browser failure\n");
    stderr.write(valid.slice(0, -1) + ',"private":"PRIVATE"}\n');
    stderr.write(valid.replace("40001", "00001") + "\n");
    stderr.write(valid.replace("40001", "99999") + "\n");
    stderr.write("PRIVATE".repeat(10_000) + valid + "\n");
    stderr.write(valid.slice(0, 30));
    stderr.write(valid.slice(30) + "\n");
    expect(warning.mock.calls).toEqual([[valid]]);
  } finally {
    stderr.destroy();
    warning.mockRestore();
  }
});
seatbeltTest("WB-4: host supervises real child with an inherited capability and cleans its socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-host-"));
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({ accounts: [], privateSources: [] }),
    { mode: 0o600 },
  );
  try {
    const host = await startWebChatHost(root);
    try {
      expect(
        await host.client.call(
          { agent: "finn", session: "s" },
          { operation: "list" },
        ),
      ).toEqual([]);
      expect(existsSync(join(root, "bridge.sock"))).toBe(true);
      expect(currentToolBoundary()).toBeDefined();
      for (const path of [
        ".ssh/id_ed25519",
        ".config/gh/hosts.yml",
        ".aws/credentials",
        ".gnupg/private-keys-v1.d/key",
        ".netrc",
        "Library/Keychains/login.keychain-db",
      ]) {
        expect(currentToolBoundary()!.fileAllowed(join(homedir(), path))).toBe(
          false,
        );
      }
      expect(
        (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root }))).some(
          (p) => /key|token|capability/.test(p),
        ),
      ).toBe(false);
    } finally {
      await host.stop();
    }
    expect(existsSync(join(root, "bridge.sock"))).toBe(false);
    expect(currentToolBoundary()).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

seatbeltTest("WB-10: capacity warning reaches the operator through the real private worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-capacity-host-"));
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({ accounts: [], privateSources: [] }),
    { mode: 0o600 },
  );
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const host = await startWebChatHost(root);
    try {
      await host.client.registerPrivateContent(
        { agent: "fixture", session: "capacity" },
        [randomBytes(650_000).toString("hex")],
      );
      for (let i = 0; i < 100 && !warning.mock.calls.length; i++)
        await Bun.sleep(10);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warning.mock.calls[0]![0])).toEqual({
        event: "web_chat_private_registry_capacity",
        entries: 40001,
        limit: 80000,
      });
    } finally {
      await host.stop();
    }
  } finally {
    warning.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

seatbeltTest("WB-7: unexpected host exit stops its child and releases socket/profile ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-parent-exit-"));
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({ accounts: [], privateSources: [] }),
    { mode: 0o600 },
  );
  let childPid: number | undefined;
  try {
    const parent = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/host-parent.ts"),
        root,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    childPid = Number((await new Response(parent.stdout).text()).trim());
    expect(await parent.exited).toBe(0);
    expect(childPid).toBeGreaterThan(0);
    for (let i = 0; i < 100 && existsSync(join(root, "owner.lock")); i++)
      await Bun.sleep(20);
    expect(existsSync(join(root, "owner.lock"))).toBe(false);
    expect(existsSync(join(root, "bridge.sock"))).toBe(false);
  } finally {
    if (childPid)
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
