import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghReader } from "../../src/mesh-jobs/github";
import { startMeshJobConsumer } from "../../src/mesh-jobs/start";

describe("ghReader", () => {
  test("reads the PR, diff, issue and reviews with gh and maps the fields", async () => {
    const calls: string[][] = [];
    const outputs: Record<string, string> = {
      "pr view": JSON.stringify({ headRefOid: "abc1234def", state: "OPEN", mergedAt: null, title: "Queue", body: "closes #76", author: { login: "example-author" } }),
      "pr diff": "diff --git a/x b/x\n",
      "issue view": JSON.stringify({ title: "Intent", body: "BODY" }),
      api: [
        JSON.stringify({ commitId: "abc1234def", body: "Reviewer: jade", submittedAt: "2026-10-14T01:02:00Z", url: "https://github.com/r/p/pull/80#pullrequestreview-1", authorType: "Bot" }),
        JSON.stringify({ commitId: "abc1234def", body: "", submittedAt: null, url: "https://github.com/r/p/pull/80#pullrequestreview-2" }),
        "",
      ].join("\n"),
    };
    const reader = ghReader(async (args) => {
      calls.push(args);
      return outputs[args[0] === "api" ? "api" : `${args[0]} ${args[1]}`]!;
    });

    expect(await reader.pullRequest("rfcclub/anima", 80)).toEqual({ headSha: "abc1234def", state: "open", merged: false, title: "Queue", body: "closes #76", author: "example-author" });
    expect(await reader.diff("rfcclub/anima", 80)).toBe("diff --git a/x b/x\n");
    expect(await reader.issue("rfcclub/anima", 76)).toEqual({ title: "Intent", body: "BODY" });
    expect(await reader.reviews("rfcclub/anima", 80)).toEqual([
      { commitId: "abc1234def", body: "Reviewer: jade", submittedAt: "2026-10-14T01:02:00Z", url: "https://github.com/r/p/pull/80#pullrequestreview-1", authorType: "Bot" },
    ]);

    expect(calls[0]).toEqual(["pr", "view", "80", "--repo", "rfcclub/anima", "--json", "headRefOid,state,mergedAt,title,body,author"]);
    expect(calls[1]).toEqual(["pr", "diff", "80", "--repo", "rfcclub/anima"]);
    expect(calls[2]).toEqual(["issue", "view", "76", "--repo", "rfcclub/anima", "--json", "title,body"]);
    expect(calls[3]!.slice(0, 3)).toEqual(["api", "repos/rfcclub/anima/pulls/80/reviews", "--paginate"]);
    expect(calls[3]![4]).toContain("authorType: .user.type");
  });

  test.each([
    { state: "CLOSED", mergedAt: null, expectedState: "closed", merged: false },
    { state: "MERGED", mergedAt: "2026-11-07T23:00:00Z", expectedState: "closed", merged: true },
  ])("maps PR lifecycle $state for the revision preflight", async ({ state, mergedAt, expectedState, merged }) => {
    const reader = ghReader(async () => JSON.stringify({
      headRefOid: "abc1234def", state, mergedAt, title: "Queue", body: "", author: { login: "author" },
    }));
    expect(await reader.pullRequest("rfcclub/anima", 80)).toMatchObject({ state: expectedState, merged });
  });

  test("refuses an incomplete PR lifecycle response", async () => {
    const reader = ghReader(async () => JSON.stringify({
      headRefOid: "abc1234def", title: "Queue", body: "", author: { login: "author" },
    }));
    await expect(reader.pullRequest("rfcclub/anima", 80)).rejects.toThrow(/state|merged/i);
  });
});

describe("startMeshJobConsumer", () => {
  test("absent config → null, and no timer", () => {
    const lines: string[] = [];
    const handle = startMeshJobConsumer({ configPath: "/nonexistent/mesh-jobs.json", presence: null, log: (_l, m) => lines.push(m) });
    expect(handle).toBeNull();
    expect(lines).toEqual([]);
  });

  test("invalid config → null, logged without throwing", () => {
    const lines: string[] = [];
    const handle = startMeshJobConsumer({ configPath: import.meta.path, presence: null, log: (level, m) => lines.push(`${level} ${m}`) });
    expect(handle).toBeNull();
    expect(lines.some((line) => line.startsWith("error mesh job consumer"))).toBe(true);
  });

  function validConfig(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "mesh-jobs-start-"));
    const path = join(dir, "mesh-jobs.json");
    writeFileSync(path, JSON.stringify({ gatewayUrl: "http://127.0.0.1:1526", workers: [{ agent: "finn" }] }));
    chmodSync(path, 0o600);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  // AJ-16: the worker has no credential of its own, so without mesh presence it cannot work.
  test("valid config but no mesh presence → null, logged", () => {
    const { path, cleanup } = validConfig();
    const lines: string[] = [];
    const handle = startMeshJobConsumer({ configPath: path, presence: null, log: (level, m) => lines.push(`${level} ${m}`) });
    cleanup();
    expect(handle).toBeNull();
    expect(lines).toEqual(["error mesh job consumer needs mesh presence (ANIMA_MESH_PRESENCE=on) — off"]);
  });

  test("valid config with presence → started, logging each worker by mesh ID", () => {
    const { path, cleanup } = validConfig();
    const logged: Array<Record<string, unknown> | undefined> = [];
    const presence = { meshId: (agent: string) => `${agent}-anima-1a2b3c4d@m`, inbox: () => null };
    const handle = startMeshJobConsumer({ configPath: path, presence, log: (_level, _m, fields) => logged.push(fields) });
    cleanup();
    expect(handle).not.toBeNull();
    handle!();
    expect(logged).toEqual([{ workers: ["finn-anima-1a2b3c4d@m"], intervalMs: 60_000 }]);
  });
});
