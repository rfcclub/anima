import { expect, test } from "bun:test";
import { loadState, saveState } from "./state.ts";
import { reduceIncidents } from "./incidents.ts";
import type { Fs, State } from "./types.ts";

class MemoryFs implements Fs {
  files = new Map<string, string>();
  modes = new Map<string, number>();
  renames: Array<[string, string]> = [];
  read(path: string): string | undefined { return this.files.get(path); }
  write(path: string, data: string): void { this.files.set(path, data); }
  rename(from: string, to: string): void {
    const value = this.files.get(from);
    if (value === undefined) throw new Error("missing source");
    this.files.set(to, value); this.files.delete(from); this.renames.push([from, to]);
  }
  chmod(path: string, mode: number): void { this.modes.set(path, mode); }
  stat(path: string): { size: number } | undefined {
    const value = this.files.get(path); return value === undefined ? undefined : { size: value.length };
  }
  mkdir(): void {}
  readdir(): string[] { return []; }
  size(path: string): number { return this.files.get(path)?.length ?? 0; }
}
const empty = (): State => ({ version: 1, failCount: {}, incidents: {}, restarts: {}, runSamples: {}, presenceSince: {}, queue: [] });

test("SC-014: saved state survives a fresh load and the next failure opens an incident", () => {
  const fs = new MemoryFs();
  const state = empty(); state.failCount["mesh.join|"] = 1;
  saveState(fs, "state.json", state);
  const reloaded = loadState(fs, "state.json");
  expect(reloaded.failCount["mesh.join|"]).toBe(1);
  const nextRun = reduceIncidents(reloaded, [{ id: "mesh.join", status: "fail" }], 200);
  expect(nextRun.state.incidents["mesh.join|"]).toBeDefined();
  expect(fs.files.has("state.json.tmp")).toBe(false);
  expect(fs.modes.get("state.json")).toBe(0o600);
});

test("SC-014: a corrupt state file is moved aside and returns empty state", () => {
  const fs = new MemoryFs(); fs.write("state.json", "not json");
  expect(loadState(fs, "state.json")).toEqual(empty());
  expect(fs.files.has("state.json")).toBe(false);
  expect(fs.renames).toHaveLength(1);
  expect(fs.renames[0]?.[0]).toBe("state.json");
});

test("SC-014: a missing state file returns empty state", () => {
  expect(loadState(new MemoryFs(), "missing.json")).toEqual(empty());
});

test("SC-014: state save does not expose a partial destination before rename", () => {
  const fs = new MemoryFs();
  const rename = fs.rename.bind(fs);
  fs.rename = (from, to) => {
    expect(fs.files.has(to)).toBe(false);
    expect(fs.files.has(`${to}.tmp`)).toBe(true);
    rename(from, to);
  };
  saveState(fs, "state.json", empty());
  expect(fs.files.has("state.json")).toBe(true);
});

test("SC-014: non-finite numbers in a persisted state are quarantined", () => {
  const base = '{"version":1,"failCount":{},"incidents":{},"restarts":{},"runSamples":{},"presenceSince":{},"queue":[]}';
  const cases: Array<[string, string]> = [
    ['"incidents":{}', '"incidents":{"k":{"openedAt":1e999,"reason":"r","alertSent":false,"capAlertSent":false}}'],
    ['"runSamples":{}', '"runSamples":{"k":[{"t":1e999,"runs":1}]}'],
    ['"runSamples":{}', '"runSamples":{"k":[{"t":1,"runs":1e999}]}'],
  ];
  for (const [from, to] of cases) {
    const fs = new MemoryFs();
    const text = base.replace(from, to);
    expect(text).not.toBe(base);
    fs.write("state.json", text);
    expect(loadState(fs, "state.json")).toEqual(empty());
    expect(fs.renames.length).toBe(1);
  }
  // control: the same shapes with finite numbers are accepted
  const ok = new MemoryFs();
  ok.write("state.json", base.replace('"runSamples":{}', '"runSamples":{"k":[{"t":1,"runs":1}]}'));
  expect(loadState(ok, "state.json").runSamples.k).toEqual([{ t: 1, runs: 1 }]);
});

test("SC-014: a fractional or negative failure count is quarantined, a whole one is kept", () => {
  const base = '{"version":1,"failCount":{},"incidents":{},"restarts":{},"runSamples":{},"presenceSince":{},"queue":[]}';
  for (const bad of ["1.5", "-1", "0.1"]) {
    const fs = new MemoryFs();
    fs.write("state.json", base.replace('"failCount":{}', `"failCount":{"mesh.join|":${bad}}`));
    expect(loadState(fs, "state.json")).toEqual(empty());
    expect(fs.renames.length).toBe(1);
  }
  const ok = new MemoryFs();
  ok.write("state.json", base.replace('"failCount":{}', '"failCount":{"mesh.join|":1}'));
  expect(loadState(ok, "state.json").failCount["mesh.join|"]).toBe(1);
});
