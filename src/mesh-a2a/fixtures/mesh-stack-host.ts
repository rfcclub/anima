/**
 * Test host, run as a child process: the real colony-meshd gateway (A2A conversations, join,
 * list/send, jobs) and the real identity-runtime HTTP server, on temp databases and ports.
 * Continuity is a synthetic stand-in, so no ANIMA server is needed for an identity join.
 * Prints one JSON line `{ meshUrl, identityUrl }` once both listen.
 *
 * env: MESH_STACK_ROOT (temp dir), MESH_STACK_AGENTS (comma-separated roster), and optionally
 * MESH_STACK_COMPILE_GATE (dir): the first identity compile writes `compile-entered` there and waits
 * for `compile-release`, so a test can hold a join inside identity-runtime; MESH_STACK_ENROLL_GATE
 * (dir): the first enrollment identity-runtime sends to Mesh is held in a proxy (`enroll-entered`)
 * until `enroll-release` exists, then forwarded, as a request delayed in transit would be.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TenantIdentityRuntime, type TenantRuntimeTenant } from "@anima/identity-runtime/tenant-runtime";
import { startTenantIdentityRuntimeHttp } from "@anima/identity-runtime/tenant-http";
import { MeshEnrollmentClient } from "@anima/identity-runtime/mesh-enrollment";
import type { RemoteContinuityPort } from "../../identity-runtime/contract/remote-continuity.ts";

// colony-mesh does not export its daemon pieces; the test host reaches them by file.
const meshSrc = new URL("../../../node_modules/colony-mesh/src/a2a/", import.meta.url);
const { A2ARealtimeRuntime } = await import(new URL("realtime-runtime.ts", meshSrc).href);
const { createConfiguredMeshService } = await import(new URL("mesh-service-runtime.ts", meshSrc).href);
const { A2AGatewayServer } = await import(new URL("gateway-server.ts", meshSrc).href);

const root = process.env.MESH_STACK_ROOT!;
const agents = (process.env.MESH_STACK_AGENTS ?? "").split(",").filter(Boolean);
const keys = generateKeyPairSync("ed25519");
const gate = process.env.MESH_STACK_COMPILE_GATE;
let gated = false;
const enrollGate = process.env.MESH_STACK_ENROLL_GATE;
let enrollHeld = false;

const realtime = new A2ARealtimeRuntime(join(root, "mesh.db"));
const serviceCapability = crypto.randomUUID();
realtime.registerIdentity({ address: "mesh-service@local", capability: serviceCapability, leaseMs: 3_600_000 });
const meshService = createConfiguredMeshService({
  issuer: "identity-runtime",
  issuerKeys: { "identity-1": keys.publicKey },
  sender: { address: "mesh-service@local" },
  senderCredential: () => serviceCapability,
  agents: [],
  registryPath: join(root, "mesh-registry.db"),
}, realtime.service);
const gateway = new A2AGatewayServer(realtime.port, meshService, realtime.jobs);
const meshListener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => gateway.handle(request) });
const meshUrl = `http://127.0.0.1:${meshListener.port}`;

function continuity(agentId: string): RemoteContinuityPort {
  return {
    compile: async (input) => {
      if (gate && !gated) {
        gated = true;
        writeFileSync(join(gate, "compile-entered"), "entered");
        while (!existsSync(join(gate, "compile-release"))) await Bun.sleep(10);
      }
      return {
      projection: {
        prompt: "synthetic projection", promptStaticHash: "static", kernelVersion: "kernel", substrateViewVersion: "view",
        cartridgeVersions: {}, readScopes: [], writeScopes: [], proposalScopes: [], declaredSubstrateScopes: [], scopeDeclarationStatus: "none",
      },
      grant: {
        grantId: `grant-${agentId}`, identity: agentId, surfaceId: input.surfaceId, projectionId: "projection", stateHash: "state",
        writeScopes: [], issuedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
      },
    };
    },
    remember: async () => ({ id: "unused", createdAt: new Date().toISOString() }),
    recall: async () => { throw new Error("unused"); },
    directRecall: async () => [],
  } as RemoteContinuityPort;
}

// identity-runtime reaches Mesh through this proxy, which can hold the first enrollment.
const identityMesh = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    const body = await request.text();
    const holding = Boolean(enrollGate && url.pathname === "/mesh/v1/join" && !enrollHeld);
    if (holding) {
      enrollHeld = true;
      writeFileSync(join(enrollGate!, "enroll-entered"), "entered");
      while (!existsSync(join(enrollGate!, "enroll-release"))) await Bun.sleep(5);
    }
    const response = await fetch(`${meshUrl}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, ...(body ? { body } : {}) });
    if (holding) writeFileSync(join(enrollGate!, `enroll-forwarded-${response.status}`), "done");
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  },
});

const tenants = new Map<string, TenantRuntimeTenant>(agents.map((agent) => [agent, { continuity: continuity(agent) }]));
const identity = new TenantIdentityRuntime({
  dbPath: join(root, "identity-runtime.db"),
  tenants,
  log: () => {},
  meshEnrollment: new MeshEnrollmentClient({ meshUrl: `http://127.0.0.1:${identityMesh.port}`, issuer: "identity-runtime", kid: "identity-1", privateKey: keys.privateKey }),
});
const identityServer = startTenantIdentityRuntimeHttp(identity, "127.0.0.1", 0);

console.log(JSON.stringify({ meshUrl, identityUrl: identityServer.url.origin }));
