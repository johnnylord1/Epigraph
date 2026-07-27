import { describe, expect, test, vi } from "vitest";

import { ManagedSourceRuntimeCache } from "./managed";
import type { SourceRuntime } from "./types";

function runtime(id: string): SourceRuntime {
  return { id } as unknown as SourceRuntime;
}

describe("ManagedSourceRuntimeCache", () => {
  test("reuses an adapter only while its endpoint generation is fresh", async () => {
    let now = 1_000;
    const createRuntime = vi.fn(async (endpoint: string) => runtime(endpoint));
    const cache = new ManagedSourceRuntimeCache(createRuntime, () => now, 30_000);

    const first = cache.get("http://127.0.0.1:4567/api/graphql");
    expect(cache.get("http://127.0.0.1:4567/api/graphql")).toBe(first);

    now += 30_001;
    const refreshed = cache.get("http://127.0.0.1:4567/api/graphql");
    expect(refreshed).not.toBe(first);
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  test("invalidates rejected adapters and explicit lifecycle resets", async () => {
    const failed = Promise.reject(new Error("runtime restarted"));
    failed.catch(() => undefined);
    const createRuntime = vi.fn()
      .mockReturnValueOnce(failed)
      .mockResolvedValue(runtime("recovered"));
    const cache = new ManagedSourceRuntimeCache(createRuntime);

    await expect(cache.get("http://127.0.0.1:4567/api/graphql")).rejects.toThrow("runtime restarted");
    await Promise.resolve();
    await expect(cache.get("http://127.0.0.1:4567/api/graphql")).resolves.toMatchObject({ id: "recovered" });

    cache.reset();
    cache.get("http://127.0.0.1:4567/api/graphql");
    expect(createRuntime).toHaveBeenCalledTimes(3);
  });
});
