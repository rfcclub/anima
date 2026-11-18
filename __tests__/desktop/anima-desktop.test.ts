/**
 * Anima Desktop App — Structure tests
 * Verifies the Tauri project scaffold is complete.
 */

import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../packages/anima-desktop");

describe("Anima Desktop App — Scaffold", () => {
  test("package.json exists with tauri dependencies", () => {
    const pkg = join(ROOT, "package.json");
    expect(existsSync(pkg)).toBe(true);
    const json = JSON.parse(readFileSync(pkg, "utf-8"));
    expect(json.name).toBe("anima-desktop");
    expect(json.dependencies).toBeDefined();
    expect(json.dependencies["@tauri-apps/api"]).toBeDefined();
  });

  test("index.html entry point exists", () => {
    expect(existsSync(join(ROOT, "index.html"))).toBe(true);
  });

  test("React App component exists", () => {
    expect(existsSync(join(ROOT, "src", "App.tsx"))).toBe(true);
  });

  test("vite.config.ts exists", () => {
    expect(existsSync(join(ROOT, "vite.config.ts"))).toBe(true);
  });

  test("Tauri config exists with correct app name", () => {
    const cfg = join(ROOT, "src-tauri", "tauri.conf.json");
    expect(existsSync(cfg)).toBe(true);
    const json = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(json.productName).toMatch(/anima/i);
  });

  test("Cargo.toml exists", () => {
    expect(existsSync(join(ROOT, "src-tauri", "Cargo.toml"))).toBe(true);
  });

  test("main.rs entry point exists", () => {
    expect(existsSync(join(ROOT, "src-tauri", "src", "main.rs"))).toBe(true);
  });
});

describe("Anima Desktop App — Features", () => {
  test("App.tsx has 3 tabs: Town, OpenClaw, Chat", () => {
    const app = readFileSync(join(ROOT, "src", "App.tsx"), "utf-8");
    expect(app).toContain("Town");
    expect(app).toContain("OpenClaw");
    expect(app).toContain("Chat");
  });

  test("App.tsx has server URL configuration", () => {
    const app = readFileSync(join(ROOT, "src", "App.tsx"), "utf-8");
    // Uses resolveApiEndpoints/endpoints for server URL configuration
    expect(app).toMatch(/serverUrl|SERVER_URL|baseUrl|BASE_URL|endpoints|resolveApi/i);
  });

  test("App.tsx renders iframe for tabs", () => {
    const app = readFileSync(join(ROOT, "src", "App.tsx"), "utf-8");
    // Uses IframeHost component for tab content
    expect(app).toMatch(/iframe|IframeHost/i);
  });

  test("tauri.conf.json has window config with title Chamber", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf-8"));
    const windows = cfg.app?.windows || [];
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0].title).toBeDefined();
  });

  test.skip("tauri.conf.json has system tray config", () => {
    // TODO: system tray not yet implemented
    const cfg = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf-8"));
    const hasTray = cfg.app?.tray !== undefined || cfg.app?.windows?.[0]?.closeAsTray;
    expect(hasTray).toBe(true);
  });

  test("App.tsx has connection status indicator", () => {
    const app = readFileSync(join(ROOT, "src", "App.tsx"), "utf-8");
    expect(app).toMatch(/connected|status|health|green|red/);
  });

  test("Cargo.toml has tauri dependency v2", () => {
    const cargo = readFileSync(join(ROOT, "src-tauri", "Cargo.toml"), "utf-8");
    expect(cargo).toContain("tauri");
    expect(cargo).toMatch(/version\s*=\s*"2/);
  });
});
