import { describe, test, expect } from "bun:test";
import type {
  ProjectionManifest,
  IncarnationLease,
  IdentityProposal,
  PromotionReceipt,
  ContinuityPort,
  IncarnationPort,
  ProjectionManifestCompiler,
  ProposalPromoter,
} from "../src/types";

describe("SC-01 package surface", () => {
  test("importing the types module executes no runtime code", async () => {
    const typesModule = await import("../src/types");
    expect(Object.keys(typesModule)).toEqual([]);
  });

  test("index exports LOCKED_SCOPES and re-exports the port/record types", async () => {
    const index = await import("../src/index");
    expect(index.LOCKED_SCOPES).toEqual(["identity", "private", "heartwood"]);
  });

  test("ProjectionManifest carries both stateHash and projectionId", () => {
    const manifest: ProjectionManifest = {
      agentId: "fixture",
      kernelVersion: "k",
      cartridgeVersions: {},
      substrateViewVersion: "v",
      memoryDomainVersions: { identity: "0", private: "0", heartwood: "0" },
      stateHash: "hash-state",
      surfaceId: "cc",
      compiledAt: 0,
      promptStaticHash: "hash-prompt",
      projectionId: "hash-projection",
    };
    expect(manifest.stateHash).toBe("hash-state");
    expect(manifest.projectionId).toBe("hash-projection");
  });

  test("the four port interfaces are usable as type annotations", () => {
    // Type-only check: if this file compiles, the surface exists.
    const _shapes: {
      continuity?: ContinuityPort;
      incarnation?: IncarnationPort;
      compiler?: ProjectionManifestCompiler;
      promoter?: ProposalPromoter;
      lease?: IncarnationLease;
      proposal?: IdentityProposal;
      receipt?: PromotionReceipt;
    } = {};
    expect(_shapes).toEqual({});
  });
});
