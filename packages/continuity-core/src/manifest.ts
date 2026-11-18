/**
 * Pure ProjectionManifest builder — no I/O, no adapter reads.
 *
 * stateHash covers only the four surface/compile-agnostic state inputs;
 * projectionId layers per-compile metadata on top.
 */

import { createHash } from "node:crypto";
import type { LockedScope, ProjectionManifest } from "./types.js";

export interface BuildManifestInput {
  agentId: string;
  kernelVersion: string;
  cartridgeVersions: Record<string, string>;
  substrateViewVersion: string;
  /** Per-scope revision-counter strings, already read by the caller (see domain-revisions.ts). */
  memoryDomainVersions: Record<LockedScope, string>;
  surfaceId: string;
  compiledAt: number;
  promptStaticHash: string;
}

export function buildManifest(input: BuildManifestInput): ProjectionManifest {
  const stateHash = canonicalSha256({
    kernelVersion: input.kernelVersion,
    cartridgeVersions: input.cartridgeVersions,
    substrateViewVersion: input.substrateViewVersion,
    memoryDomainVersions: input.memoryDomainVersions,
  });

  const projectionId = canonicalSha256({
    stateHash,
    surfaceId: input.surfaceId,
    compiledAt: input.compiledAt,
    promptStaticHash: input.promptStaticHash,
  });

  return {
    agentId: input.agentId,
    kernelVersion: input.kernelVersion,
    cartridgeVersions: input.cartridgeVersions,
    substrateViewVersion: input.substrateViewVersion,
    memoryDomainVersions: input.memoryDomainVersions,
    stateHash,
    surfaceId: input.surfaceId,
    compiledAt: input.compiledAt,
    promptStaticHash: input.promptStaticHash,
    projectionId,
  };
}

/** Deterministic canonical-JSON (sorted keys, recursive) — exported for reuse by lease-store/promoter hashing needs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
