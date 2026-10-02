import { describe, expect, test } from "vitest";
import { normalizeMihonMemoFields } from "./mihonMemo";

/** Build a protobuf field: key (varint of fieldNo*8+wire) + value.
 * For wire 2, payload is the byte content (length prefix added automatically).
 * For wire 0, payload is a number encoded as varint.
 */
function field(no: number, wire: number, payload: Uint8Array | number): Uint8Array {
  const key = encodeVarintBytes(no * 8 + wire);
  if (wire === 2) {
    const bytes = payload as Uint8Array;
    const len = encodeVarintBytes(bytes.length);
    return concat([key, len, bytes]);
  }
  if (wire === 0) {
    return concat([key, encodeVarintBytes(payload as number)]);
  }
  // wire 1 (8 bytes) or wire 5 (4 bytes): payload is the raw bytes
  return concat([key, payload as Uint8Array]);
}

function encodeVarintBytes(n: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return Uint8Array.from(bytes);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function str(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("normalizeMihonMemoFields", () => {
  test("rewrites empty manga and chapter memos to {}", () => {
    // Chapter: url (field 1, wire 2) = "/c1", memo (field 13, wire 2) = ""
    const chapter = concat([
      field(1, 2, str("/c1")),
      field(13, 2, new Uint8Array(0)),
    ]);

    // Manga: title (field 3, wire 2) = "A", memo (field 112, wire 2) = "", chapter (field 16, wire 2)
    const manga = concat([
      field(3, 2, str("A")),
      field(112, 2, new Uint8Array(0)),
      field(16, 2, chapter),
    ]);

    // Top-level Backup: manga (field 1, wire 2)
    const backup = field(1, 2, manga);

    const result = normalizeMihonMemoFields(backup);

    // Expected: same structure but memos are "{}"
    const expectedChapter = concat([
      field(1, 2, str("/c1")),
      field(13, 2, str("{}")),
    ]);
    const expectedManga = concat([
      field(3, 2, str("A")),
      field(112, 2, str("{}")),
      field(16, 2, expectedChapter),
    ]);
    const expected = field(1, 2, expectedManga);

    expect(result).toEqual(expected);
  });

  test("returns same instance when non-empty memo needs no change", () => {
    const memo = str('{"slug":"x"}');
    const chapter = concat([
      field(1, 2, str("/c1")),
      field(13, 2, memo),
    ]);
    const manga = concat([
      field(3, 2, str("A")),
      field(112, 2, memo),
      field(16, 2, chapter),
    ]);
    const backup = field(1, 2, manga);

    const result = normalizeMihonMemoFields(backup);
    expect(result).toBe(backup);
  });

  test("preserves unknown fields in place and in order", () => {
    // Manga with unknown field 800 (varint) before and after known fields
    const chapter = field(13, 2, new Uint8Array(0));
    const manga = concat([
      field(800, 0, 42),
      field(3, 2, str("A")),
      field(112, 2, new Uint8Array(0)),
      field(16, 2, chapter),
      field(801, 0, 99),
    ]);

    // Top-level with unknown field 602 (varint)
    const backup = concat([
      field(602, 0, 7),
      field(1, 2, manga),
    ]);

    const result = normalizeMihonMemoFields(backup);

    // Expected: unknown fields preserved, memos rewritten
    const expectedChapter = field(13, 2, str("{}"));
    const expectedManga = concat([
      field(800, 0, 42),
      field(3, 2, str("A")),
      field(112, 2, str("{}")),
      field(16, 2, expectedChapter),
      field(801, 0, 99),
    ]);
    const expected = concat([
      field(602, 0, 7),
      field(1, 2, expectedManga),
    ]);

    expect(result).toEqual(expected);
  });

  test("returns same instance for truncated input", () => {
    const chapter = field(13, 2, new Uint8Array(0));
    const manga = field(16, 2, chapter);
    const backup = field(1, 2, manga);

    // Cut the last byte
    const truncated = backup.subarray(0, backup.length - 1);

    const result = normalizeMihonMemoFields(truncated);
    expect(result).toBe(truncated);
  });

  test("handles manga length that needs 2 varint bytes", () => {
    // Title of 200 chars makes the manga body > 127 bytes
    const longTitle = "a".repeat(200);
    const chapter = field(13, 2, new Uint8Array(0));
    const manga = concat([
      field(3, 2, str(longTitle)),
      field(112, 2, new Uint8Array(0)),
      field(16, 2, chapter),
    ]);

    // Manga body is > 127 bytes, so its length varint is 2 bytes
    expect(manga.length).toBeGreaterThan(127);

    const backup = field(1, 2, manga);
    const result = normalizeMihonMemoFields(backup);

    // Verify by reading back: decode the top-level field 1, then check manga content
    // The output should be well-formed with the manga length grown by 2 (empty memo → "{}")
    const expectedChapter = field(13, 2, str("{}"));
    const expectedManga = concat([
      field(3, 2, str(longTitle)),
      field(112, 2, str("{}")),
      field(16, 2, expectedChapter),
    ]);
    const expected = field(1, 2, expectedManga);

    expect(result).toEqual(expected);
    // Both manga memo and chapter memo grow by 2 bytes each
    expect(result.length).toBe(backup.length + 4);
  });
});
