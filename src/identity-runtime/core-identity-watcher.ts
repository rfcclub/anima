import { watch, type FSWatcher } from "node:fs";
import type { CoreIdentityPaths } from "./core-identity-compiler";

export interface CoreIdentityWatcherOptions {
  debounceMs?: number;
  compile: (paths: CoreIdentityPaths) => Promise<unknown>;
}

export interface CoreIdentityWatcherHandle {
  close(): void;
}

export function startCoreIdentityWatcher(
  paths: CoreIdentityPaths,
  options: CoreIdentityWatcherOptions,
): CoreIdentityWatcherHandle {
  const debounceMs = options.debounceMs ?? 1000;
  const watchedFiles = [
    `${paths.agoraRoot}/SOUL.md`,
    `${paths.agoraRoot}/codex-one/KERNEL.md`,
    `${paths.agoraRoot}/codex-one/JUDGMENTS.md`,
    `${paths.agoraRoot}/codex-one/OWNER.md`,
    `${paths.agoraRoot}/codex-one/SCARS.md`,
  ];

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void options.compile(paths);
    }, debounceMs);
  };

  const watchers: FSWatcher[] = watchedFiles.map((file) => watch(file, () => schedule()));

  return {
    close(): void {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
