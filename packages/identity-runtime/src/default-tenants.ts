import {
  HttpAnimaTenantContinuityClient,
  type AnimaContinuityFetcher,
} from "./anima-continuity-client.ts";
import { createDirectRecallPolicy } from "./bruno-recall-policy.ts";
import type {
  TenantMeshRegistrationPort,
  TenantRuntimeTenant,
} from "./tenant-runtime.ts";
import { StaticServiceContinuity } from "./service-continuity.ts";

/**
 * A non-model service installation admitted by explicit owner configuration.
 * Absent from the option means the service is not registered at all.
 */
export interface ServiceTenantDefinition {
  agentId: string;
  platform?: string;
}

export interface DefaultTenantDefinitionsOptions {
  animaOrigin: string;
  mesh?: TenantMeshRegistrationPort;
  eliPlatform?: string;
  brunoPlatform?: string;
  /**
   * Every other roster agent that is a tenant (bruno and eli have their own entries below).
   * Their identity is compiled from their substrate map by ANIMA, memory stays in ANIMA.
   */
  agentIds?: readonly string[];
  /** Platform reported for those agents in the mesh. */
  agentPlatform?: string;
  /**
   * Non-model service tenants. Absent or empty keeps the default (agent-only) map unchanged, so
   * deploying the service kind admits nothing by itself.
   */
  serviceTenants?: readonly ServiceTenantDefinition[];
  fetcher?: AnimaContinuityFetcher;
}

/**
 * The initial registered tenant set for the shared identity runtime.
 * More tenants must be explicitly added here; request bodies never admit an
 * arbitrary agent ID.
 */
export function createDefaultTenantDefinitions(
  options: DefaultTenantDefinitionsOptions,
): ReadonlyMap<string, TenantRuntimeTenant> {
  const fetcher = options.fetcher ?? fetch;
  const tenants = new Map<string, TenantRuntimeTenant>([
    [
      "eli",
      {
        continuity: new HttpAnimaTenantContinuityClient(options.animaOrigin, "eli", fetcher),
        mesh: options.mesh,
        platform: options.eliPlatform,
      },
    ],
    [
      "bruno",
      {
        continuity: new HttpAnimaTenantContinuityClient(options.animaOrigin, "bruno", fetcher),
        mesh: options.mesh,
        platform: options.brunoPlatform,
        recallPolicy: createDirectRecallPolicy(),
      },
    ],
    ...(options.agentIds ?? ["abel"])
      .filter((agentId) => agentId !== "eli" && agentId !== "bruno")
      .map((agentId): [string, TenantRuntimeTenant] => [
        agentId,
        {
          continuity: new HttpAnimaTenantContinuityClient(options.animaOrigin, agentId, fetcher),
          mesh: options.mesh,
          platform: options.agentPlatform,
        },
      ]),
  ]);
  // Service tenants are added after the roster entries so an explicitly configured service name can
  // never be silently re-admitted as a model agent.
  for (const service of options.serviceTenants ?? []) {
    tenants.set(service.agentId, {
      kind: "service",
      continuity: new StaticServiceContinuity(service.agentId),
      mesh: options.mesh,
      platform: service.platform,
    });
  }
  return tenants;
}
