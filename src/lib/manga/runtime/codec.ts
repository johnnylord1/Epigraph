import { incompatiblePayload } from "./errors";

export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw incompatiblePayload(path, "object");
  }
  return value as UnknownRecord;
}

export function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw incompatiblePayload(path, "array");
  return value;
}

export function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw incompatiblePayload(path, "string");
  return value;
}

export function nullableString(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : string(value, path);
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw incompatiblePayload(path, "boolean");
  return value;
}

export function nullableBoolean(value: unknown, path: string): boolean | null {
  return value === null || value === undefined ? null : boolean(value, path);
}

export function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw incompatiblePayload(path, "finite number");
  }
  return value;
}

export function nullableNumber(value: unknown, path: string): number | null {
  return value === null || value === undefined ? null : number(value, path);
}

export function integer(value: unknown, path: string): number {
  const parsed = number(value, path);
  if (!Number.isInteger(parsed)) throw incompatiblePayload(path, "integer");
  return parsed;
}

export function integerString(value: unknown, path: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  throw incompatiblePayload(path, "integer or integer string");
}

export function nullableIntegerNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(integerString(value, path));
  if (!Number.isSafeInteger(parsed)) {
    throw incompatiblePayload(path, "safe integer or integer string");
  }
  return parsed;
}

export function field(value: UnknownRecord, key: string, path: string): unknown {
  if (!(key in value)) throw incompatiblePayload(`${path}.${key}`, "present field");
  return value[key];
}

export function nodes(value: unknown, path: string): readonly unknown[] {
  const connection = record(value, path);
  return array(field(connection, "nodes", path), `${path}.nodes`);
}
