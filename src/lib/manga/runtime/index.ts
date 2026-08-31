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
  fetchSourceChapterPages,
  fetchSourceMangaChapters,
  fetchSourceMangaDetails,
  searchSourceManga,
  type SourceMangaSearchVariables,
} from "./sourceOperations";
export { runDeterministicSourceContract } from "./sourceContract";
export type {
  DeterministicSourceContractEvidence,
  DeterministicSourceContractInput,
} from "./sourceContract";
export { runExplicitCompatibilityProbe } from "./observedCompatibility";
export type { ExplicitCompatibilityProbeInput } from "./observedCompatibility";
export {
  canonicalizeExtensionStoreUrl,
  resolveExtensionStoreInputUrl,
} from "./storeUrl";
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
  MAX_OBSERVED_COMPATIBILITY_REPORTS,
  OBSERVED_COMPATIBILITY_REPORT_SCHEMA_VERSION,
  aggregateObservedCompatibilityStages,
  extensionCompatibilityIdentity,
  latestObservedCompatibilityReport,
  loadExtensionCompatibilityState,
  normalizeExtensionCompatibilityRecord,
  normalizeExtensionCompatibilityState,
  normalizeObservedCompatibilityReport,
  resetExtensionCompatibilityStateCacheForTests,
  saveExtensionCompatibilityState,
  upsertExtensionCompatibilityRecord,
  upsertObservedCompatibilityReport,
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
  CompatibilityAggregateStatus,
  CompatibilityReportTrigger,
  CompatibilityRuntimeScope,
  CompatibilityStageKind,
  CompatibilityStageStatus,
  ObservedCompatibilityReport,
  ObservedCompatibilityStage,
} from "./extensionCompatibility";
export {
  INTROSPECTION_OPERATION,
  canonicalSchemaJson,
  canonicalSchemaSha256,
  canonicalizeSchema,
  evaluateRuntimeContract,
  canonicalRuntimeCapabilitiesJson,
  runtimeCapabilitiesSha256,
} from "./schema";
export type { CanonicalGraphQLSchema } from "./schema";
export {
  canonicalEndpointIdentity,
  redactDiagnosticText,
  redactDiagnosticValue,
} from "./diagnostics";
export type { DiagnosticValue } from "./diagnostics";
export { SuwayomiTransport } from "./transport";
export type {
  GraphQLExecuteOptions,
  GraphQLOperation,
  GraphQLTransport,
  GraphQLVariables,
  SuwayomiTransportOptions,
  GraphQLTraceEvent,
  GraphQLTraceObserver,
  GraphQLTraceStage,
} from "./transport";
export type * from "./types";
