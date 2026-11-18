import { Socket } from "node:net";
import { readFileSync } from "node:fs";
import { acquireBridgeLock, readConfig } from "./config";
import { startIpc } from "./ipc";
import { WebChatService } from "./service";
import { BrowserProcess as BrowserManager } from "./browser-process";
process.umask(0o077);
const root = process.argv[2]!;
const key = readFileSync(3);
if (key.length !== 32) throw Error("invalid inherited capability");
const release = acquireBridgeLock(root);
try {
  const config = readConfig(root),
    browser = new BrowserManager({ root, accounts: config.accounts });
  const service = new WebChatService({
    root,
    accounts: config.accounts,
    limits: config.limits,
    browser,
  });
  for (const path of config.privateSources) {
    const bytes = readFileSync(path);
    if (bytes.length > 1_000_000) throw Error("private source too large");
    service.registerPrivateContent(bytes.toString("utf8"));
  }
  const ipc = await startIpc({ root, key, service, release });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await ipc.close();
    await browser.shutdown();
    key.fill(0);
    process.exit(0);
  };
  const parent = new Socket({ fd: 4, readable: true, writable: false });
  parent.on("end", () => void stop());
  parent.on("error", () => void stop());
  parent.resume();
  const parentPid = process.ppid;
  const parentCheck = setInterval(() => {
    try {
      process.kill(parentPid, 0);
      if (process.ppid !== parentPid) void stop();
    } catch {
      void stop();
    }
  }, 250);
  parentCheck.unref();
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  process.stdout.write("ready\n");
} catch {
  release();
  process.stderr.write("web chat worker startup failed\n");
  process.exit(1);
}
