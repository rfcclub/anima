import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteContinuityPort } from "../../../src/identity-runtime/contract/remote-continuity.ts";
import { mappedSubstrateLoader } from "../../../src/identity-runtime/substrate-load.ts";
import { handleTenantRuntimeRequest } from "../src/tenant-http.ts";
import { TenantIdentityRuntime } from "../src/tenant-runtime.ts";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A fixture substrate: two declared files, one undeclared file, one symlink out of the root. */
function makeSubstrate(base: string, agentId: string): { root: string; mapContent: string } {
  const substrateRoot = join(base, agentId, "substrate");
  const outside = join(base, agentId, "outside.md");
  mkdirSync(join(base, agentId), { recursive: true });
  writeFileSync(outside, "outside secret\n");
  mkdirSync(join(substrateRoot, "0_SOUL"), { recursive: true });
  mkdirSync(join(substrateRoot, "state"), { recursive: true });
  writeFileSync(join(substrateRoot, "0_SOUL", "axioms.md"), "# Axioms\n");
  writeFileSync(join(substrateRoot, "state", "operational.md"), "# State\n");
  writeFileSync(join(substrateRoot, "secret.md"), "# Secret\n");
  // Declared by the map below, but resolves outside the substrate root: never listed, never served.
  symlinkSync(outside, join(substrateRoot, "0_SOUL", "escape.md"));
  return {
    root: substrateRoot,
    mapContent: JSON.stringify({
      version: 1,
      agent_id: agentId,
      substrate_type: "substrate",
      root: substrateRoot,
      scopes: {
        identity_core: {
          description: "Stable identity.",
          required: true,
          sources: [{ type: "paths", paths: ["0_SOUL/"], trust: "high", weight: 1, evidence_required: false }],
        },
        current_state: {
          description: "Current state.",
          required: true,
          sources: [{ type: "paths", paths: ["state/"], trust: "medium", weight: 0.8, evidence_required: false }],
        },
        relationship: {
          description: "Relationship.",
          required: false,
          sources: [{ type: "paths", paths: ["0_SOUL/escape.md"], trust: "high", weight: 1, evidence_required: false }],
        },
      },
    }),
  };
}

describe("TenantIdentityRuntime.loadSubstrate", () => {
  test("lists the session's own virtual mapping and refuses another tenant's token", async () => {
    root = mkdtempSync(join(tmpdir(), "substrate-load-runtime-"));
    const eli = makeSubstrate(root, "eli");
    const bruno = makeSubstrate(root, "bruno");
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([
        ["eli", {
          continuity: continuity("eli"),
          substrateLoader: mappedSubstrateLoader({ mapContent: eli.mapContent, rootOverride: eli.root }),
        }],
        ["bruno", {
          continuity: continuity("bruno"),
          substrateLoader: mappedSubstrateLoader({ mapContent: bruno.mapContent, rootOverride: bruno.root }),
        }],
      ]),
      now: () => 100,
    });
    const eliJoin = await runtime.join("eli", joinInput());
    const brunoJoin = await runtime.join("bruno", joinInput());

    const mapping = await runtime.loadSubstrate({
      agentId: "eli",
      leaseId: eliJoin.leaseId,
      clientId: "cli",
      sessionToken: eliJoin.sessionToken,
      stateHash: eliJoin.stateHash,
    });

    expect(Array.isArray(mapping)).toBe(true);
    const entries = mapping as Array<{ id: string; scope: string; trust: string; size: number }>;
    expect(entries.map((entry) => entry.id)).toEqual([
      "eli/0_SOUL/axioms.md",
      "eli/state/operational.md",
    ]);
    expect(entries[0]).toMatchObject({ scope: "identity_core", trust: "high" });
    // Never a real path, never the substrate root, never an undeclared file.
    expect(JSON.stringify(entries)).not.toContain(eli.root);
    expect(JSON.stringify(entries)).not.toContain("secret.md");

    // Bruno's session against Eli's path is refused, and so is Eli's against Bruno's.
    await expect(runtime.loadSubstrate({
      agentId: "eli",
      leaseId: brunoJoin.leaseId,
      clientId: "cli",
      sessionToken: brunoJoin.sessionToken,
      stateHash: brunoJoin.stateHash,
    })).rejects.toThrow("runtime session is unavailable");
    await expect(runtime.loadSubstrate({
      agentId: "bruno",
      leaseId: eliJoin.leaseId,
      clientId: "cli",
      sessionToken: eliJoin.sessionToken,
      stateHash: eliJoin.stateHash,
    })).rejects.toThrow("runtime session is unavailable");
    runtime.close();
  });

  test("serves one declared file and refuses traversal, escape, undeclared and stale ids", async () => {
    root = mkdtempSync(join(tmpdir(), "substrate-load-runtime-file-"));
    const eli = makeSubstrate(root, "eli");
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", {
        continuity: continuity("eli"),
        substrateLoader: mappedSubstrateLoader({ mapContent: eli.mapContent, rootOverride: eli.root }),
      }]]),
      now: () => 100,
    });
    const joined = await runtime.join("eli", joinInput());
    const load = (path: string, stateHash = joined.stateHash) => runtime.loadSubstrate({
      agentId: "eli",
      leaseId: joined.leaseId,
      clientId: "cli",
      sessionToken: joined.sessionToken,
      stateHash,
      path,
    });

    await expect(load("eli/0_SOUL/axioms.md")).resolves.toMatchObject({
      id: "eli/0_SOUL/axioms.md",
      content: "# Axioms\n",
    });
    await expect(load("eli/0_SOUL/../../outside.md")).rejects.toThrow(/not declared/);
    await expect(load("../outside.md")).rejects.toThrow(/not declared/);
    await expect(load("eli/0_SOUL/escape.md")).rejects.toThrow(/substrate root/);
    await expect(load("eli/secret.md")).rejects.toThrow(/not declared/);
    await expect(load("bruno/0_SOUL/axioms.md")).rejects.toThrow(/not declared/);
    // Same guard as recall/remember: the caller must hold the lease's current projection state.
    await expect(load("eli/0_SOUL/axioms.md", "stale")).rejects.toThrow("substrate-load stateHash is stale");
    runtime.close();
  });

  test("refuses a tenant that declares no substrate loader", async () => {
    root = mkdtempSync(join(tmpdir(), "substrate-load-runtime-none-"));
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", { continuity: continuity("eli") }]]),
      now: () => 100,
    });
    const joined = await runtime.join("eli", joinInput());

    await expect(runtime.loadSubstrate({
      agentId: "eli",
      leaseId: joined.leaseId,
      clientId: "cli",
      sessionToken: joined.sessionToken,
      stateHash: joined.stateHash,
    })).rejects.toThrow("tenant substrate loader is unavailable");
    runtime.close();
  });
});

describe("substrate-load route", () => {
  test("lists the mapping and returns one file through POST /identity-runtime/substrate-load/<agent>", async () => {
    root = mkdtempSync(join(tmpdir(), "substrate-load-http-"));
    const eli = makeSubstrate(root, "eli");
    const runtime = new TenantIdentityRuntime({
      dbPath: join(root, "runtime.db"),
      tenants: new Map([["eli", {
        continuity: continuity("eli"),
        substrateLoader: mappedSubstrateLoader({ mapContent: eli.mapContent, rootOverride: eli.root }),
      }]]),
      now: () => 100,
    });
    const joined = await runtime.join("eli", joinInput());
    const call = (body: Record<string, unknown>) => handleTenantRuntimeRequest(
      runtime,
      new Request("http://runtime/identity-runtime/substrate-load/eli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const session = {
      leaseId: joined.leaseId,
      clientId: "cli",
      sessionToken: joined.sessionToken,
      stateHash: joined.stateHash,
    };

    const list = await call(session);
    expect(list.status).toBe(200);
    const mapping = await list.json() as Array<{ id: string }>;
    expect(mapping.map((entry) => entry.id)).toEqual(["eli/0_SOUL/axioms.md", "eli/state/operational.md"]);

    const one = await call({ ...session, path: "eli/0_SOUL/axioms.md" });
    expect(one.status).toBe(200);
    await expect(one.json()).resolves.toMatchObject({ id: "eli/0_SOUL/axioms.md", content: "# Axioms\n" });

    // Containment refusals are HTTP statuses, not a leaked path or an empty body.
    expect((await call({ ...session, path: "eli/0_SOUL/../../outside.md" })).status).toBe(404);
    expect((await call({ ...session, path: "eli/0_SOUL/escape.md" })).status).toBe(403);
    expect((await call({ ...session, path: "eli/secret.md" })).status).toBe(404);
    expect((await call({ ...session, stateHash: "stale" })).status).toBe(409);
    // The agent is named in the path, never the body.
    expect((await call({ ...session, agentId: "bruno" })).status).toBe(400);
    runtime.close();
  });
});

function joinInput() {
  return { clientId: "cli", surfaceId: "remote-harness", message: "hello" };
}

function continuity(identity: string): RemoteContinuityPort {
  return {
    compile: async (input) => ({
      projection: {
        prompt: identity + " projection",
        promptStaticHash: "static",
        kernelVersion: "kernel",
        cartridgeVersions: {},
        substrateViewVersion: "view",
        readScopes: ["episode", "observation"],
        writeScopes: ["scent"],
        proposalScopes: [],
        declaredSubstrateScopes: ["episodic_memory"],
        scopeDeclarationStatus: "implemented" as const,
      },
      grant: {
        grantId: identity + "-grant",
        identity,
        surfaceId: input.surfaceId,
        projectionId: identity + "-projection",
        stateHash: identity + "-state",
        writeScopes: ["scent"],
        readScopes: ["episode", "observation"],
        declaredSubstrateScopes: ["episodic_memory"],
        scopeDeclarationStatus: "implemented" as const,
        issuedAt: 1,
        expiresAt: 1_000_000,
      },
    }),
    remember: async () => ({ id: "memory", createdAt: "now" }),
    recall: async () => ({
      resolution: {
        ok: true as const,
        requestedScope: "episodic_memory",
        memoryScopes: ["episode", "observation"],
      },
      results: [],
    }),
  };
}
