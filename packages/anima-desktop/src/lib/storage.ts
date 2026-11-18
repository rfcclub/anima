/**
 * Settings persistence. In the Tauri shell, settings live in the app-data
 * directory (`settings.json`); in a plain browser (vite dev without Tauri)
 * we fall back to localStorage so the UI stays usable.
 */

import { parseSettings, serializeSettings, type Settings } from "./settings";

const FILE = "settings.json";
const LS_KEY = "anima-desktop-settings";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadSettings(): Promise<Settings> {
  if (inTauri()) {
    try {
      const { readTextFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      const raw = await readTextFile(FILE, { baseDir: BaseDirectory.AppData });
      return parseSettings(raw);
    } catch {
      return parseSettings("");
    }
  }
  try {
    return parseSettings(localStorage.getItem(LS_KEY) ?? "");
  } catch {
    return parseSettings("");
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const raw = serializeSettings(settings);
  if (inTauri()) {
    const { writeTextFile, mkdir, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    try {
      await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
    } catch {
      // already exists
    }
    await writeTextFile(FILE, raw, { baseDir: BaseDirectory.AppData });
    return;
  }
  try {
    localStorage.setItem(LS_KEY, raw);
  } catch {
    // storage unavailable; settings stay in memory
  }
}
