import { expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import type { Fs } from "./types.ts";

class ConfigFs implements Fs {
  constructor(private value?: string) {}
  read(): string | undefined { return this.value; }
  write(): void {}
  rename(): void {}
  chmod(): void {}
  stat(): { size: number } | undefined { return undefined; }
  mkdir(): void {}
  readdir(): string[] { return []; }
  size(): number { return 0; }
}

test("config: defaults provide the watchdog settings", () => {
  const config = loadConfig(new ConfigFs(), "config.json");
  expect(config.intervalMs).toBe(120000);
  expect(config.runCapMs).toBe(60000);
  expect(config.owned).toEqual([]);
  expect(config.ports).toEqual({});
  expect(config.thresholds).toEqual({ presenceMinutes: 5, claimMinutes: 30, crashRuns: 5, crashWindowMinutes: 10, restartCap: 3, restartWindowMinutes: 60 });
  expect(config.logMaxBytes).toBe(1048576);
});

test("config: overrides replace defaults", () => {
  const config = loadConfig(new ConfigFs(JSON.stringify({ intervalMs: 5000, owned: ["custom.label"] })), "config.json");
  expect(config.intervalMs).toBe(5000);
  expect(config.owned).toEqual(["custom.label"]);
  expect(config.runCapMs).toBe(60000);
});

test("config: invalid values are rejected with the field name", () => {
  expect(() => loadConfig(new ConfigFs('{"intervalMs":0}'), "config.json")).toThrow(/intervalMs/);
});

test("crashRuns and restartCap are whole numbers", () => {
  for (const name of ["crashRuns", "restartCap"]) {
    expect(() => loadConfig(new ConfigFs(JSON.stringify({ thresholds: { [name]: 2.5 } })), "config.json")).toThrow(new RegExp(name));
  }
});

test("logMaxBytes below 256 is rejected", () => {
  expect(() => loadConfig(new ConfigFs(JSON.stringify({ logMaxBytes: 1 })), "config.json")).toThrow(/logMaxBytes/);
});
