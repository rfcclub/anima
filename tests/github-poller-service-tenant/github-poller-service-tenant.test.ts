import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RemoteCompileResult,
  RemoteContinuityPort,
} from "../../src/identity-runtime/contract/remote-continuity.ts";
import { createDefaultTenantDefinitions } from "../../packages/identity-runtime/src/default-tenants.ts";
import { StaticServiceContinuity } from "../../packages/identity-runtime/src/service-continuity.ts";
import { TenantIdentityRuntime } from "../../packages/identity-runtime/src/tenant-runtime.ts";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

/** An agent continuity port that counts compile calls and never touches a real model. */
function agentContinuity(prompt: string) {
  const calls = { compile: 0 };
  const port: RemoteContinuityPort = {
    async compile(): Promise<RemoteCompileResult> {
      calls.compile += 1;
      return {
        projection: {
          prompt,
          promptStaticHash: "static-hash",
          kernelVersion: "kernel",
          cartridgeVersions: { core: "1" },
          substrateViewVersion: "substrate-view",
          readScopes: [],
          writeScopes: [],
          proposalScopes: [],
          declaredSubstrateScopes: [],
          scopeDeclarationStatus: "none",
        },
        grant: {
          grantId: "grant-1",
          identity: "bruno",
          surfaceId: "claude",
          projectionId: "projection-1",
          stateHash: "state-1",
          writeScopes: [],
          readScopes: [],
          issuedAt: 1_000,
          expiresAt: 1_000_000,
        },
      };
    },
    async remember() {
      throw new Error("not used");
    },
    async recall() {
      throw new Error("not used");
    },
  };
  return { port, calls };
}

function sessionKinds(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    return (db.query("SELECT kind FROM identity_runtime_sessions").all() as Array<{ kind: string }>)
      .map((row) => row.kind);
  } finally {
    db.close();
  }
}

function serviceRuntime(dbPath: string, mesh?: { registerRecipient: (r: unknown) => void }) {
  return new TenantIdentityRuntime({
    dbPath,
    tenants: new Map([[
      "github-poller",
      {
        kind: "service" as const,
        continuity: new StaticServiceContinuity("github-poller"),
        ...(mesh ? { mesh } : {}),
      },
    ]]),
    now: () => 1_000,
    idGenerator: sequence("id"),
  });
}

describe("service tenant admission", () => {
  test("an omitted kind resolves as an agent", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const dbPath = join(root, "runtime.db");
    const agent = agentContinuity("agent prompt");
    const runtime = new TenantIdentityRuntime({
      dbPath,
      tenants: new Map([["bruno", { continuity: agent.port }]]),
      now: () => 1_000,
      idGenerator: sequence("id"),
    });

    await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "join" });

    expect(sessionKinds(dbPath)).toEqual(["agent"]);
  });

  test("an explicit service kind is preserved across joins", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const dbPath = join(root, "runtime.db");
    const runtime = serviceRuntime(dbPath);

    await runtime.join("github-poller", { clientId: "poller", surfaceId: "poller", message: "join" });
    await runtime.join("github-poller", { clientId: "poller", surfaceId: "poller", message: "join" });

    expect(sessionKinds(dbPath)).toEqual(["service", "service"]);
  });

  test("a service join issues no compile request", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const dbPath = join(root, "runtime.db");
    const service = new StaticServiceContinuity("github-poller");
    const runtime = new TenantIdentityRuntime({
      dbPath,
      tenants: new Map([["github-poller", { kind: "service" as const, continuity: service }]]),
      now: () => 1_000,
      idGenerator: sequence("id"),
    });

    // Reaching the port at all is a failure: it refuses instead of returning a fake projection.
    await expect(service.compile()).rejects.toThrow("service tenants are not compiled");

    const joined = await runtime.join("github-poller", {
      clientId: "poller", surfaceId: "poller", message: "join",
    });
    expect(joined.kernelVersion).toBe("service-static");
  });

  test("a service join performs no memory write", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const service = new StaticServiceContinuity("github-poller");
    await expect(service.remember({} as never)).rejects.toThrow("service tenants have no memory");
    await expect(service.recall({} as never)).rejects.toThrow("service tenants have no recall");

    const runtime = serviceRuntime(join(root, "runtime.db"));
    const joined = await runtime.join("github-poller", {
      clientId: "poller", surfaceId: "poller", message: "join",
    });

    expect(joined.writeScopes).toEqual([]);
    expect(runtime.health().tenants).toEqual([{ agentId: "github-poller", pendingMutations: 0 }]);
  });

  test("a service join still mints a lease and session", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const runtime = serviceRuntime(join(root, "runtime.db"));

    const joined = await runtime.join("github-poller", {
      clientId: "poller", surfaceId: "poller", message: "join",
    });

    expect(joined.leaseId).not.toBe("");
    expect(joined.sessionToken).not.toBe("");
    expect(joined.expiresAt).toBeGreaterThan(0);
  });

  test("a service tenant with a recall policy is refused", () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    expect(() => new TenantIdentityRuntime({
      dbPath: join(root!, "runtime.db"),
      tenants: new Map([[
        "github-poller",
        {
          kind: "service" as const,
          continuity: new StaticServiceContinuity("github-poller"),
          recallPolicy: { recall: async () => ({}) },
        },
      ]]),
    })).toThrow("service tenant must not declare a recall policy");
  });

  test("a service lease carries no memory write scope", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const runtime = serviceRuntime(join(root, "runtime.db"));

    const joined = await runtime.join("github-poller", {
      clientId: "poller", surfaceId: "poller", message: "join",
    });

    expect(joined.writeScopes).toEqual([]);
    expect(joined.declaredSubstrateScopes).toEqual([]);
  });

  test("an unregistered service is refused", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const dbPath = join(root, "runtime.db");
    const runtime = new TenantIdentityRuntime({
      dbPath,
      tenants: new Map([["bruno", { continuity: agentContinuity("p").port }]]),
      now: () => 1_000,
      idGenerator: sequence("id"),
    });

    await expect(runtime.join("github-poller", {
      clientId: "poller", surfaceId: "poller", message: "join",
    })).rejects.toThrow("identity tenant is not registered");
    expect(sessionKinds(dbPath)).toEqual([]);
  });

  test("a service join with an empty client is refused", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const dbPath = join(root, "runtime.db");
    const runtime = serviceRuntime(dbPath);

    await expect(runtime.join("github-poller", {
      clientId: "", surfaceId: "poller", message: "join",
    })).rejects.toThrow();
    expect(sessionKinds(dbPath)).toEqual([]);
  });

  test("a service join with a malformed installation hint is refused", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const registered: unknown[] = [];
    const runtime = serviceRuntime(join(root, "runtime.db"), {
      registerRecipient: (r: unknown) => { registered.push(r); },
    });

    await expect(runtime.join("github-poller", {
      clientId: "poller",
      surfaceId: "poller",
      message: "join",
      mesh: { harness: "poller", cwd: "", machine: "" } as never,
    })).rejects.toThrow();
    expect(registered).toEqual([]);
  });

  test("a service lease records its kind", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const dbPath = join(root, "runtime.db");
    const runtime = serviceRuntime(dbPath);

    await runtime.join("github-poller", { clientId: "poller", surfaceId: "poller", message: "join" });

    expect(sessionKinds(dbPath)).toEqual(["service"]);
  });

  test("the instance id is stable across restarts", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const ids: string[] = [];
    const mesh = { registerRecipient: (r: unknown) => { ids.push((r as { instance_id: string }).instance_id); } };

    for (const index of [1, 2]) {
      const runtime = new TenantIdentityRuntime({
        dbPath: join(root, `runtime-${index}.db`),
        tenants: new Map([[
          "github-poller",
          { kind: "service" as const, continuity: new StaticServiceContinuity("github-poller"), mesh },
        ]]),
        now: () => 1_000,
        idGenerator: sequence(`id${index}`),
      });
      await runtime.join("github-poller", { clientId: "poller", surfaceId: "poller", message: "join" });
    }

    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
  });

  test("distinct surfaces are distinct installments", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const ids: string[] = [];
    const mesh = { registerRecipient: (r: unknown) => { ids.push((r as { instance_id: string }).instance_id); } };
    const runtime = serviceRuntime(join(root, "runtime.db"), mesh);

    await runtime.join("github-poller", { clientId: "poller", surfaceId: "poller", message: "join" });
    await runtime.join("github-poller", { clientId: "poller", surfaceId: "poller-2", message: "join" });

    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("service tenant registration gate", () => {
  test("gate off keeps the default map unchanged", () => {
    const definitions = createDefaultTenantDefinitions({
      animaOrigin: "http://127.0.0.1:1",
      agentIds: ["bruno", "eli", "abel"],
      fetcher: async () => new Response("{}"),
    });

    expect(definitions.has("github-poller")).toBe(false);
    expect(definitions.size).toBe(3);
  });

  test("gate on registers exactly one service tenant", () => {
    const definitions = createDefaultTenantDefinitions({
      animaOrigin: "http://127.0.0.1:1",
      agentIds: ["bruno", "eli", "abel"],
      serviceTenants: [{ agentId: "github-poller" }],
      fetcher: async () => new Response("{}"),
    });

    const service = [...definitions.entries()].filter(([, tenant]) => tenant.kind === "service");
    expect(service.map(([id]) => id)).toEqual(["github-poller"]);
    expect([...definitions.entries()]
      .filter(([id]) => id !== "github-poller")
      .every(([, tenant]) => (tenant.kind ?? "agent") === "agent")).toBe(true);
  });

  test("an agent join response keeps compiled fields", async () => {
    root = mkdtempSync(join(tmpdir(), "service-tenant-"));
    const dbPath = join(root, "runtime.db");
    const agent = agentContinuity("agent prompt");
    const runtime = new TenantIdentityRuntime({
      dbPath,
      tenants: new Map([["bruno", { continuity: agent.port }]]),
      now: () => 1_000,
      idGenerator: sequence("id"),
    });

    const joined = await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "join" });

    expect(agent.calls.compile).toBe(1);
    expect(joined.kernelVersion).toBe("kernel");
    expect(joined.projectionId).toBe("projection-1");
    expect(joined.stateHash).toBe("state-1");
  });

  test("the agent tenant count is unchanged at registration", () => {
    const definitions = createDefaultTenantDefinitions({
      animaOrigin: "http://127.0.0.1:1",
      agentIds: ["bruno", "eli", "abel", "finn"],
      fetcher: async () => new Response("{}"),
    });

    expect(definitions.size).toBe(4);
    expect([...definitions.values()].every((tenant) => (tenant.kind ?? "agent") === "agent")).toBe(true);
  });
});
