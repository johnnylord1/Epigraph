import {
  SourceRuntimeError,
  isSourceRuntimeError,
  type SourceRuntimeErrorCode,
} from "./errors";
import type {
  ExtensionRef,
  ExtensionStore,
  RuntimeInfo,
  SourceRef,
  SourceRuntime,
  SourceSearchMode,
} from "./types";

export type ExtensionHealthStatus =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "unknown"
  | "not_applicable";

export type ExtensionHealthDimension =
  | "runtime"
  | "manager"
  | "store"
  | "artifact"
  | "compatibility"
  | "load"
  | "registration"
  | "reachability";

export type ExtensionHealthCode =
  | SourceRuntimeErrorCode
  | "STORE_UNAVAILABLE"
  | "EXTENSION_NOT_INSTALLED"
  | "EXTENSION_OBSOLETE"
  | "EXTENSION_NOT_LOADED"
  | "SOURCE_NOT_REGISTERED"
  | "UPDATE_AVAILABLE";

export interface ExtensionHealthCheck {
  dimension: ExtensionHealthDimension;
  status: ExtensionHealthStatus;
  code: ExtensionHealthCode | null;
  message: string;
}

export interface ExtensionStructuralHealth {
  packageName: string;
  extensionName: string;
  overall: ExtensionHealthStatus;
  sourceIds: readonly string[];
  checks: readonly ExtensionHealthCheck[];
}

export interface StructuralExtensionHealthSnapshot {
  level: 0;
  observedAt: number;
  stale: boolean;
  runtimeInfo: RuntimeInfo | null;
  runtime: ExtensionHealthCheck;
  manager: ExtensionHealthCheck;
  extensions: readonly ExtensionStructuralHealth[];
}

export interface SourceReachabilityHealth {
  level: 1;
  sourceId: string;
  packageName: string | null;
  status: ExtensionHealthStatus;
  classification: SourceRuntimeErrorCode | null;
  observedAt: number;
  lastKnownHealthyAt: number | null;
  stale: boolean;
  itemCount: number | null;
  message: string;
}

export interface StructuralHealthOptions {
  signal?: AbortSignal;
  previous?: StructuralExtensionHealthSnapshot | null;
  now?: () => number;
  helperPackageNames?: ReadonlySet<string>;
}

export interface SourceReachabilityProbeInput {
  sourceId: string;
  packageName?: string | null;
  mode?: SourceSearchMode;
  query?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  force?: boolean;
}

const DEFAULT_HELPER_PACKAGES = new Set([
  "eu.kanade.tachiyomi.extension.all.tachidesk",
]);

function check(
  dimension: ExtensionHealthDimension,
  status: ExtensionHealthStatus,
  code: ExtensionHealthCode | null,
  message: string,
): ExtensionHealthCheck {
  return { dimension, status, code, message };
}

function normalizeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function overallStatus(checks: readonly ExtensionHealthCheck[]): ExtensionHealthStatus {
  if (checks.some((item) => item.status === "unhealthy")) return "unhealthy";
  if (checks.some((item) => item.status === "degraded")) return "degraded";
  if (checks.some((item) => item.status === "healthy")) return "healthy";
  return "unknown";
}

function extensionHealth(
  extension: ExtensionRef,
  stores: readonly ExtensionStore[],
  sources: readonly SourceRef[],
  helperPackageNames: ReadonlySet<string>,
): ExtensionStructuralHealth {
  const extensionSources = sources.filter(
    (source) => source.extensionPackageName === extension.packageName,
  );
  const helper = helperPackageNames.has(extension.packageName);
  const storeId = normalizeUrl(extension.storeId);
  const storeAvailable = storeId !== null && stores.some(
    (store) => normalizeUrl(store.id) === storeId || normalizeUrl(store.indexUrl) === storeId,
  );
  const checks: ExtensionHealthCheck[] = [];

  if (!extension.isInstalled) {
    checks.push(check("artifact", "not_applicable", "EXTENSION_NOT_INSTALLED", "Extension is not installed."));
  } else {
    checks.push(check("artifact", "healthy", null, "Installed artifact is registered by Suwayomi."));
  }

  if (storeId === null) {
    checks.push(check("store", extension.isInstalled ? "degraded" : "unknown", "STORE_UNAVAILABLE", "No extension store is associated with this artifact."));
  } else if (storeAvailable) {
    checks.push(check("store", "healthy", null, "Origin store is available."));
  } else {
    checks.push(check("store", "degraded", "STORE_UNAVAILABLE", "Origin store is no longer configured."));
  }

  if (extension.isObsolete) {
    checks.push(check("compatibility", "degraded", "EXTENSION_OBSOLETE", "Suwayomi marks this extension as obsolete."));
  } else if (extension.hasUpdate) {
    checks.push(check("compatibility", "degraded", "UPDATE_AVAILABLE", "A newer extension artifact is available."));
  } else if (extension.isInstalled) {
    checks.push(check("compatibility", "healthy", null, "No structural compatibility warning is reported."));
  } else {
    checks.push(check("compatibility", "not_applicable", null, "Compatibility is evaluated after installation."));
  }

  if (helper || !extension.isInstalled) {
    const message = helper
      ? "Helper extension does not register content sources."
      : "Load state is evaluated after installation.";
    checks.push(check("load", "not_applicable", null, message));
    checks.push(check("registration", "not_applicable", null, message));
  } else if (extensionSources.length > 0) {
    checks.push(check("load", "healthy", null, "Extension loaded and exposed at least one source."));
    checks.push(check("registration", "healthy", null, "Source registration is visible through GraphQL."));
  } else {
    checks.push(check("load", "unhealthy", "EXTENSION_NOT_LOADED", "Installed extension did not expose a source."));
    checks.push(check("registration", "unhealthy", "SOURCE_NOT_REGISTERED", "No source is registered for the installed extension."));
  }

  checks.push(check("reachability", "unknown", null, "Website reachability is not tested at Level 0."));
  return {
    packageName: extension.packageName,
    extensionName: extension.name,
    overall: overallStatus(checks),
    sourceIds: extensionSources.map((source) => source.id),
    checks,
  };
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" ");
}

export function classifyExtensionFailure(error: unknown): SourceRuntimeError {
  if (isSourceRuntimeError(error) && error.code !== "UNKNOWN") return error;
  const text = errorText(error);

  if (/AbstractMethodError|NoSuchMethodError|IncompatibleClassChangeError|NoClassDefFoundError|ClassNotFoundException|VerifyError|UnsupportedClassVersionError/i.test(text)) {
    return new SourceRuntimeError(
      "EXTENSION_INCOMPATIBLE",
      "The extension is incompatible with the active Suwayomi runtime.",
      { cause: error, details: { failureClass: "abi-or-classloader" } },
    );
  }
  if (/SerializationException|JsonDecodingException|MissingFieldException|InvalidDefinitionException/i.test(text)) {
    return new SourceRuntimeError(
      "EXTENSION_INCOMPATIBLE",
      "The extension returned data that is incompatible with the active runtime contract.",
      { cause: error, details: { failureClass: "serialization" } },
    );
  }
  if (/cloudflare|captcha|challenge|cf-chl|just a moment|status\s*403|http\s*403/i.test(text)) {
    return new SourceRuntimeError(
      "ANTIBOT_CHALLENGE",
      "The source is currently protected by an anti-bot challenge.",
      { retryable: true, cause: error },
    );
  }
  if (/unauthori[sz]ed|login required|authentication required|invalid cookie|expired cookie|status\s*401|http\s*401/i.test(text)) {
    return new SourceRuntimeError(
      "AUTHENTICATION_REQUIRED",
      "The source requires authentication.",
      { cause: error },
    );
  }
  if (/rate.?limit|too many requests|status\s*429|http\s*429/i.test(text)) {
    return new SourceRuntimeError(
      "RATE_LIMITED",
      "The source temporarily limited requests.",
      { retryable: true, cause: error },
    );
  }
  if (/timeout|timed out|ENOTFOUND|ECONNREFUSED|ECONNRESET|network|dns|host.*unreachable|offline/i.test(text)) {
    return new SourceRuntimeError(
      "SOURCE_OFFLINE",
      "The source is temporarily unreachable.",
      { retryable: true, cause: error },
    );
  }
  if (/preference|required setting|configuration required|not configured/i.test(text)) {
    return new SourceRuntimeError(
      "CONFIGURATION_REQUIRED",
      "The source requires configuration before it can be used.",
      { cause: error },
    );
  }
  return isSourceRuntimeError(error)
    ? error
    : new SourceRuntimeError("UNKNOWN", "The source health probe failed for an unknown reason.", { cause: error });
}

function runtimeFailureCheck(error: SourceRuntimeError): ExtensionHealthCheck {
  const status = error.retryable ? "degraded" : "unhealthy";
  return check("runtime", status, error.code, error.message);
}

export async function collectStructuralExtensionHealth(
  runtime: SourceRuntime,
  options: StructuralHealthOptions = {},
): Promise<StructuralExtensionHealthSnapshot> {
  const observedAt = (options.now ?? Date.now)();
  try {
    const [runtimeInfo, stores, extensions, sources] = await Promise.all([
      runtime.getRuntimeInfo(),
      runtime.listStores(options.signal),
      runtime.listExtensions(options.signal),
      runtime.listSources(options.signal),
    ]);
    const helperPackages = options.helperPackageNames ?? DEFAULT_HELPER_PACKAGES;
    return {
      level: 0,
      observedAt,
      stale: false,
      runtimeInfo,
      runtime: check("runtime", "healthy", null, "Suwayomi runtime contract is available."),
      manager: check("manager", "healthy", null, "Extension manager inventory is available."),
      extensions: extensions.map((extension) => extensionHealth(extension, stores, sources, helperPackages)),
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const classified = classifyExtensionFailure(error);
    const preservePrevious = classified.retryable && options.previous !== null && options.previous !== undefined;
    return {
      level: 0,
      observedAt,
      stale: preservePrevious,
      runtimeInfo: preservePrevious ? options.previous!.runtimeInfo : null,
      runtime: runtimeFailureCheck(classified),
      manager: check(
        "manager",
        preservePrevious ? "degraded" : "unknown",
        classified.code,
        preservePrevious
          ? "Showing the last valid extension inventory while the runtime recovers."
          : "Extension manager inventory is unavailable.",
      ),
      extensions: preservePrevious ? options.previous!.extensions : [],
    };
  }
}

export class SourceHealthProbeCache {
  private readonly entries = new Map<string, { expiresAt: number; report: SourceReachabilityHealth }>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 100,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): SourceReachabilityHealth | null {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.report;
  }

  remember(key: string, report: SourceReachabilityHealth): SourceReachabilityHealth {
    const previous = this.get(key);
    const transient = report.classification === "SOURCE_OFFLINE"
      || report.classification === "NETWORK_FAILURE"
      || report.classification === "RATE_LIMITED"
      || report.classification === "ANTIBOT_CHALLENGE";
    const resolved = report.status !== "healthy" && transient
      && previous?.lastKnownHealthyAt
      ? {
          ...report,
          status: "degraded" as const,
          stale: true,
          lastKnownHealthyAt: previous.lastKnownHealthyAt,
          itemCount: previous.itemCount,
        }
      : report;
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, report: resolved });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return resolved;
  }

  clear(): void {
    this.entries.clear();
  }
}

const defaultProbeCache = new SourceHealthProbeCache();

function probeKey(input: SourceReachabilityProbeInput): string {
  return [input.sourceId, input.mode ?? "POPULAR", input.query?.trim() ?? ""].join("\u0000");
}

export async function probeSourceReachability(
  runtime: SourceRuntime,
  input: SourceReachabilityProbeInput,
  cache: SourceHealthProbeCache = defaultProbeCache,
): Promise<SourceReachabilityHealth> {
  const key = probeKey(input);
  if (!input.force) {
    const cached = cache.get(key);
    if (cached) return cached;
  }

  if (input.signal?.aborted) {
    throw input.signal.reason ?? new DOMException("Source health probe was cancelled.", "AbortError");
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (input.signal?.aborted) controller.abort(input.signal.reason);
  const timeout = globalThis.setTimeout(
    () => {
      timedOut = true;
      controller.abort(new DOMException("Source health probe timed out.", "TimeoutError"));
    },
    Math.min(30_000, Math.max(500, input.timeoutMs ?? 8_000)),
  );
  const observedAt = Date.now();

  try {
    const result = await runtime.search({
      sourceId: input.sourceId,
      mode: input.mode ?? "POPULAR",
      page: 1,
      ...(input.query === undefined ? {} : { query: input.query }),
      signal: controller.signal,
    });
    return cache.remember(key, {
      level: 1,
      sourceId: input.sourceId,
      packageName: input.packageName ?? null,
      status: "healthy",
      classification: null,
      observedAt,
      lastKnownHealthyAt: observedAt,
      stale: false,
      itemCount: result.items.length,
      message: "Source responded to a lightweight request.",
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const classified = timedOut
      ? new SourceRuntimeError(
          "SOURCE_OFFLINE",
          "The source health probe timed out.",
          { retryable: true, cause: error },
        )
      : classifyExtensionFailure(error);
    return cache.remember(key, {
      level: 1,
      sourceId: input.sourceId,
      packageName: input.packageName ?? null,
      status: classified.retryable ? "degraded" : "unhealthy",
      classification: classified.code,
      observedAt,
      lastKnownHealthyAt: null,
      stale: false,
      itemCount: null,
      message: classified.message,
    });
  } finally {
    globalThis.clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}
