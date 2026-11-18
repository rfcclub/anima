import { expect, test } from "bun:test";
import { handleRequest } from "../../../src/server";

test("CORE-2 regression: cross-origin requests get 403 forbidden before route parsing", async () => {
  const response = await handleRequest(new Request("http://127.0.0.1:3700/api/mesh/notify", {
    method: "POST",
    headers: { host: "127.0.0.1:3700", origin: "http://evil.example", "content-type": "application/json" },
    body: "invalid JSON: route must never parse this",
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "origin_not_allowed" });
});

test("CORE-4 regression: DNS-rebinding Host gets 403 forbidden before health", async () => {
  const response = await handleRequest(new Request("http://evil.example:3700/health", {
    headers: { host: "evil.example:3700" },
  }));
  expect(response.status).toBe(403);
});
