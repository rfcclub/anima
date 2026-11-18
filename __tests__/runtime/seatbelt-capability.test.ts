import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasSeatbeltBinary } from "../helpers/seatbelt";
test("CI-1 Seatbelt integrations require Darwin and its binary; other platforms keep refusal coverage", () => {
  expect(hasSeatbeltBinary("darwin", true)).toBe(true);
  expect(hasSeatbeltBinary("darwin", false)).toBe(false);
  expect(hasSeatbeltBinary("linux", true)).toBe(false);
  expect(hasSeatbeltBinary("linux", false)).toBe(false);
  expect(hasSeatbeltBinary("win32", true)).toBe(false);
});
test("CI-1 unsupported web-chat host refuses activation without spawning or installing a boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "anima-unsupported-seatbelt-"));
  try {
    writeFileSync(join(root, "config.json"), JSON.stringify({ accounts: [], privateSources: [] }), { mode: 0o600 });
    const host = resolve(import.meta.dir, "../../src/web-chat/host.ts");
    const boundary = resolve(import.meta.dir, "../../src/web-chat/tool-boundary.ts");
    const code = `
      Object.defineProperty(process, "platform", {value:"linux"});
      const {startWebChatFromEnv}=await import(${JSON.stringify(host)});
      const {currentToolBoundary}=await import(${JSON.stringify(boundary)});
      let spawns=0;
      Bun.spawn=()=>{ spawns++; throw Error("unexpected worker spawn"); };
      let reason;
      try { await startWebChatFromEnv({ANIMA_WEB_CHAT:"on",ANIMA_WEB_CHAT_ROOT:process.argv[1]}); }
      catch(e) { reason=e.message; }
      console.log(JSON.stringify({reason,spawns,active:!!currentToolBoundary(),off:await startWebChatFromEnv({})===undefined}));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", code, root], {
      env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, ANIMA_MESH_PRESENCE: "off", ANIMA_ACTIVATION_MODE: "off" },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      reason: "web chat requires enforced OS tool isolation", spawns: 0, active: false, off: true,
    });
    expect(existsSync(join(root, "bridge.sock"))).toBe(false);
    expect(existsSync(join(root, "owner.lock"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
