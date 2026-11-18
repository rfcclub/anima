import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RememberRejectedError,
  type ActiveJoinIntent,
  type RemoteCompileResult,
  type RemoteContinuityPort,
  type RemoteRecallRequest,
  type RemoteRememberRequest,
} from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { LeaseStore } from "../../continuity-core/src/index.ts";
import { TenantIdentityRuntime } from "../src/tenant-runtime.ts";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("TenantIdentityRuntime", () => {
  test("joins Eli and Bruno as separate tenants and routes Eli recall only to Eli", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    const eli = createContinuity("eli");
    const bruno = createContinuity("bruno");
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        ["eli", { continuity: eli.port }],
        ["bruno", { continuity: bruno.port }],
      ]),
      now: () => 1_000,
      idGenerator: sequence("id"),
    });

    const eliJoin = await runtime.join("eli", {
      clientId: "eli-cli",
      surfaceId: "codex",
      message: "hello",
    });
    const brunoJoin = await runtime.join("bruno", {
      clientId: "bruno-cli",
      surfaceId: "claude",
      message: "hello",
    });

    expect(eliJoin).toMatchObject({
      leaseId: "id-1",
      sessionToken: "id-3",
      projection: "eli projection",
      kernelVersion: "kernel",
    });
    expect(brunoJoin).toMatchObject({
      leaseId: "id-4",
      sessionToken: "id-6",
      projection: "bruno projection",
      kernelVersion: "kernel",
    });
    expect(eli.compileCalls).toEqual(["eli"]);
    expect(bruno.compileCalls).toEqual(["bruno"]);

    await expect(runtime.recall({
      leaseId: eliJoin.leaseId,
      clientId: "eli-cli",
      sessionToken: eliJoin.sessionToken,
      stateHash: eliJoin.stateHash,
      query: "what happened?",
      substrateScope: "episodic_memory",
    })).resolves.toEqual({
      resolution: {
        ok: true,
        requestedScope: "episodic_memory",
        memoryScopes: ["episode", "observation"],
      },
      results: [],
    });
    expect(eli.recallCalls).toEqual([{
      grantId: "eli-grant",
      stateHash: "eli-state",
      query: "what happened?",
      substrateScope: "episodic_memory",
    }]);
    expect(bruno.recallCalls).toEqual([]);
    runtime.close();
  });

  // Requirement: an identity file changing silently between sessions must
  // be detectable, not invisible. kernelVersion (a
  // content hash of soul+gene, already computed by every compiler) now rides
  // in the join response so a client — or an operator — can compare it
  // across joins instead of only trusting that nothing changed.
  test("surfaces kernelVersion in the join response, and it changes when compiled identity content does", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    let currentKernelVersion = "kernel-v1";
    const bruno = createContinuity("bruno", {
      compile: async (input) => ({
        projection: {
          prompt: "bruno projection",
          promptStaticHash: "bruno-static",
          kernelVersion: currentKernelVersion,
          cartridgeVersions: {},
          substrateViewVersion: "view",
          readScopes: ["episode", "observation"],
          writeScopes: ["scent"],
          proposalScopes: [],
          declaredSubstrateScopes: ["episodic_memory"],
          scopeDeclarationStatus: "implemented",
        },
        grant: {
          grantId: "bruno-grant",
          identity: "bruno",
          surfaceId: input.surfaceId,
          projectionId: "bruno-projection",
          stateHash: "bruno-state",
          writeScopes: ["scent"],
          readScopes: ["episode", "observation"],
          declaredSubstrateScopes: ["episodic_memory"],
          scopeDeclarationStatus: "implemented",
          issuedAt: 1,
          expiresAt: 10_000,
        },
      }),
    });
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["bruno", { continuity: bruno.port }]]),
      now: () => 1_000,
    });

    const before = await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "hello" });
    expect(before.kernelVersion).toBe("kernel-v1");

    currentKernelVersion = "kernel-v2-someone-edited-soul-md";
    const after = await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "hello again" });
    expect(after.kernelVersion).toBe("kernel-v2-someone-edited-soul-md");
    expect(after.kernelVersion).not.toBe(before.kernelVersion);
    runtime.close();
  });

  // Requirement: kernelVersion (soul+gene
  // content hash) only detects a content edit — it does NOT change if
  // substrate.map.yaml itself changes (a scope's paths added/removed, or its
  // trust/weight retuned), so a compile-config change was silently
  // undetectable. AnimaProjectionCompiler already computes substrateViewVersion
  // (a hash of the resolved {relativePath, trust, weight} set) for exactly this
  // purpose, but it never left the process. Surface it in the join response the
  // same way kernelVersion was surfaced for P2.
  test("surfaces substrateViewVersion in the join response, and it changes when the compiled substrate config does (independent of kernelVersion)", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    let currentSubstrateViewVersion = "view-v1";
    const bruno = createContinuity("bruno", {
      compile: async (input) => ({
        projection: {
          prompt: "bruno projection",
          promptStaticHash: "bruno-static",
          kernelVersion: "kernel-stable",
          cartridgeVersions: {},
          substrateViewVersion: currentSubstrateViewVersion,
          readScopes: ["episode", "observation"],
          writeScopes: ["scent"],
          proposalScopes: [],
          declaredSubstrateScopes: ["episodic_memory"],
          scopeDeclarationStatus: "implemented",
        },
        grant: {
          grantId: "bruno-grant",
          identity: "bruno",
          surfaceId: input.surfaceId,
          projectionId: "bruno-projection",
          stateHash: "bruno-state",
          writeScopes: ["scent"],
          readScopes: ["episode", "observation"],
          declaredSubstrateScopes: ["episodic_memory"],
          scopeDeclarationStatus: "implemented",
          issuedAt: 1,
          expiresAt: 10_000,
        },
      }),
    });
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["bruno", { continuity: bruno.port }]]),
      now: () => 1_000,
    });

    const before = await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "hello" });
    expect(before.substrateViewVersion).toBe("view-v1");
    expect(before.kernelVersion).toBe("kernel-stable");

    currentSubstrateViewVersion = "view-v2-scope-added";
    const after = await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "hello again" });
    expect(after.substrateViewVersion).toBe("view-v2-scope-added");
    expect(after.substrateViewVersion).not.toBe(before.substrateViewVersion);
    // Content is untouched — kernelVersion must not move just because the
    // compile-config did. The two signals are independent.
    expect(after.kernelVersion).toBe("kernel-stable");
    runtime.close();
  });

  test("keeps a pending Eli mutation from blocking Bruno admission", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    let releaseEliRemember: (() => void) | undefined;
    const eli = createContinuity("eli", {
      remember: async () => new Promise((resolve) => {
        releaseEliRemember = () => resolve({ id: "eli-memory", createdAt: "now" });
      }),
    });
    const bruno = createContinuity("bruno");
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        ["eli", { continuity: eli.port }],
        ["bruno", { continuity: bruno.port }],
      ]),
      now: () => 1_000,
      idGenerator: sequence("id"),
    });
    const eliJoin = await runtime.join("eli", {
      clientId: "eli-cli",
      surfaceId: "codex",
      message: "hello",
    });
    const pending = runtime.remember({
      leaseId: eliJoin.leaseId,
      clientId: "eli-cli",
      sessionToken: eliJoin.sessionToken,
      stateHash: eliJoin.stateHash,
      idempotencyKey: "pending",
      entry: memoryEntry("eli"),
    });

    const brunoJoin = await runtime.join("bruno", {
      clientId: "bruno-cli",
      surfaceId: "claude",
      message: "hello",
    });

    expect(brunoJoin.projection).toBe("bruno projection");
    releaseEliRemember?.();
    await pending;
    runtime.close();
  });

  // Requirement: an external client's write must be
  // provenance-tagged, not indistinguishable from the agent's own memory.
  test("tags every remember with the joining client's clientId and surfaceId", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    const rememberedEntries: Array<{ tags?: string[]; metadata?: Record<string, unknown> }> = [];
    const bruno = createContinuity("bruno", {
      remember: async ({ entry }) => {
        rememberedEntries.push(entry);
        return { id: "m1", createdAt: "now" };
      },
    });
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["bruno", { continuity: bruno.port }]]),
      now: () => 1_000,
    });
    const joined = await runtime.join("bruno", { clientId: "windows-codex", surfaceId: "host-pc", message: "hello" });

    await runtime.remember({
      leaseId: joined.leaseId,
      clientId: "windows-codex",
      sessionToken: joined.sessionToken,
      stateHash: joined.stateHash,
      idempotencyKey: "k1",
      entry: memoryEntry("bruno"),
    });

    expect(rememberedEntries).toEqual([{
      ...memoryEntry("bruno"),
      tags: ["source-client:windows-codex", "source-surface:host-pc"],
      metadata: { sourceClientId: "windows-codex", sourceSurfaceId: "host-pc" },
    }]);
    runtime.close();
  });

  test("keeps an admitted tenant join alive when mesh registration fails", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        [
          "eli",
          {
            continuity: createContinuity("eli").port,
            mesh: {
              registerRecipient: () => {
                throw new Error("mesh unavailable");
              },
            },
          },
        ],
      ]),
      now: () => 1_000,
    });

    await expect(runtime.join("eli", {
      clientId: "eli-cli",
      surfaceId: "codex",
      message: "hello",
    })).resolves.toMatchObject({
      projection: "eli projection",
      sessionToken: expect.any(String),
    });
    runtime.close();
  });

  test("uses projection read scopes when an older ANIMA grant does not declare them", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    const continuity = createContinuity("eli");
    continuity.port.compile = async (input) => ({
      projection: {
        prompt: "eli projection",
        promptStaticHash: "static",
        kernelVersion: "kernel",
        cartridgeVersions: {},
        substrateViewVersion: "view",
        readScopes: ["episode", "observation"],
        writeScopes: ["scent"],
        proposalScopes: [],
        declaredSubstrateScopes: [],
        scopeDeclarationStatus: "unimplemented",
      },
      grant: {
        grantId: "grant",
        identity: "eli",
        surfaceId: input.surfaceId,
        projectionId: "projection",
        stateHash: "state",
        writeScopes: ["scent"],
        issuedAt: 1,
        expiresAt: 10_000,
      },
    });
    const dbPath = join(root, "runtime.db");
    const runtime = new TenantIdentityRuntime({
      dbPath,
      tenants: new Map([["eli", { continuity: continuity.port }]]),
      now: () => 1_000,
    });

    const joined = await runtime.join("eli", {
      clientId: "eli-cli",
      surfaceId: "codex",
      message: "hello",
    });
    const leases = new LeaseStore(dbPath);

    expect(leases.get(joined.leaseId)?.readScopes).toEqual(["episode", "observation"]);
    leases.close();
    runtime.close();
  });

  test("runs a direct recall policy only for the tenant that registered it", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    const policyQueries: string[] = [];
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        ["eli", { continuity: createContinuity("eli").port }],
        [
          "bruno",
          {
            continuity: createContinuity("bruno").port,
            recallPolicy: {
              recall: async (query) => {
                policyQueries.push(query);
                return [{ source: "bruno_entity", content: "Bruno memory" }];
              },
            },
          },
        ],
      ]),
      now: () => 1_000,
    });
    const eli = await runtime.join("eli", {
      clientId: "eli-cli",
      surfaceId: "codex",
      message: "hello",
    });
    const bruno = await runtime.join("bruno", {
      clientId: "bruno-cli",
      surfaceId: "claude",
      message: "hello",
    });

    await expect(runtime.directRecall({
      leaseId: bruno.leaseId,
      clientId: "bruno-cli",
      sessionToken: bruno.sessionToken,
      stateHash: bruno.stateHash,
      query: "what did I decide?",
    })).resolves.toEqual([{ source: "bruno_entity", content: "Bruno memory" }]);
    await expect(runtime.directRecall({
      leaseId: eli.leaseId,
      clientId: "eli-cli",
      sessionToken: eli.sessionToken,
      stateHash: eli.stateHash,
      query: "what did I decide?",
    })).rejects.toThrow("tenant direct recall is unavailable");
    expect(policyQueries).toEqual(["what did I decide?"]);
    runtime.close();
  });

  // SC-001/SC-004 (identity-runtime-mutation-recovery): a remember that ANIMA
  // refused BEFORE writing releases its pending row; any other failure is an
  // unknown outcome and keeps blocking join ("mutation recovery").
  describe("a remember that throws after the mutation was claimed", () => {
    async function rememberThatThrows(error: Error) {
      root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
      const runtime = new TenantIdentityRuntime({
        dbPath: join(root, "runtime.db"),
        tenants: new Map([["bruno", { continuity: createContinuity("bruno", {
          remember: async () => { throw error; },
        }).port }]]),
        now: () => 1_000,
      });
      const joined = await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "hello" });
      await expect(runtime.remember({
        leaseId: joined.leaseId,
        clientId: "bruno-cli",
        sessionToken: joined.sessionToken,
        stateHash: joined.stateHash,
        idempotencyKey: "k",
        entry: memoryEntry("bruno"),
      })).rejects.toThrow(error.message);
      return runtime;
    }

    test("releases the pending row when ANIMA proved nothing was written", async () => {
      const runtime = await rememberThatThrows(new RememberRejectedError("remote remember stateHash is stale"));

      await expect(runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "again" }))
        .resolves.toMatchObject({ projection: "bruno projection" });
      runtime.close();
    });

    test("keeps the pending row, and blocks join, when the outcome is unknown", async () => {
      const runtime = await rememberThatThrows(new Error("fetch failed"));

      await expect(runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "again" }))
        .rejects.toThrow("identity runtime mutation recovery required");
      runtime.close();
    });

    test("M2: pendingMutations lists the stuck row and abandonPendingMutation unblocks join", async () => {
      const runtime = await rememberThatThrows(new Error("fetch failed"));

      const pending = runtime.pendingMutations("bruno");
      expect(pending).toEqual([
        { leaseId: expect.any(String), operation: "remember", idempotencyKey: "k", createdAt: 1_000 },
      ]);

      runtime.abandonPendingMutation("bruno", pending[0].leaseId, "remember", "k");

      await expect(runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "again" }))
        .resolves.toMatchObject({ projection: "bruno projection" });
      runtime.close();
    });
  });

  // Eli and abel keep their memory in ANIMA, not in the runtime process, so with no
  // local policy their direct recall is forwarded through the continuity boundary.
  test("direct recall is forwarded to the tenant's continuity port when it has no local policy", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    const seen: Array<{ grantId: string; stateHash: string; query: string }> = [];
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: createContinuity("eli", {
        directRecall: async (request) => { seen.push(request); return [{ source: "eli_memory", content: "a decision" }]; },
      }).port }]]),
      now: () => 1_000,
    });
    const joined = await runtime.join("eli", { clientId: "eli-cli", surfaceId: "codex", message: "hello" });
    const auth = { leaseId: joined.leaseId, clientId: "eli-cli", sessionToken: joined.sessionToken };

    await expect(runtime.directRecall({ ...auth, stateHash: joined.stateHash, query: "what did I decide?" }))
      .resolves.toEqual([{ source: "eli_memory", content: "a decision" }]);
    expect(seen).toEqual([{ grantId: "eli-grant", stateHash: "eli-state", query: "what did I decide?" }]);

    await expect(runtime.directRecall({ ...auth, stateHash: "stale", query: "x" }))
      .rejects.toThrow("direct-recall stateHash is stale");
    expect(seen).toHaveLength(1);
    runtime.close();
  });

  // Regression: direct recall was the one read path with no
  // stateHash, so a caller could pull memory without proving which projection
  // state it was holding. recall/remember already refuse a stale hash.
  test("direct recall is fail-closed on a stale stateHash and never runs the policy", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
    const policyQueries: string[] = [];
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        ["bruno", {
          continuity: createContinuity("bruno").port,
          recallPolicy: { recall: async (query) => { policyQueries.push(query); return []; } },
        }],
      ]),
      now: () => 1_000,
    });
    const bruno = await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "hello" });

    await expect(runtime.directRecall({
      leaseId: bruno.leaseId,
      clientId: "bruno-cli",
      sessionToken: bruno.sessionToken,
      stateHash: "not-the-lease-state",
      query: "what did I decide?",
    })).rejects.toThrow("direct-recall stateHash is stale");
    expect(policyQueries).toEqual([]);
    runtime.close();
  });

  // Observability: diagnosis needed hand-written
  // probes because the runtime logged nothing beyond its two startup lines.
  describe("observability", () => {
    function captureLog(): { lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }>; log: NonNullable<import("../src/tenant-runtime.ts").TenantIdentityRuntimeOptions["log"]> } {
      const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
      return { lines, log: (level, msg, fields = {}) => { lines.push({ level, msg, fields }); } };
    }

    test("logs one line for a successful join", async () => {
      root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
      const { lines, log } = captureLog();
      const runtime = new TenantIdentityRuntime({
        dbPath: join(root, "runtime.db"),
        tenants: new Map([["bruno", { continuity: createContinuity("bruno").port }]]),
        now: () => 1_000,
        log,
      });

      await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "hello" });

      expect(lines).toEqual([
        { level: "info", msg: "join", fields: { agentId: "bruno", clientId: "bruno-cli", surfaceId: "claude", outcome: "ok" } },
      ]);
      runtime.close();
    });

    test("logs one error line when join fails, with the error message", async () => {
      root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
      const { lines, log } = captureLog();
      const runtime = new TenantIdentityRuntime({
        dbPath: join(root, "runtime.db"),
        tenants: new Map(),
        now: () => 1_000,
        log,
      });

      await expect(runtime.join("ghost", { clientId: "c", surfaceId: "s", message: "hello" })).rejects.toThrow();

      expect(lines).toEqual([
        { level: "error", msg: "join", fields: { agentId: "ghost", clientId: "c", surfaceId: "s", outcome: "error", error: "identity tenant is not registered" } },
      ]);
      runtime.close();
    });

    test("logs one line each for remember and recall", async () => {
      root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
      const { lines, log } = captureLog();
      const runtime = new TenantIdentityRuntime({
        dbPath: join(root, "runtime.db"),
        tenants: new Map([["bruno", { continuity: createContinuity("bruno").port }]]),
        now: () => 1_000,
        log,
      });
      const joined = await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "hello" });
      lines.length = 0;

      await runtime.remember({
        leaseId: joined.leaseId,
        clientId: "bruno-cli",
        sessionToken: joined.sessionToken,
        stateHash: joined.stateHash,
        idempotencyKey: "k1",
        entry: memoryEntry("bruno"),
      });
      await runtime.recall({
        leaseId: joined.leaseId,
        clientId: "bruno-cli",
        sessionToken: joined.sessionToken,
        stateHash: joined.stateHash,
        query: "what happened?",
        substrateScope: "episodic_memory",
      });

      expect(lines).toEqual([
        { level: "info", msg: "remember", fields: { agentId: "bruno", leaseId: joined.leaseId, clientId: "bruno-cli", outcome: "ok" } },
        { level: "info", msg: "recall", fields: { agentId: "bruno", leaseId: joined.leaseId, clientId: "bruno-cli", outcome: "ok" } },
      ]);
      runtime.close();
    });

    test("health() reports every registered tenant and its pending-mutation count", async () => {
      root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-"));
      const runtime = new TenantIdentityRuntime({
        dbPath: join(root, "runtime.db"),
        tenants: new Map([
          ["bruno", { continuity: createContinuity("bruno", {
            remember: async () => { throw new Error("fetch failed"); },
          }).port }],
          ["eli", { continuity: createContinuity("eli").port }],
        ]),
        now: () => 1_000,
      });

      expect(runtime.health()).toEqual({
        tenants: [
          { agentId: "bruno", pendingMutations: 0 },
          { agentId: "eli", pendingMutations: 0 },
        ],
      });

      const joined = await runtime.join("bruno", { clientId: "bruno-cli", surfaceId: "claude", message: "hello" });
      await expect(runtime.remember({
        leaseId: joined.leaseId,
        clientId: "bruno-cli",
        sessionToken: joined.sessionToken,
        stateHash: joined.stateHash,
        idempotencyKey: "k-stuck",
        entry: memoryEntry("bruno"),
      })).rejects.toThrow("fetch failed");

      expect(runtime.health()).toEqual({
        tenants: [
          { agentId: "bruno", pendingMutations: 1 },
          { agentId: "eli", pendingMutations: 0 },
        ],
      });
      runtime.close();
    });
  });
});

function createContinuity(
  identity: "eli" | "bruno",
  overrides: Partial<RemoteContinuityPort> = {},
): {
  port: RemoteContinuityPort;
  compileCalls: string[];
  recallCalls: RemoteRecallRequest[];
} {
  const compileCalls: string[] = [];
  const recallCalls: RemoteRecallRequest[] = [];
  const compile = async (input: ActiveJoinIntent): Promise<RemoteCompileResult> => {
    compileCalls.push(input.identity);
    return {
      projection: {
        prompt: `${identity} projection`,
        promptStaticHash: `${identity}-static`,
        kernelVersion: "kernel",
        cartridgeVersions: {},
        substrateViewVersion: "view",
        readScopes: ["episode", "observation"],
        writeScopes: ["scent"],
        proposalScopes: [],
        declaredSubstrateScopes: ["episodic_memory"],
        scopeDeclarationStatus: "implemented",
      },
      grant: {
        grantId: `${identity}-grant`,
        identity,
        surfaceId: input.surfaceId,
        projectionId: `${identity}-projection`,
        stateHash: `${identity}-state`,
        writeScopes: ["scent"],
        readScopes: ["episode", "observation"],
        declaredSubstrateScopes: ["episodic_memory"],
        scopeDeclarationStatus: "implemented",
        issuedAt: 1,
        expiresAt: 10_000,
      },
    };
  };
  const port: RemoteContinuityPort = {
    compile,
    remember: async (_request: RemoteRememberRequest) => ({ id: `${identity}-memory`, createdAt: "now" }),
    recall: async (request: RemoteRecallRequest) => {
      recallCalls.push(request);
      return {
        resolution: {
          ok: true,
          requestedScope: request.substrateScope,
          memoryScopes: ["episode", "observation"],
        },
        results: [],
      };
    },
    ...overrides,
  };
  return { port, compileCalls, recallCalls };
}

function memoryEntry(identity: string) {
  return {
    scope: "scent" as const,
    content: `${identity} memory`,
    tags: [],
    confidence: 1,
    source: "test",
  };
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

describe("TenantIdentityRuntime Mesh enrollment", () => {
  function meshPort() {
    const calls: Array<{ agentId: string; hint: unknown }> = [];
    return {
      calls,
      port: {
        enroll: async (agentId: string, hint: { harness: string; cwd: string; machine: string }) => {
          calls.push({ agentId, hint });
          return { status: "enrolled" as const, meshId: `${agentId}-omp-x@mac`, leaseExpiresAt: 9, heartbeatCredential: "hb" };
        },
        proof: (agentId: string) => `proof-for-${agentId}`,
      },
    };
  }
  const hint = { harness: "omp", cwd: "/work/eli", machine: "mac" };

  test("adds the Mesh result to join only when enrollment is configured and the join names its installation", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-mesh-"));
    const mesh = meshPort();
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: createContinuity("eli").port }]]),
      now: () => 1_000, idGenerator: sequence("id"), meshEnrollment: mesh.port,
    });
    const enrolled = await runtime.join("eli", { clientId: "cli", surfaceId: "omp", message: "hello", mesh: hint });
    expect(enrolled).toMatchObject({ sessionToken: expect.any(String), meshEnrollment: { status: "enrolled", meshId: "eli-omp-x@mac", heartbeatCredential: "hb" } });
    expect(mesh.calls).toEqual([{ agentId: "eli", hint }]);
    const plain = await runtime.join("eli", { clientId: "cli", surfaceId: "omp", message: "hello" });
    expect("meshEnrollment" in plain).toBe(false);
    expect(mesh.calls).toHaveLength(1);
    runtime.close();

    const unconfigured = new TenantIdentityRuntime({
      dbPath: join(root, "runtime-off.db"),
      tenants: new Map([["eli", { continuity: createContinuity("eli").port }]]),
      now: () => 1_000, idGenerator: sequence("off"),
    });
    expect("meshEnrollment" in await unconfigured.join("eli", { clientId: "cli", surfaceId: "omp", message: "hello", mesh: hint })).toBe(false);
    unconfigured.close();
  });

  test("a join whose Mesh deadline passed by enrollment time does not enroll", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-mesh-deadline-"));
    const mesh = meshPort();
    let clock = 1_000;
    const base = createContinuity("eli");
    // A slow compile: the deadline is checked when enrollment would start, not when the join arrived.
    const continuity = { ...base.port, compile: async (input: ActiveJoinIntent) => { const compiled = await base.port.compile(input); clock = 2_000; return compiled; } };
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity }]]),
      now: () => clock, idGenerator: sequence("id"), meshEnrollment: mesh.port,
    });
    const late = await runtime.join("eli", { clientId: "cli", surfaceId: "omp", message: "hello", mesh: { ...hint, notAfter: 1_500 } });
    expect(late.meshEnrollment).toEqual({ status: "expired" });
    expect(mesh.calls).toEqual([]);
    clock = 1_000;
    const onTime = await runtime.join("eli", { clientId: "cli", surfaceId: "omp", message: "hello", mesh: { ...hint, notAfter: 2_000 } });
    expect(onTime.meshEnrollment).toMatchObject({ status: "enrolled" });
    expect(mesh.calls).toHaveLength(1);
    runtime.close();
  });

  test("rejects invalid installation metadata before minting a lease", async () => {
    root = mkdtempSync(join(tmpdir(), "tenant-identity-runtime-mesh-invalid-"));
    const mesh = meshPort();
    const continuity = createContinuity("eli");
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: continuity.port }]]),
      now: () => 1_000, idGenerator: sequence("id"), meshEnrollment: mesh.port,
    });
    await expect(runtime.join("eli", { clientId: "cli", surfaceId: "omp", message: "hello", mesh: { ...hint, cwd: "" } })).rejects.toThrow("mesh installation is invalid");
    expect(continuity.compileCalls).toEqual([]);
    expect(mesh.calls).toEqual([]);
    runtime.close();
  });
});
