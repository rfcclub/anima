import type { AgentMemoryEntry } from "../../../src/memory/contract.ts";
import type {
  RemoteContinuityPort,
  RemoteRecallResult,
  RemoteRememberResult,
  TenantMeshRegistrationPort,
} from "../../identity-runtime/src/index.ts";
import {
  TenantIdentityRuntime,
  type TenantIdentityRuntimeOptions,
} from "../../identity-runtime/src/tenant-runtime.ts";

export type MeshRegistrationPort = TenantMeshRegistrationPort;

export interface EliRuntimeOptions {
  dbPath: string;
  continuity: RemoteContinuityPort;
  agentId?: string;
  now?: () => number;
  idGenerator?: () => string;
  leaseTtlMs?: number;
  mesh?: MeshRegistrationPort;
  platform?: string;
}

export interface JoinEliInput {
  clientId: string;
  surfaceId: string;
  message: string;
  cartridgeOverride?: string | null;
  hostContext?: string[];
}

export interface EliJoinResponse {
  projection: string;
  projectionId: string;
  stateHash: string;
  leaseId: string;
  expiresAt: number;
  writeScopes: string[];
  declaredSubstrateScopes: string[];
  scopeDeclarationStatus: "unimplemented" | "implemented" | "none";
  capabilityToken: string;
}

export interface EliRememberInput {
  leaseId: string;
  clientId: string;
  capabilityToken: string;
  stateHash: string;
  idempotencyKey: string;
  entry: Omit<AgentMemoryEntry, "id" | "createdAt">;
}

export interface EliRecallInput {
  leaseId: string;
  clientId: string;
  capabilityToken: string;
  stateHash: string;
  query: string;
  substrateScope: string;
}

/**
 * Compatibility facade for Eli's former standalone process.
 * New callers use TenantIdentityRuntime with path-scoped admission directly.
 */
export class EliRuntime {
  private readonly agentId: string;
  private readonly runtime: TenantIdentityRuntime;

  constructor(options: EliRuntimeOptions) {
    this.agentId = options.agentId ?? "eli";
    const runtimeOptions: TenantIdentityRuntimeOptions = {
      dbPath: options.dbPath,
      tenants: new Map([
        [
          this.agentId,
          {
            continuity: options.continuity,
            mesh: options.mesh,
            platform: options.platform,
          },
        ],
      ]),
      now: options.now,
      idGenerator: options.idGenerator,
      leaseTtlMs: options.leaseTtlMs,
    };
    this.runtime = new TenantIdentityRuntime(runtimeOptions);
  }

  async join(input: JoinEliInput): Promise<EliJoinResponse> {
    const joined = await this.runtime.join(this.agentId, input);
    return { ...joined, capabilityToken: joined.sessionToken };
  }

  remember(input: EliRememberInput): Promise<RemoteRememberResult> {
    return this.runtime.remember({
      ...input,
      sessionToken: input.capabilityToken,
    });
  }

  recall(input: EliRecallInput): Promise<RemoteRecallResult> {
    return this.runtime.recall({
      ...input,
      sessionToken: input.capabilityToken,
    });
  }

  close(): void {
    this.runtime.close();
  }
}
