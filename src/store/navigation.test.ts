import { afterEach, describe, expect, test } from "vitest";
import { openHomeDashboard, setNavPage, store } from "./state.svelte";

describe("navigation subscriptions", () => {
  afterEach(() => {
    openHomeDashboard();
    store.activeManga = null;
    store.activeBookId = null;
    store.activeBookReaderId = null;
    store.activeNovelDetail = null;
    store.activeNovelReader = null;
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
