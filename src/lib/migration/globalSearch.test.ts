import { describe, expect, it, vi } from "vitest";
import type { Manga } from "../types";
import { searchSourcesLive, type SourceSearchOutcome } from "./globalSearch";

function manga(id: number, title: string): Manga {
  return { id, title, thumbnailUrl: "", inLibrary: false } as Manga;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("searchSourcesLive", () => {
  it("reports each source as soon as it answers, without waiting for slower ones", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<Manga[]>>>();
    const search = vi.fn(({ sourceId }: { sourceId: string }) => {
      const next = deferred<Manga[]>();
      pending.set(sourceId, next);
      return next.promise;
    });
    const reports: Array<[string, SourceSearchOutcome]> = [];

    const run = searchSourcesLive({
      sourceIds: ["slow", "fast"],
      query: "One Piece",
      title: "One Piece",
      search,
      onSourceDone: (sourceId, outcome) => reports.push([sourceId, outcome]),
    });
    await flush();
    pending.get("fast")!.resolve([manga(2, "One Pace"), manga(1, "One Piece")]);
    await flush();

    expect(reports.map(([id]) => id)).toEqual(["fast"]);
    expect(reports[0]![1].results.map((result) => result.manga.id)).toEqual([1, 2]);
    expect(reports[0]![1].results[0]!.similarity).toBe(1);

    pending.get("slow")!.reject(new Error("Cloudflare"));
    await run;
    expect(reports.map(([id]) => id)).toEqual(["fast", "slow"]);
    expect(reports[1]![1]).toEqual({ results: [], error: "Cloudflare" });
  });

  it("keeps at most the given number of searches in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const search = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await flush();
      inFlight -= 1;
      return [];
    });
    const done: string[] = [];

    await searchSourcesLive({
      sourceIds: ["a", "b", "c", "d", "e"],
      query: "x",
      title: "x",
      concurrency: 2,
      search,
      onSourceDone: (sourceId) => done.push(sourceId),
    });

    expect(peak).toBe(2);
    expect(done.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("stops reporting and starts no new search once aborted", async () => {
    const controller = new AbortController();
    const first = deferred<Manga[]>();
    const search = vi.fn(() => first.promise);
    const onSourceDone = vi.fn();

    const run = searchSourcesLive({
      sourceIds: ["a", "b"],
      query: "x",
      title: "x",
      concurrency: 1,
      signal: controller.signal,
      search,
      onSourceDone,
    });
    await flush();
    controller.abort();
    first.resolve([manga(1, "x")]);
    await run;

    expect(search).toHaveBeenCalledTimes(1);
    expect(onSourceDone).not.toHaveBeenCalled();
  });

  it("does nothing for an empty query", async () => {
    const search = vi.fn();
    await searchSourcesLive({ sourceIds: ["a"], query: "  ", title: "x", search, onSourceDone: vi.fn() });
    expect(search).not.toHaveBeenCalled();
  });
});
