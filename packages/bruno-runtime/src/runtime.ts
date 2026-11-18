import type { AgentMemoryEntry } from "../../../src/memory/contract.ts";
import type {
  RemoteContinuityPort,
  RemoteRememberResult,
  TenantMeshRegistrationPort,
} from "../../identity-runtime/src/index.ts";
import {
  TenantIdentityRuntime,
  type TenantIdentityRuntimeOptions,
} from "../../identity-runtime/src/tenant-runtime.ts";

export type MeshRegistrationPort = TenantMeshRegistrationPort;

export interface BrunoRuntimeOptions {
  dbPath: string;
  continuity: RemoteContinuityPort;
  agentId?: string;
  now?: () => number;
  idGenerator?: () => string;
  leaseTtlMs?: number;
  mesh?: MeshRegistrationPort;
  platform?: string;
}

export interface JoinBrunoInput {
  clientId: string;
  surfaceId: string;
  message: string;
  cartridgeOverride?: string | null;
  hostContext?: string[];
}

export interface BrunoJoinResponse {
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

export interface BrunoRememberInput {
  leaseId: string;
  clientId: string;
  capabilityToken: string;
  stateHash: string;
  idempotencyKey: string;
  entry: Omit<AgentMemoryEntry, "id" | "createdAt">;
}

/**
 * Compatibility facade for Bruno's former standalone incarnation runtime.
 * Bruno's direct-recall policy now lives in identity-runtime and is selected
 * only by the shared tenant runtime.
 */
export class BrunoRuntime {
  private readonly agentId: string;
  private readonly runtime: TenantIdentityRuntime;

  constructor(options: BrunoRuntimeOptions) {
    this.agentId = options.agentId ?? "bruno";
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

  async join(input: JoinBrunoInput): Promise<BrunoJoinResponse> {
    const joined = await this.runtime.join(this.agentId, input);
    return { ...joined, capabilityToken: joined.sessionToken };
  }

  remember(input: BrunoRememberInput): Promise<RemoteRememberResult> {
    return this.runtime.remember({
      ...input,
      sessionToken: input.capabilityToken,
    });
  }

  close(): void {
    this.runtime.close();
  }
}
