import { describe, expect, it } from "vitest";
import pako from "pako";
import {
  isGzipBytes,
  normalizeNativeMangaBackupBytes,
} from "./mangaNativeFormat";

describe("manga native backup formats", () => {
  it("keeps tachibk bytes unchanged", () => {
    const gzipped = pako.gzip(new TextEncoder().encode("proto payload"));
    expect(normalizeNativeMangaBackupBytes(gzipped, "tachibk")).toEqual(gzipped);
  });

  it("can export gzip proto and raw proto from the same source", () => {
    const raw = new TextEncoder().encode("proto payload");
    const gzipped = normalizeNativeMangaBackupBytes(raw, "proto-gz");
    expect(isGzipBytes(gzipped)).toBe(true);
    expect(new TextDecoder().decode(normalizeNativeMangaBackupBytes(gzipped, "proto"))).toBe("proto payload");
  });
});
