export { SuwayomiAdapter } from "./adapter";
export {
  CompatibilityProfileV21,
  CompatibilityProfileV23,
} from "./compatibility";
export type {
  CompatibilityProfile,
  CompatibilityProfileOperations,
} from "./compatibility";
export {
  SourceRuntimeError,
  isSourceRuntimeError,
  normalizeSourceRuntimeError,
} from "./errors";
export type {
  SourceRuntimeErrorCode,
  SourceRuntimeErrorOptions,
} from "./errors";
export {
  createSuwayomiSourceRuntime,
  detectCompatibilityProfile,
} from "./factory";
export {
  getManagedSourceRuntime,
  resetManagedSourceRuntime,
} from "./managed";
export {
  SourceHealthProbeCache,
  classifyExtensionFailure,
  collectStructuralExtensionHealth,
  probeSourceReachability,
} from "./health";
export type {
  ExtensionHealthCheck,
  ExtensionHealthCode,
  ExtensionHealthDimension,
  ExtensionHealthStatus,
  ExtensionStructuralHealth,
  SourceReachabilityHealth,
  SourceReachabilityProbeInput,
  StructuralExtensionHealthSnapshot,
  StructuralHealthOptions,
} from "./health";
export { createExtensionProvenance } from "./provenance";
export {
  EXTENSION_COMPATIBILITY_SCHEMA_VERSION,
  extensionCompatibilityIdentity,
  loadExtensionCompatibilityState,
  normalizeExtensionCompatibilityRecord,
  normalizeExtensionCompatibilityState,
  resetExtensionCompatibilityStateCacheForTests,
  saveExtensionCompatibilityState,
  upsertExtensionCompatibilityRecord,
} from "./extensionCompatibility";
export {
  createNativeExtensionBatchDriver,
  ExtensionUpdateCoordinator,
  extensionUpdateCandidate,
  runTransactionalExtensionUpdates,
} from "./extensionUpdateCoordinator";
export type {
  ExtensionBatchDriver,
  ExtensionBatchEvidence,
  ExtensionBatchResult,
  ExtensionNativeBatchResult,
  ExtensionUpdateCandidate,
  ExtensionUpdateCoordinatorOptions,
  ExtensionUpdatePhase,
  NativeExtensionBatchInput,
} from "./extensionUpdateCoordinator";
export type {
  ExtensionCertificationScope,
  ExtensionCompatibilityRecord,
  ExtensionCompatibilityScope,
  ExtensionCompatibilityState,
  ExtensionCompatibilityStatus,
  ExtensionFailureOwner,
} from "./extensionCompatibility";
export {
  INTROSPECTION_OPERATION,
  canonicalSchemaJson,
  canonicalSchemaSha256,
  canonicalizeSchema,
  evaluateRuntimeContract,
} from "./schema";
export type { CanonicalGraphQLSchema } from "./schema";
export { SuwayomiTransport } from "./transport";
export type {
  GraphQLExecuteOptions,
  GraphQLOperation,
  GraphQLTransport,
  GraphQLVariables,
  SuwayomiTransportOptions,
} from "./transport";
export type * from "./types";
