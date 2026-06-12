import { afterEach, describe, expect, test } from "vitest";
import { openBookReader, openHomeDashboard, openHomeHistory, openMangaDetail, openReader, openSearchSources, setNavPage, setSettingsOpen, store } from "./state.svelte";

describe("navigation subscriptions", () => {
  afterEach(() => {
    openHomeDashboard();
    store.activeManga = null;
    store.activeBookId = null;
    store.activeBookReaderId = null;
    store.activeNovelDetail = null;
    store.activeNovelReader = null;
    store.activeChapter = null;
    store.activeChapterList = [];
    store.previewManga = null;
    store.pageUrls = [];
    store.pageNumber = 1;
  });

  test("emits when navPage changes", () => {
    const seen: string[] = [];
    const unsubscribe = store.subscribeNavigation(() => {
      seen.push(store.navPage);
    });

    setNavPage("downloads");
    setNavPage("library");
    unsubscribe();
    setNavPage("home");

    expect(seen).toEqual(["downloads", "library"]);
  });

  test("openHomeDashboard clears active detail state", () => {
    store.activeManga = { id: 42, title: "Test", thumbnailUrl: "" } as never;
    store.activeBookId = "book-1";
    store.activeBookReaderId = "reader-1";
    store.activeNovelDetail = { novelId: "novel-1" } as never;
    store.activeNovelReader = { novelId: "novel-1" } as never;
    store.activeChapter = { id: 99 } as never;
    store.activeChapterList = [{ id: 99 } as never];
    store.activeSource = { id: "source-1" } as never;
    store.genreFilter = "action";
    store.libraryFilter = "all";

    openHomeDashboard();

    expect(store.navPage).toBe("home");
    expect(store.activeManga).toBeNull();
    expect(store.activeBookId).toBeNull();
    expect(store.activeBookReaderId).toBeNull();
    expect(store.activeNovelDetail).toBeNull();
    expect(store.activeNovelReader).toBeNull();
    expect(store.activeChapter).toBeNull();
    expect(store.activeChapterList).toEqual([]);
    expect(store.activeSource).toBeNull();
    expect(store.genreFilter).toBe("");
    expect(store.libraryFilter).toBe("library");
  });

  test("setNavPage clears active detail and reader state deterministically", () => {
    store.activeManga = { id: 42, title: "Test", thumbnailUrl: "" } as never;
    store.activeBookId = "book-1";
    store.activeBookReaderId = "reader-1";
    store.activeNovelDetail = { novelId: "novel-1" } as never;
    store.activeNovelReader = { novelId: "novel-1" } as never;
    store.activeChapter = { id: 99 } as never;
    store.activeChapterList = [{ id: 99 } as never];
    store.activeSource = { id: "source-1" } as never;
    store.homePanelHint = "history";

    setNavPage("search");

    expect(store.navPage).toBe("search");
    expect(store.activeManga).toBeNull();
    expect(store.activeBookId).toBeNull();
    expect(store.activeBookReaderId).toBeNull();
    expect(store.activeNovelDetail).toBeNull();
    expect(store.activeNovelReader).toBeNull();
    expect(store.activeChapter).toBeNull();
    expect(store.activeChapterList).toEqual([]);
    expect(store.activeSource).toBeNull();
    expect(store.homePanelHint).toBeNull();
  });

  test("openMangaDetail navigates to library without clearing the selected manga", () => {
    store.activeBookId = "book-1";
    store.activeBookReaderId = "book-1";
    store.activeNovelDetail = { novelId: "novel-1" } as never;
    store.activeNovelReader = { novelId: "novel-1" } as never;
    store.activeChapter = { id: 99 } as never;
    store.activeChapterList = [{ id: 99 } as never];
    store.previewManga = { id: 11, title: "Preview", thumbnailUrl: "" } as never;
    store.activeSource = { id: "source-1" } as never;

    openMangaDetail({ id: 42, title: "Opened", thumbnailUrl: "" } as never);

    expect(store.navPage).toBe("library");
    expect(store.librarySection).toBe("comics");
    expect(store.activeManga?.id).toBe(42);
    expect(store.activeBookId).toBeNull();
    expect(store.activeBookReaderId).toBeNull();
    expect(store.activeNovelDetail).toBeNull();
    expect(store.activeNovelReader).toBeNull();
    expect(store.activeChapter).toBeNull();
    expect(store.activeChapterList).toEqual([]);
    expect(store.previewManga).toBeNull();
    expect(store.activeSource).toBeNull();
  });

  test("reader entry points clear competing reader and detail state", () => {
    store.activeBookId = "book-1";
    store.activeBookReaderId = "book-1";
    store.activeNovelDetail = { novelId: "novel-1" } as never;
    store.activeNovelReader = { novelId: "novel-1" } as never;

    openReader(
      { id: 99, mangaId: 42, name: "Chapter 1" } as never,
      [{ id: 99, mangaId: 42, name: "Chapter 1" } as never],
      { id: 42, title: "Manga", thumbnailUrl: "" } as never,
    );

    expect(store.activeManga?.id).toBe(42);
    expect(store.activeChapter?.id).toBe(99);
    expect(store.activeBookId).toBeNull();
    expect(store.activeBookReaderId).toBeNull();
    expect(store.activeNovelDetail).toBeNull();
    expect(store.activeNovelReader).toBeNull();

    store.activeManga = { id: 42, title: "Manga", thumbnailUrl: "" } as never;
    store.activeNovelDetail = { novelId: "novel-1" } as never;
    store.activeNovelReader = { novelId: "novel-1" } as never;
    store.activeChapter = { id: 99 } as never;
    store.activeChapterList = [{ id: 99 } as never];

    openBookReader("book-2");

    expect(store.activeBookId).toBe("book-2");
    expect(store.activeBookReaderId).toBe("book-2");
    expect(store.activeManga).toBeNull();
    expect(store.activeNovelDetail).toBeNull();
    expect(store.activeNovelReader).toBeNull();
    expect(store.activeChapter).toBeNull();
    expect(store.activeChapterList).toEqual([]);
  });

  test("shortcut navigation clears detail state while applying hints", () => {
    store.activeManga = { id: 42, title: "Test", thumbnailUrl: "" } as never;
    store.activeSource = { id: "source-1" } as never;
    store.activeBookReaderId = "reader-1";

    openSearchSources("extensions", "repos");

    expect(store.navPage).toBe("search");
    expect(store.searchTabHint).toBe("sources");
    expect(store.searchSourcesPaneHint).toBe("extensions");
    expect(store.extensionsPanelHint).toBe("repos");
    expect(store.activeManga).toBeNull();
    expect(store.activeSource).toBeNull();
    expect(store.activeBookReaderId).toBeNull();

    store.activeManga = { id: 43, title: "Another", thumbnailUrl: "" } as never;
    openHomeHistory();

    expect(store.navPage).toBe("home");
    expect(store.homePanelHint).toBe("history");
    expect(store.activeManga).toBeNull();
  });

  test("opening settings clears transient detail state and returns to the last page", () => {
    setNavPage("library");
    store.activeManga = { id: 42, title: "Test", thumbnailUrl: "" } as never;
    store.activeSource = { id: "source-1" } as never;

    setSettingsOpen(true);

    expect(store.navPage).toBe("settings");
    expect(store.settingsOpen).toBe(true);
    expect(store.activeManga).toBeNull();
    expect(store.activeSource).toBeNull();

    setSettingsOpen(false);

    expect(store.navPage).toBe("library");
    expect(store.settingsOpen).toBe(false);
  });

  test("navigation clears lingering search-engaged body classes", () => {
    const previousDocument = (globalThis as { document?: Document }).document;
    const bodyClasses = new Set<string>();
    (globalThis as typeof globalThis & {
      document: {
        body: {
          classList: {
            add: (...tokens: string[]) => void;
            remove: (...tokens: string[]) => void;
            contains: (token: string) => boolean;
          };
        };
      };
    }).document = {
      body: {
        classList: {
          add: (...tokens: string[]) => { tokens.forEach((token) => bodyClasses.add(token)); },
          remove: (...tokens: string[]) => { tokens.forEach((token) => bodyClasses.delete(token)); },
          contains: (token: string) => bodyClasses.has(token),
        },
      },
    };

    bodyClasses.add("aethon-settings-search-engaged");
    bodyClasses.add("aethon-home-search-engaged");
    bodyClasses.add("aethon-library-search-engaged");
    bodyClasses.add("aethon-browse-search-engaged");

    setNavPage("downloads");
    expect(document.body.classList.contains("aethon-settings-search-engaged")).toBe(false);
    expect(document.body.classList.contains("aethon-home-search-engaged")).toBe(false);
    expect(document.body.classList.contains("aethon-library-search-engaged")).toBe(false);
    expect(document.body.classList.contains("aethon-browse-search-engaged")).toBe(false);

    document.body.classList.add("aethon-browse-search-engaged");
    openHomeDashboard();
    expect(document.body.classList.contains("aethon-browse-search-engaged")).toBe(false);

    if (previousDocument) {
      (globalThis as { document?: Document }).document = previousDocument;
    } else {
      delete (globalThis as { document?: Document }).document;
    }
  });
});
