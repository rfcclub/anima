/** Compatibility exports; the shared identity-runtime owns admission policy. */
export {
  privateTenantRuntimeSecurity as privateTransportSecurity,
  uuidBearerTenantSecurity as uuidBearerSecurity,
  type TenantRuntimeSecurity as SecurityProvider,
} from "../../identity-runtime/src/tenant-security.ts";
