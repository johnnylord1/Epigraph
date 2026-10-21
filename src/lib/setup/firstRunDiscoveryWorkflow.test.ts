import { describe, expect, it, vi } from "vitest";

import {
  createFirstRunDiscoveryWorkflow,
  rankFirstRunDiscoverySources,
  type FirstRunDiscoveryDependencies,
} from "./firstRunDiscoveryWorkflow";

function dependencies(overrides: Partial<FirstRunDiscoveryDependencies> = {}): FirstRunDiscoveryDependencies {
  return {
    loadMangaSources: vi.fn(async () => [{ id: "manga-a", name: "Manga A" }]),
    loadNovelSources: vi.fn(async () => [{ id: "novel-a", name: "Novel A" }]),
    findManga: vi.fn(async (_source, query) => [{
      id: 11,
      title: query ? "Named manga" : "Popular manga",
      coverUrl: null,
      inLibrary: false,
    }]),
    findNovels: vi.fn(async (_source, query) => [{
      id: "novel-a:path",
      path: "path",
      title: query ? "Named novel" : "Popular novel",
      coverUrl: null,
      inLibrary: false,
    }]),
    addManga: vi.fn(async () => {}),
    addNovel: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("first-run discovery workflow", () => {
  it("does not start searches after disposal while source discovery is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const searched: string[] = [];
    const workflow = createFirstRunDiscoveryWorkflow(dependencies({
      loadMangaSources: async () => { await pending; return [{ id: "late", name: "Late" }]; },
      loadNovelSources: async () => [],
      findManga: async (source) => { searched.push(source.id); return []; },
    }));
    const loading = workflow.loadPopular();
    const disposing = workflow.dispose();
    release();
    await Promise.all([loading, disposing]);
    expect(searched).toEqual([]);
    await workflow.loadPopular();
    expect(searched).toEqual([]);
  });

  it("drains active searches and cancels queued searches before releasing resources once", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    const workflow = createFirstRunDiscoveryWorkflow(dependencies({
      loadMangaSources: async () => ["a", "b", "c", "d"].map((id) => ({ id, name: id })),
      loadNovelSources: async () => [],
      findManga: async (source) => { events.push(source.id); await pending; events.push(`done:${source.id}`); return []; },
      dispose: async () => { events.push("disposed"); },
    }));
    const loading = workflow.loadPopular();
    await vi.waitFor(() => expect(events).toEqual(["a", "b"]));
    const disposing = workflow.dispose();
    await Promise.resolve();
    expect(events).toEqual(["a", "b"]);
    release();
    await Promise.all([loading, disposing, workflow.dispose()]);
    expect(events).toEqual(["a", "b", "done:a", "done:b", "disposed"]);
  });
  it("names the sources that failed while keeping results from the others", async () => {
    const workflow = createFirstRunDiscoveryWorkflow(dependencies({
      loadNovelSources: async () => [{ id: "royal", name: "Royal Road" }, { id: "central", name: "Central Novel" }],
      findNovels: async (source) => {
        if (source.id === "central") throw new Error("Cannot read properties of undefined (reading 'split')");
        return [{ id: "royal:a", path: "a", title: "Royal title", coverUrl: null, inLibrary: false }];
      },
    }));
    await workflow.loadPopular();
    expect(workflow.items.some((item) => item.title === "Royal title")).toBe(true);
    expect(workflow.failedSources).toEqual(["Central Novel"]);
    expect(workflow.error).toBeNull();
  });
  it("shows novels alongside a large manga result set", async () => {
    const workflow = createFirstRunDiscoveryWorkflow(dependencies({
      findManga: async () => Array.from({ length: 30 }, (_, id) => ({ id, title: `Manga ${id}`, coverUrl: null, inLibrary: false })),
    }));
    await workflow.loadPopular();
    expect(workflow.items.some((item) => item.title === "Popular novel")).toBe(true);
    expect(workflow.items.length).toBeLessThanOrEqual(8);
  });
  it("serializes distinct novel writes so both additions survive", async () => {
    let release!: () => void;
    const firstSave = new Promise<void>((resolve) => { release = resolve; });
    let persisted: string[] = [];
    const workflow = createFirstRunDiscoveryWorkflow(dependencies({
      loadMangaSources: async () => [],
      findNovels: async () => ["first", "second"].map((id) => ({ id, path: id, title: id, coverUrl: null, inLibrary: false })),
      addNovel: async (_source, result) => {
        const snapshot = [...persisted];
        if (result.id === "first") await firstSave;
        persisted = [...snapshot, String(result.id)];
      },
    }));
    await workflow.loadPopular();
    const first = workflow.addToLibrary(workflow.items[0].id);
    const second = workflow.addToLibrary(workflow.items[1].id);
    release();
    await Promise.all([first, second]);
    expect(persisted).toEqual(["first", "second"]);
    expect(workflow.items.every((item) => item.inLibrary)).toBe(true);
  });

  it("keeps a duplicate request pending until the actual write confirms", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const workflow = createFirstRunDiscoveryWorkflow(dependencies({ addManga: () => pending }));
    await workflow.loadPopular();
    const first = workflow.addToLibrary(workflow.items[0].id);
    let duplicateFinished = false;
    const duplicate = workflow.addToLibrary(workflow.items[0].id).then(() => { duplicateFinished = true; });
    await Promise.resolve();
    expect(duplicateFinished).toBe(false);
    release();
    await Promise.all([first, duplicate]);
  });

  it("clears a failed-add error after retry succeeds", async () => {
    let failing = true;
    const workflow = createFirstRunDiscoveryWorkflow(dependencies({ addManga: async () => { if (failing) throw new Error("offline"); } }));
    await workflow.loadPopular();
    const id = workflow.items[0].id;
    await expect(workflow.addToLibrary(id)).rejects.toThrow("offline");
    failing = false;
    await workflow.addToLibrary(id);
    expect(workflow.error).toBeNull();
  });
  it("loads installed-source popular results and replaces them with a named search", async () => {
    const deps = dependencies();
    const workflow = createFirstRunDiscoveryWorkflow(deps);

    await workflow.loadPopular();
    expect(workflow.items.map((item) => item.title)).toEqual(["Popular manga", "Popular novel"]);

    await workflow.search("named");
    expect(workflow.items.map((item) => item.title)).toEqual(["Named manga", "Named novel"]);
    expect(deps.findManga).toHaveBeenLastCalledWith(expect.objectContaining({ id: "manga-a" }), "named");
    expect(deps.findNovels).toHaveBeenLastCalledWith(expect.objectContaining({ id: "novel-a" }), "named");
  });

  it("publishes an added work only after the production mutation succeeds", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const deps = dependencies({ addManga: vi.fn(() => pending) });
    const workflow = createFirstRunDiscoveryWorkflow(deps);
    await workflow.loadPopular();
    const id = workflow.items.find((item) => item.kind === "manga")!.id;

    const adding = workflow.addToLibrary(id);
    expect(workflow.items.find((item) => item.id === id)?.status).toBe("adding");
    expect(workflow.items.find((item) => item.id === id)?.inLibrary).toBe(false);

    finish();
    await adding;
    expect(workflow.items.find((item) => item.id === id)).toMatchObject({ status: "added", inLibrary: true });
  });

  it("rolls back the visible state when a Library mutation fails", async () => {
    const deps = dependencies({ addNovel: vi.fn(async () => { throw new Error("write failed"); }) });
    const workflow = createFirstRunDiscoveryWorkflow(deps);
    await workflow.loadPopular();
    const id = workflow.items.find((item) => item.kind === "novel")!.id;

    await expect(workflow.addToLibrary(id)).rejects.toThrow("write failed");
    expect(workflow.items.find((item) => item.id === id)).toMatchObject({ status: "idle", inLibrary: false });
  });

  it("keeps successful source results when another installed source fails", async () => {
    const deps = dependencies({
      loadMangaSources: vi.fn(async () => [
        { id: "broken", name: "Broken" },
        { id: "working", name: "Working" },
      ]),
      findManga: vi.fn(async (source) => {
        if (source.id === "broken") throw new Error("offline");
        return [{ id: 22, title: "Available", coverUrl: null, inLibrary: false }];
      }),
    });
    const workflow = createFirstRunDiscoveryWorkflow(deps);

    await workflow.loadPopular();
    expect(workflow.items.some((item) => item.title === "Available")).toBe(true);
    expect(workflow.error).toBeNull();
  });
});

describe("rankFirstRunDiscoverySources", () => {
  const variant = (id: string, lang: string, group = "MANGA Plus") => ({ id, name: `${group} (${lang})`, group, lang });

  it("keeps the app language's variant of each extension and lists those first", () => {
    const ranked = rankFirstRunDiscoverySources([
      variant("mp-en", "en"),
      variant("mp-es", "es"),
      { id: "other", name: "Other", group: "Other", lang: "en" },
      variant("mp-pt", "pt-BR"),
      variant("mp-fr", "fr"),
    ], "pt-BR");

    expect(ranked.map((source) => source.id)).toEqual(["mp-pt", "other"]);
  });

  it("falls back to multi-language and then English variants", () => {
    expect(rankFirstRunDiscoverySources([variant("a-es", "es"), variant("a-en", "en")], "pt-BR").map((source) => source.id)).toEqual(["a-en"]);
    expect(rankFirstRunDiscoverySources([variant("a-en", "en"), variant("a-all", "all")], "pt-BR").map((source) => source.id)).toEqual(["a-all"]);
  });

  it("matches novel sources by language name", () => {
    const ranked = rankFirstRunDiscoverySources([
      { id: "en-novel", name: "English novels", lang: "English" },
      { id: "pt-novel", name: "Central Novel", lang: "Português" },
    ], "pt-BR");

    expect(ranked.map((source) => source.id)).toEqual(["pt-novel", "en-novel"]);
  });
});
