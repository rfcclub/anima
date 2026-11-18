import { test, expect } from "bun:test";
import { TelegramGateway } from "../src/channels/telegram-gateway";

function makeGateway() {
  return new TelegramGateway({
    botToken: "test-token",
    webhookSecret: "test-secret",
    log: () => {},
  });
}

test("validateSecret returns true for correct secret", () => {
  const gw = makeGateway();
  const req = new Request("http://localhost:3700/webhook/telegram", {
    headers: { "x-telegram-bot-api-secret-token": "test-secret" },
  });
  expect(gw.validateSecret(req)).toBe(true);
});

test("validateSecret returns false for wrong secret", () => {
  const gw = makeGateway();
  const req = new Request("http://localhost:3700/webhook/telegram", {
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
  });
  expect(gw.validateSecret(req)).toBe(false);
});

test("validateSecret returns false for missing header", () => {
  const gw = makeGateway();
  const req = new Request("http://localhost:3700/webhook/telegram");
  expect(gw.validateSecret(req)).toBe(false);
});

test("handleWebhook returns 401 for invalid secret", async () => {
  const gw = makeGateway();
  const req = new Request("http://localhost:3700/webhook/telegram", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
  });
  const resp = await gw.handleWebhook(req);
  expect(resp.status).toBe(401);
});

test("handleWebhook returns 400 for invalid JSON body", async () => {
  const gw = makeGateway();
  const req = new Request("http://localhost:3700/webhook/telegram", {
    method: "POST",
    headers: {
      "x-telegram-bot-api-secret-token": "test-secret",
      "content-type": "application/json",
    },
    body: "not json",
  });
  const resp = await gw.handleWebhook(req);
  expect(resp.status).toBe(400);
});

test("handleWebhook returns 200 for text message", async () => {
  const gw = makeGateway();
  const req = new Request("http://localhost:3700/webhook/telegram", {
    method: "POST",
    headers: {
      "x-telegram-bot-api-secret-token": "test-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 123, first_name: "Test" },
        chat: { id: 456, type: "private" },
        text: "@bruno hello",
      },
    }),
  });
  const resp = await gw.handleWebhook(req);
  expect(resp.status).toBe(200);
});
