import { expect, test } from "bun:test";
import type { RemoteRecallRequest } from "../../identity-runtime/src/index.js";
import { HttpAnimaContinuityClient } from "../src/anima-continuity-client.ts";

test("recall posts to ANIMA's Eli continuity endpoint", async () => {
  const request: RemoteRecallRequest = {
    grantId: "grant",
    stateHash: "state",
    query: "what happened?",
    substrateScope: "episodic_memory",
  };
  let received: { url: string; init: RequestInit } | undefined;
  const client = new HttpAnimaContinuityClient("http://127.0.0.1:3700/", async (url, init = {}) => {
    received = { url, init };
    return Response.json({
      resolution: { ok: true, requestedScope: "episodic_memory", memoryScopes: ["episode", "observation"] },
      results: [],
    });
  });

  await expect(client.recall(request)).resolves.toEqual({
    resolution: { ok: true, requestedScope: "episodic_memory", memoryScopes: ["episode", "observation"] },
    results: [],
  });
  expect(received?.url).toBe("http://127.0.0.1:3700/internal/continuity/eli/recall");
  expect(received?.init.method).toBe("POST");
  expect(JSON.parse(received?.init.body as string)).toEqual(request);
});
