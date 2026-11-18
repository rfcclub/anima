import type { MemoryScope } from "../../memory/contract.ts";
import type { LockedScope } from "@anima/continuity-core";
import type { CanonicalSubstrateScope } from "./types.ts";

export interface RuntimeJoinRequest {
  clientId: string;
  surfaceId: string;
}

export interface RuntimeProjection {
  prompt: string;
  promptStaticHash: string;
  kernelVersion: string;
  cartridgeVersions: Record<string, string>;
  substrateViewVersion: string;
  readScopes: MemoryScope[];
  writeScopes: MemoryScope[];
  proposalScopes: LockedScope[];
  /** Server-composed cartridge declarations; clients cannot widen them. */
  declaredSubstrateScopes: CanonicalSubstrateScope[];
  /** Distinguishes an intentional empty policy from the Phase-1 mapping gap. */
  scopeDeclarationStatus: "implemented" | "unimplemented" | "none";
}
