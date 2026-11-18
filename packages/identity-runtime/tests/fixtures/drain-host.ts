import { TenantIdentityRuntime } from "../../src/tenant-runtime.ts";
import { startTenantIdentityRuntimeHttp } from "../../src/tenant-http.ts";
import { installRuntimeShutdown } from "../../src/lifecycle.ts";
import type { RemoteContinuityPort } from "../../../../src/identity-runtime/contract/remote-continuity.ts";

export function fakeContinuity(remember?: RemoteContinuityPort["remember"]): RemoteContinuityPort {
  return {
    compile: async input => ({
      projection: { prompt: "synthetic projection", promptStaticHash: "static", kernelVersion: "kernel", substrateViewVersion: "view", cartridgeVersions: {}, readScopes: [], writeScopes: ["observation"], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "none" },
      grant: { grantId: "grant", identity: "eli", surfaceId: input.surfaceId, projectionId: "projection", stateHash: "state", writeScopes: ["observation"], issuedAt: Date.now(), expiresAt: Date.now() + 60000 },
    }),
    remember: remember ?? (async () => ({ id: "saved", createdAt: new Date().toISOString() })),
    recall: async () => { throw new Error("unused"); },
    directRecall: async () => [],
  };
}

if (import.meta.main) {
  const runtime = new TenantIdentityRuntime({ dbPath: process.env.TEST_RUNTIME_DB!, log: () => {}, tenants: new Map([["eli", { continuity: fakeContinuity(async () => {
    console.log("mutation-started");
    await new Promise(resolve => setTimeout(resolve, process.env.TEST_HANG === "1" ? 60000 : 100));
    return { id: "saved", createdAt: new Date().toISOString() };
  }) }]]) });
  const server = startTenantIdentityRuntimeHttp(runtime, "127.0.0.1", 0);
  installRuntimeShutdown({ runtime, server, timeoutMs: 300 });
  console.log(JSON.stringify({ origin: server.url.origin }));
}
