export { IdentityRuntime, StaleMutationError, type IdentityRuntimeOptions, type JoinIdentityResponse } from "./runtime.ts";
export { IdentitySession, type SessionRecallRequest, type SessionRememberRequest } from "./identity-session.ts";
export { ScopeMapper, SUBSTRATE_SCOPE_MEMORY_SCOPES, type CanonicalSubstrateScope, type ScopeResolution } from "../../../src/identity-runtime/contract/scope-mapper.ts";
export { type IdentityRuntimeEvent } from "../../../src/identity-runtime/contract/runtime-events.ts";
export { IdentityRuntimeRegistry } from "./runtime-registry.ts";
export { VersionedIdentityTransport, IdentityRuntimeClient, type TransportRequest, type TransportResponse } from "./transport.ts";
export {
  narrowProjectionGrant,
  type ProjectionGrant,
  type NarrowProjectionGrantInput,
  type NarrowedProjectionGrant,
} from "../../../src/identity-runtime/contract/projection-grant.ts";
export {
  assertActiveJoinIntent,
  assertRemoteRecallRequest,
  assertRemoteRememberRequest,
  assertRemoteDirectRecallRequest,
  RememberRejectedError,
  type ActiveJoinIntent,
  type RemoteCompileResult,
  type RemoteRememberRequest,
  type RemoteRememberResult,
  type RemoteRecallRequest,
  type RemoteRecallResult,
  type RemoteDirectRecallRequest,
  type RemoteDirectRecallResult,
  type RemoteRoomReadRequest,
  type SharedRoomReadResult,
  assertRoomCommitInput,
  RoomCommitRejectedError,
  type SharedRoomCommitInput,
  type RemoteRoomCommitRequest,
  type SharedRoomCommitResult,
  type RemoteContinuityPort,
} from "../../../src/identity-runtime/contract/remote-continuity.ts";
export {
  HttpAnimaTenantContinuityClient,
  type AnimaContinuityFetcher,
} from "./anima-continuity-client.ts";
export {
  TenantIdentityRuntime,
  type TenantIdentityRuntimeOptions,
  type TenantJoinInput,
  type TenantJoinResponse,
  type TenantDirectRecallInput,
  type TenantRoomReadInput,
  type TenantRoomCommitInput,
  type TenantDirectRecallPolicy,
  type TenantRecallInput,
  type TenantRememberInput,
  type TenantMeshRegistrationPort,
  type TenantRuntimeTenant,
  type TenantKind,
} from "./tenant-runtime.ts";
export {
  StaticServiceContinuity,
  staticJoinResult,
  serviceStateHash,
  SERVICE_STATIC_MARKER,
} from "./service-continuity.ts";
export {
  startTenantIdentityRuntimeHttp,
} from "./tenant-http.ts";
export {
  privateTenantRuntimeSecurity,
  uuidBearerTenantSecurity,
  type TenantRuntimeSecurity,
} from "./tenant-security.ts";
export {
  createDefaultTenantDefinitions,
  type DefaultTenantDefinitionsOptions,
  type ServiceTenantDefinition,
} from "./default-tenants.ts";
export { tenantInstanceId } from "./tenant-instance-id.ts";
export {
  TenantMutationOutbox,
  type TenantMutationClaim,
} from "./tenant-mutation-outbox.ts";
export {
  defaultClassifier as defaultBrunoRecallClassifier,
  HeuristicQueryClassifier,
  JevQueryClassifier,
  LLMQueryClassifier,
  recall as recallBruno,
  type QueryClassifier as BrunoRecallQueryClassifier,
  type RecallDeps as BrunoRecallDeps,
  type RecallResult as BrunoRecallResult,
  type RecallSource as BrunoRecallSource,
} from "./bruno-recall-policy.ts";
export { isTenantId, readRosterAgentIds, resolveColonyPath } from "./roster.ts";
