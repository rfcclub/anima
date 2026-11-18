/**
 * cartridge-worker-dispatch: the executor builds through a worker adapter.
 * Adapter #0 is today's loop; its parity is the unchanged executor suite next to this file.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionExecutor } from "../../src/work/executor";
import type { WorkerAdapter, WorkerAdapterInput } from "../../src/work/adapter";
import { WorkStore, type WorkRecord } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";
import { SANDBOX_BINARY } from "../../src/work/sandbox";
import { SessionStore } from "../../src/memory/session-store";
import { SessionManager } from "../../src/session/manager";

const sbx = existsSync(SANDBOX_BINARY) ? describe : describe.skip;

let dir: string;
let source: string;
let store: WorkStore;
let sessions: SessionStore;
let work: WorkRecord;

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "work-seam-")));
  source = join(dir, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "README.md"), "hello\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "first");
  store = WorkStore.open(":memory:", { rootBase: join(dir, "roots") });
  sessions = new SessionStore(join(dir, "sessions.db"));
  work = store.createWork({ repo: "rfcclub/anima", issue: 7, approvedDigest: "d1d1d1d1d1d1", config: loadWorkConfig({}) }).work;
});
afterEach(() => { store.close(); sessions.close(); });

sbx("worker adapter seam (cartridge-worker-dispatch S1)", () => {
  test("adapter-seam: the executor prepares the workspace, hands the session to the adapter and returns its result", async () => {
    const seen: WorkerAdapterInput[] = [];
    const adapter: WorkerAdapter = {
      kind: "fake",
      async run(input) { seen.push(input); return { stopCause: "done", iterations: 2, cessation: "proven" }; },
    };
    let providerCalls = 0;
    const executor = createSessionExecutor({
      store, sessionStore: sessions, sessionManager: new SessionManager({ store: sessions, maxTokens: 200_000 }),
      createProvider: async () => { providerCalls++; throw new Error("adapter #0 must not run"); },
      loadIdentity: async () => { throw new Error("adapter #0 must not run"); },
      issue: async () => ({ title: "T", body: "B" }),
      cloneSource: () => source,
      parentEnv: { PATH: process.env.PATH },
      adapter,
    });
    const reserved = store.reserveSession(work.workId, { jobId: "job-1", claimId: "claim-1" });
    if (!reserved.ok) throw new Error("not reserved");
    const signal = new AbortController().signal;
    const outcome = await executor.runSession({
      work: store.getWork(work.workId)!, session: reserved.session, maxIterations: 4, deadlineMs: reserved.deadlineMs,
      signal, claim: { id: "claim-1", jobId: "job-1" }, kind: "revise",
    }).catch((error: Error) => error);
    expect(providerCalls).toBe(0);
    expect(seen.length).toBe(1);
    const result = outcome as Exclude<typeof outcome, Error>;
    const input = seen[0]!;
    expect(input.workspace.tree).toBe(join(store.getWork(work.workId)!.root, "tree"));
    expect(existsSync(join(input.workspace.tree, "README.md"))).toBe(true);
    expect([input.work.workId, input.session.sessionId, input.maxIterations, input.kind, input.signal]).toEqual([work.workId, reserved.session.sessionId, 4, "revise", signal]);
    expect(input.claim).toEqual({ id: "claim-1", jobId: "job-1" });
    expect([result.stopCause, result.iterations, result.cessation]).toEqual(["done", 2, "proven"]);
    expect(result.execMs).toBeGreaterThanOrEqual(0);
  });
});
