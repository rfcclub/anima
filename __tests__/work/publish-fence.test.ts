/**
 * castle-work-loop: a session that lost its lease must not write to GitHub,
 * even when the loss happens while the App token is being minted. The real publisher and the real GitHub tool,
 * with a scripted HTTP layer that can hold the token response; nothing leaves the process.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createPublisher } from "../../src/work/publish";
import { _resetGithubTokenCache, type GithubDeps } from "../../src/tools/github-app";
import type { WorkRecord } from "../../src/work/store";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const work = { workId: "wabc1234ef0", repo: "rfcclub/anima", issue: 7, author: "finn", branch: "work/7-wabc1234ef0", root: "/w/rfcclub/anima/wabc1234ef0" } as WorkRecord;

let requests: Array<{ method: string; url: string }>;
let gitRuns: string[][];
let releaseToken: () => void;
let tokenHeld: Promise<void>;
let hold: boolean;

function githubDeps(): Partial<GithubDeps> {
  return {
    fetch: (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 111 }), { status: 200 });
      if (url.endsWith("/access_tokens")) {
        if (hold) await tokenHeld;
        return new Response(JSON.stringify({ token: "ghs_TOKEN", expires_at: new Date(1_800_003_600_000).toISOString() }), { status: 201 });
      }
      return new Response(JSON.stringify({ number: 12, html_url: "https://github.com/rfcclub/anima/pull/12" }), { status: 201 });
    }) as unknown as typeof fetch,
    readKeyPem: () => PEM,
    runGit: async (args) => { gitRuns.push(args); return { code: 0, out: "ok" }; },
    now: () => 1_800_000_000_000,
    appendLog: () => {},
  };
}

beforeEach(() => {
  _resetGithubTokenCache();
  requests = [];
  gitRuns = [];
  hold = false;
  tokenHeld = new Promise<void>((resolve) => { releaseToken = resolve; });
});

function rig() {
  return createPublisher({
    base: "master",
    githubDeps: githubDeps(),
    stage: () => ({ dir: "/w/rfcclub/anima/wabc1234ef0.push.git", sha: "c".repeat(40) }),
    record: () => {},
  });
}

const writes = () => requests.filter((r) => r.method === "POST" && !r.url.endsWith("/access_tokens"));
const OPEN_PR = { action: "open_pr", title: "Add the thing", body: "What and why.\n\nCloses #7" };

describe("a session that lost its lease while the token was being minted", () => {
  test("open_pr does not POST the pull request", async () => {
    hold = true;
    let live = true;
    const out = rig()(work, OPEN_PR, () => { if (!live) throw new Error("lease lost"); });
    await Bun.sleep(20);
    expect(requests.some((r) => r.url.endsWith("/access_tokens"))).toBe(true); // the mint is in flight
    live = false;
    releaseToken();
    expect(await out).toMatch(/^Error:/);
    expect(writes()).toEqual([]);
  });

  test("push does not run git push", async () => {
    hold = true;
    let live = true;
    const out = rig()(work, { action: "push" }, () => { if (!live) throw new Error("lease lost"); });
    await Bun.sleep(20);
    live = false;
    releaseToken();
    expect(await out).toMatch(/^Error:/);
    expect(gitRuns).toEqual([]);
  });

  test.each([
    ["open_pr", OPEN_PR],
    ["push", { action: "push" }],
  ])("%s: a heartbeat answer that arrives during the token mint is awaited by an async guard before the write", async (_name, args) => {
    hold = true;
    let answer: Promise<void> | null = null;
    const guard = async () => { if (answer) await answer; };
    const out = rig()(work, args, guard);
    await Bun.sleep(20);
    expect(requests.some((r) => r.url.endsWith("/access_tokens"))).toBe(true); // the mint is in flight
    // a heartbeat starts now and will answer 409 shortly after the token comes back
    answer = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("lease lost")), 30));
    answer.catch(() => {});
    releaseToken();
    expect(await out).toMatch(/^Error:/);
    expect(writes()).toEqual([]);
    expect(gitRuns).toEqual([]);
  });

  test("a session that still holds the lease publishes as before", async () => {
    hold = true;
    const open = rig()(work, OPEN_PR, () => {});
    await Bun.sleep(20);
    releaseToken();
    expect(JSON.parse(await open).number).toBe(12);
    expect(writes().length).toBe(1);
    const push = await rig()(work, { action: "push" }, () => {});
    expect(JSON.parse(push).status).toBe("ok");
    expect(gitRuns.length).toBe(1);
  });

  test("a session that is already over does not even stage the branch", async () => {
    let staged = 0;
    const publish = createPublisher({
      base: "master", githubDeps: githubDeps(),
      stage: () => { staged++; return { dir: "/w/x.push.git", sha: "c".repeat(40) }; }, record: () => {},
    });
    const out = await publish(work, { action: "push" }, () => { throw new Error("lease lost"); });
    expect(out).toMatch(/^Error:/);
    expect(staged).toBe(0);
    expect(requests).toEqual([]);
  });
});
