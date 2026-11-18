/**
 * castle-work-loop, WL-10 / WL-4 publish half: the host identity broker.
 * A Unix socket, a fake GitHub writer and a fake token source; nothing reaches GitHub.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBroker, brokerCall, type Broker, type GitHubWriter, type BrokerScope } from "../../src/work/broker";
import { buildProfile, SANDBOX_BINARY } from "../../src/work/sandbox";

const TOKEN = "session-token-0123456789abcdef";
const GH_SECRET = "ghs_APP_INSTALLATION_TOKEN_SENTINEL";

let dir: string;
let sock: string;
let broker: Broker;
let writerCalls: Array<{ op: string; args: Record<string, unknown>; githubToken: string }>;
let tokenRequests: string[];
let current: { claimId: string; generation: number; active: boolean };

const scope: BrokerScope = { repo: "rfcclub/anima", base: "master", branch: "work/7-wabc", author: "finn", issue: 7 };

const writer: GitHubWriter = {
  async push(a) { writerCalls.push({ op: "push", args: a.args, githubToken: a.githubToken }); return { head: "a".repeat(40) }; },
  async openPr(a) { writerCalls.push({ op: "pr.open", args: a.args, githubToken: a.githubToken }); return { number: 12, url: "https://github.com/rfcclub/anima/pull/12", head: "a".repeat(40) }; },
  async updatePrBody(a) { writerCalls.push({ op: "pr.update-body", args: a.args, githubToken: a.githubToken }); return {}; },
  async comment(a) { writerCalls.push({ op: "comment", args: a.args, githubToken: a.githubToken }); return {}; },
};

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "wb-")));
  sock = join(dir, "b.sock");
  writerCalls = [];
  tokenRequests = [];
  current = { claimId: "c1", generation: 1, active: true };
  broker = await createBroker({
    socketPath: sock,
    token: TOKEN,
    scope,
    current: () => current,
    writer,
    githubTokenFor: async (author) => { tokenRequests.push(author); return GH_SECRET; },
  });
});
afterEach(async () => { await broker.close(); });

const call = (op: string, args: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  brokerCall(sock, { token: TOKEN, op, args, claimId: "c1", generation: 1, ...over });

describe("allowed operations", () => {
  test("push of the work branch succeeds once and reaches the writer with the author's token", async () => {
    const r = await call("push", { branch: "work/7-wabc" });
    expect(r.ok).toBe(true);
    expect(writerCalls.map((c) => c.op)).toEqual(["push"]);
    expect(writerCalls[0]!.githubToken).toBe(GH_SECRET);
    expect(tokenRequests).toEqual(["finn"]);
  });

  test("opening a pull request for the right repository, base and head succeeds", async () => {
    const r = await call("pr.open", { repo: "rfcclub/anima", base: "master", head: "work/7-wabc", title: "t", body: "Closes #7" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result as { number: number }).number).toBe(12);
    expect(writerCalls.map((c) => c.op)).toEqual(["pr.open"]);
  });

  test("a token is fetched for each call, never reused or cached", async () => {
    await call("push", {});
    await call("push", {});
    expect(tokenRequests.length).toBe(2);
  });

  test("a comment on the work's issue is allowed, on another issue is refused", async () => {
    expect((await call("comment", { number: 7, body: "progress" })).ok).toBe(true);
    const other = await call("comment", { number: 99, body: "x" });
    expect(other.ok).toBe(false);
    expect(writerCalls.length).toBe(1);
  });
});

describe("refused operations", () => {
  test.each([
    ["push", { branch: "master" }],
    ["push", { branch: "work/8-wother" }],
    ["push", { repo: "rfcclub/other", branch: "work/7-wabc" }],
    ["pr.open", { repo: "rfcclub/other", base: "master", head: "work/7-wabc", title: "t", body: "b" }],
    ["pr.open", { repo: "rfcclub/anima", base: "release", head: "work/7-wabc", title: "t", body: "b" }],
    ["pr.open", { repo: "rfcclub/anima", base: "master", head: "other-branch", title: "t", body: "b" }],
    ["merge", { number: 12 }],
    ["pr.merge", { number: 12 }],
    ["review.approve", { number: 12 }],
    ["review.request-changes", { number: 12 }],
    ["intent.edit", { number: 7, body: "approved by me" }],
    ["issue.label", { number: 7, labels: ["orca:approved"] }],
    ["push --force", {}],
    ["", {}],
  ])("%s %j is refused and the writer is never called", async (op, args) => {
    const r = await call(op as string, args as Record<string, unknown>);
    expect(r.ok).toBe(false);
    expect(writerCalls.length).toBe(0);
  });

  test("a wrong or missing session token is refused", async () => {
    expect((await call("push", {}, { token: "nope" })).ok).toBe(false);
    expect((await call("push", {}, { token: undefined })).ok).toBe(false);
    expect(writerCalls.length).toBe(0);
    expect(tokenRequests.length).toBe(0);
  });

  test("an older generation, a different claim and a released claim are refused", async () => {
    current = { claimId: "c2", generation: 2, active: true };
    const stale = await call("push", {});
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toBe("stale");
    expect((await call("push", {}, { claimId: "c2", generation: 1 })).ok).toBe(false);
    expect((await call("push", {}, { claimId: "c1", generation: 2 })).ok).toBe(false);
    current = { claimId: "c2", generation: 2, active: false };
    expect((await call("push", {}, { claimId: "c2", generation: 2 })).ok).toBe(false);
    expect(writerCalls.length).toBe(0);
    expect(tokenRequests.length).toBe(0);
  });

  test("malformed input is refused without crashing the broker", async () => {
    const c = await Bun.connect({ unix: sock, socket: { data() {}, open(s) { s.write("not json\n"); }, close() {}, error() {} } });
    await Bun.sleep(50);
    c.end();
    expect((await call("push", {})).ok).toBe(true);
  });
});

describe("secrets", () => {
  test("no response contains the GitHub token or the session token echo, and nothing is written under the work dir", async () => {
    const responses = [
      await call("push", {}),
      await call("pr.open", { repo: "rfcclub/anima", base: "master", head: "work/7-wabc", title: "t", body: "b" }),
      await call("merge", { number: 12 }),
      await call("push", {}, { token: "wrong" }),
    ];
    const text = JSON.stringify(responses);
    expect(text).not.toContain(GH_SECRET);
    expect(text).not.toContain(TOKEN);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.isSocket() ? [] : [join(d, e.name)]));
    for (const f of walk(dir)) expect(readFileSync(f, "utf-8")).not.toContain(GH_SECRET);
  });

  test("the socket is private to the owner", () => {
    expect(statSync(sock).mode & 0o077).toBe(0);
  });

  test("the broker source never asks `gh` who the user is", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/work/broker.ts"), "utf-8");
    expect(src).not.toMatch(/api\s+user/);
    expect(src).not.toMatch(/["']gh["']/);
  });
});

describe("from inside the sandbox", () => {
  (existsSync(SANDBOX_BINARY) ? test : test.skip)("by default a sandboxed tool cannot reach the broker at all (no network), so publishing is a host-run tool", async () => {
    const root = join(dir, "root-default");
    mkdirSync(join(root, "tree"), { recursive: true });
    const script = `
      const sock = ${JSON.stringify(sock)};
      Bun.connect({ unix: sock, socket: { open(s) { s.write("{}\n"); }, data(s, d) { console.log("REACHED " + d); process.exit(0); }, error(_s, e) { console.log("BLOCKED " + (e && e.code)); process.exit(0); }, close() {} } }).catch((e) => { console.log("BLOCKED " + (e && e.code)); process.exit(0); });
      setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 3000);
    `;
    const child = Bun.spawn([SANDBOX_BINARY, "-p", buildProfile({ writableRoots: [root] }), process.execPath, "-e", script], {
      cwd: join(root, "tree"), env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(stdout).not.toContain("REACHED");
    expect(writerCalls.length).toBe(0);
  });

  (existsSync(SANDBOX_BINARY) ? test : test.skip)("when the operator allows the network, a sandboxed tool can reach the broker, and a refusal comes back as a refusal", async () => {
    const root = join(dir, "root");
    mkdirSync(join(root, "tree"), { recursive: true });
    const script = `
      const sock = ${JSON.stringify(sock)};
      const out = [];
      const ask = (req) => new Promise((resolve) => {
        let buf = "";
        Bun.connect({ unix: sock, socket: {
          open(s) { s.write(JSON.stringify(req) + "\\n"); },
          data(s, d) { buf += d.toString(); if (buf.includes("\\n")) { s.end(); resolve(JSON.parse(buf)); } },
          error() { resolve({ ok: false, error: "connect" }); }, close() {},
        }});
      });
      out.push(await ask({ token: ${JSON.stringify(TOKEN)}, op: "push", args: {}, claimId: "c1", generation: 1 }));
      out.push(await ask({ token: ${JSON.stringify(TOKEN)}, op: "merge", args: { number: 12 }, claimId: "c1", generation: 1 }));
      console.log(JSON.stringify(out));
    `;
    // async: the broker runs in this process, so a blocking spawn would starve it
    const child = Bun.spawn([SANDBOX_BINARY, "-p", buildProfile({ writableRoots: [root], allowNetwork: true }), process.execPath, "-e", script], {
      cwd: join(root, "tree"), env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const answers = JSON.parse(stdout.trim()) as Array<{ ok: boolean }>;
    expect(answers.map((a) => a.ok)).toEqual([true, false]);
    expect(writerCalls.map((c) => c.op)).toEqual(["push"]);
  });
});
