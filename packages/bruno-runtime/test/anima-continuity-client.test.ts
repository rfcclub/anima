import { describe, expect, test } from "bun:test";
import type { ActiveJoinIntent, RemoteRememberRequest } from "../../identity-runtime/src/index.js";
import type { RuntimeProjection } from "../../../src/identity-runtime/contract/runtime-projection.ts";
import type { ProjectionGrant } from "../../../src/identity-runtime/contract/projection-grant.js";
import { HttpBrunoContinuityClient, type Fetcher } from "../src/anima-continuity-client";

function recordingFetch(respondWith: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: Fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    return respondWith(url, init);
  };
  return { fetcher, calls };
}

const INTENT: ActiveJoinIntent = { identity: "bruno", surfaceId: "surface", message: "hello" };
const REMEMBER: RemoteRememberRequest = {
  grantId: "grant", stateHash: "state", idempotencyKey: "key",
  entry: { scope: "observation", content: "memory", tags: [], confidence: 1, source: "test" },
};

describe("HttpBrunoContinuityClient", () => {
  test("compile posts the join intent to ANIMA's bruno continuity endpoint", async () => {
    const projection: RuntimeProjection = { prompt: "Bruno projection", promptStaticHash: "static", kernelVersion: "kernel", cartridgeVersions: {}, substrateViewVersion: "view", readScopes: [], writeScopes: ["scent"], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "unimplemented" };
    const grant: ProjectionGrant = { grantId: "grant", identity: "bruno", surfaceId: "surface", projectionId: "projection", stateHash: "state", writeScopes: ["scent"], issuedAt: 1, expiresAt: 2 };
    const { fetcher, calls } = recordingFetch(() => Response.json({ projection, grant }));
    const client = new HttpBrunoContinuityClient("http://127.0.0.1:3700/", fetcher);

    const result = await client.compile(INTENT);

    expect(result).toEqual({ projection, grant });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:3700/internal/continuity/bruno/compile");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(calls[0].init.body as string)).toEqual(INTENT);
  });

  test("remember posts to ANIMA's bruno continuity endpoint", async () => {
    const { fetcher, calls } = recordingFetch(() => Response.json({ id: "memory-1", createdAt: "now" }));
    const client = new HttpBrunoContinuityClient("http://127.0.0.1:3700", fetcher);

    const result = await client.remember(REMEMBER);

    expect(result).toEqual({ id: "memory-1", createdAt: "now" });
    expect(calls[0].url).toBe("http://127.0.0.1:3700/internal/continuity/bruno/remember");
    expect(JSON.parse(calls[0].init.body as string)).toEqual(REMEMBER);
  });

  test("a non-ok response surfaces ANIMA's error payload", async () => {
    const { fetcher } = recordingFetch(() => Response.json({ error: "projection grant is unavailable" }, { status: 409 }));
    const client = new HttpBrunoContinuityClient("http://127.0.0.1:3700", fetcher);

    await expect(client.remember(REMEMBER)).rejects.toThrow("projection grant is unavailable");
  });
});
