import { describe, expect, test, vi } from "vitest";
import {
  createDiscordPublicCoverFingerprint,
  DISCORD_PUBLIC_COVER_CACHE_TTL_MS,
  DISCORD_PUBLIC_COVER_RESOLVER_VERSION,
  DISCORD_PUBLIC_WORKER_COVER_CACHE_TTL_MS,
  DiscordPublicCoverResolver,
} from "./discordPublicCoverResolver";
import type { DiscordCoverCacheStorage } from "./discordCoverService";
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

function input(patch: Partial<Parameters<DiscordPublicCoverResolver["resolve"]>[0]> = {}) {
  return {
    settings: enabledSettings(),
    workKind: "book" as const,
    workId: "book-secret-id",
    existingPublicCoverUrl: null,
    trackerKey: "tracker",
    resolveTrackerCover: null,
    workerSource: { type: "trusted-local-path" as const, value: "C:\\private\\books\\secret-cover.jpg" },
    resolveWorkerCover: vi.fn(async () => "https://cdn.example.com/worker.jpg"),
    ...patch,
  };
}

describe("Discord public cover resolver", () => {
  test("returns before cache, tracker, or worker when the cover privacy gate blocks", async () => {
    const gateCases: Array<Partial<DiscordPrivacySettings>> = [
      { discordRpc: false },
      { discordRpcPrivateMode: true },
      { discordRpcShowCover: false },
    ];

    for (const patch of gateCases) {
      const cache = createMemoryStorage();
      const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
      const tracker = vi.fn(async () => "https://tracker.example.com/cover.jpg");
      const worker = vi.fn(async () => "https://cdn.example.com/worker.jpg");

      await expect(resolver.resolve(input({
        settings: enabledSettings(patch),
        resolveTrackerCover: tracker,
        resolveWorkerCover: worker,
      }))).resolves.toBeNull();

      expect(cache.storage.getItem).not.toHaveBeenCalled();
      expect(cache.storage.setItem).not.toHaveBeenCalled();
      expect(cache.storage.removeItem).not.toHaveBeenCalled();
      expect(tracker).not.toHaveBeenCalled();
      expect(worker).not.toHaveBeenCalled();
    }
  });

  test("can use tracker covers when cover improvement is disabled", async () => {
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
    const tracker = vi.fn(async () => "https://tracker.example.com/cover.jpg");
    const worker = vi.fn(async () => "https://cdn.example.com/worker.jpg");

    await expect(resolver.resolve(input({
      settings: enabledSettings({ discordRpcImproveCovers: false }),
      resolveTrackerCover: tracker,
      resolveWorkerCover: worker,
    }))).resolves.toEqual({ url: "https://tracker.example.com/cover.jpg", source: "tracker" });

    expect(tracker).toHaveBeenCalledTimes(1);
    expect(worker).not.toHaveBeenCalled();
  });

  test("does not use worker when cover improvement is disabled", async () => {
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
    const tracker = vi.fn(async () => null);
    const worker = vi.fn(async () => "https://cdn.example.com/worker.jpg");

    await expect(resolver.resolve(input({
      settings: enabledSettings({ discordRpcImproveCovers: false }),
      resolveTrackerCover: tracker,
      resolveWorkerCover: worker,
    }))).resolves.toBeNull();

    expect(tracker).toHaveBeenCalledTimes(1);
    expect(worker).not.toHaveBeenCalled();
  });

  test("uses an existing public HTTPS cover before tracker or worker", async () => {
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
    const tracker = vi.fn(async () => "https://tracker.example.com/cover.jpg");
    const worker = vi.fn(async () => "https://cdn.example.com/worker.jpg");

    await expect(resolver.resolve(input({
      existingPublicCoverUrl: "https://covers.example.com/current.jpg",
      resolveTrackerCover: tracker,
      resolveWorkerCover: worker,
    }))).resolves.toEqual({ url: "https://covers.example.com/current.jpg", source: "existing" });

    expect(tracker).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  test("uses tracker cover before worker", async () => {
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
    const tracker = vi.fn(async () => "https://tracker.example.com/cover.jpg");
    const worker = vi.fn(async () => "https://cdn.example.com/worker.jpg");

    await expect(resolver.resolve(input({
      resolveTrackerCover: tracker,
      resolveWorkerCover: worker,
    }))).resolves.toEqual({ url: "https://tracker.example.com/cover.jpg", source: "tracker" });

    expect(tracker).toHaveBeenCalledTimes(1);
    expect(worker).not.toHaveBeenCalled();
  });

  test("uses worker only when existing and tracker covers do not resolve", async () => {
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
    const tracker = vi.fn(async () => null);
    const worker = vi.fn(async () => "https://cdn.example.com/worker.jpg");

    await expect(resolver.resolve(input({
      resolveTrackerCover: tracker,
      resolveWorkerCover: worker,
    }))).resolves.toEqual({ url: "https://cdn.example.com/worker.jpg", source: "worker" });

    expect(tracker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  test("uses source/local worker fallback for untracked works when cover improvement is enabled", async () => {
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
    const worker = vi.fn(async () => "https://relay.aethon.dev/discord-covers/v1/source.jpg");

    await expect(resolver.resolve(input({
      trackerKey: null,
      resolveTrackerCover: null,
      workerSource: {
        type: "trusted-thumbnail",
        value: "http://127.0.0.1:4567/api/v1/manga/123/thumbnail",
        trustedLocalBaseUrl: "http://127.0.0.1:4567",
        authHeader: "Bearer secret",
      },
      resolveWorkerCover: worker,
    }))).resolves.toEqual({
      url: "https://relay.aethon.dev/discord-covers/v1/source.jpg",
      source: "worker",
    });

    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith({
      type: "trusted-thumbnail",
      value: "http://127.0.0.1:4567/api/v1/manga/123/thumbnail",
      trustedLocalBaseUrl: "http://127.0.0.1:4567",
      authHeader: "Bearer secret",
    });
  });

  test("valid cache avoids a new tracker or worker job", async () => {
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
    const tracker = vi.fn(async () => "https://tracker.example.com/cover.jpg");
    const worker = vi.fn(async () => "https://cdn.example.com/worker.jpg");

    await expect(resolver.resolve(input({
      resolveTrackerCover: tracker,
      resolveWorkerCover: worker,
    }))).resolves.toEqual({ url: "https://tracker.example.com/cover.jpg", source: "tracker" });
    await expect(resolver.resolve(input({
      resolveTrackerCover: tracker,
      resolveWorkerCover: worker,
    }))).resolves.toEqual({ url: "https://tracker.example.com/cover.jpg", source: "tracker" });

    expect(tracker).toHaveBeenCalledTimes(1);
    expect(worker).not.toHaveBeenCalled();
  });

  test("expired cache is ignored and refreshed", async () => {
    let now = 10_000;
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage, now: () => now });
    const tracker = vi.fn()
      .mockResolvedValueOnce("https://tracker.example.com/first.jpg")
      .mockResolvedValueOnce("https://tracker.example.com/second.jpg");

    await expect(resolver.resolve(input({ resolveTrackerCover: tracker })))
      .resolves.toEqual({ url: "https://tracker.example.com/first.jpg", source: "tracker" });

    now += DISCORD_PUBLIC_COVER_CACHE_TTL_MS + 1;
    await expect(resolver.resolve(input({ resolveTrackerCover: tracker })))
      .resolves.toEqual({ url: "https://tracker.example.com/second.jpg", source: "tracker" });

    expect(tracker).toHaveBeenCalledTimes(2);
    expect(cache.storage.removeItem).toHaveBeenCalled();
  });

  test("fingerprint changes with resolver version and source hints", async () => {
    const base = {
      workKind: "comic" as const,
      workId: "42",
      trackerKey: "anilist",
      workerSource: { type: "public-url" as const, value: "https://covers.example.com/a.jpg" },
      version: DISCORD_PUBLIC_COVER_RESOLVER_VERSION,
    };
    const first = await createDiscordPublicCoverFingerprint(base);
    const nextVersion = await createDiscordPublicCoverFingerprint({ ...base, version: "tracker-cover-first-v5" });
    const nextTracker = await createDiscordPublicCoverFingerprint({ ...base, trackerKey: "mal" });

    expect(first).not.toBe(nextVersion);
    expect(first).not.toBe(nextTracker);
  });

  test("deduplicates simultaneous lookups for the same fingerprint", async () => {
    let release!: (value: string) => void;
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
    const tracker = vi.fn(() => new Promise<string>((resolve) => {
      release = resolve;
    }));
    const worker = vi.fn(async () => "https://cdn.example.com/worker.jpg");

    const first = resolver.resolve(input({ resolveTrackerCover: tracker, resolveWorkerCover: worker }));
    const second = resolver.resolve(input({ resolveTrackerCover: tracker, resolveWorkerCover: worker }));

    await vi.waitFor(() => {
      expect(tracker).toHaveBeenCalledTimes(1);
    });
    release("https://tracker.example.com/shared.jpg");

    await expect(Promise.all([first, second])).resolves.toEqual([
      { url: "https://tracker.example.com/shared.jpg", source: "tracker" },
      { url: "https://tracker.example.com/shared.jpg", source: "tracker" },
    ]);
    expect(worker).not.toHaveBeenCalled();
  });

  test("failed resolution does not poison cache", async () => {
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
    const tracker = vi.fn(async () => {
      throw new Error("planned");
    });
    const worker = vi.fn(async () => null);

    await expect(resolver.resolve(input({ resolveTrackerCover: tracker, resolveWorkerCover: worker }))).resolves.toBeNull();

    expect(cache.storage.setItem).not.toHaveBeenCalled();
    expect(cache.dump()).toEqual({});
  });

  test("does not store private source data in clear text", async () => {
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });

    await expect(resolver.resolve(input())).resolves.toEqual({
      url: "https://cdn.example.com/worker.jpg",
      source: "worker",
    });

    const serialized = JSON.stringify(cache.dump());
    expect(serialized).not.toContain("book-secret-id");
    expect(serialized).not.toContain("secret-cover");
    expect(serialized).not.toContain("C:\\private");
    expect(serialized).not.toContain("A Secret Book");
    expect(serialized).toContain("worker.jpg");
  });

  test("stores worker covers with a short TTL for temporary hosts", async () => {
    const now = 25_000;
    const cache = createMemoryStorage();
    const resolver = new DiscordPublicCoverResolver({ storage: cache.storage, now: () => now });

    await expect(resolver.resolve(input())).resolves.toEqual({
      url: "https://cdn.example.com/worker.jpg",
      source: "worker",
    });

    const entry = JSON.parse(Object.values(cache.dump())[0] ?? "{}") as { expiresAt?: number };
    expect(entry.expiresAt).toBe(now + DISCORD_PUBLIC_WORKER_COVER_CACHE_TTL_MS);
  });

  test("rejects local/private URL candidates without exposing them", async () => {
    const privateUrls = [
      "file:///C:/Users/private/cover.jpg",
      "data:image/png;base64,abc",
      "blob:https://example.com/id",
      "https://localhost/cover.jpg",
      "https://127.0.0.1/cover.jpg",
      "https://192.168.1.9/cover.jpg",
    ];

    for (const privateUrl of privateUrls) {
      const cache = createMemoryStorage();
      const resolver = new DiscordPublicCoverResolver({ storage: cache.storage });
      const worker = vi.fn(async () => null);

      await expect(resolver.resolve(input({
        existingPublicCoverUrl: privateUrl,
        resolveTrackerCover: async () => privateUrl,
        workerSource: { type: "public-url", value: privateUrl },
        resolveWorkerCover: worker,
      }))).resolves.toBeNull();

      expect(cache.storage.setItem).not.toHaveBeenCalled();
      expect(worker).not.toHaveBeenCalled();
      expect(JSON.stringify(cache.dump())).not.toContain(privateUrl);
    }
  });
});
