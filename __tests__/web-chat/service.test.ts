import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebChatService } from "../../src/web-chat/service";
import type { BrowserRunner, ChatOwner } from "../../src/web-chat/types";

const alice: ChatOwner = { agent: "finn", session: "session-a" };
const bob: ChatOwner = { agent: "pia", session: "session-b" };
const roots: string[] = [];
const services: WebChatService[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), "anima-webchat-test-"));
  roots.push(p);
  return p;
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw Error("state did not settle");
};
const runner: BrowserRunner = {
  run: async (_c, prompt, signal, submitted) => {
    signal.throwIfAborted();
    submitted("turn-new", "https://chatgpt.com/c/test");
    return {
      text: prompt === "short" ? "OK" : "answer-new",
      turnId: "turn-new",
      url: "https://chatgpt.com/c/test",
    };
  },
  close: async () => {},
};
function make(path = root(), browser = runner, limits = {}) {
  const s = new WebChatService({
    root: path,
    accounts: [
      {
        id: "gpt",
        service: "chatgpt",
        validatedVersion: "test-version",
        validatedService: "chatgpt" as const,
      },
    ],
    adapterVersion: "test-version",
    browser,
    limits,
  });
  services.push(s);
  return s;
}
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

test("WB-3: foreign session cannot send/read/cancel/close another conversation", async () => {
  const s = make();
  const c = s.create(alice, "gpt");
  expect(() =>
    s.send(bob, { conversationId: c.id, retryKey: "a", prompt: "private" }),
  ).toThrow("owner");
  const r = s.send(alice, {
    conversationId: c.id,
    retryKey: "a",
    prompt: "private",
  });
  expect(() => s.result(bob, r.id)).toThrow("owner");
  expect(() => s.cancel(bob, r.id)).toThrow("owner");
  await expect(s.close(bob, c.id)).rejects.toThrow("owner");
});

test("WB-5/WB-9: idempotent send keeps prompt out of durable state and returns short answer", async () => {
  const p = root();
  let sent = 0;
  const s = make(p, {
    ...runner,
    run: async (...args) => {
      sent++;
      return runner.run(...args);
    },
  });
  const c = s.create(alice, "gpt");
  const first = s.send(alice, {
    conversationId: c.id,
    retryKey: "once",
    prompt: "short",
  });
  expect(
    s.send(alice, { conversationId: c.id, retryKey: "once", prompt: "short" })
      .id,
  ).toBe(first.id);
  expect(() =>
    s.send(alice, {
      conversationId: c.id,
      retryKey: "once",
      prompt: "different",
    }),
  ).toThrow("conflict");
  await until(() => s.result(alice, first.id).state === "completed");
  const result = s.result(alice, first.id);
  expect(result.answer).toBe("OK");
  expect(result.usage).toBeNull();
  expect(sent).toBe(1);
  expect(s.result(alice, first.id).events.length).toBeGreaterThan(0);
  expect(s.result(alice, first.id, result.cursor).events).toEqual([]);
  expect(statSync(p).mode & 0o777).toBe(0o700);
  expect(statSync(join(p, "state.db")).mode & 0o777).toBe(0o600);
  expect(
    readFileSync(join(p, "state.db")).includes(Buffer.from('"prompt":"short"')),
  ).toBe(false);
});

test("WB-7: cancellation after send blocks reuse even if the local browser is stopped", async () => {
  const s = make(undefined, {
    run: async (_c, _p, signal, submitted) => {
      submitted("u1", "https://chatgpt.com/c/1");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      throw Error("unreachable");
    },
    close: async () => {},
  });
  const c = s.create(alice, "gpt");
  const r = s.send(alice, { conversationId: c.id, retryKey: "k", prompt: "p" });
  await until(() => s.result(alice, r.id).state === "waiting");
  s.cancel(alice, r.id);
  await until(() => s.result(alice, r.id).state === "unknown_submission");
  expect(() =>
    s.send(alice, { conversationId: c.id, retryKey: "k2", prompt: "p" }),
  ).toThrow("blocked");
  await s.close(alice, c.id);
  expect(() =>
    s.send(alice, { conversationId: c.id, retryKey: "k3", prompt: "p" }),
  ).toThrow("closed");
});

test("WB-1/WB-8: an unverified adapter is not available to agents", () => {
  const s = new WebChatService({
    root: root(),
    accounts: [{ id: "gpt", service: "chatgpt" }],
    adapterVersion: "test-version",
    browser: runner,
  });
  services.push(s);
  expect(s.list()[0].available).toBe(false);
  expect(() => s.create(alice, "gpt")).toThrow("unverified");
});

test("WB-7: queue deadline never submits behind a busy account", async () => {
  let sends = 0;
  const s = make(
    undefined,
    {
      run: async (_c, _p, signal, submitted) => {
        sends++;
        submitted("u1", "https://chatgpt.com/c/1");
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
        throw Error("unreachable");
      },
      close: async () => {},
    },
    { deadlineMs: 60 },
  );
  const a = s.create(alice, "gpt"),
    b = s.create(alice, "gpt");
  const r1 = s.send(alice, {
    conversationId: a.id,
    retryKey: "a",
    prompt: "a",
  });
  const r2 = s.send(alice, {
    conversationId: b.id,
    retryKey: "b",
    prompt: "b",
  });
  await until(() => s.result(alice, r2.id).state !== "queued");
  expect(s.result(alice, r1.id).state).toBe("unknown_submission");
  expect(s.result(alice, r2.id).state).toBe("failed");
  expect(sends).toBe(1);
});

test("WB-9: oversized prompt rejected and answer truncation is explicit", async () => {
  const s = make(undefined, runner, { promptChars: 5, answerChars: 3 });
  const c = s.create(alice, "gpt");
  expect(() =>
    s.send(alice, { conversationId: c.id, retryKey: "bad", prompt: "123456" }),
  ).toThrow("prompt");
  const r = s.send(alice, {
    conversationId: c.id,
    retryKey: "ok",
    prompt: "yes",
  });
  await until(() => s.result(alice, r.id).state === "completed");
  expect(s.result(alice, r.id).answer).toBe("ans");
  expect(s.result(alice, r.id).truncated).toBe(true);
});

test("WB-10: private excerpts and obvious secrets refuse before the browser and audit safe sends", async () => {
  const s = make();
  s.registerPrivateContent(
    "private source contains sensitive words for this test only",
  );
  const c = s.create(alice, "gpt");
  for (const prompt of [
    "-----BEGIN " + "PRIVATE KEY-----\nsecret\n-----END " + "PRIVATE KEY-----",
    "private source contains sensitive words for this test only",
  ]) {
    expect(() =>
      s.send(alice, {
        conversationId: c.id,
        retryKey: crypto.randomUUID(),
        prompt,
      }),
    ).toThrow("egress");
  }
  const r = s.send(alice, {
    conversationId: c.id,
    retryKey: "safe",
    prompt: "safe topic",
  });
  const audit = s.result(alice, r.id).audit;
  expect(audit).toMatchObject({
    agent: "finn",
    session: "session-a",
    account: "gpt",
    service: "chatgpt",
    promptLength: 10,
  });
  expect(audit.promptDigest).toHaveLength(64);
  expect(JSON.stringify(audit)).not.toContain("safe topic");
});

test("WB-6: a cursor from a different request cannot suppress events", async () => {
  const s = make(),
    c = s.create(alice, "gpt");
  const a = s.send(alice, {
    conversationId: c.id,
    retryKey: "1",
    prompt: "short",
  });
  await until(() => s.result(alice, a.id).state === "completed");
  const cursor = s.result(alice, a.id).cursor;
  const b = s.send(alice, {
    conversationId: c.id,
    retryKey: "2",
    prompt: "short",
  });
  await until(() => s.result(alice, b.id).state === "completed");
  expect(() => s.result(alice, b.id, cursor)).toThrow("cursor");
});

test("WB-10: recognizable encoded and split secrets/private excerpts are refused", () => {
  const s = make(),
    c = s.create(alice, "gpt");
  const privateText = "unique-private-material-kept-out-of-egress";
  s.registerPrivateContent(privateText);
  for (const prompt of [
    Buffer.from("sk-" + "abcdefghijklmnopqrstuvwxyz123456").toString("base64"),
    '"sk-abcdefghijklmno" + "pqrstuvwxyz123456"',
    Buffer.from(privateText).toString("base64"),
  ]) {
    expect(() =>
      s.send(alice, {
        conversationId: c.id,
        retryKey: crypto.randomUUID(),
        prompt,
      }),
    ).toThrow("egress");
  }
});

test("WB-9: expired conversations cannot replay a deleted retry tombstone", async () => {
  let now = Date.now();
  const s = new WebChatService({
    root: root(),
    accounts: [
      {
        id: "gpt",
        service: "chatgpt",
        validatedVersion: "test-version",
        validatedService: "chatgpt" as const,
      },
    ],
    adapterVersion: "test-version",
    browser: runner,
    now: () => now,
  });
  services.push(s);
  const c = s.create(alice, "gpt"),
    r = s.send(alice, {
      conversationId: c.id,
      retryKey: "old",
      prompt: "short",
    });
  await until(() => s.result(alice, r.id).state === "completed");
  now += 86_400_001;
  expect(s.result(alice, r.id).answer).toBeUndefined();
  now += 7 * 86_400_000;
  expect(() => s.result(alice, r.id)).toThrow("owner");
  expect(() =>
    s.send(alice, { conversationId: c.id, retryKey: "old", prompt: "short" }),
  ).toThrow("owner");
});

test("WB-6/WB-7: restart never resends and late reconciliation uses the original request", async () => {
  const path = root();
  let now = Date.now(),
    sends = 0;
  const s = make(path);
  const c = s.create(alice, "gpt"),
    r = s.send(alice, {
      conversationId: c.id,
      retryKey: "lost",
      prompt: "short",
    });
  await until(() => s.result(alice, r.id).state === "completed");
  await s.shutdown();
  services.splice(services.indexOf(s), 1);
  const { ChatStore } = await import("../../src/web-chat/store");
  const store = new ChatStore(path),
    saved = store.request(r.id)!;
  saved.state = "waiting";
  store.putRequest(saved);
  store.close();
  const second = new WebChatService({
    root: path,
    accounts: [
      {
        id: "gpt",
        service: "chatgpt",
        validatedVersion: "test-version",
        validatedService: "chatgpt" as const,
      },
    ],
    adapterVersion: "test-version",
    browser: {
      ...runner,
      run: async (...args) => {
        sends++;
        return runner.run(...args);
      },
      reconcile: async () => ({
        state: "completed",
        answer: {
          text: "late OK",
          turnId: "old-turn",
          url: "https://chatgpt.com/c/test",
        },
      }),
    },
    now: () => now,
  });
  services.push(second);
  expect(second.result(alice, r.id).state).toBe("unknown_submission");
  expect(() =>
    second.send(alice, { conversationId: c.id, retryKey: "next", prompt: "p" }),
  ).toThrow("blocked");
  now += 400_000;
  expect((await second.reconcile(alice, r.id)).answer).toBe("late OK");
  expect(second.result(alice, r.id).late).toBe(true);
  expect(sends).toBe(0);
});

test("WB-6: pruned event cursors explicitly expire", async () => {
  const s = make(),
    c = s.create(alice, "gpt"),
    r = s.send(alice, {
      conversationId: c.id,
      retryKey: "events",
      prompt: "short",
    });
  await until(() => s.result(alice, r.id).state === "completed");
  const early = s.result(alice, r.id).events[0]!.cursor;
  const { ChatStore } = await import("../../src/web-chat/store");
  const store = new ChatStore((s as any).store.root);
  for (let i = 0; i < 140; i++) store.event(store.request(r.id)!);
  store.close();
  expect(s.result(alice, r.id).events).toHaveLength(128);
  expect(() => s.result(alice, r.id, early)).toThrow("cursor");
});

test("WB-7: shutdown aborts and waits for read-only reconciliation before closing the store", async () => {
  const s = make(undefined, {
    ...runner,
    reconcile: async (_c, _r, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { state: "unknown_submission" };
    },
  });
  const c = s.create(alice, "gpt"),
    r = s.send(alice, { conversationId: c.id, retryKey: "r", prompt: "short" });
  await until(() => s.result(alice, r.id).state === "completed");
  const store = (s as any).store;
  const record = store.request(r.id);
  record.state = "unknown_submission";
  store.putRequest(record);
  const reconcile = s.reconcile(alice, r.id);
  const shutdown = s.shutdown();
  await Promise.race([
    shutdown,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(Error("shutdown did not settle reconciliation")),
        500,
      ),
    ),
  ]);
  await reconcile;
  services.splice(services.indexOf(s), 1);
});

test("WB-7: global concurrency two and one per account are enforced before browser effects", async () => {
  let running = 0,
    max = 0;
  const accountActive = new Set<string>();
  let overlap = false;
  const s = new WebChatService({
    root: root(),
    adapterVersion: "test",
    accounts: ["a", "b", "c"].map((id) => ({
      id,
      service: "chatgpt",
      validatedVersion: "test",
      validatedService: "chatgpt" as const,
    })),
    browser: {
      run: async (c, _p, signal, submitted) => {
        if (accountActive.has(c.account)) overlap = true;
        accountActive.add(c.account);
        running++;
        max = Math.max(max, running);
        submitted("u", "https://chatgpt.com/c/test");
        await Bun.sleep(25);
        signal.throwIfAborted();
        running--;
        accountActive.delete(c.account);
        return { text: "OK", turnId: "a", url: "https://chatgpt.com/c/test" };
      },
      close: async () => {},
    },
  });
  services.push(s);
  const requests = ["a", "a", "b", "c"].map((account, i) =>
    s.send(alice, {
      conversationId: s.create(alice, account).id,
      retryKey: String(i),
      prompt: "p",
    }),
  );
  await until(() =>
    requests.every((r) => s.result(alice, r.id).state === "completed"),
  );
  expect(max).toBe(2);
  expect(overlap).toBe(false);
});

test("WB-9: uncertain/idle conversation metadata cannot grow without a bound", () => {
  const s = make();
  for (let i = 0; i < 256; i++) s.create(alice, "gpt");
  expect(() => s.create(alice, "gpt")).toThrow("capacity");
});

test("WB-9: retention also removes expired answer text from SQLite pages", async () => {
  const path = root();
  let now = Date.now();
  const answer = "EXPIRED_PRIVATE_ANSWER_".repeat(80);
  const s = new WebChatService({
    root: path,
    accounts: [
      {
        id: "gpt",
        service: "chatgpt",
        validatedVersion: "v",
        validatedService: "chatgpt" as const,
      },
    ],
    adapterVersion: "v",
    browser: {
      ...runner,
      run: async () => ({
        text: answer,
        turnId: "t",
        url: "https://chatgpt.com/c/test",
      }),
    },
    now: () => now,
  });
  services.push(s);
  const c = s.create(alice, "gpt"),
    r = s.send(alice, {
      conversationId: c.id,
      retryKey: "expiry",
      prompt: "p",
    });
  await until(() => s.result(alice, r.id).state === "completed");
  expect(
    readFileSync(join(path, "state.db")).includes(Buffer.from(answer)),
  ).toBe(true);
  now += 86_400_001;
  expect(s.result(alice, r.id).answer).toBeUndefined();
  expect(
    readFileSync(join(path, "state.db")).includes(Buffer.from(answer)),
  ).toBe(false);
});

test("WB-5: final thread URL survives restart and reaches the next browser run", async () => {
  const path = root();
  const finalUrl = "https://chatgpt.com/c/durable-thread";
  const s = make(path, {
    ...runner,
    run: async (_c, _prompt, _signal, submitted) => {
      submitted("u1", "https://chatgpt.com/");
      return { text: "OK", turnId: "a1", url: finalUrl };
    },
  });
  const c = s.create(alice, "gpt");
  const r = s.send(alice, { conversationId: c.id, retryKey: "1", prompt: "p" });
  await until(() => s.result(alice, r.id).state === "completed");
  expect(s.resume(alice, c.id).url).toBe(finalUrl);
  await s.shutdown();
  services.splice(services.indexOf(s), 1);
  let resumedUrl: string | undefined;
  const restarted = make(path, {
    ...runner,
    run: async (conversation, ...args) => {
      resumedUrl = conversation.url;
      return runner.run(conversation, ...args);
    },
  });
  const next = restarted.send(alice, {
    conversationId: c.id,
    retryKey: "2",
    prompt: "next",
  });
  await until(() => restarted.result(alice, next.id).state === "completed");
  expect(resumedUrl).toBe(finalUrl);
});

for (const closeFirst of [true, false])
  test(`WB-7: permanent close survives reconciliation (${closeFirst ? "close" : "answer"} first)`, async () => {
    let release!: (value: any) => void;
    let reconciliationSignal!: AbortSignal;
    const s = make(undefined, {
      ...runner,
      reconcile: async (_c, _r, signal) => {
        reconciliationSignal = signal;
        // Deliberately ignores abort: stale browser completion must never reopen a conversation.
        return await new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const c = s.create(alice, "gpt");
    const r = s.send(alice, {
      conversationId: c.id,
      retryKey: "1",
      prompt: "p",
    });
    await until(() => s.result(alice, r.id).state === "completed");
    const store = (s as any).store;
    const saved = store.request(r.id);
    saved.state = "unknown_submission";
    store.putRequest(saved);
    const pending = s.reconcile(alice, r.id);
    if (closeFirst) await s.close(alice, c.id);
    release({
      state: "completed",
      answer: {
        text: "late",
        turnId: "a2",
        url: "https://chatgpt.com/c/final",
      },
    });
    await pending;
    if (!closeFirst) {
      expect(s.resume(alice, c.id).url).toBe("https://chatgpt.com/c/final");
      await s.close(alice, c.id);
    } else expect(reconciliationSignal.aborted).toBe(true);
    expect(store.conversation(c.id)).toMatchObject({
      closed: true,
      blocked: true,
    });
    expect(() =>
      s.send(alice, { conversationId: c.id, retryKey: "2", prompt: "next" }),
    ).toThrow("closed");
  });

test("WB-10: a full private source is checked against a maximum safe prompt within a bounded time", () => {
  const s = make(undefined, runner, { promptChars: 64_000 });
  s.registerPrivateContent(randomBytes(720_000).toString("base64"));
  const c = s.create(alice, "gpt");
  const started = performance.now();
  s.send(alice, {
    conversationId: c.id,
    retryKey: "performance",
    prompt: "public ".repeat(9_000),
  });
  expect(performance.now() - started).toBeLessThan(500);
});

test("WB-10: private registry capacity warns once before full and preserves fail-closed recovery diagnostics", () => {
  const s = make();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const source = randomBytes(4032).toString("hex");
  s.registerPrivateContent(source);
  expect(warning).not.toHaveBeenCalled();
  try {
    expect(() => {
      for (let i = 0; i < 400; i++)
        s.registerPrivateContent(randomBytes(4032).toString("hex"));
    }).toThrow(
      "private source registry full (80000/80000 entries); restart the web-chat bridge or reduce registered boot content",
    );
    expect(warning).toHaveBeenCalledTimes(1);
    const diagnostic = JSON.parse(warning.mock.calls[0]![0]);
    expect(diagnostic).toEqual({
      event: "web_chat_private_registry_capacity",
      entries: 40001,
      limit: 80000,
    });
    expect(() =>
      s.registerPrivateContent("another new private source after the cap"),
    ).toThrow("restart the web-chat bridge");
    // Existing registrations survive overflow; nothing is evicted or silently skipped.
    const c = s.create(alice, "gpt");
    expect(() =>
      s.send(alice, {
        conversationId: c.id,
        retryKey: "overflow",
        prompt: source.slice(0, 64),
      }),
    ).toThrow("egress denied");
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
  }
});
