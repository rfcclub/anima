import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../../src/work/store";
import { loadWorkConfig } from "../../src/work/config";

type Owner = { workId: string; sessionId: string; leaseId: string; generation: number; signal: AbortSignal };
type Item = {
  workId: string; id: string; owner: Omit<Owner, "workId" | "signal">;
  status: string; evidence: unknown[]; result: unknown; revision: number;
};
type Progress = {
  revokeDomainLease?: (sessionId: string, leaseId: string, generation: number) => void;
  createDomainItem?: (owner: Owner, id: string) => Item;
  claimDomainItem?: (owner: Owner, id: string) => Item;
  updateDomainItem?: (owner: Owner, id: string, update: unknown) => Item;
  getDomainItem?: (workId: string, id: string) => Item | null;
  listDomainItems?: (workId: string) => Item[];
};
const stores: WorkStore[] = [];
const dirs: string[] = [];
const progress = (store: WorkStore) => store as unknown as Progress;
function open(path = ":memory:") { const store = WorkStore.open(path); stores.push(store); return store; }
function close(store: WorkStore) { stores.splice(stores.indexOf(store), 1); store.close(); }
function ownerFor(store: WorkStore, workId: string, leaseId: string) {
  const reservation = store.reserveSession(workId, { jobId: "job-1", claimId: leaseId });
  if (!reservation.ok) throw new Error(`session reservation failed: ${reservation.reason}`);
  const controller = new AbortController();
  const owner = { workId, sessionId: reservation.session.sessionId, leaseId, generation: reservation.session.generation, signal: controller.signal };
  return { owner, controller };
}
function setup(path = ":memory:") {
  const store = open(path);
  const work = store.createWork({ repo: "example/project", issue: 1, approvedDigest: "123456789abc", config: loadWorkConfig({}) }).work;
  return { store, work, ...ownerFor(store, work.workId, "lease-1") };
}
function tempDb() { const dir = mkdtempSync(join(tmpdir(), "domain-progress-")); dirs.push(dir); return join(dir, "work.db"); }
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const complete = { status: "completed", evidence: [{ type: "note", value: "checked" }], result: { type: "text", value: "done" } };
const underway = { status: "in_progress", evidence: [{ type: "reference", value: "part-1" }], result: null };

describe("domain progress", () => {
  test("creates, claims and reads a completed item with typed evidence and result", () => {
    const { store, owner } = setup();
    const api = progress(store);
    expect(typeof api.createDomainItem).toBe("function");
    api.createDomainItem!(owner, "item-1");
    api.claimDomainItem!(owner, "item-1");
    api.updateDomainItem!(owner, "item-1", complete);
    expect(api.getDomainItem!(owner.workId, "item-1")).toMatchObject({
      id: "item-1", workId: owner.workId,
      owner: { sessionId: owner.sessionId, leaseId: owner.leaseId, generation: owner.generation },
      ...complete,
    });
    expect(api.listDomainItems!(owner.workId)).toHaveLength(1);
  });

  test("rejects invalid status, evidence and result without storing success", () => {
    const { store, owner } = setup();
    const api = progress(store);
    api.createDomainItem?.(owner, "item-1");
    api.updateDomainItem?.(owner, "item-1", underway);
    const prior = api.getDomainItem?.(owner.workId, "item-1");
    expect(prior?.status).toBe("in_progress");
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    const invalid = [
      { ...complete, status: "succeeded" },
      { ...complete, evidence: [{ type: "bad", value: "x" }] },
      { ...complete, evidence: [{ type: "note", value: "x", extra: true }] },
      { ...complete, result: { type: "number", value: "one" } },
      { ...complete, result: { type: "number", value: Infinity } },
      { ...complete, result: { type: "text", value: "done", extra: true } },
      { ...complete, result: { type: "json", value: cyclic } },
      { ...complete, result: null },
    ];
    for (const update of invalid) {
      expect(() => api.updateDomainItem!(owner, "item-1", update)).toThrow();
      expect(api.getDomainItem!(owner.workId, "item-1")).toEqual(prior);
    }
  });

  test("preserves an in-progress item across restart and allows the replacement to claim it", () => {
    const path = tempDb();
    const first = setup(path);
    progress(first.store).createDomainItem?.(first.owner, "item-1");
    progress(first.store).updateDomainItem?.(first.owner, "item-1", underway);
    expect(progress(first.store).getDomainItem?.(first.work.workId, "item-1")?.status).toBe("in_progress");
    close(first.store);
    const store = open(path);
    expect(store.recoverOpenSessions()).toHaveLength(1);
    const second = ownerFor(store, first.work.workId, "lease-2");
    const item = progress(store).claimDomainItem!(second.owner, "item-1");
    expect(item).toMatchObject({ ...underway, owner: { sessionId: second.owner.sessionId, leaseId: "lease-2", generation: second.owner.generation } });
    progress(store).updateDomainItem!(second.owner, "item-1", complete);
    expect(progress(store).getDomainItem!(first.work.workId, "item-1")?.result).toEqual(complete.result);
  });

  test("rejects a stale generation and a mismatched lease claim on every write", () => {
    const first = setup();
    const api = progress(first.store);
    api.createDomainItem?.(first.owner, "item-1");
    expect(api.getDomainItem?.(first.work.workId, "item-1")).toBeDefined();
    first.store.closeSession(first.owner.sessionId, { iterations: 1, execMs: 1, stopCause: "max_reached" });
    const second = ownerFor(first.store, first.work.workId, "lease-2");
    api.claimDomainItem!(second.owner, "item-1");
    const current = api.getDomainItem!(first.work.workId, "item-1");
    for (const stale of [first.owner, { ...second.owner, leaseId: "wrong" }]) {
      expect(() => api.createDomainItem!(stale, "item-2")).toThrow();
      expect(() => api.claimDomainItem!(stale, "item-1")).toThrow();
      expect(() => api.updateDomainItem!(stale, "item-1", complete)).toThrow();
      expect(api.getDomainItem!(first.work.workId, "item-1")).toEqual(current);
    }
  });

  test("forbidden: an unauthorized session cannot write an item before claiming it", () => {
    const first = setup();
    const api = progress(first.store);
    api.createDomainItem!(first.owner, "item-1");
    api.updateDomainItem!(first.owner, "item-1", underway);
    first.store.closeSession(first.owner.sessionId, { iterations: 1, execMs: 1, stopCause: "max_reached" });
    const second = ownerFor(first.store, first.work.workId, "lease-2");
    const before = api.getDomainItem!(first.work.workId, "item-1");
    expect(() => api.updateDomainItem!(second.owner, "item-1", complete)).toThrow(/claimed by another session/);
    expect(api.getDomainItem!(first.work.workId, "item-1")).toEqual(before);
    api.claimDomainItem!(second.owner, "item-1");
    expect(api.updateDomainItem!(second.owner, "item-1", complete).status).toBe("completed");
  });

  test("a revoked lease stays fenced through another store connection", () => {
    const path = tempDb();
    const first = setup(path);
    const api = progress(first.store);
    api.createDomainItem?.(first.owner, "item-1");
    const second = progress(open(path));
    expect(typeof api.revokeDomainLease).toBe("function");
    api.revokeDomainLease!(first.owner.sessionId, first.owner.leaseId, first.owner.generation);
    const replacement = { ...first.owner, signal: new AbortController().signal };
    expect(() => second.updateDomainItem!(replacement, "item-1", complete)).toThrow();
    expect(second.getDomainItem!(first.work.workId, "item-1")?.status).toBe("not_started");
  });

  test("repeating an identical result is idempotent, including JSON key order", () => {
    const { store, owner } = setup();
    const api = progress(store);
    api.createDomainItem?.(owner, "item-1");
    const first = api.updateDomainItem?.(owner, "item-1", { ...complete, result: { type: "json", value: { a: 1, b: 2 } } });
    expect(first?.status).toBe("completed");
    const second = api.updateDomainItem!(owner, "item-1", { ...complete, result: { type: "json", value: { b: 2, a: 1 } } });
    expect(second).toEqual(first);
    expect(api.listDomainItems!(owner.workId)).toHaveLength(1);
  });

  test("preserves existing work session and event reads", () => {
    const { store, owner } = setup();
    store.appendEvent(owner.workId, "domain-test-existing", { count: 1 });
    const session = store.getSession(owner.sessionId);
    const events = store.listEvents(owner.workId);
    progress(store).createDomainItem?.(owner, "item-1");
    expect(progress(store).getDomainItem?.(owner.workId, "item-1")?.status).toBe("not_started");
    expect(store.getSession(owner.sessionId)).toEqual(session);
    expect(store.listEvents(owner.workId)).toEqual(events);
  });
});
