import { expect, test } from "bun:test";
import { WebChatClient } from "../../src/web-chat/client";

const owner = { agent: "fixture", session: "s" };
test("WB-10: registration receipts dedupe concurrent boot, retry failures and belong to one bridge lifetime", async () => {
  const client = new WebChatClient("/unused-fixture", new Uint8Array(32));
  const chunks: string[] = [];
  let fail = true;
  client.call = async (_owner, operation) => {
    chunks.push((operation as any).content);
    if (fail) throw Error("fixture transport loss");
    await Bun.sleep(5);
  };
  const boot = "sensitive-boot-".repeat(1000);
  await expect(client.registerPrivateContent(owner, [boot])).rejects.toThrow(
    "transport loss",
  );
  fail = false;
  await Promise.all([
    client.registerPrivateContent(owner, [boot]),
    client.registerPrivateContent(owner, [boot]),
  ]);
  expect(chunks).toHaveLength(3); // failed first chunk, successful retry and second overlapping chunk
  expect(chunks[1]!.slice(8000)).toBe(chunks[2]!.slice(0, 64));
  await client.registerPrivateContent(owner, [boot]);
  expect(chunks).toHaveLength(3);
  await client.registerPrivateContent(owner, [boot + "changed"]);
  expect(chunks).toHaveLength(4);
  const replacement = new WebChatClient(
    "/replacement-fixture",
    new Uint8Array(32),
  );
  let replacementCalls = 0;
  replacement.call = async () => {
    replacementCalls++;
  };
  await replacement.registerPrivateContent(owner, [boot]);
  expect(replacementCalls).toBe(2);
});

test("WB-10: client capacity has actionable recovery without sending unregistered content", async () => {
  const client = new WebChatClient("/unused-fixture", new Uint8Array(32));
  let calls = 0;
  client.call = async () => {
    calls++;
  };
  for (let i = 0; i < 40_000; i++)
    await client.registerPrivateContent(owner, [
      "synthetic private boot source " + i,
    ]);
  await expect(
    client.registerPrivateContent(owner, ["new synthetic boot source"]),
  ).rejects.toThrow(
    "private source registry full (40000/40000 chunks); restart the web-chat bridge or reduce registered boot content",
  );
  expect(calls).toBe(40_000);
});
