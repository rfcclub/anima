import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebChatService } from "../../src/web-chat/service";
import { ChatStore } from "../../src/web-chat/store";
import {
  ADAPTER_VERSION,
  BrowserFailure,
  type BrowserRunner,
} from "../../src/web-chat/types";

const owner = { agent: "operator", session: "one" };
const services: WebChatService[] = [];
const roots: string[] = [];
const runner: BrowserRunner = {
  run: async () => ({
    text: "answer",
    turnId: "a",
    url: "https://chatgpt.com/c/fixture",
  }),
  close: async () => {},
};
function setup(browser = runner) {
  const root = mkdtempSync(join(tmpdir(), "console-operator-"));
  roots.push(root);
  const service = new WebChatService({
    root,
    browser,
    accounts: ["a", "b"].map((id) => ({
      id,
      service: "chatgpt",
      validatedVersion: ADAPTER_VERSION,
      validatedService: "chatgpt",
    })),
  });
  services.push(service);
  return { root, service };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw Error("did not settle");
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("recovery-history: other conversations cannot hide unknown requests behind the history window", async () => {
  const { service: s } = setup({
    ...runner,
    run: async (c, ...args) => {
      if (c.account === "a")
        throw new BrowserFailure("unknown_submission", false);
      return runner.run(c, ...args);
    },
  });
  const a = s.create(owner, "a"),
    b = s.create(owner, "b");
  const unknown = s.send(owner, {
    conversationId: a.id,
    retryKey: "unknown",
    prompt: "public",
  });
  await until(() => s.result(owner, unknown.id).state === "unknown_submission");
  for (let i = 0; i < 21; i++) {
    const request = s.send(owner, {
      conversationId: b.id,
      retryKey: `b-${i}`,
      prompt: "public",
    });
    await until(() => s.result(owner, request.id).state === "completed");
  }
  const history = s.history(owner);
  expect(history.requests.map((r) => r.id)).toContain(unknown.id);
  expect(
    history.requests.filter((r) => r.conversationId === b.id),
  ).toHaveLength(20);
});

test("SC-4: maintenance fences new/resumed chat and reconciliation, retaining other accounts", async () => {
  const { service: s } = setup();
  const c = s.create(owner, "a");
  const prior = s.send(owner, {
    conversationId: c.id,
    retryKey: "prior",
    prompt: "public",
  });
  await until(() => s.result(owner, prior.id).state === "completed");
  const release = s.acquireMaintenance("a");
  expect(s.list().find((a) => a.account === "a")).toMatchObject({
    available: false,
    reason: "maintenance",
  });
  expect(() => s.acquireMaintenance("a")).toThrow("maintenance");
  expect(() => s.create(owner, "a")).toThrow("maintenance");
  expect(s.resume(owner, c.id).id).toBe(c.id);
  expect(() =>
    s.send(owner, { conversationId: c.id, retryKey: "next", prompt: "public" }),
  ).toThrow("maintenance");
  await expect(s.reconcile(owner, prior.id)).rejects.toThrow("maintenance");
  expect(s.create(owner, "b").account).toBe("b");
  release();
  const nextRelease = s.acquireMaintenance("a");
  release(); // A stale closure cannot release a newer lease.
  expect(() => s.create(owner, "a")).toThrow("maintenance");
  nextRelease();
  expect(s.create(owner, "a").account).toBe("a");
  expect(() => s.acquireMaintenance("missing")).toThrow("unknown");
});

test("SC-4: queued and active requests prevent maintenance before browser changes", async () => {
  const { service: s } = setup({
    ...runner,
    run: async (_c, _prompt, signal, submitted) => {
      submitted("u", "https://chatgpt.com/c/fixture");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      throw Error("unreachable");
    },
  });
  const c = s.create(owner, "a");
  const r = s.send(owner, {
    conversationId: c.id,
    retryKey: "queued",
    prompt: "public",
  });
  expect(() => s.acquireMaintenance("a")).toThrow("busy");
  await until(() => s.result(owner, r.id).state === "waiting");
  expect(() => s.acquireMaintenance("a")).toThrow("busy");
  s.cancel(owner, r.id);
});

test("SC-4: durable uncertainty and running reconciliation prevent maintenance after restart", async () => {
  const { root, service: first } = setup();
  const c = first.create(owner, "a");
  const r = first.send(owner, {
    conversationId: c.id,
    retryKey: "old",
    prompt: "public",
  });
  await until(() => first.result(owner, r.id).state === "completed");
  await first.shutdown();
  services.splice(services.indexOf(first), 1);
  const store = new ChatStore(root);
  const saved = store.request(r.id)!;
  saved.state = "unknown_submission";
  store.putRequest(saved);
  store.close();
  let finish!: () => void;
  const restarted = new WebChatService({
    root,
    accounts: [
      {
        id: "a",
        service: "chatgpt",
        validatedVersion: ADAPTER_VERSION,
        validatedService: "chatgpt",
      },
    ],
    browser: {
      ...runner,
      reconcile: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { state: "unknown_submission" };
      },
    },
  });
  services.push(restarted);
  expect(() => restarted.acquireMaintenance("a")).toThrow("uncertain");
  const pending = restarted.reconcile(owner, r.id);
  expect(() => restarted.acquireMaintenance("a")).toThrow("busy");
  finish();
  await pending;
  restarted.resolve(owner, r.id, "not_sent");
  const release = restarted.acquireMaintenance("a");
  release();
  await restarted.shutdown();
  services.splice(services.indexOf(restarted), 1);
  expect(() => restarted.acquireMaintenance("a")).toThrow("stopped");
});

test("SC-3/SC-4: explicit validation lease admits only its private attempt owner and never marks verified", async () => {
  const root = mkdtempSync(join(tmpdir(), "console-validation-"));
  roots.push(root);
  const s = new WebChatService({
    root,
    accounts: [{ id: "a", service: "chatgpt" }],
    browser: runner,
  });
  services.push(s);
  const attempt = {
    agent: "operator-validation",
    session: crypto.randomUUID(),
  };
  const release = s.acquireMaintenance("a", attempt);
  expect(s.list()[0]).toMatchObject({
    available: false,
    reason: "maintenance",
  });
  expect(() => s.create(owner, "a")).toThrow("maintenance");
  const conversation = s.create(attempt, "a");
  const request = s.send(attempt, {
    conversationId: conversation.id,
    retryKey: "validate",
    prompt: "unique public challenge",
  });
  await until(() => s.result(attempt, request.id).state === "completed");
  release();
  expect(s.list()[0]).toMatchObject({ available: false, reason: "unverified" });
  expect(() => s.create(attempt, "a")).toThrow("unverified");
});
