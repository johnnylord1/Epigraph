import { describe, expect, test, vi } from "vitest";
import {
  createDiscordCoverFingerprint,
  DISCORD_COVER_CACHE_TTL_MS,
  DISCORD_COVER_COMPOSITOR_VERSION,
  DiscordCoverService,
  type DiscordCoverCacheStorage,
  type DiscordCoverProcessor,
} from "./discordCoverService";
import type { DiscordPrivacySettings } from "./types";

function createMemoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const storage: DiscordCoverCacheStorage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
  return {
    storage,
    dump() {
      return Object.fromEntries(data);
    },
  };
}

function enabledSettings(patch: Partial<DiscordPrivacySettings> = {}): DiscordPrivacySettings {
  return {
    discordRpc: true,
    discordRpcShowTitle: true,
    discordRpcShowCover: true,
    discordRpcImproveCovers: true,
    discordRpcShowProgress: true,
    discordRpcPrivateMode: false,
    ...patch,
  };
}

function coverInput(settings: Partial<DiscordPrivacySettings> = {}) {
  return {
    settings: enabledSettings(settings),
    workKind: "book" as const,
    workId: "book-1",
    source: { type: "public-url" as const, value: "https://covers.example.com/private-book-cover.jpg" },
  };
}

describe("Discord optimized cover service", () => {
  test("returns before cache or processor work when the gate is blocked", async () => {
    const cache = createMemoryStorage();
    const processor = vi.fn(async () => "https://cdn.example.com/optimized.jpg");
    const service = new DiscordCoverService({ storage: cache.storage, processor });

    await expect(service.resolveOptimizedCover(coverInput({ discordRpcImproveCovers: false }))).resolves.toBeNull();

    expect(cache.storage.getItem).not.toHaveBeenCalled();
    expect(cache.storage.setItem).not.toHaveBeenCalled();
    expect(cache.storage.removeItem).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
  });

  test("requires every privacy gate condition", async () => {
    const cases: Array<Partial<DiscordPrivacySettings>> = [
      { discordRpc: false },
      { discordRpcPrivateMode: true },
      { discordRpcShowCover: false },
      { discordRpcImproveCovers: false },
    ];

    for (const patch of cases) {
      const cache = createMemoryStorage();
      const processor = vi.fn(async () => "https://cdn.example.com/optimized.jpg");
      const service = new DiscordCoverService({ storage: cache.storage, processor });

      await expect(service.resolveOptimizedCover(coverInput(patch))).resolves.toBeNull();
      expect(cache.storage.getItem).not.toHaveBeenCalled();
      expect(processor).not.toHaveBeenCalled();
    }

    const processor = vi.fn(async () => "https://cdn.example.com/optimized.jpg");
    const service = new DiscordCoverService({ storage: createMemoryStorage().storage, processor });

    await expect(service.resolveOptimizedCover(coverInput())).resolves.toBe("https://cdn.example.com/optimized.jpg");
    expect(processor).toHaveBeenCalledTimes(1);
  });

  test("uses a valid cache entry instead of starting another job", async () => {
    let now = 10_000;
    const cache = createMemoryStorage();
    const processor = vi.fn(async () => "https://cdn.example.com/optimized.jpg");
    const service = new DiscordCoverService({ storage: cache.storage, processor, now: () => now });

    await expect(service.resolveOptimizedCover(coverInput())).resolves.toBe("https://cdn.example.com/optimized.jpg");
    await expect(service.resolveOptimizedCover(coverInput())).resolves.toBe("https://cdn.example.com/optimized.jpg");

    expect(processor).toHaveBeenCalledTimes(1);
    now += 1;
    await expect(service.resolveOptimizedCover(coverInput())).resolves.toBe("https://cdn.example.com/optimized.jpg");
    expect(processor).toHaveBeenCalledTimes(1);
  });

  test("ignores expired cache entries and runs a new job", async () => {
    let now = 10_000;
    const cache = createMemoryStorage();
    const processor = vi.fn(async () => "https://cdn.example.com/optimized.jpg");
    const service = new DiscordCoverService({ storage: cache.storage, processor, now: () => now });

    await expect(service.resolveOptimizedCover(coverInput())).resolves.toBe("https://cdn.example.com/optimized.jpg");
    now += DISCORD_COVER_CACHE_TTL_MS + 1;
    await expect(service.resolveOptimizedCover(coverInput())).resolves.toBe("https://cdn.example.com/optimized.jpg");

    expect(processor).toHaveBeenCalledTimes(2);
    expect(cache.storage.removeItem).toHaveBeenCalled();
  });

  test("fingerprint changes with the compositor version", async () => {
    const source = { type: "public-url" as const, value: "https://covers.example.com/a.jpg" };
    const first = await createDiscordCoverFingerprint({
      workKind: "comic",
      workId: "42",
      source,
      algorithmVersion: DISCORD_COVER_COMPOSITOR_VERSION,
    });
    const second = await createDiscordCoverFingerprint({
      workKind: "comic",
      workId: "42",
      source,
      algorithmVersion: "cover-compositor-v8",
    });

    expect(first).not.toBe(second);
  });

  test("deduplicates simultaneous jobs for the same fingerprint", async () => {
    let release!: (value: string) => void;
    const cache = createMemoryStorage();
    const processor = vi.fn<DiscordCoverProcessor>(() => new Promise<string>((resolve) => {
      release = resolve;
    }));
    const service = new DiscordCoverService({ storage: cache.storage, processor });

    const first = service.resolveOptimizedCover(coverInput());
    const second = service.resolveOptimizedCover(coverInput());

    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });
    release("https://cdn.example.com/shared.jpg");

    await expect(Promise.all([first, second])).resolves.toEqual([
      "https://cdn.example.com/shared.jpg",
      "https://cdn.example.com/shared.jpg",
    ]);
    expect(processor).toHaveBeenCalledTimes(1);
  });

  test("does not write cache when processing fails", async () => {
    const cache = createMemoryStorage();
    const processor = vi.fn(async () => {
      throw new Error("planned failure");
    });
    const service = new DiscordCoverService({ storage: cache.storage, processor });

    await expect(service.resolveOptimizedCover(coverInput())).resolves.toBeNull();

    expect(cache.storage.setItem).not.toHaveBeenCalled();
    expect(cache.dump()).toEqual({});
  });

  test("does not store clear source or title data in cache", async () => {
    const cache = createMemoryStorage();
    const processor = vi.fn(async () => "https://cdn.example.com/optimized.jpg");
    const service = new DiscordCoverService({ storage: cache.storage, processor });

    await expect(service.resolveOptimizedCover(coverInput())).resolves.toBe("https://cdn.example.com/optimized.jpg");

    const serializedCache = JSON.stringify(cache.dump());
    expect(serializedCache).not.toContain("private-book-cover");
    expect(serializedCache).not.toContain("covers.example.com");
    expect(serializedCache).not.toContain("book-1");
    expect(serializedCache).not.toContain("A Book");
    expect(serializedCache).toContain("optimized.jpg");
  });

  test("rejects local and private public-url sources without exposing them", async () => {
    const sources = [
      "file:///C:/Users/private/cover.jpg",
      "data:image/png;base64,abc",
      "blob:https://example.com/id",
      "https://localhost/cover.jpg",
      "https://127.0.0.1/cover.jpg",
      "https://192.168.1.9/cover.jpg",
    ];

    for (const value of sources) {
      const cache = createMemoryStorage();
      const processor = vi.fn(async () => "https://cdn.example.com/optimized.jpg");
      const service = new DiscordCoverService({ storage: cache.storage, processor });

      await expect(service.resolveOptimizedCover({
        ...coverInput(),
        source: { type: "public-url", value },
      })).resolves.toBeNull();

      expect(cache.storage.getItem).not.toHaveBeenCalled();
      expect(cache.storage.setItem).not.toHaveBeenCalled();
      expect(processor).not.toHaveBeenCalled();
      expect(JSON.stringify(cache.dump())).not.toContain(value);
    }
  });
});
