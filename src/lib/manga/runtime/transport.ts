import {
  SourceRuntimeError,
  incompatiblePayload,
  normalizeSourceRuntimeError,
} from "./errors";

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
}

export interface GraphQLTransport {
  execute<TVariables, TResult>(
    operation: GraphQLOperation<TVariables, TResult>,
    variables: TVariables,
    options?: GraphQLExecuteOptions,
  ): Promise<TResult>;
}

export interface SuwayomiTransportOptions {
  endpoint: string | (() => string);
  headers?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof fetch;
  retries?: number;
  retryDelayMs?: number;
  defaultTimeoutMs?: number;
  beforeMutation?: () => void | Promise<void>;
  beginMutationLease?: () => Promise<() => void | Promise<void>>;
}

interface GraphQLErrorPayload {
  message: string;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function decodeErrors(value: unknown): readonly GraphQLErrorPayload[] {
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
    return { message };
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

  constructor(private readonly options: SuwayomiTransportOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.retries = Math.max(0, options.retries ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
    this.defaultTimeoutMs = Math.max(1, options.defaultTimeoutMs ?? 12_000);
  }

  async execute<TVariables, TResult>(
    operation: GraphQLOperation<TVariables, TResult>,
    variables: TVariables,
    options: GraphQLExecuteOptions = {},
  ): Promise<TResult> {
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
        try {
          return await this.executeOnce(operation, variables, controller.signal);
        } catch (error) {
          if (isAbort(error, controller.signal)) {
            throw new SourceRuntimeError(
              "NETWORK_FAILURE",
              "The Suwayomi request timed out or was cancelled.",
              { retryable: true, cause: error },
            );
          }
          const normalized = normalizeSourceRuntimeError(error);
          if (!normalized.retryable || attempt === retries) throw normalized;
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
  ): Promise<TResult> {
    const endpoint = typeof this.options.endpoint === "function"
      ? this.options.endpoint()
      : this.options.endpoint;
    const headers = new Headers(await this.options.headers?.());
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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
    try {
      payload = await response.json();
    } catch (error) {
      throw new SourceRuntimeError(
        "RUNTIME_INCOMPATIBLE",
        "Suwayomi returned invalid JSON.",
        { cause: error, details: { operation: operation.name } },
      );
    }

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
        { details: { operation: operation.name } },
      );
    }
    if (!("data" in envelope)) throw incompatiblePayload("response.data", "present field");
    return operation.decode(envelope.data);
  }
}
