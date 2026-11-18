import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { privateDirectory, privateFile } from "./store";
import type { ChatAccount, ChatLimits } from "./types";
export interface BridgeConfig {
  accounts: ChatAccount[];
  privateSources: string[];
  limits?: Partial<ChatLimits>;
}
export function readConfig(root: string): BridgeConfig {
  privateDirectory(root);
  const path = join(root, "config.json");
  privateFile(path);
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (
    !config ||
    !Array.isArray(config.accounts) ||
    !Array.isArray(config.privateSources) ||
    config.privateSources.some((x: unknown) => typeof x !== "string")
  )
    throw Error("invalid bridge config");
  return config;
}
/** Shared by online worker and offline maintenance. A live owner is never unlinked. */
export function acquireBridgeLock(root: string): () => void {
  privateDirectory(root);
  const path = join(root, "owner.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8") === String(process.pid))
            unlinkSync(path);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      privateFile(path);
      const pid = Number(readFileSync(path, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw Error("unsafe ownership lock");
      try {
        process.kill(pid, 0);
        throw Error("bridge/profile already owned");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      unlinkSync(path);
    }
  }
  throw Error("bridge/profile ownership race");
}
