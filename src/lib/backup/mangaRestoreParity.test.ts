import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureMangaRestoreParity, localMangaParityLedger, type MangaParityCapture, type MangaParityLedger } from "./mangaRestoreParity";

const page = (nodes: unknown[], hasNextPage = false) => ({ mangas: { pageInfo: { hasNextPage }, nodes } });
const manga = (id: number, url: string, categoryIds: number[], sourceId = "10") =>
  ({ id, sourceId, url, categories: { nodes: categoryIds.map(categoryId => ({ id: categoryId })) } });
const orders = (...pairs: [number, number][]) => [[0, 0], ...pairs].map(([id, order]) => ({ id, order }));
const orderedIds = (categories: { id: number; order: number }[]) =>
  categories.filter(category => category.id > 0).sort((left, right) => left.order - right.order).map(category => [category.id, category.order]);

/** Answers category reads and applies moves the way Suwayomi does: every category renumbered from 1. */
const categoryServer = (initial: { id: number; order: number }[]) => {
  const state = { categories: initial, moves: [] as unknown[] };
  const handle = (query: string, variables?: Record<string, unknown>) => {
    if (query.includes("updateCategoryOrder")) {
      state.moves.push(variables);
      const list = state.categories.filter(category => category.id > 0).sort((left, right) => left.order - right.order || left.id - right.id);
      const [moved] = list.splice(list.findIndex(category => category.id === variables?.id), 1);
      list.splice(Number(variables?.position) - 1, 0, moved);
      list.forEach((category, index) => { category.order = index + 1; });
      return { updateCategoryOrder: { categories: state.categories.map(category => ({ ...category })) } };
    }
    if (query.includes("EpigraphRestoreParityCategoryOrder")) return { categories: { nodes: state.categories.map(category => ({ ...category })) } };
    return undefined;
  };
  return Object.assign(state, { handle });
};

describe("captureMangaRestoreParity", () => {
  it("adds back only the categories of titles the backup brings without any", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const responses = [
      page([manga(1, "/a", [0, 2, 5]), manga(2, "/b", [4])], true),
      page([manga(3, "/c", []), manga(4, "/elsewhere", [6])]),
    ];
    const server = categoryServer(orders([2, 1], [4, 2], [5, 3]));
    const request = async <T,>(query: string, variables?: Record<string, unknown>) => {
      const answer = server.handle(query, variables);
      if (answer) return answer as T;
      calls.push([query.includes("mutation") ? "add" : "read", variables]);
      return (query.includes("mutation") ? {} : responses.shift()) as T;
    };
    const apply = await captureMangaRestoreParity([
      { sourceId: "10", url: "/a", hasCategories: false },
      { sourceId: "10", url: "/b", hasCategories: true },
      { sourceId: "10", url: "/c", hasCategories: false },
    ], request);
    expect(calls.map(([kind, variables]) => [kind, variables?.offset])).toEqual([["read", 0], ["read", 500]]);
    expect(calls[0][1]?.sourceIds).toEqual(["10"]);

    expect(await apply()).toEqual([]);
    expect(calls.slice(2)).toEqual([["add", { mangaId: 1, addTo: [2, 5] }]]);
    expect(server.moves).toEqual([]);
  });

  it("reads no titles when every title brings its own categories", async () => {
    const server = categoryServer(orders([2, 1]));
    const apply = await captureMangaRestoreParity([{ sourceId: "10", url: "/a", hasCategories: true }], async <T,>(query: string, variables?: Record<string, unknown>) => {
      const answer = server.handle(query, variables);
      if (!answer) throw Error("unexpected");
      return answer as T;
    });
    expect(await apply()).toEqual([]);
  });

  it("puts existing categories back in their order and appends the new ones, as Mihon does", async () => {
    // Before: Mine (1), Reading (2). The backup orders Dropped 1, Best 2, Reading 3.
    const server = categoryServer(orders([1, 1], [2, 2]));
    const request = async <T,>(query: string, variables?: Record<string, unknown>) => server.handle(query, variables) as T;
    const apply = await captureMangaRestoreParity([{ sourceId: "10", url: "/a", hasCategories: true }], request);

    // Suwayomi's restore gives Reading the backup's order and appends Dropped and Best after the old maximum.
    server.categories = orders([1, 1], [2, 3], [3, 3], [4, 4]);
    expect(await apply()).toEqual([]);
    expect(orderedIds(server.categories)).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
  });

  it("leaves categories alone when the restore kept their order", async () => {
    const server = categoryServer(orders([1, 1], [2, 2]));
    const request = async <T,>(query: string, variables?: Record<string, unknown>) => server.handle(query, variables) as T;
    const apply = await captureMangaRestoreParity([{ sourceId: "10", url: "/a", hasCategories: true }], request);
    server.categories.push({ id: 3, order: 3 });
    expect(await apply()).toEqual([]);
    expect(server.moves).toEqual([]);
  });

  it("reports categories it could not add back", async () => {
    let reads = 0;
    const server = categoryServer(orders([2, 1]));
    const apply = await captureMangaRestoreParity([{ sourceId: "10", url: "/a", hasCategories: false }], async <T,>(query: string) => {
      if (query.includes("mutation")) throw Error("offline");
      const answer = server.handle(query);
      if (answer) return answer as T;
      reads++;
      return page([manga(1, "/a", [2])]) as T;
    });
    expect(reads).toBe(1);
    expect(await apply()).toEqual(["MANGA_RESTORE_CATEGORIES_NOT_KEPT"]);
  });

  it("fails before the restore when the library cannot be read", async () => {
    await expect(captureMangaRestoreParity([{ sourceId: "10", url: "/a", hasCategories: false }], async () => { throw Error("offline"); }))
      .rejects.toThrow("offline");
  });

  it("keeps an interrupted capture and applies it when the same backup is restored again", async () => {
    let saved: MangaParityCapture = { kept: [] };
    const ledger: MangaParityLedger = { load: () => saved, save: capture => { saved = capture; }, clear: () => { saved = { kept: [] }; } };
    const adds: unknown[] = [];
    let library = [manga(1, "/a", [2]), manga(2, "/b", [3])];
    const server = categoryServer(orders([3, 1], [2, 2]));
    const request = async <T,>(query: string, variables?: Record<string, unknown>) => {
      const answer = server.handle(query, variables);
      if (answer) return answer as T;
      if (query.includes("mutation")) { adds.push(variables); return {} as T; }
      return page(library) as T;
    };
    const titles = [{ sourceId: "10", url: "/a", hasCategories: false }, { sourceId: "10", url: "/b", hasCategories: false }];

    await captureMangaRestoreParity(titles, request, ledger);
    expect(saved).toEqual({ kept: [{ mangaId: 1, categoryIds: [2] }, { mangaId: 2, categoryIds: [3] }], categoryOrder: [3, 2] });

    // The app stopped before the re-add; the restore had already cleared both titles and reordered the categories.
    library = [manga(1, "/a", []), manga(2, "/b", [7])];
    server.categories = orders([3, 2], [2, 1], [7, 3]);
    const apply = await captureMangaRestoreParity(titles, request, ledger);
    expect(await apply()).toEqual([]);
    expect(adds).toEqual([{ mangaId: 1, addTo: [2] }, { mangaId: 2, addTo: [3, 7] }]);
    expect(orderedIds(server.categories)).toEqual([[3, 1], [2, 2], [7, 3]]);
    expect(saved).toEqual({ kept: [] });
  });

  it("keeps the capture when adding it back fails", async () => {
    let saved: MangaParityCapture = { kept: [] };
    const ledger: MangaParityLedger = { load: () => saved, save: capture => { saved = capture; }, clear: () => { saved = { kept: [] }; } };
    const server = categoryServer(orders([2, 1]));
    const apply = await captureMangaRestoreParity([{ sourceId: "10", url: "/a", hasCategories: false }], async <T,>(query: string) => {
      if (query.includes("mutation")) throw Error("offline");
      const answer = server.handle(query);
      if (answer) return answer as T;
      return page([manga(1, "/a", [2])]) as T;
    }, ledger);
    expect(await apply()).toEqual(["MANGA_RESTORE_CATEGORIES_NOT_KEPT"]);
    expect(saved).toEqual({ kept: [{ mangaId: 1, categoryIds: [2] }], categoryOrder: [2] });
  });

  it("still adds back the other titles and restores the order when one title fails", async () => {
    const added: unknown[] = [];
    const server = categoryServer(orders([1, 1], [2, 2]));
    const apply = await captureMangaRestoreParity([{ sourceId: "10", url: "/a", hasCategories: false }, { sourceId: "10", url: "/b", hasCategories: false }],
      async <T,>(query: string, variables?: Record<string, unknown>) => {
        const answer = server.handle(query, variables);
        if (answer) return answer as T;
        if (query.includes("mutation")) {
          if (variables?.mangaId === 1) throw Error("gone");
          added.push(variables); return {} as T;
        }
        return page([manga(1, "/a", [1]), manga(2, "/b", [2])]) as T;
      });
    server.categories = orders([1, 2], [2, 1]);
    expect(await apply()).toEqual(["MANGA_RESTORE_CATEGORIES_NOT_KEPT"]);
    expect(added).toEqual([{ mangaId: 2, addTo: [2] }]);
    expect(orderedIds(server.categories)).toEqual([[1, 1], [2, 2]]);
  });
});

describe("localMangaParityLedger", () => {
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("serves a capture only to the same backup on the same target", () => {
    localMangaParityLedger("target-a", "digest-1").save({ kept: [{ mangaId: 1, categoryIds: [2, 0] }], categoryOrder: [4, 0, 2] });
    expect(localMangaParityLedger("target-a", "digest-1").load()).toEqual({ kept: [{ mangaId: 1, categoryIds: [2] }], categoryOrder: [4, 2] });
    expect(localMangaParityLedger("target-b", "digest-1").load()).toEqual({ kept: [] });
    expect(localMangaParityLedger("target-a", "digest-2").load()).toEqual({ kept: [] });

    localMangaParityLedger("target-a", "digest-2").clear();
    expect(localMangaParityLedger("target-a", "digest-1").load().kept).toHaveLength(1);
    localMangaParityLedger("target-a", "digest-1").clear();
    expect(data.size).toBe(0);
  });

  it("ignores a damaged entry", () => {
    localStorage.setItem("epigraph.restore.categoryParity.v1", "{not json");
    expect(localMangaParityLedger("target-a", "digest-1").load()).toEqual({ kept: [] });
  });

  it("reads an entry saved before the category order was captured", () => {
    localStorage.setItem("epigraph.restore.categoryParity.v1", JSON.stringify({ target: "target-a", backupDigest: "digest-1", kept: [{ mangaId: 1, categoryIds: [2] }] }));
    expect(localMangaParityLedger("target-a", "digest-1").load()).toEqual({ kept: [{ mangaId: 1, categoryIds: [2] }] });
  });
});
