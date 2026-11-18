import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RememberRejectedError } from "./contract/remote-continuity.ts";
import type { RuntimeProjection } from "./contract/runtime-projection.ts";
import { AnimaContinuityService } from "./continuity-service";
import { ProjectionGrantStore } from "./projection-grant-store";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const projection: RuntimeProjection = {
  prompt: "Eli projection",
  promptStaticHash: "static-1",
  kernelVersion: "kernel-1",
  cartridgeVersions: {},
  substrateViewVersion: "view-1",
  readScopes: ["episode", "observation"],
  writeScopes: ["scent"],
  proposalScopes: [],
  declaredSubstrateScopes: ["episodic_memory"],
  scopeDeclarationStatus: "implemented",
};

function createService(projectionOverride: RuntimeProjection = projection) {
  root = mkdtempSync(join(tmpdir(), "continuity-service-"));
  const grantStore = new ProjectionGrantStore(join(root, "continuity.db"));
  const remembered: string[] = [];
  const recalled: Array<{ query: string; scopes: readonly string[] }> = [];
  const service = new AnimaContinuityService({
    identity: "eli",
    grantStore,
    now: () => 1_000,
    grantTtlMs: 1_000,
    idGenerator: () => "grant-1",
    compileProjection: async () => projectionOverride,
    canonicalStateHash: () => "state-1",
    remember: async ({ entry }) => {
      remembered.push(entry.content);
      return { id: "memory-1", createdAt: "2026-07-17T00:00:00.000Z" };
    },
    recall: async ({ query }, scopes) => {
      recalled.push({ query, scopes });
      return [{
        id: "episode-1", content: "the runtime joined", scope: "episode", tags: [],
        confidence: 1, source: "test", createdAt: "2026-07-17T00:00:00.000Z",
      }];
    },
  });
  return { service, grantStore, remembered, recalled };
}

describe("AnimaContinuityService", () => {
  test("compiles Eli and stores an ANIMA-owned grant", async () => {
    const { service, grantStore } = createService();

    const result = await service.compile({
      identity: "eli",
      surfaceId: "windows-codex",
      message: "Review the runtime.",
    });

    expect(result.projection).toEqual(projection);
    expect(result.grant).toMatchObject({
      grantId: "grant-1",
      identity: "eli",
      surfaceId: "windows-codex",
      stateHash: "state-1",
      writeScopes: ["scent"],
      readScopes: ["episode", "observation"],
      declaredSubstrateScopes: ["episodic_memory"],
      scopeDeclarationStatus: "implemented",
      expiresAt: 2_000,
    });
    expect(grantStore.getActive("grant-1", 1_000)).toEqual(result.grant);
    grantStore.close();
  });

  test("rejects cross-identity and bounded remember violations before writing", async () => {
    const { service, grantStore, remembered } = createService();
    await service.compile({ identity: "eli", surfaceId: "windows-codex", message: "Review." });

    await expect(service.compile({ identity: "bruno", surfaceId: "windows-codex", message: "Review." }))
      .rejects.toThrow("active join identity does not match ANIMA continuity identity");
    await expect(service.remember({
      grantId: "grant-1",
      stateHash: "state-1",
      idempotencyKey: "remember-1",
      entry: { scope: "identity", content: "forbidden", tags: [], confidence: 1, source: "test" },
    })).rejects.toThrow("projection grant does not allow requested write scopes");
    expect(remembered).toEqual([]);

    await expect(service.remember({
      grantId: "grant-1",
      stateHash: "state-1",
      idempotencyKey: "remember-2",
      entry: { scope: "scent", content: "allowed", tags: [], confidence: 1, source: "test" },
    })).resolves.toEqual({ id: "memory-1", createdAt: "2026-07-17T00:00:00.000Z" });
    expect(remembered).toEqual(["allowed"]);
    grantStore.close();
  });

  test("recalls through the declared episodic scope and forwards mapped memory scopes", async () => {
    const { service, grantStore, recalled } = createService();
    await service.compile({ identity: "eli", surfaceId: "windows-codex", message: "Review." });

    await expect(service.recall({
      grantId: "grant-1",
      stateHash: "state-1",
      query: "what joined?",
      substrateScope: "episodic_memory",
    })).resolves.toEqual({
      resolution: { ok: true, requestedScope: "episodic_memory", memoryScopes: ["episode", "observation"] },
      results: [{
        id: "episode-1", content: "the runtime joined", scope: "episode", tags: [],
        confidence: 1, source: "test", createdAt: "2026-07-17T00:00:00.000Z",
      }],
    });
    expect(recalled).toEqual([{ query: "what joined?", scopes: ["episode", "observation"] }]);
    grantStore.close();
  });

  test("returns a structured rejection without calling the memory store for an undeclared scope", async () => {
    const { service, grantStore, recalled } = createService();
    await service.compile({ identity: "eli", surfaceId: "windows-codex", message: "Review." });

    await expect(service.recall({
      grantId: "grant-1",
      stateHash: "state-1",
      query: "must not leak",
      substrateScope: "current_state",
    })).resolves.toEqual({
      resolution: {
        ok: false,
        requestedScope: "current_state",
        diagnostic: {
          code: "undeclared_scope",
          message: 'Scope "current_state" is not declared by this cartridge.',
        },
      },
      results: [],
    });
    expect(recalled).toEqual([]);
    grantStore.close();
  });

  test("returns a structured rejection when the mapped memory scope is not granted", async () => {
    const { service, grantStore, recalled } = createService({ ...projection, readScopes: ["episode"] });
    await service.compile({ identity: "eli", surfaceId: "windows-codex", message: "Review." });

    await expect(service.recall({
      grantId: "grant-1",
      stateHash: "state-1",
      query: "must not leak",
      substrateScope: "episodic_memory",
    })).resolves.toEqual({
      resolution: {
        ok: false,
        requestedScope: "episodic_memory",
        diagnostic: {
          code: "read_scope_not_granted",
          message: 'Scope "episodic_memory" resolves to a memory scope outside the grant read capability.',
        },
      },
      results: [],
    });
    expect(recalled).toEqual([]);
    grantStore.close();
  });

  test("rejects a grant when ANIMA canonical state has moved", async () => {
    root = mkdtempSync(join(tmpdir(), "continuity-service-"));
    const grantStore = new ProjectionGrantStore(join(root, "continuity.db"));
    const service = new AnimaContinuityService({
      identity: "eli",
      grantStore,
      now: () => 1_000,
      idGenerator: () => "grant-1",
      compileProjection: async () => projection,
      canonicalStateHash: () => "state-1",
      claimCurrentState: () => undefined,
      remember: async () => ({ id: "memory-1", createdAt: "2026-07-17T00:00:00.000Z" }),
      recall: async () => [],
    });
    await service.compile({ identity: "eli", surfaceId: "windows-codex", message: "Review." });

    await expect(service.remember({
      grantId: "grant-1",
      stateHash: "state-1",
      idempotencyKey: "remember-1",
      entry: { scope: "scent", content: "stale", tags: [], confidence: 1, source: "test" },
    })).rejects.toThrow("remote remember stateHash is stale");
    grantStore.close();
  });

  test("direct recall needs an active grant and the grant's stateHash, and a configured source", async () => {
    root = mkdtempSync(join(tmpdir(), "continuity-service-"));
    const grantStore = new ProjectionGrantStore(join(root, "continuity.db"));
    const asked: string[] = [];
    const make = (withSource: boolean) => new AnimaContinuityService({
      identity: "eli", grantStore, now: () => 1_000, idGenerator: () => "grant-1",
      compileProjection: async () => projection, canonicalStateHash: () => "state-1",
      remember: async () => ({ id: "m", createdAt: "t" }), recall: async () => [],
      ...(withSource ? { directRecall: async ({ query }: { query: string }) => { asked.push(query); return [{ source: "eli_memory", content: "hit" }]; } } : {}),
    });
    const service = make(true);
    await service.compile({ identity: "eli", surfaceId: "windows-codex", message: "Review." });

    await expect(service.directRecall({ grantId: "grant-1", stateHash: "state-1", query: "q1" }))
      .resolves.toEqual([{ source: "eli_memory", content: "hit" }]);
    await expect(service.directRecall({ grantId: "no-such", stateHash: "state-1", query: "q2" })).rejects.toThrow("projection grant is unavailable");
    await expect(service.directRecall({ grantId: "grant-1", stateHash: "moved", query: "q3" })).rejects.toThrow("stateHash is stale");
    await expect(make(false).directRecall({ grantId: "grant-1", stateHash: "state-1", query: "q4" })).rejects.toThrow("direct recall is not configured");
    expect(asked).toEqual(["q1"]);
    grantStore.close();
  });

  // SC-002: every refusal made BEFORE the store is touched is a typed, provable
  // "nothing landed" signal; a store failure is not (the outcome is unknown).
  test("marks pre-write refusals as RememberRejectedError and a store failure as not", async () => {
    const { service, grantStore, remembered } = createService();
    await service.compile({ identity: "eli", surfaceId: "windows-codex", message: "Review." });
    const entry = { scope: "scent" as const, content: "x", tags: [], confidence: 1, source: "test" };

    await expect(service.remember({ grantId: "grant-1", stateHash: "moved", idempotencyKey: "k1", entry }))
      .rejects.toBeInstanceOf(RememberRejectedError);
    await expect(service.remember({ grantId: "no-such-grant", stateHash: "state-1", idempotencyKey: "k2", entry }))
      .rejects.toBeInstanceOf(RememberRejectedError);
    await expect(service.remember({
      grantId: "grant-1", stateHash: "state-1", idempotencyKey: "k3",
      entry: { ...entry, scope: "identity" },
    })).rejects.toBeInstanceOf(RememberRejectedError);
    expect(remembered).toEqual([]);
    grantStore.close();

    root = mkdtempSync(join(tmpdir(), "continuity-service-"));
    const failingStore = new ProjectionGrantStore(join(root, "continuity.db"));
    const failing = new AnimaContinuityService({
      identity: "eli", grantStore: failingStore, now: () => 1_000, idGenerator: () => "grant-1",
      compileProjection: async () => projection, canonicalStateHash: () => "state-1",
      remember: async () => { throw new Error("disk full"); },
      recall: async () => [],
    });
    await failing.compile({ identity: "eli", surfaceId: "windows-codex", message: "Review." });
    const error = await failing.remember({ grantId: "grant-1", stateHash: "state-1", idempotencyKey: "k4", entry })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RememberRejectedError);
    failingStore.close();
  });
});
