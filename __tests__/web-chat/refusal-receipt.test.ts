import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebChatService } from "../../src/web-chat/service";
import type { BrowserRunner, ChatOwner } from "../../src/web-chat/types";

const alice: ChatOwner = { agent: "finn", session: "session-a" };
const bob: ChatOwner = { agent: "pia", session: "session-b" };
const roots: string[] = [];
const services: WebChatService[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), "anima-webchat-refusal-"));
  roots.push(p);
  return p;
};
const SECRET_PROMPT =
  "sk-" + "abcdefghijklmnopqrstuvwxyz123456" + " is my key, do not send it";
const PRIVATE_PROMPT =
  "the registered private sentence that must never leave this host";

function setup(path = root()) {
  let sent = 0;
  const browser: BrowserRunner = {
    run: async () => {
      sent++;
      return { text: "answer", turnId: "t", url: "https://chatgpt.com/c/x" };
    },
    close: async () => {},
  };
  const service = new WebChatService({
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
  });
  services.push(service);
  return { service, sent: () => sent };
}
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

test("WB-10: a refused send leaves a content-free receipt and never reaches the browser", () => {
  const { service: s, sent } = setup();
  s.registerPrivateContent(PRIVATE_PROMPT);
  const c = s.create(alice, "gpt");
  expect(() =>
    s.send(alice, { conversationId: c.id, retryKey: "secret", prompt: SECRET_PROMPT }),
  ).toThrow("egress denied");
  expect(() =>
    s.send(alice, {
      conversationId: c.id,
      retryKey: "private",
      prompt: "context: " + PRIVATE_PROMPT,
    }),
  ).toThrow("egress denied");
  expect(sent()).toBe(0);

  const refusals = s.history(alice).refusals;
  expect(refusals).toHaveLength(2);
  expect(refusals.map((r) => r.category)).toEqual(["secret", "private_source"]);
  for (const receipt of refusals) {
    expect(receipt).toMatchObject({
      owner: alice,
      conversationId: c.id,
      account: "gpt",
      service: "chatgpt",
    });
    expect(typeof receipt.id).toBe("string");
    expect(receipt.at).toBeGreaterThan(0);
    // The receipt proves a refusal happened without carrying what was refused.
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain(PRIVATE_PROMPT);
    expect(Object.keys(receipt).sort()).toEqual([
      "account",
      "at",
      "category",
      "conversationId",
      "id",
      "owner",
      "promptLength",
      "service",
    ]);
  }
  expect(refusals[0]!.promptLength).toBe(SECRET_PROMPT.length);
  // A refused send creates no request row: nothing was submitted.
  expect(s.history(alice).requests).toHaveLength(0);
});

test("WB-10: refusal receipts belong to their owner and survive a bridge restart", async () => {
  const path = root();
  const { service: s } = setup(path);
  const c = s.create(alice, "gpt");
  expect(() =>
    s.send(alice, { conversationId: c.id, retryKey: "secret", prompt: SECRET_PROMPT }),
  ).toThrow("egress denied");
  const [receipt] = s.history(alice).refusals;
  await s.shutdown();
  services.splice(services.indexOf(s), 1);

  const again = setup(path);
  expect(again.service.history(alice).refusals).toEqual([receipt]);
  expect(again.service.history(bob).refusals).toEqual([]);
  // Fail closed: the receipt grants no permission to resend the same content.
  expect(() =>
    again.service.send(alice, {
      conversationId: c.id,
      retryKey: "secret",
      prompt: SECRET_PROMPT,
    }),
  ).toThrow("egress denied");
  const db = readFileSync(join(again.service["store"].root, "state.db"));
  expect(db.includes(Buffer.from('"prompt":'))).toBe(false);
  expect(db.includes(Buffer.from(SECRET_PROMPT))).toBe(false);
});

test("WB-10: refusal receipts are bounded so refusal spam cannot grow state", () => {
  const { service: s } = setup();
  const c = s.create(alice, "gpt");
  for (let i = 0; i < 140; i++)
    expect(() =>
      s.send(alice, {
        conversationId: c.id,
        retryKey: `secret-${i}`,
        prompt: SECRET_PROMPT,
      }),
    ).toThrow("egress denied");
  const refusals = s.history(alice).refusals;
  expect(refusals).toHaveLength(128);
  expect(refusals.length).toBeLessThan(140);
  // Retention keeps the newest receipts, in order.
  expect(refusals.map((r) => r.promptLength)).toEqual(
    Array.from({ length: 128 }, () => SECRET_PROMPT.length),
  );
});
