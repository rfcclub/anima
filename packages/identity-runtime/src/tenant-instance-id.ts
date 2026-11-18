const NON_ALNUM_RUN = /[^a-z0-9-]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/** Stable mesh recipient identity derived solely from the joined tenant/surface. */
export function tenantInstanceId(agentId: string, surfaceId: string): string {
  return (agentId + "-" + surfaceId)
    .toLowerCase()
    .replace(NON_ALNUM_RUN, "-")
    .replace(EDGE_DASHES, "");
}
