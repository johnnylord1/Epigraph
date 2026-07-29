export const DIAGNOSTIC_MAX_DEPTH = 4;
export const DIAGNOSTIC_MAX_ARRAY_ITEMS = 24;
export const DIAGNOSTIC_MAX_OBJECT_KEYS = 48;
export const DIAGNOSTIC_MAX_STRING_LENGTH = 1_024;
export const DIAGNOSTIC_MAX_STACK_LENGTH = 4_096;

export interface DiagnosticArray extends ReadonlyArray<DiagnosticValue> {}

export interface DiagnosticObject {
  readonly [key: string]: DiagnosticValue;
}

export type DiagnosticValue =
  | string
  | number
  | boolean
  | null
  | DiagnosticArray
  | DiagnosticObject;

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|bootstrap|qr|tlskey|privatekey)/i;
const PERSONAL_KEY_PATTERN = /^(?:query|description|content|body|html|username|email)$/i;
const WINDOWS_PRIVATE_PATH_PATTERN = /[A-Za-z]:\\Users\\[^\\\s]+/g;
const UNIX_PRIVATE_PATH_PATTERN = /\/(?:home|Users)\/[^/\s]+/g;

interface RedactionOptions {
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

export function redactDiagnosticText(
  value: string,
  maxLength = DIAGNOSTIC_MAX_STRING_LENGTH,
): string {
  return truncate(
    value
      .replace(WINDOWS_PRIVATE_PATH_PATTERN, "[PRIVATE_PATH]")
      .replace(UNIX_PRIVATE_PATH_PATTERN, "[PRIVATE_PATH]"),
    maxLength,
  );
}

export function redactDiagnosticValue(
  value: unknown,
  options: RedactionOptions = {},
): DiagnosticValue {
  const maxDepth = Math.max(1, options.maxDepth ?? DIAGNOSTIC_MAX_DEPTH);
  const maxArrayItems = Math.max(1, options.maxArrayItems ?? DIAGNOSTIC_MAX_ARRAY_ITEMS);
  const maxObjectKeys = Math.max(1, options.maxObjectKeys ?? DIAGNOSTIC_MAX_OBJECT_KEYS);
  const maxStringLength = Math.max(16, options.maxStringLength ?? DIAGNOSTIC_MAX_STRING_LENGTH);
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number, key: string | null): DiagnosticValue => {
    if (key && (SENSITIVE_KEY_PATTERN.test(key) || PERSONAL_KEY_PATTERN.test(key))) {
      return "[REDACTED]";
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "string") return redactDiagnosticText(current, maxStringLength);
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "undefined") return "[UNDEFINED]";
    if (typeof current === "function" || typeof current === "symbol") {
      return `[${typeof current}]`;
    }
    if (depth >= maxDepth) return "[MAX_DEPTH]";

    if (current instanceof Error) {
      return {
        name: redactDiagnosticText(current.name, maxStringLength),
        message: redactDiagnosticText(current.message, maxStringLength),
        stack: redactDiagnosticText(current.stack ?? "", DIAGNOSTIC_MAX_STACK_LENGTH),
        cause: visit(current.cause, depth + 1, "cause"),
      };
    }

    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);

    if (Array.isArray(current)) {
      const items = current
        .slice(0, maxArrayItems)
        .map((item) => visit(item, depth + 1, null));
      if (current.length > maxArrayItems) {
        items.push(`[TRUNCATED ${current.length - maxArrayItems} ITEMS]`);
      }
      return items;
    }

    const entries = Object.entries(current as Record<string, unknown>);
    const result: Record<string, DiagnosticValue> = {};
    for (const [entryKey, entryValue] of entries.slice(0, maxObjectKeys)) {
      result[entryKey] = visit(entryValue, depth + 1, entryKey);
    }
    if (entries.length > maxObjectKeys) {
      result.__truncatedKeys = entries.length - maxObjectKeys;
    }
    return result;
  };

  return visit(value, 0, null);
}

export function canonicalEndpointIdentity(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "http:" && parsed.port === "80")
      || (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return "invalid-endpoint";
  }
}
