import {
  SourceRuntimeError,
  incompatiblePayload,
  normalizeSourceRuntimeError,
} from "./errors";
import type { SourceRuntimeGraphQLError } from "./errors";
import {
  canonicalEndpointIdentity,
  redactDiagnosticText,
  redactDiagnosticValue,
  type DiagnosticValue,
} from "./diagnostics";

export type GraphQLVariables = Readonly<Record<string, unknown>>;

export interface GraphQLOperation<TVariables, TResult> {
  name: string;
  kind: "query" | "mutation";
  document: string;
  decode(data: unknown): TResult;
}

export interface GraphQLExecuteOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Synchronous check after admission/credentials resolve, immediately before send. */
  assertTarget?: () => void;
}

export interface GraphQLTransport {
  getEndpointIdentity?(): string;
  execute<TVariables, TResult>(
    operation: GraphQLOperation<TVariables, TResult>,
    variables: TVariables,
    options?: GraphQLExecuteOptions,
  ): Promise<TResult>;
}

export type GraphQLTraceStage =
  | "request"
  | "response"
  | "decode"
  | "retry"
  | "complete"
  | "failure";

export interface GraphQLTraceEvent {
  requestId: string;
  operationName: string;
  operationKind: "query" | "mutation";
  attempt: number;
  stage: GraphQLTraceStage;
  durationMs: number;
  httpStatus: number | null;
  responseBytes: number | null;
  variables?: DiagnosticValue;
  graphqlErrors?: readonly SourceRuntimeGraphQLError[];
  error?: DiagnosticValue;
}

export type GraphQLTraceObserver = (event: Readonly<GraphQLTraceEvent>) => void;

export interface SuwayomiTransportOptions {
  endpoint: string | (() => string);
  headers?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof fetch;
  retries?: number;
  retryDelayMs?: number;
  defaultTimeoutMs?: number;
  beforeMutation?: () => void | Promise<void>;
  beginMutationLease?: () => Promise<() => void | Promise<void>>;
  traceObserver?: GraphQLTraceObserver;
  requestIdFactory?: () => string;
  now?: () => number;
}

let fallbackRequestSequence = 0;

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function decodeErrors(value: unknown): readonly SourceRuntimeGraphQLError[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw incompatiblePayload("response.errors", "array");
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw incompatiblePayload(`response.errors[${index}]`, "object");
    }
    const message = (item as Record<string, unknown>).message;
    if (typeof message !== "string") {
      throw incompatiblePayload(`response.errors[${index}].message`, "string");
    }
    const raw = item as Record<string, unknown>;
    const path = Array.isArray(raw.path)
      ? raw.path.filter((segment): segment is string | number => (
          typeof segment === "string" || typeof segment === "number"
        ))
      : [];
    const locations = Array.isArray(raw.locations)
      ? raw.locations.flatMap((location) => {
          if (typeof location !== "object" || location === null || Array.isArray(location)) return [];
          const line = (location as Record<string, unknown>).line;
          const column = (location as Record<string, unknown>).column;
          return typeof line === "number"
            && typeof column === "number"
            && Number.isInteger(line)
            && Number.isInteger(column)
            ? [{ line, column }]
            : [];
        })
      : [];
    return {
      message: redactDiagnosticText(message),
      path,
      locations,
      extensions: redactDiagnosticValue(raw.extensions ?? null),
    };
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = globalThis.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export class SuwayomiTransport implements GraphQLTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly requestIdFactory: () => string;

  constructor(private readonly options: SuwayomiTransportOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.retries = Math.max(0, options.retries ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
    this.defaultTimeoutMs = Math.max(1, options.defaultTimeoutMs ?? 12_000);
    this.now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
    this.requestIdFactory = options.requestIdFactory ?? (() => {
      if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
      fallbackRequestSequence += 1;
      return `source-runtime-${Date.now()}-${fallbackRequestSequence}`;
    });
  }

  getEndpointIdentity(): string {
    const endpoint = typeof this.options.endpoint === "function"
      ? this.options.endpoint()
      : this.options.endpoint;
    return canonicalEndpointIdentity(endpoint);
  }

  async execute<TVariables, TResult>(
    operation: GraphQLOperation<TVariables, TResult>,
    variables: TVariables,
    options: GraphQLExecuteOptions = {},
  ): Promise<TResult> {
    const requestId = this.requestIdFactory();
    const startedAt = this.now();
    if (operation.kind === "mutation") await this.options.beforeMutation?.();
    const releaseMutationLease = operation.kind === "mutation"
      ? await this.options.beginMutationLease?.()
      : undefined;

    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (options.signal?.aborted) controller.abort();

    const timeoutMs = Math.max(1, options.timeoutMs ?? this.defaultTimeoutMs);
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      // A mutation may have completed server-side even when its HTTP response
      // was lost. Retrying it here can duplicate writes, so only queries use
      // the transport-level retry policy.
      const retries = operation.kind === "query" ? this.retries : 0;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (this.options.traceObserver) {
          this.trace({
            requestId,
            operationName: operation.name,
            operationKind: operation.kind,
            attempt: attempt + 1,
            stage: "request",
            durationMs: this.now() - startedAt,
            httpStatus: null,
            responseBytes: null,
            variables: redactDiagnosticValue(variables),
          });
        }
        try {
          return await this.executeOnce(
            operation,
            variables,
            controller.signal,
            requestId,
            attempt + 1,
            startedAt,
            options.assertTarget,
          );
        } catch (error) {
          if (isAbort(error, controller.signal)) {
            const normalized = new SourceRuntimeError(
              "NETWORK_FAILURE",
              "The Suwayomi request timed out or was cancelled.",
              { retryable: true, cause: error },
            );
            this.traceFailure(requestId, operation, attempt + 1, startedAt, normalized);
            throw normalized;
          }
          const normalized = normalizeSourceRuntimeError(error);
          if (!normalized.retryable || attempt === retries) {
            this.traceFailure(requestId, operation, attempt + 1, startedAt, normalized);
            throw normalized;
          }
          this.trace({
            requestId,
            operationName: operation.name,
            operationKind: operation.kind,
            attempt: attempt + 1,
            stage: "retry",
            durationMs: this.now() - startedAt,
            httpStatus: typeof normalized.details.status === "number"
              ? normalized.details.status
              : null,
            responseBytes: null,
            error: this.options.traceObserver
              ? redactDiagnosticValue(normalized)
              : undefined,
          });
          await delay(this.retryDelayMs * (attempt + 1), controller.signal);
        }
      }
      throw new SourceRuntimeError("UNKNOWN", "The Suwayomi request did not complete.");
    } finally {
      globalThis.clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromParent);
      await releaseMutationLease?.();
    }
  }

  private async executeOnce<TVariables, TResult>(
    operation: GraphQLOperation<TVariables, TResult>,
    variables: TVariables,
    signal: AbortSignal,
    requestId: string,
    attempt: number,
    startedAt: number,
    assertTarget?: () => void,
  ): Promise<TResult> {
    const endpoint = typeof this.options.endpoint === "function"
      ? this.options.endpoint()
      : this.options.endpoint;
    const headers = new Headers(await this.options.headers?.());
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    assertTarget?.();
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: operation.name,
        query: operation.document,
        variables,
      }),
      signal,
    });

    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? "AUTHENTICATION_REQUIRED"
        : response.status === 429
          ? "RATE_LIMITED"
          : "RUNTIME_UNAVAILABLE";
      throw new SourceRuntimeError(code, `Suwayomi HTTP ${response.status}.`, {
        retryable: retryableStatus(response.status),
        details: { status: response.status, operation: operation.name },
      });
    }

    let payload: unknown;
    let responseText = "";
    try {
      responseText = await response.text();
      payload = JSON.parse(responseText);
    } catch (error) {
      throw new SourceRuntimeError(
        "RUNTIME_INCOMPATIBLE",
        "Suwayomi returned invalid JSON.",
        { cause: error, details: { operation: operation.name } },
      );
    }

    this.trace({
      requestId,
      operationName: operation.name,
      operationKind: operation.kind,
      attempt,
      stage: "response",
      durationMs: this.now() - startedAt,
      httpStatus: response.status,
      responseBytes: new TextEncoder().encode(responseText).byteLength,
    });

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw incompatiblePayload("response", "GraphQL response object");
    }
    const envelope = payload as Record<string, unknown>;
    const errors = decodeErrors(envelope.errors);
    if (errors.length > 0) {
      throw new SourceRuntimeError(
        "UNKNOWN",
        errors.map((error) => error.message.trim()).filter(Boolean).join("; ")
          || "Suwayomi returned an empty GraphQL error.",
        {
          details: { operation: operation.name, graphqlErrorCount: errors.length },
          graphqlErrors: errors,
        },
      );
    }
    if (!("data" in envelope)) throw incompatiblePayload("response.data", "present field");
    this.trace({
      requestId,
      operationName: operation.name,
      operationKind: operation.kind,
      attempt,
      stage: "decode",
      durationMs: this.now() - startedAt,
      httpStatus: response.status,
      responseBytes: new TextEncoder().encode(responseText).byteLength,
    });
    const result = operation.decode(envelope.data);
    this.trace({
      requestId,
      operationName: operation.name,
      operationKind: operation.kind,
      attempt,
      stage: "complete",
      durationMs: this.now() - startedAt,
      httpStatus: response.status,
      responseBytes: new TextEncoder().encode(responseText).byteLength,
    });
    return result;
  }

  private trace(event: GraphQLTraceEvent): void {
    try {
      this.options.traceObserver?.(Object.freeze(event));
    } catch {
      // Diagnostics must never affect the source request.
    }
  }

  private traceFailure<TVariables, TResult>(
    requestId: string,
    operation: GraphQLOperation<TVariables, TResult>,
    attempt: number,
    startedAt: number,
    error: SourceRuntimeError,
  ): void {
    if (!this.options.traceObserver) return;
    this.trace({
      requestId,
      operationName: operation.name,
      operationKind: operation.kind,
      attempt,
      stage: "failure",
      durationMs: this.now() - startedAt,
      httpStatus: typeof error.details.status === "number" ? error.details.status : null,
      responseBytes: null,
      graphqlErrors: error.graphqlErrors,
      error: redactDiagnosticValue(error),
    });
  }
}
