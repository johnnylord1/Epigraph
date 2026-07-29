import { describe, expect, test } from "vitest";

import {
  canonicalEndpointIdentity,
  redactDiagnosticText,
  redactDiagnosticValue,
} from "./diagnostics";

describe("source runtime diagnostics", () => {
  test("canonicalizes endpoint identity without credentials or transient URL data", () => {
    expect(canonicalEndpointIdentity(
      "HTTP://user:password@LOCALHOST:80/api/graphql/?token=secret#fragment",
    )).toBe("http://localhost/api/graphql");
    expect(canonicalEndpointIdentity("not a URL")).toBe("invalid-endpoint");
  });

  test("redacts secrets, personal queries and private user paths", () => {
    expect(redactDiagnosticValue({
      query: "a private title",
      authorization: "Bearer secret",
      nested: {
        cookie: "session=secret",
        path: "C:\\Users\\private-user\\AppData\\Local\\Aethon",
      },
    })).toEqual({
      query: "[REDACTED]",
      authorization: "[REDACTED]",
      nested: {
        cookie: "[REDACTED]",
        path: "[PRIVATE_PATH]\\AppData\\Local\\Aethon",
      },
    });
    expect(redactDiagnosticText("/home/private-user/.config/aethon")).toBe(
      "[PRIVATE_PATH]/.config/aethon",
    );
  });

  test("bounds depth, collection size and circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(redactDiagnosticValue(circular)).toEqual({ self: "[CIRCULAR]" });
    expect(redactDiagnosticValue(
      { nested: { deeper: { value: true } } },
      { maxDepth: 2 },
    )).toEqual({
      nested: {
        deeper: "[MAX_DEPTH]",
      },
    });
    expect(redactDiagnosticValue([1, 2, 3], { maxArrayItems: 2 })).toEqual([
      1,
      2,
      "[TRUNCATED 1 ITEMS]",
    ]);
  });
});
