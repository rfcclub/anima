/** Admission boundary for the public shared identity-runtime listener. */
export interface TenantRuntimeSecurity {
  admit(request: Request): boolean | Promise<boolean>;
}

/** The deployment default for a listener already restricted to a private network. */
export const privateTenantRuntimeSecurity: TenantRuntimeSecurity = {
  admit: () => true,
};

/** Optional bearer admission seam retained from the per-agent runtime wrappers. */
export function uuidBearerTenantSecurity(token: string): TenantRuntimeSecurity {
  return {
    admit: (request) => request.headers.get("authorization") === "Bearer " + token,
  };
}
