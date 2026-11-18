import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { SessionStore } from "../../memory/session-store";

// UI_DIR must resolve correctly both when run from source (src/ui/services/,
// where import.meta.dir points at the source tree) and when bundled into a
// single dist/server.js (where import.meta.dir points at ~/.anima/dist/).
// In source: ../ui from services/ would double to src/ui/ui, so we use ../../ui
// to reach src/ui. When bundled, that path won't exist, so we fall back to the
// production install at ~/.anima/ui (one level up from dist/).
function resolveUiDir(): string {
  const sourcePath = join(import.meta.dir, "..", "..", "ui");
  if (existsSync(join(sourcePath, "index.html"))) {
    return sourcePath;
  }
  // Bundled/production: ~/.anima/ui (sibling of dist/)
  const prodPath = join(import.meta.dir, "..", "ui");
  if (existsSync(join(prodPath, "index.html"))) {
    return prodPath;
  }
  // Last resort: env or default install location
  return Bun.env.ANIMA_UI_DIR ?? join(process.env.HOME ?? "~", ".anima", "ui");
}

const UI_DIR = resolveUiDir();

/**
 * Resolve a path inside a feature directory. Works for both source runs
 * (src/ui/features/<name>/) and bundled production (~/.anima/ui/features/<name>/)
 * by anchoring on UI_DIR rather than import.meta.dir (which points at dist/
 * when bundled and would miss the feature files).
 */
export function featureDir(name: string, ...segments: string[]): string {
  return join(UI_DIR, "features", name, ...segments);
}

export function uiSessionDbPath(): string {
  return join(defaultStateDir(), "sessions.db");
}

export function getSessionStore(): SessionStore {
  return new SessionStore(uiSessionDbPath());
}

export function defaultRoomsDir(): string {
  return Bun.env.ANIMA_ROOMS_DIR ?? join(process.env.HOME ?? "~", ".anima", "rooms");
}

export function defaultStateDir(): string {
  return Bun.env.ANIMA_UI_STATE_DIR ?? join(process.env.HOME ?? "~", ".anima");
}

export function stateFilePath(stateDir: string): string {
  return join(stateDir, "state.yaml");
}

const DEFAULT_MODE = "plan";
const VALID_MODES = new Set<string>(["plan", "edit", "auto"]);

export function readMode(stateDir: string): string {
  const path = stateFilePath(stateDir);
  if (!existsSync(path)) return DEFAULT_MODE;
  try {
    const doc = yaml.load(readFileSync(path, "utf-8"));
    if (typeof doc === "object" && doc !== null) {
      const mode = (doc as Record<string, unknown>).mode;
      if (typeof mode === "string") return mode;
    }
  } catch {
    // ignore corrupt state file
  }
  return DEFAULT_MODE;
}

export function writeMode(stateDir: string, mode: string): void {
  const path = stateFilePath(stateDir);
  const dir = join(path, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, yaml.dump({ mode }), "utf-8");
}

export { UI_DIR, DEFAULT_MODE, VALID_MODES };
