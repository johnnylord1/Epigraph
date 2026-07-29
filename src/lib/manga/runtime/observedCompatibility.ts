import { probeSourceReachability } from "./health";
import {
  aggregateObservedCompatibilityStages,
  type CompatibilityRuntimeScope,
  type ObservedCompatibilityReport,
  type ObservedCompatibilityStage,
} from "./extensionCompatibility";
import type { SourceRuntime } from "./types";

export interface ExplicitCompatibilityProbeInput {
  profileId: string;
  packageName: string;
  versionCode: string;
  artifactSha256?: string | null;
  runtimeArtifactSha256?: string | null;
  runtimeScope: CompatibilityRuntimeScope;
  signal?: AbortSignal;
  now?: () => number;
  reportId?: string;
}

function reportIdentifier(input: ExplicitCompatibilityProbeInput, startedAt: number): string {
  if (input.reportId) return input.reportId;
  return `live:${input.packageName}:${input.versionCode}:${startedAt}`;
}

export async function runExplicitCompatibilityProbe(
  runtime: SourceRuntime,
  input: ExplicitCompatibilityProbeInput,
): Promise<ObservedCompatibilityReport> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const [runtimeInfo, fingerprint, sources] = await Promise.all([
    runtime.getRuntimeInfo(),
    runtime.getRuntimeFingerprint(),
    runtime.listSources(input.signal),
  ]);
  const source = sources.find((entry) => entry.extensionPackageName === input.packageName) ?? null;
  const stages: ObservedCompatibilityStage[] = [{
    id: "runtime-readiness",
    label: "Runtime readiness",
    kind: "DETERMINISTIC",
    status: "PASS",
    durationMs: null,
    failureCode: null,
  }, {
    id: "source-registration",
    label: "Source registration",
    kind: "DETERMINISTIC",
    status: source ? "PASS" : "FAIL",
    durationMs: null,
    failureCode: source ? null : "SOURCE_NOT_REGISTERED",
  }];

  if (source) {
    const reachability = await probeSourceReachability(runtime, {
      sourceId: source.id,
      packageName: input.packageName,
      mode: "POPULAR",
      signal: input.signal,
      force: true,
    });
    stages.push({
      id: "live-search",
      label: "Live search",
      kind: "OBSERVATIONAL",
      status: reachability.status === "healthy" ? "PASS" : "INCONCLUSIVE",
      durationMs: null,
      failureCode: reachability.classification,
    });
  } else {
    stages.push({
      id: "live-search",
      label: "Live search",
      kind: "OBSERVATIONAL",
      status: "SKIPPED",
      durationMs: null,
      failureCode: "SOURCE_NOT_REGISTERED",
    });
  }

  stages.push({
    id: "http-parser-internals",
    label: "HTTP and parser internals",
    kind: "OBSERVATIONAL",
    status: "NOT_OBSERVED",
    durationMs: null,
    failureCode: null,
  });
  const completedAt = now();
  return {
    schemaVersion: 1,
    reportId: reportIdentifier(input, startedAt),
    profileId: input.profileId,
    packageName: input.packageName,
    versionCode: input.versionCode,
    artifactSha256: input.artifactSha256 ?? null,
    runtimeVersion: runtimeInfo.version,
    runtimeArtifactSha256: input.runtimeArtifactSha256 ?? null,
    adapterProfile: runtimeInfo.profileId,
    endpointIdentity: fingerprint.endpointIdentity,
    runtimeScope: input.runtimeScope,
    trigger: "EXPLICIT_LIVE",
    sourceId: source?.id ?? null,
    startedAt,
    completedAt,
    aggregateStatus: aggregateObservedCompatibilityStages(stages),
    stages,
  };
}
