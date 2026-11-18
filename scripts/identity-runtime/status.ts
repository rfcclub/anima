#!/usr/bin/env bun
/**
 * Status command for the identity-runtime.
 *
 * Hits the live identity-runtime's /health and pretty-prints per-tenant
 * status, flagging any tenant that needs scripts/identity-runtime/recover-mutations.ts.
 */

export interface TenantHealth {
  agentId: string;
  pendingMutations: number;
}

export interface HealthResponse {
  ok: boolean;
  runtime: string;
  tenants: TenantHealth[];
}

export function formatStatus(health: HealthResponse): string {
  if (health.tenants.length === 0) return "no tenants registered";
  return health.tenants
    .map((tenant) => {
      const flag = tenant.pendingMutations > 0
        ? ` ⚠ needs recovery: bun scripts/identity-runtime/recover-mutations.ts list ${tenant.agentId}`
        : "";
      return `${tenant.agentId}: pendingMutations=${tenant.pendingMutations}${flag}`;
    })
    .join("\n");
}

export async function fetchHealth(origin: string, fetcher: typeof fetch = fetch): Promise<HealthResponse> {
  const response = await fetcher(origin + "/health");
  if (!response.ok) throw new Error(`${origin}/health failed: ${response.status}`);
  return response.json() as Promise<HealthResponse>;
}

if (import.meta.main) {
  const origin = Bun.env.IDENTITY_RUNTIME_URL ?? "http://127.0.0.1:13541";
  try {
    const health = await fetchHealth(origin);
    console.log(formatStatus(health));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
