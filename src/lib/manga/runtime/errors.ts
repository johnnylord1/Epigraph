import type { DiagnosticValue } from "./diagnostics";

export type SourceRuntimeErrorCode =
  | "RUNTIME_UNAVAILABLE"
  | "RUNTIME_INCOMPATIBLE"
  | "EXTENSION_INCOMPATIBLE"
  | "SOURCE_OBSOLETE"
  | "SOURCE_PARSER_FAILURE"
  | "SOURCE_OFFLINE"
  | "AUTHENTICATION_REQUIRED"
  | "ANTIBOT_CHALLENGE"
  | "RATE_LIMITED"
  | "CONFIGURATION_REQUIRED"
  | "PREFERENCE_UNSUPPORTED"
  | "PREFERENCE_VALIDATION_FAILED"
  | "PREFERENCE_CONFIRMATION_FAILED"
  | "NETWORK_FAILURE"
  | "UNKNOWN";

export interface SourceRuntimeErrorOptions {
  retryable?: boolean;
  details?: Readonly<Record<string, string | number | boolean | null>>;
  graphqlErrors?: readonly SourceRuntimeGraphQLError[];
  cause?: unknown;
}

export interface SourceRuntimeGraphQLError {
  message: string;
  path: readonly (string | number)[];
  locations: readonly Readonly<{ line: number; column: number }>[];
  extensions: DiagnosticValue;
}

export class SourceRuntimeError extends Error {
  readonly code: SourceRuntimeErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
  readonly graphqlErrors: readonly SourceRuntimeGraphQLError[];

  constructor(
    code: SourceRuntimeErrorCode,
    message: string,
    options: SourceRuntimeErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SourceRuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.graphqlErrors = Object.freeze([...(options.graphqlErrors ?? [])]);
  }
}

export function isSourceRuntimeError(error: unknown): error is SourceRuntimeError {
  return error instanceof SourceRuntimeError;
}

export function incompatiblePayload(path: string, expected: string): SourceRuntimeError {
  return new SourceRuntimeError(
    "RUNTIME_INCOMPATIBLE",
    `Suwayomi returned an incompatible payload at ${path}.`,
    { details: { path, expected } },
  );
}

export function normalizeSourceRuntimeError(error: unknown): SourceRuntimeError {
  if (isSourceRuntimeError(error)) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new SourceRuntimeError("NETWORK_FAILURE", "The Suwayomi request was cancelled.", {
      retryable: true,
      cause: error,
    });
  }
  return new SourceRuntimeError("UNKNOWN", "An unexpected source runtime error occurred.", {
    cause: error,
  });
}
