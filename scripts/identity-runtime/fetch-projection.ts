/** Any registered roster agent; the runtime rejects ids it has not registered. */
export type IdentityRuntimeTenant = string;

export type ProjectionFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProjectionFetchRequest {
  origin: string;
  tenant: IdentityRuntimeTenant;
  clientId: string;
  surfaceId: string;
  message: string;
  fetcher?: ProjectionFetcher;
}

function joinUrl(origin: string, tenant: IdentityRuntimeTenant): string {
  return `${origin.replace(/\/+$/, "")}/identity-runtime/${tenant}/join`;
}

/** Fetch one tenant-owned projection without exposing tenant selection in JSON. */
export async function fetchIdentityProjection(request: ProjectionFetchRequest): Promise<string> {
  const response = await (request.fetcher ?? fetch)(joinUrl(request.origin, request.tenant), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: request.clientId,
      surfaceId: request.surfaceId,
      message: request.message,
    }),
  });
  const body = await response.json() as { error?: unknown; projection?: unknown };
  if (!response.ok || typeof body.projection !== "string" || !body.projection.trim()) {
    throw new Error(`join failed: ${typeof body.error === "string" ? body.error : response.status}`);
  }
  return body.projection;
}
