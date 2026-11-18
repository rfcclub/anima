/**
 * IncarnationPort.join() — thin wiring adapter (Phase 0, `continuity-ports`).
 *
 * Composes over the four EXISTING pipeline stages (AgentLoader, resolveExecutionPlan,
 * DefaultSubstrateViewLayer.buildView, buildSystemPrompt/buildSystemPromptFromPlan) —
 * it does not reimplement them. The caller (`AgentSession.prepareTurn()`, when the
 * `continuity.incarnationPort` flag is on) passes in what it has already computed;
 * join() only adds the two new pure steps: manifest + lease. This is why the golden
 * test (SC-03: byte-identical StructuredPrompt) holds by construction — join() never
 * rebuilds the prompt, it echoes back what prepareTurn already built.
 */

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import type { LoadedAgent } from "./loader";
import type { ExecutionPlan } from "../cartridge/types";
import type { ResolvedCartridgeRetrieval } from "../substrate/substrate-view";
import type { SubstrateView } from "../substrate/substrate-view";
import {
  buildManifest,
  canonicalJson,
  LeaseStore,
  DomainRevisions,
  type IncarnationLease,
  type ProjectionManifest,
  type LockedScope,
} from "@anima/continuity-core";

const LOCKED_SCOPES: readonly LockedScope[] = ["identity", "private", "heartwood"];

/** Default: 30 minutes. A surface re-joins rather than auto-renewing (design.md §3). */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

export interface JoinPrompt {
  full: string;
  staticPrefix: string;
  dynamicSuffix?: string;
  staticHash: string;
}

export interface JoinInput {
  agent: LoadedAgent;
  surfaceId: string;
  /** The ExecutionPlan prepareTurn already resolved this turn, or null on the non-cartridge branch. */
  executionPlan: ExecutionPlan | null;
  /** The StructuredPrompt prepareTurn already built this turn — returned unchanged. */
  prompt: JoinPrompt;
  /** The SubstrateView prepareTurn already built (real cartridge policies), if any. */
  substrateView?: SubstrateView;
  /** From the existing ExecutionPlan guard-intersection computation (or DEFAULT_WRITE_SCOPES fallback). */
  writeScopes: string[];
  proposalScopes?: LockedScope[];
  /** Overridable for tests; defaults to `~/.anima/agents/<agent>/continuity.db`. */
  dbPath?: string;
  now?: () => number;
  leaseTtlMs?: number;
  idGenerator?: () => string;
}

export interface JoinResult {
  prompt: Required<JoinPrompt>;
  manifest: ProjectionManifest;
  lease: IncarnationLease;
}

export function defaultContinuityDbPath(agentName: string): string {
  return joinPath(homedir(), ".anima", "agents", agentName, "continuity.db");
}

/**
 * Codex review finding (2026-07-15): this function previously mapped
 * `CartridgeBlock.scope` into `ResolvedCartridgeRetrieval.scopesIncluded`.
 * `CartridgeBlock.scope` is a storage/visibility category ("shared" | "agent"
 * — see `src/cartridge/activation.ts`'s `toBlock()`/filter), NOT a substrate
 * retrieval scope like "identity_core"/"current_state". That mapping silently
 * produced non-functional-but-plausible-looking retrieval policies — worse
 * than the honest `[]` placeholder it was meant to replace, because it looked
 * like real coverage while retrieving nothing real.
 *
 * No existing code connects `ExecutionPlan` to genuine substrate-scope
 * declarations per cartridge (`SubstrateRetrievalRequest.scopes` is the
 * adjacent-looking candidate, but that's `MemoryScope[]` vocabulary — a third,
 * still-mismatched vocabulary, not the substrate map's scope names either).
 * Building a correct mapping requires adding real per-cartridge substrate-
 * scope declarations, which is Phase 1 work, not a Phase 0 fix. Deferred —
 * `cartridgePolicies` stays `[]` unconditionally; see design.md Open Items.
 */
export function realCartridgePolicies(_plan: ExecutionPlan | null): ResolvedCartridgeRetrieval[] {
  return [];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function join(input: JoinInput): Promise<JoinResult> {
  const agentId = input.agent.name;
  const dbPath = input.dbPath ?? defaultContinuityDbPath(agentId);
  const now = input.now ?? Date.now;
  const nowMs = now();
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const genId = input.idGenerator ?? randomUUID;

  const domainRevisions = new DomainRevisions(dbPath);
  const leaseStore = new LeaseStore(dbPath);

  try {
    const kernelVersion = sha256(`${input.agent.soulContent ?? ""}\n${input.agent.geneContent ?? ""}`);

    const cartridgeVersions: Record<string, string> = {};
    if (input.executionPlan) {
      const blocks = [
        input.executionPlan.interactionPersona,
        input.executionPlan.workingRole,
        input.executionPlan.task,
        input.executionPlan.language,
        input.executionPlan.framework,
        input.executionPlan.project,
        ...input.executionPlan.universal,
        ...input.executionPlan.dependencies,
      ].filter((b): b is NonNullable<typeof b> => Boolean(b));
      for (const block of blocks) {
        cartridgeVersions[block.name] = sha256(block.content);
      }
    }

    const viewTuples = (input.substrateView?.results ?? [])
      .map((r) => ({ relativePath: r.relativePath, trust: r.trust, weight: r.weight }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const substrateViewVersion = sha256(canonicalJson(viewTuples));

    const memoryDomainVersions = Object.fromEntries(
      LOCKED_SCOPES.map((scope) => [scope, domainRevisions.getRevision(agentId, scope)]),
    ) as Record<LockedScope, string>;

    const manifest = buildManifest({
      agentId,
      kernelVersion,
      cartridgeVersions,
      substrateViewVersion,
      memoryDomainVersions,
      surfaceId: input.surfaceId,
      compiledAt: nowMs,
      promptStaticHash: input.prompt.staticHash,
    });

    const leaseId = genId();
    const lease = leaseStore.mint({
      leaseId,
      agentId,
      surfaceId: input.surfaceId,
      baseManifest: manifest,
      readScopes: input.substrateView?.scopesCovered ?? [],
      writeScopes: input.writeScopes,
      proposalScopes: input.proposalScopes ?? [],
      idempotencyNamespace: `${agentId}:${input.surfaceId}:${leaseId}`,
      issuedAt: nowMs,
      expiresAt: nowMs + leaseTtlMs,
    });

    return {
      prompt: {
        full: input.prompt.full,
        staticPrefix: input.prompt.staticPrefix,
        dynamicSuffix: input.prompt.dynamicSuffix ?? "",
        staticHash: input.prompt.staticHash,
      },
      manifest,
      lease,
    };
  } finally {
    domainRevisions.close();
    leaseStore.close();
  }
}
