import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "./base64";

function sample(length: number) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 7919 + (index >> 8)) & 0xff;
  return bytes;
}

describe.each([
  ["native", true],
  ["fallback", false],
])("base64 bytes (%s)", (_name, native) => {
  it("round-trips every byte value and matches the standard encodings", () => {
    const every = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(encodeBase64(every, "base64", native)).toBe(Buffer.from(every).toString("base64"));
    expect(encodeBase64(every, "base64url", native)).toBe(Buffer.from(every).toString("base64url"));
    expect([...decodeBase64(encodeBase64(every, "base64", native), "base64", native)]).toEqual([...every]);
    expect([...decodeBase64(encodeBase64(every, "base64url", native), "base64url", native)]).toEqual([...every]);
  });

  it("keeps a page larger than one chunk intact, whatever its length", () => {
    for (const length of [0, 1, 2, 3, 0x8000 - 1, 0x8000, 0x8000 + 1, 3 * 0x8000 + 2]) {
      const bytes = sample(length);
      const base64 = encodeBase64(bytes, "base64", native);
      expect(base64).toBe(Buffer.from(bytes).toString("base64"));
      expect(Buffer.from(decodeBase64(base64, "base64", native)).equals(Buffer.from(bytes))).toBe(true);
      const url = encodeBase64(bytes, "base64url", native);
      expect(url).not.toMatch(/[+/=]/);
      expect(Buffer.from(decodeBase64(url, "base64url", native)).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("refuses text that is not base64", () => {
    expect(() => decodeBase64("not base64!", "base64", native)).toThrow();
  });
});
