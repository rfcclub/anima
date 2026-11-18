import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MeshBus } from "colony-mesh";
import { createDefaultTenantDefinitions } from "./default-tenants.ts";
import { loadEnvKeys } from "./load-env-keys.ts";
import { loadMeshEnrollmentConfig } from "./mesh-enrollment.ts";
import { installRuntimeShutdown } from "./lifecycle.ts";
import { readRosterAgentIds, resolveColonyPath } from "./roster.ts";
import { startTenantIdentityRuntimeHttp } from "./tenant-http.ts";
import { TenantIdentityRuntime } from "./tenant-runtime.ts";

// Bruno's recall classifier (Jev via TypeSafe) needs this key; a service manager
// may give the process no environment. Load just that one key from the env file — names only in the log.
const loadedKeys = loadEnvKeys(
  Bun.env.IDENTITY_RUNTIME_ENV_FILE ?? join(homedir(), ".anima", "anima.env"),
  ["TYPESAFE_API_KEY"],
);
console.log("identity-runtime env keys loaded: " + (loadedKeys.join(", ") || "none"));

const dbPath = Bun.env.IDENTITY_RUNTIME_DB
  ?? join(homedir(), ".anima", "identity-runtime", "identity-runtime.db");
mkdirSync(dirname(dbPath), { recursive: true });

const colonyPath = resolveColonyPath({ explicit: Bun.env.IDENTITY_RUNTIME_COLONY_JSON });
const rosterAgentIds = colonyPath ? readRosterAgentIds(colonyPath) : [];
console.log(`identity-runtime roster: ${rosterAgentIds.length} agents from ${colonyPath ?? "(no colony.json found; only eli, bruno, abel)"}`);

/**
 * Non-model service tenants, comma-separated. Absent means none, so deploying
 * this code admits no service installation until an operator names it explicitly.
 */
const serviceTenantIds = (Bun.env.IDENTITY_RUNTIME_SERVICE_TENANTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
console.log(`identity-runtime service tenants: ${serviceTenantIds.length ? serviceTenantIds.join(", ") : "none"}`);

const mesh = new MeshBus(Bun.env.IDENTITY_RUNTIME_MESH_DB);
// Colony Mesh admission is off unless IDENTITY_RUNTIME_MESH_URL, _KEY_FILE and _KID are all set.
const meshEnrollment = loadMeshEnrollmentConfig(Bun.env) ?? undefined;
console.log("identity-runtime mesh enrollment: " + (meshEnrollment ? "on" : "off"));
const runtime = new TenantIdentityRuntime({
  dbPath,
  meshEnrollment,
  tenants: createDefaultTenantDefinitions({
    animaOrigin: Bun.env.ANIMA_CONTINUITY_URL ?? "http://127.0.0.1:3700",
    mesh,
    eliPlatform: Bun.env.IDENTITY_RUNTIME_ELI_PLATFORM ?? Bun.env.ELI_RUNTIME_PLATFORM ?? "macos",
    brunoPlatform: Bun.env.IDENTITY_RUNTIME_BRUNO_PLATFORM ?? Bun.env.BRUNO_RUNTIME_PLATFORM ?? "macos",
    agentIds: rosterAgentIds,
    agentPlatform: Bun.env.IDENTITY_RUNTIME_AGENT_PLATFORM ?? "macos",
    serviceTenants: serviceTenantIds.map((agentId) => ({ agentId })),
  }),
});
const server = startTenantIdentityRuntimeHttp(
  runtime,
  Bun.env.IDENTITY_RUNTIME_HOST ?? "0.0.0.0",
  Number(Bun.env.IDENTITY_RUNTIME_PORT ?? "13541"),
);
installRuntimeShutdown({ runtime, server, closeResources: () => mesh.close() });
console.log("identity-runtime listening on http://" + server.hostname + ":" + server.port);
