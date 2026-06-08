import { beforeEach, describe, expect, it, vi } from "vitest";
import { cache } from "./cache";

describe("cache diagnostics and trimming", () => {
  beforeEach(() => {
    vi.useRealTimers();
    cache.clearAll();
  });

  it("trims expired entries and reports cache groups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    await cache.get("short", () => Promise.resolve("value"), 100, "group-a");
    await cache.get("long", () => Promise.resolve("kept"), 5_000, "group-a");

    vi.setSystemTime(1_200);
    expect(cache.stats().expiredEntryCount).toBe(1);

    cache.trimExpired();

    const stats = cache.stats();
    expect(stats.entryCount).toBe(1);
    expect(stats.expiredEntryCount).toBe(0);
    expect(stats.keysByGroup["group-a"]).toEqual(["long"]);
    expect(cache.has("short")).toBe(false);
    expect(cache.has("long")).toBe(true);
  });

  it("keeps direct set entries pinned for the session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    cache.set("manual", { ok: true }, "manual-group");
    vi.setSystemTime(10_000_000);
    cache.trimExpired();

    expect(cache.has("manual")).toBe(true);
    expect(cache.stats().keysByGroup["manual-group"]).toEqual(["manual"]);
  });
});
