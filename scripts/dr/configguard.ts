import { createHash } from "node:crypto";
import type { Fs } from "./types.ts";

type GuardFs = Fs & { mtimeMs(path: string): number | undefined };

export interface GuardDeps {
  fs: GuardFs;
  liveFile: string;
  lastGoodDir: string;
  signingPublicKey: () => string | null;
  now: () => number;
}

export type GuardPlan =
  | { kind: "none"; reason: string }
  | { kind: "remember"; copy: string; hash: string }
  | { kind: "touch"; copy: string }
  | { kind: "restore"; from: string; backup: string; mode: 0o600; restart: "colony-meshd" }
  | { kind: "refuse"; reason: string };

export function validateRuntime(text: string, publicKey: string | null): { ok: true } | { ok: false; reason: string } {
  if (publicKey === null) return { ok: false, reason: "signing key unknown" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "runtime must be an object" };
  }

  const meshService = (parsed as Record<string, unknown>).meshService;
  if (typeof meshService !== "object" || meshService === null || Array.isArray(meshService)) {
    return { ok: false, reason: "meshService must be an object" };
  }
  const issuerPublicKey = (meshService as Record<string, unknown>).issuerPublicKey;
  if (typeof issuerPublicKey !== "string") {
    return { ok: false, reason: "meshService.issuerPublicKey must be a string" };
  }
  if (issuerPublicKey !== publicKey) {
    return { ok: false, reason: "meshService.issuerPublicKey does not match signing key" };
  }
  return { ok: true };
}

const digest12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);
const joinPath = (dir: string, name: string): string => `${dir.replace(/\/+$/, "")}/${name}`;

export function planGuard(deps: GuardDeps, joinStatus: number | null): GuardPlan {
  const liveText = deps.fs.read(deps.liveFile);
  if (
    joinStatus !== null && joinStatus !== 401 && liveText !== undefined &&
    validateRuntime(liveText, deps.signingPublicKey()).ok
  ) {
    const hash = digest12(liveText);
    const name = `runtime-${hash}.json`;
    const copy = joinPath(deps.lastGoodDir, name);
    if (deps.fs.readdir(deps.lastGoodDir).includes(name)) {
      return { kind: "touch", copy };
    }
    return { kind: "remember", copy, hash };
  }

  if (joinStatus === 404) {
    if (liveText !== undefined && !isMissingMeshService(liveText)) {
      return { kind: "none", reason: "live runtime does not establish missing meshService" };
    }

    const publicKey = deps.signingPublicKey();
    const candidates = deps.fs.readdir(deps.lastGoodDir)
      .filter((name) => /^runtime-[a-f0-9]{12}\.json$/.test(name))
      .map((name) => {
        const path = joinPath(deps.lastGoodDir, name);
        const mtime = deps.fs.mtimeMs(path);
        const text = deps.fs.read(path);
        return mtime !== undefined && Number.isFinite(mtime) && text !== undefined &&
          validateRuntime(text, publicKey).ok
          ? { name, path, mtime }
          : undefined;
      })
      .filter((candidate): candidate is { name: string; path: string; mtime: number } => candidate !== undefined)
      .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

    const newest = candidates[0];
    if (!newest) return { kind: "refuse", reason: "no valid last-good copy" };
    return {
      kind: "restore",
      from: newest.path,
      backup: `${deps.liveFile}.bak-${deps.now()}`,
      mode: 0o600,
      restart: "colony-meshd",
    };
  }

  if (joinStatus === null) {
    return { kind: "none", reason: liveText === undefined ? "live runtime unreadable" : "join status unknown" };
  }
  return { kind: "none", reason: "join status is not 404" };
}

function isMissingMeshService(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
      !Object.prototype.hasOwnProperty.call(parsed, "meshService");
  } catch {
    return false;
  }
}
