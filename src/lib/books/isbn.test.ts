import { describe, expect, it } from "vitest";

import { extractIsbns, normalizeIsbn } from "./isbn";

describe("ISBN metadata helpers", () => {
  it("normalizes valid ISBN-10 and ISBN-13 values", () => {
    expect(normalizeIsbn("978-0-306-40615-7")).toBe("9780306406157");
    expect(normalizeIsbn("0-306-40615-2")).toBe("0306406152");
  });

  it("rejects malformed identifiers and UUID-like metadata", () => {
    expect(normalizeIsbn("9780306406158")).toBeNull();
    expect(normalizeIsbn("urn:uuid:12345678-1234-1234-1234-123456789012")).toBeNull();
  });

  it("extracts unique ISBN values from nested metadata", () => {
    expect(extractIsbns(
      { identifier: "urn:isbn:978-0-306-40615-7" },
      ["ISBN 0-306-40615-2", "9780306406157"],
    )).toEqual(["9780306406157", "0306406152"]);
  });
});
