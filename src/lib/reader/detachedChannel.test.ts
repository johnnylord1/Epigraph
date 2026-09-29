import { describe, expect, it } from "vitest";
import {
  createDetachedChannelKey,
  importDetachedChannelKey,
  isDetachedReaderLabel,
  isDetachedReaderWindow,
  isSealedDetachedMessage,
  openDetachedMessage,
  readDetachedPageUrls,
  readDetachedReaderSecret,
  sealDetachedMessage,
  trimTrailingUndefined,
} from "./detachedChannel";

const LABEL = "detached-reader-abc123";

describe("detached reader channel", () => {
  it("opens a message only with the same key, label and direction", async () => {
    const { key, secret } = await createDetachedChannelKey();
    const readerKey = await importDetachedChannelKey(secret);
    const sealed = await sealDetachedMessage(key, "to-reader", LABEL, { id: 1, value: "ok" });
    expect(isSealedDetachedMessage(sealed)).toBe(true);
    await expect(openDetachedMessage(readerKey, "to-reader", sealed)).resolves.toEqual({ id: 1, value: "ok" });

    await expect(openDetachedMessage(readerKey, "to-main", sealed)).rejects.toThrow();
    await expect(openDetachedMessage(readerKey, "to-reader", { ...sealed, label: "detached-reader-other" })).rejects.toThrow();
    const other = await createDetachedChannelKey();
    await expect(openDetachedMessage(other.key, "to-reader", sealed)).rejects.toThrow();
    // The first character carries six ciphertext bits; the last one may only carry padding bits.
    const firstChar = sealed.data[0] === "A" ? "B" : "A";
    await expect(openDetachedMessage(readerKey, "to-reader", { ...sealed, data: `${firstChar}${sealed.data.slice(1)}` })).rejects.toThrow();
  });

  it("reads only a well-formed key from the fragment", async () => {
    const { secret } = await createDetachedChannelKey();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readDetachedReaderSecret({ search: "", hash: `#k=${secret}` })).toBe(secret);
    expect(readDetachedReaderSecret({ search: "", hash: "#k=short" })).toBeNull();
    expect(readDetachedReaderSecret({ search: "", hash: "" })).toBeNull();
    expect(readDetachedReaderSecret({ search: `?k=${secret}`, hash: "" })).toBeNull();
  });

  it("recognises reader windows and their labels", () => {
    expect(isDetachedReaderWindow({ search: "?detachedReader=1", hash: "" })).toBe(true);
    expect(isDetachedReaderWindow({ search: "", hash: "#detachedReader=1" })).toBe(false);
    expect(isDetachedReaderWindow(undefined)).toBe(false);
    expect(isDetachedReaderLabel(LABEL)).toBe(true);
    expect(isDetachedReaderLabel("main")).toBe(false);
    expect(isDetachedReaderLabel("novel-runtime-host")).toBe(false);
    expect(isDetachedReaderLabel("detached-reader-ABC")).toBe(false);
    expect(isDetachedReaderLabel("detached-reader-")).toBe(false);
    expect(isSealedDetachedMessage({ label: "main", iv: "a", data: "b" })).toBe(false);
  });

  it("takes handed-over page URLs only when every one is a plain http(s) URL", () => {
    const pages = ["http://127.0.0.1:4567/api/v1/manga/27/chapter/1/page/0", "https://example.test/p/1"];
    expect(readDetachedPageUrls(pages)).toEqual(pages);
    expect(readDetachedPageUrls(pages)).not.toBe(pages);
    expect(readDetachedPageUrls([])).toBeNull();
    expect(readDetachedPageUrls(undefined)).toBeNull();
    expect(readDetachedPageUrls("http://127.0.0.1:4567/page/0")).toBeNull();
    expect(readDetachedPageUrls([pages[0], "blob:http://tauri.localhost/1234"])).toBeNull();
    expect(readDetachedPageUrls([pages[0], "javascript:alert(1)"])).toBeNull();
    expect(readDetachedPageUrls([pages[0], 7])).toBeNull();
    expect(readDetachedPageUrls([pages[0], "not a url"])).toBeNull();
  });

  it("drops only trailing undefined arguments", () => {
    expect(trimTrailingUndefined([1, undefined, 2, undefined, undefined])).toEqual([1, undefined, 2]);
    expect(trimTrailingUndefined([undefined])).toEqual([]);
  });
});
