export type {
  LockedScope,
  ProjectionManifest,
  IncarnationLease,
  ProposalStatus,
  IdentityProposal,
  PromotionReceipt,
  ProposeInput,
  ContinuityPort,
  IncarnationPort,
  ProjectionManifestCompiler,
} from "./types.js";
export type { ProposalPromoter as ProposalPromoterPort } from "./types.js";
export {
  assertProjectionCompileRequest,
  type ProjectionCompileRequest,
  type ProjectionCompiler,
  type ProjectionMode,
} from "./projection.js";

export const LOCKED_SCOPES = ["identity", "private", "heartwood"] as const;

export { buildManifest, canonicalJson, type BuildManifestInput } from "./manifest.js";
export { DomainRevisions } from "./domain-revisions.js";
export { LeaseStore, ProposalScopeNotLockedError, type MintLeaseInput } from "./lease-store.js";
export {
  ProposalPromoter,
  LeaseInvalidError,
  ScopeNotProposableError,
  StateHashMismatchError,
  EmptyContentError,
  MissingEvidenceError,
  ProposalNotFoundError,
  ProposalNotPromotableError,
  StaleProposalError,
  type PrivilegedWriter,
  type ProposalPromoterOptions,
} from "./promoter.js";
