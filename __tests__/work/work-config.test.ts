/**
 * castle-work-loop: the `work` block of mesh-jobs.json. Off unless explicitly enabled, and a
 * bad block is an error that names the field, never a silent default.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMeshJobsConfig } from "../../src/mesh-jobs/config";

let dir: string;
let path: string;
const write = (value: unknown) => { writeFileSync(path, JSON.stringify(value)); chmodSync(path, 0o600); };
const errorOf = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof Error ? e.message : String(e); } throw new Error("expected a throw"); };

const workBlock = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  author: "finn",
  authorActor: "finn-gotako[bot]",
  authorMeshId: "finn-anima-1@mac",
  enqueuer: "bruno",
  base: "master",
  reviewers: [
    { agent: "cleo", meshId: "cleo-anima-1@mac", login: "cleo-gotako[bot]" },
    { agent: "pia", meshId: "pia-anima-1@mac", login: "pia-gotako[bot]" },
  ],
  ...over,
});
const base = (work?: unknown) => ({ gatewayUrl: "http://127.0.0.1:1526", workers: [{ agent: "finn" }], ...(work === undefined ? {} : { work }) });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "work-config-")); path = join(dir, "mesh-jobs.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("work block", () => {
  test("absent or disabled means work jobs are off", () => {
    write(base());
    expect(loadMeshJobsConfig(path)!.work).toBeUndefined();
    write(base(workBlock({ enabled: false })));
    expect(loadMeshJobsConfig(path)!.work).toBeUndefined();
  });

  test("a complete block is read with its defaults filled in", () => {
    write(base(workBlock()));
    const w = loadMeshJobsConfig(path)!.work!;
    expect(w.author).toBe("finn");
    expect(w.reviewers.map((r) => r.agent)).toEqual(["cleo", "pia"]);
    expect(w.releaseBackoffMs).toBe(30_000);
    expect(w.reconcileIntervalMs).toBe(60_000);
    expect(w.cloneUrl).toBe("https://github.com/{repo}.git");
    expect(w.perToolCallMs).toBe(120_000);
  });

  test("a work author may name a provider and model; one without the other is refused", () => {
    write(base(workBlock({ provider: "hypercharm", model: "deepseek-v4.1-flash" })));
    const w = loadMeshJobsConfig(path)!.work!;
    expect(w.provider).toBe("hypercharm");
    expect(w.model).toBe("deepseek-v4.1-flash");

    write(base(workBlock({ provider: "hypercharm" })));
    expect(errorOf(() => loadMeshJobsConfig(path))).toContain("work.model");
    write(base(workBlock({ model: "deepseek-v4.1-flash" })));
    expect(errorOf(() => loadMeshJobsConfig(path))).toContain("work.provider");
  });

  test("a local source is accepted as an absolute path template, so a work can clone from a checkout on this machine", () => {
    write(base(workBlock({ cloneUrl: "/Users/user/.anima/work-sources/{repo}" })));
    expect(loadMeshJobsConfig(path)!.work!.cloneUrl).toBe("/Users/user/.anima/work-sources/{repo}");
  });

  test("the author must be one of the workers, so the claim can happen", () => {
    write(base(workBlock({ author: "someone" })));
    expect(errorOf(() => loadMeshJobsConfig(path))).toContain("work.author");
  });

  test.each([
    ["authorActor", ""],
    ["authorMeshId", "not a mesh id"],
    ["enqueuer", "Bad Name"],
    ["base", ""],
    ["reviewers", []],
    ["reviewers", [{ agent: "cleo", meshId: "bad id", login: "x" }]],
    ["reviewers", [{ agent: "finn", meshId: "finn-anima-1@mac", login: "finn-gotako[bot]" }]],
    ["releaseBackoffMs", 10],
    ["reconcileIntervalMs", 1000],
    ["cloneUrl", "http://insecure/{repo}.git"],
    ["cloneUrl", "https://github.com/fixed.git"],
    ["cloneUrl", "work-sources/{repo}"],
    ["cloneUrl", "/srv/work-sources/fixed"],
    ["cloneUrl", "/srv/../etc/{repo}"],
    ["cloneUrl", "file:///srv/{repo}"],
    ["perToolCallMs", 0],
  ])("%s = %p is refused, naming the field", (field, value) => {
    write(base(workBlock({ [field]: value })));
    expect(errorOf(() => loadMeshJobsConfig(path))).toContain(`work.${field}`);
  });

  test("an unknown field is refused instead of ignored", () => {
    write(base(workBlock({ shell: "unrestricted" })));
    expect(errorOf(() => loadMeshJobsConfig(path))).toContain("work.shell");
  });
});

describe("work.hostPublish", () => {
  test("is off unless the operator sets it to true", () => {
    write(base(workBlock()));
    expect((loadMeshJobsConfig(path)!.work as unknown as { hostPublish?: boolean }).hostPublish).toBe(false);
    write(base(workBlock({ hostPublish: false })));
    expect((loadMeshJobsConfig(path)!.work as unknown as { hostPublish?: boolean }).hostPublish).toBe(false);
    write(base(workBlock({ hostPublish: true })));
    expect((loadMeshJobsConfig(path)!.work as unknown as { hostPublish?: boolean }).hostPublish).toBe(true);
  });

  test("anything but a boolean is an error that names the field", () => {
    for (const value of ["true", 1, null, {}, []]) {
      write(base(workBlock({ hostPublish: value })));
      expect(errorOf(() => loadMeshJobsConfig(path))).toContain("work.hostPublish");
    }
  });
});
