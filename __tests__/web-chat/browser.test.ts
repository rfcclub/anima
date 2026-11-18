import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserProcess as BrowserManager } from "../../src/web-chat/browser-process";
import { fixtureAdapter } from "../../src/web-chat/adapters";
import type {
  ChatConversation,
  ChatService,
  ChatRequest,
} from "../../src/web-chat/types";
const managers: BrowserManager[] = [],
  roots: string[] = [];
const html = readFileSync(join(import.meta.dir, "fixtures/chat.html"), "utf8");
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
});
afterAll(async () => {
  await server.stop(true);
});
afterEach(async () => {
  for (const b of managers.splice(0)) await b.shutdown();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function setup(query = "", service: ChatService = "chatgpt") {
  const root = mkdtempSync(join(tmpdir(), "webchat-browser-"));
  roots.push(root);
  const url = `http://127.0.0.1:${server.port}/${query}`;
  const manager = new BrowserManager({
    root,
    accounts: [{ id: "a", service }],
    headless: true,
    fixture: { url, adapter: fixtureAdapter },
  });
  managers.push(manager);
  const c: ChatConversation = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    owner: { agent: "a", session: "s" },
    account: "a",
    service,
    closed: false,
    blocked: false,
  };
  return { manager, c, url };
}
test("SC-3/SC-4: finishing manual login releases the real Chromium profile before another browser owner opens it", async () => {
  const { manager, c, url } = await setup("?delay=30&answer=OK");
  expect(typeof manager.finishLogin).toBe("function");
  await manager.login("a");
  await manager.finishLogin("a");
  const replacement = new BrowserManager({
    root: roots[roots.length - 1]!,
    accounts: [{ id: "a", service: "chatgpt" }],
    headless: true,
    fixture: { url, adapter: fixtureAdapter },
  });
  managers.push(replacement);
  const answer = await replacement.run(
    c,
    "public fixture",
    AbortSignal.timeout(10_000),
    () => {},
  );
  expect(answer.text).toBe("OK");
}, 20_000);
for (const service of ["claude", "chatgpt", "grok", "gemini"] as const)
  test(`WB-2/WB-8: ${service} lifecycle engine accepts short current answer only`, async () => {
    const { manager, c } = await setup("?delay=60&answer=OK", service);
    let submitted = 0;
    const answer = await manager.run(
      c,
      "exact prompt",
      AbortSignal.timeout(5000),
      () => submitted++,
    );
    expect(answer.text).toBe("OK");
    expect(answer.text).not.toContain("thinking");
    expect(submitted).toBe(1);
  }, 15000);
for (const editable of ["plain", "paragraph"])
  test(`WB-2/WB-10: multiline contenteditable ${editable} preserves the exact submitted prompt`, async () => {
    const { manager, c } = await setup(`?editable=${editable}&echo=1`);
    const prompt = "\nfirst line\n\nsecond line\n";
    let submitted = 0;
    const answer = await manager.run(
      c,
      prompt,
      AbortSignal.timeout(5000),
      () => submitted++,
    );
    expect(answer.text).toBe(prompt);
    expect(submitted).toBe(1);
  }, 10000);
test("WB-10: contenteditable mutation is refused before submission", async () => {
  const { manager, c } = await setup("?editable=plain&strip-newlines=1");
  let submitted = 0;
  await expect(
    manager.run(c, "one\ntwo", AbortSignal.timeout(5000), () => submitted++),
  ).rejects.toMatchObject({
    state: "unsupported_page",
    beforeSubmission: true,
  });
  expect(submitted).toBe(0);
}, 10000);

test("WB-2: a nonempty default thread is not silently reused", async () => {
  const { manager, c } = await setup("?stale=1");
  await expect(
    manager.run(c, "new", AbortSignal.timeout(3000), () => {}),
  ).rejects.toThrow("unsupported_page");
}, 10000);

test("WB-5: delayed Chromium thread URL is persisted across bridge/browser restart", async () => {
  const { WebChatService } = await import("../../src/web-chat/service");
  const root = mkdtempSync(join(tmpdir(), "webchat-continuity-"));
  roots.push(root);
  const paths: string[] = [];
  const local = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      paths.push(path);
      return new Response(
        html +
          (path === "/c/final-thread"
            ? "<script>turn('user','first');turn('assistant','OK');</script>"
            : "<script>document.querySelector('#send').addEventListener('click',()=>setTimeout(()=>history.replaceState({},'', '/c/final-thread'),100));</script>"),
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const accounts = [
    {
      id: "a",
      service: "chatgpt" as const,
      validatedVersion: "fixture",
      validatedService: "chatgpt" as const,
    },
  ];
  const create = () => {
    const manager = new BrowserManager({
      root: join(root, "browser"),
      accounts,
      headless: true,
      fixture: { url: `${local.url.href}?delay=250`, adapter: fixtureAdapter },
    });
    managers.push(manager);
    return {
      manager,
      service: new WebChatService({
        root: join(root, "store"),
        accounts,
        adapterVersion: "fixture",
        browser: manager,
      }),
    };
  };
  let current = create();
  const owner = { agent: "fixture", session: "s" };
  const c = current.service.create(owner, "a");
  const wait = async (id: string) => {
    for (let i = 0; i < 250; i++) {
      const result = current.service.result(owner, id);
      if (result.state === "completed") return result;
      if (!["queued", "sending", "waiting"].includes(result.state))
        throw Error(JSON.stringify(result));
      await Bun.sleep(20);
    }
    throw Error("fixture result timeout");
  };
  try {
    const r = current.service.send(owner, {
      conversationId: c.id,
      retryKey: "first",
      prompt: "first",
    });
    expect((await wait(r.id)).url).toBe(`${local.url.origin}/c/final-thread`);
    await current.service.shutdown();
    await current.manager.shutdown();
    current = create();
    const second = current.service.send(owner, {
      conversationId: c.id,
      retryKey: "second",
      prompt: "continue",
    });
    expect((await wait(second.id)).answer).toBe("OK");
    expect(paths.at(-1)).toBe("/c/final-thread");
  } finally {
    await current.service.shutdown();
    await local.stop(true);
  }
}, 15000);
test("WB-7: cancellation settles the page; a following conversation gets its own editor", async () => {
  const { manager, c } = await setup("?delay=5000");
  const controller = new AbortController();
  let sent = false;
  const task = manager.run(c, "cancel me", controller.signal, () => {
    sent = true;
    controller.abort();
  });
  await expect(task).rejects.toThrow();
  expect(sent).toBe(true);
  expect(manager.openPages).toBe(0);
}, 10000);
test("WB-2: final text without an explicit completed marker never becomes success", async () => {
  const { manager, c } = await setup("?no-final=1");
  await expect(
    manager.run(c, "p", AbortSignal.timeout(1500), () => {}),
  ).rejects.toThrow();
  expect(manager.openPages).toBe(0);
}, 10000);

test("WB-2: resume ignores an old stable answer and correlates the new user/assistant pair", async () => {
  const { manager, c, url } = await setup("?stale=1&answer=NEW");
  c.url = url;
  const answer = await manager.run(
    c,
    "new question",
    AbortSignal.timeout(5000),
    () => {},
  );
  expect(answer.text).toBe("NEW");
  expect(answer.text).not.toContain("OLD");
}, 10000);
test("WB-6: read-only reconciliation requires matching count/digest and performs no second send", async () => {
  const { manager, c } = await setup("?answer=reconciled");
  let baseline: any;
  const answer = await manager.run(
    c,
    "one question",
    AbortSignal.timeout(5000),
    (_id, url, b) => {
      c.url = url;
      baseline = b;
    },
  );
  const { createHash } = await import("node:crypto");
  const request = {
    baseline,
    audit: {
      promptDigest: createHash("sha256").update("one question").digest("hex"),
    },
  } as ChatRequest;
  expect(
    (await manager.reconcile(c, request, AbortSignal.timeout(1000))).answer
      ?.turnId,
  ).toBe(answer.turnId);
  expect(
    (
      await manager.reconcile(
        c,
        { ...request, audit: { ...request.audit, promptDigest: "wrong" } },
        AbortSignal.timeout(1000),
      )
    ).state,
  ).toBe("unknown_submission");
  expect(
    (
      await manager.reconcile(
        c,
        { ...request, baseline: { ...baseline, userCount: 99 } },
        AbortSignal.timeout(1000),
      )
    ).state,
  ).toBe("unknown_submission");
}, 10000);
for (const [marker, state] of [
  ["needs-login", "needs_login"],
  ["needs-verification", "needs_verification"],
  ["rate-limit", "rate_limited"],
])
  test(`WB-8: ${state} is distinguishable and does not submit`, async () => {
    const { manager, c } = await setup(`?state=${marker}`);
    let sent = false;
    await expect(
      manager.run(c, "do not submit", AbortSignal.timeout(5000), () => {
        sent = true;
      }),
    ).rejects.toThrow(state);
    expect(sent).toBe(false);
  }, 10000);

test("WB-3: two parallel account profiles cannot mix editors or replies", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-parallel-"));
  roots.push(root);
  const manager = new BrowserManager({
    root,
    accounts: [
      { id: "a", service: "chatgpt" },
      { id: "b", service: "chatgpt" },
    ],
    headless: true,
    fixture: {
      url: `http://127.0.0.1:${server.port}/?echo&delay=100`,
      adapter: fixtureAdapter,
    },
  });
  managers.push(manager);
  const conversation = (account: string): ChatConversation => ({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    owner: { agent: account, session: "s" },
    account,
    service: "chatgpt",
    closed: false,
    blocked: false,
  });
  const [a, b] = await Promise.all([
    manager.run(
      conversation("a"),
      "private A",
      AbortSignal.timeout(5000),
      () => {},
    ),
    manager.run(
      conversation("b"),
      "private B",
      AbortSignal.timeout(5000),
      () => {},
    ),
  ]);
  expect(a.text).toBe("private A");
  expect(b.text).toBe("private B");
  expect(a.turnId).not.toBe(b.turnId);
}, 15000);
