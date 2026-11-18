import { describe, expect, test } from "bun:test";
import { HttpAnimaTenantContinuityClient } from "../src/anima-continuity-client.ts";
import { RememberRejectedError } from "../../../src/identity-runtime/contract/remote-continuity.ts";

describe("HttpAnimaTenantContinuityClient", () => {
  test("uses its configured tenant path and refuses a body-selected identity", async () => {
    const requests: string[] = [];
    const client = new HttpAnimaTenantContinuityClient(
      "http://anima/",
      "eli",
      async (input) => {
        requests.push(input);
        return Response.json({ ok: true });
      },
    );

    await client.compile({ identity: "eli", surfaceId: "codex", message: "hello" });
    await client.remember({
      grantId: "grant",
      stateHash: "state",
      idempotencyKey: "remember",
      entry: { scope: "scent", content: "note", tags: [], confidence: 1, source: "test" },
    });
    await client.recall({
      grantId: "grant",
      stateHash: "state",
      query: "note",
      substrateScope: "episodic_memory",
    });

    expect(requests).toEqual([
      "http://anima/internal/continuity/eli/compile",
      "http://anima/internal/continuity/eli/remember",
      "http://anima/internal/continuity/eli/recall",
    ]);
    await expect(client.compile({
      identity: "bruno",
      surfaceId: "codex",
      message: "hello",
    })).rejects.toThrow("identity must match configured tenant");
  });

  test("forwards a direct recall to the tenant's own direct-recall path", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const client = new HttpAnimaTenantContinuityClient("http://anima", "abel", async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json([{ source: "memory", content: "hit" }]);
    });
    await expect(client.directRecall({ grantId: "g", stateHash: "s", query: "q" }))
      .resolves.toEqual([{ source: "memory", content: "hit" }]);
    expect(seen).toEqual([{ url: "http://anima/internal/continuity/abel/direct-recall", body: { grantId: "g", stateHash: "s", query: "q" } }]);
  });

  // SC-003: the flag on the wire becomes a typed error; an unflagged failure
  // must stay a plain Error so the runtime keeps the mutation pending.
  test("rethrows a rejectedBeforeWrite refusal as RememberRejectedError only when flagged", async () => {
    const request = {
      grantId: "grant", stateHash: "state", idempotencyKey: "remember",
      entry: { scope: "scent" as const, content: "note", tags: [], confidence: 1, source: "test" },
    };
    const flagged = new HttpAnimaTenantContinuityClient("http://anima", "eli", async () =>
      Response.json({ error: "remote remember stateHash is stale", rejectedBeforeWrite: true }, { status: 400 }));
    await expect(flagged.remember(request)).rejects.toBeInstanceOf(RememberRejectedError);
    await expect(flagged.remember(request)).rejects.toThrow("remote remember stateHash is stale");

    const unflagged = new HttpAnimaTenantContinuityClient("http://anima", "eli", async () =>
      Response.json({ error: "disk full" }, { status: 400 }));
    const error = await unflagged.remember(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RememberRejectedError);
  });
});
