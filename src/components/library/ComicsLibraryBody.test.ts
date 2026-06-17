import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Category, Manga } from "../../lib/types";
import type { ComicsSectionVM } from "../../lib/library/contracts";
import {
  cacheLibraryCoverFromServer,
  clearSessionLibraryCoverUrl,
  getCachedLibraryCoverUrl,
  getSessionLibraryCoverUrl,
  libraryCoverCacheKey,
  setSessionLibraryCoverUrl,
} from "../../lib/library/coverCache";
import { store } from "../../store/state.svelte";
import ComicsLibraryBody from "./ComicsLibraryBody.svelte";

vi.mock("../../lib/library/coverCache", () => ({
  cacheLibraryCoverFromServer: vi.fn(async () => null),
  clearSessionLibraryCoverUrl: vi.fn(),
  getCachedLibraryCoverUrl: vi.fn(async () => null),
  getSessionLibraryCoverUrl: vi.fn(() => null),
  libraryCoverCacheKey: vi.fn((_scope, manga: Manga) => `test-cover:${manga.id}`),
  setSessionLibraryCoverUrl: vi.fn(),
}));

const originalImageDecode = HTMLImageElement.prototype.decode;

describe("ComicsLibraryBody", () => {
  afterEach(() => {
    cleanup();
    if (originalImageDecode) {
      HTMLImageElement.prototype.decode = originalImageDecode;
    } else {
      delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
    }
  });

  beforeEach(() => {
    if (typeof HTMLImageElement.prototype.decode !== "function") {
      Object.defineProperty(HTMLImageElement.prototype, "decode", {
        configurable: true,
        writable: true,
        value: vi.fn(async () => undefined),
      });
    }

    store.navPage = "home";
    store.librarySection = "books";
    store.activeManga = null;
    store.activeBookId = null;
    store.activeBookReaderId = null;
    store.activeNovelDetail = null;
    store.activeNovelReader = null;
    store.activeChapter = null;
    store.activeChapterList = [];
    store.libraryScrollTop = 0;
    store.libraryVisibleCount = 0;
    store.libraryReturnToMangaId = null;
    store.runtimeServerUrl = null;
    store.runtimeResolvedLocalProfileId = null;
    vi.mocked(cacheLibraryCoverFromServer).mockReset();
    vi.mocked(cacheLibraryCoverFromServer).mockResolvedValue(null);
    vi.mocked(clearSessionLibraryCoverUrl).mockReset();
    vi.mocked(getCachedLibraryCoverUrl).mockReset();
    vi.mocked(getCachedLibraryCoverUrl).mockResolvedValue(null);
    vi.mocked(getSessionLibraryCoverUrl).mockReset();
    vi.mocked(getSessionLibraryCoverUrl).mockReturnValue(null);
    vi.mocked(libraryCoverCacheKey).mockReset();
    vi.mocked(libraryCoverCacheKey).mockImplementation((_scope, manga: Manga) => `test-cover:${manga.id}`);
    vi.mocked(setSessionLibraryCoverUrl).mockReset();
  });

  test("keeps selection and context menu ownership outside the shared grid", async () => {
    const manga = {
      id: 1,
      title: "Sample Manga",
      thumbnailUrl: null,
      inLibrary: true,
      downloadCount: 2,
      unreadCount: 4,
      source: { id: "source-1" },
    } as Manga;
    const category = {
      id: 10,
      name: "Finished",
      order: 1,
      default: false,
      mangas: { nodes: [manga] },
    } as unknown as Category;

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [{
        id: "comic:1",
        title: "Sample Manga",
        subtitle: undefined,
        coverSrc: null,
        coverFit: "cover",
        badges: [{ kind: "unread", label: "4" }],
        metaChips: [],
        progress: null,
        selectable: true,
        selected: false,
        disabled: false,
      }],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    render(ComicsLibraryBody, {
      props: {
        vm,
        mangas: [manga],
        categories: [category],
        categoryMangaMap: new Map([[10, [manga]]]),
        renderLimit: 48,
        viewKey: "library",
        onRemoveFromLibrary: vi.fn(),
        onAddToLibrary: vi.fn(),
        onDeleteAllDownloads: vi.fn(),
        onToggleCategory: vi.fn(),
        onCreateAndAssign: vi.fn(),
        onCreateCategory: vi.fn(),
      },
    });

    const card = screen.getByRole("button", { name: /Sample Manga/i });
    await fireEvent.click(card, { ctrlKey: true });
    expect(await screen.findByText(/1 selected/i)).toBeTruthy();
    await fireEvent.click(screen.getByTitle(/Cancel \(Esc\)/i));

    await fireEvent.contextMenu(card);
    expect(await screen.findByText(/Select this manga/i)).toBeTruthy();
  });

  test("renders clickable cards from manga data when the section vm omits card VMs", async () => {
    const manga = {
      id: 7,
      title: "Returned From Reader",
      thumbnailUrl: null,
      inLibrary: true,
      downloadCount: 0,
      unreadCount: 3,
      chapterCount: 10,
      status: "ONGOING",
      source: { id: "source-1", displayName: "Source One" },
    } as Manga;

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    render(ComicsLibraryBody, {
      props: {
        vm,
        mangas: [manga],
        categories: [],
        categoryMangaMap: new Map(),
        renderLimit: 48,
        viewKey: "library",
        onRemoveFromLibrary: vi.fn(),
        onAddToLibrary: vi.fn(),
        onDeleteAllDownloads: vi.fn(),
        onToggleCategory: vi.fn(),
        onCreateAndAssign: vi.fn(),
        onCreateCategory: vi.fn(),
      },
    });

    const card = screen.getByRole("button", { name: /Returned From Reader/i });
    expect(card.getAttribute("data-card-id")).toBe("comic:7");
    expect(card.textContent).toContain("3");
    expect(card.textContent).not.toContain("🌐");
    expect(card.textContent).toContain("Source One");
    expect(card.textContent).toContain("Ongoing");
    expect(card.textContent).not.toContain("Unknown");

    await fireEvent.click(card);
    expect(store.navPage).toBe("library");
    expect(store.librarySection).toBe("comics");
    expect(store.activeManga?.id).toBe(7);
  });

  test("uses session cover memory after remounting the comics section", async () => {
    vi.mocked(getSessionLibraryCoverUrl).mockReturnValue("cover://session-cover");
    const manga = {
      id: 17,
      title: "Remembered Cover",
      thumbnailUrl: "/api/v1/manga/17/thumbnail",
      inLibrary: true,
      downloadCount: 0,
      unreadCount: 0,
      chapterCount: 4,
      source: { id: "source-1", displayName: "Source One" },
    } as Manga;

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    const { container } = render(ComicsLibraryBody, {
      props: {
        vm,
        mangas: [manga],
        categories: [],
        categoryMangaMap: new Map(),
        renderLimit: 48,
        viewKey: "library",
      },
    });

    await waitFor(() => expect(container.querySelector("img.cover")?.getAttribute("src")).toBe("cover://session-cover"));
    expect(getCachedLibraryCoverUrl).not.toHaveBeenCalled();
  });

  test("uses the direct thumbnail URL while visible covers are not cached yet", async () => {
    store.runtimeServerUrl = "http://127.0.0.1:4567";
    vi.mocked(getSessionLibraryCoverUrl).mockReturnValue(null);
    vi.mocked(getCachedLibraryCoverUrl).mockResolvedValue(null);
    vi.mocked(cacheLibraryCoverFromServer).mockResolvedValue(null);

    const manga = {
      id: 18,
      title: "Uncached Visible Cover",
      thumbnailUrl: "/api/v1/manga/18/thumbnail",
      inLibrary: true,
      downloadCount: 0,
      unreadCount: 0,
      chapterCount: 4,
      source: { id: "source-1", displayName: "Source One" },
    } as Manga;

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    const { container } = render(ComicsLibraryBody, {
      props: {
        vm,
        mangas: [manga],
        categories: [],
        categoryMangaMap: new Map(),
        renderLimit: 48,
        viewKey: "library",
      },
    });

    await waitFor(() => {
      const src = container.querySelector("img.cover")?.getAttribute("src") ?? "";
      expect(src).toContain("/api/v1/manga/18/thumbnail");
      expect(src).toContain("aethon_cover_generation=");
      expect(src).toContain("aethon_cover_recovery=0");
    });
  });

  test("keeps the direct thumbnail when a cached cover cannot decode", async () => {
    store.runtimeServerUrl = "http://127.0.0.1:4567";
    vi.mocked(getSessionLibraryCoverUrl).mockReturnValue(null);
    vi.mocked(getCachedLibraryCoverUrl).mockResolvedValue("cover://bad-cache");
    vi.mocked(cacheLibraryCoverFromServer).mockResolvedValue(null);
    const decodeSpy = vi
      .spyOn(HTMLImageElement.prototype, "decode")
      .mockRejectedValue(new Error("decode failed"));

    const manga = {
      id: 19,
      title: "Bad Cached Cover",
      thumbnailUrl: "/api/v1/manga/19/thumbnail",
      inLibrary: true,
      downloadCount: 0,
      unreadCount: 0,
      chapterCount: 4,
      source: { id: "source-1", displayName: "Source One" },
    } as Manga;

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    try {
      const { container } = render(ComicsLibraryBody, {
        props: {
          vm,
          mangas: [manga],
          categories: [],
          categoryMangaMap: new Map(),
          renderLimit: 48,
          viewKey: "library",
        },
      });

      await waitFor(() => expect(getCachedLibraryCoverUrl).toHaveBeenCalled());
      await new Promise<void>((resolve) => setTimeout(resolve, 1200));

      const src = container.querySelector("img.cover")?.getAttribute("src") ?? "";
      expect(src).toContain("/api/v1/manga/19/thumbnail");
      expect(src).not.toBe("cover://bad-cache");
      expect(setSessionLibraryCoverUrl).not.toHaveBeenCalledWith(expect.anything(), manga, "cover://bad-cache");
    } finally {
      decodeSpy.mockRestore();
    }
  });

  test("renders comics through the virtual grid without a manual load-more gate", async () => {
    const mangas = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      title: `Paged Manga ${index + 1}`,
      thumbnailUrl: null,
      inLibrary: true,
      unreadCount: index + 1,
      chapterCount: 10,
      source: { id: "source-1", displayName: "Source One" },
    })) as Manga[];

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    render(ComicsLibraryBody, {
      props: {
        vm,
        mangas,
        categories: [],
        categoryMangaMap: new Map(),
        renderLimit: 2,
        viewKey: "library",
        onRemoveFromLibrary: vi.fn(),
        onAddToLibrary: vi.fn(),
        onDeleteAllDownloads: vi.fn(),
        onToggleCategory: vi.fn(),
        onCreateAndAssign: vi.fn(),
        onCreateCategory: vi.fn(),
      },
    });

    expect(screen.getByRole("button", { name: /Paged Manga 1/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Paged Manga 2/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Paged Manga 3/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Paged Manga 4/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Load 2 more/i })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: /Paged Manga 3/i }));
    expect(store.navPage).toBe("library");
    expect(store.librarySection).toBe("comics");
    expect(store.activeManga?.id).toBe(3);
  });

  test("keeps a broken cover on the placeholder after one recovery attempt", async () => {
    const manga = {
      id: 55,
      title: "Broken Cover Manga",
      thumbnailUrl: "/covers/broken.jpg",
      inLibrary: true,
      unreadCount: 0,
      chapterCount: 10,
      source: { id: "source-1", displayName: "Source One" },
    } as Manga;
    const onCoverErrorDetected = vi.fn();

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    const props = {
      vm,
      mangas: [manga],
      categories: [],
      categoryMangaMap: new Map<number, Manga[]>(),
      renderLimit: 48,
      viewKey: "library",
      onCoverErrorDetected,
      coverRecoveryVersions: new Map<number, number>(),
    };

    vi.mocked(getCachedLibraryCoverUrl).mockResolvedValue("cover://broken-cover.jpg");

    const { container, rerender } = render(ComicsLibraryBody, { props });

    await waitFor(() => expect(container.querySelector("img.cover")).toBeTruthy());
    await fireEvent.error(container.querySelector("img.cover")!);

    expect(onCoverErrorDetected).toHaveBeenCalledTimes(1);
    await rerender({
      ...props,
      coverRecoveryVersions: new Map([[55, 1]]),
    });

    expect(onCoverErrorDetected).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      const src = container.querySelector("img.cover")?.getAttribute("src") ?? "";
      expect(src).toContain("/covers/broken.jpg");
      expect(src).toContain("aethon_cover_retry=1");
      expect(src).not.toBe("cover://broken-cover.jpg");
    });

    await fireEvent.error(container.querySelector("img.cover")!);
    expect(onCoverErrorDetected).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(container.querySelector("img.cover")).toBeNull());

    await rerender({
      ...props,
      coverRecoveryVersions: new Map([[55, 2]]),
    });

    await waitFor(() => expect(container.querySelector("img.cover")).toBeNull());
  });

  test("ignores stale cached cover responses after the cover cache generation changes", async () => {
    let resolveOldCover: (value: string | null) => void = () => {};
    vi.mocked(getCachedLibraryCoverUrl).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveOldCover = resolve;
      }),
    );
    vi.mocked(libraryCoverCacheKey).mockImplementation(
      (scope, manga: Manga) => `test-cover:${manga.id}:${scope.coverCacheGeneration ?? 0}`,
    );

    store.runtimeResolvedLocalProfileId = "main";
    store.runtimeServerUrl = "http://127.0.0.1:4567";

    const manga = {
      id: 77,
      title: "Race Cover Manga",
      thumbnailUrl: "/api/v1/manga/77/thumbnail",
      inLibrary: true,
      unreadCount: 0,
      chapterCount: 10,
      source: { id: "source-1", displayName: "Source One" },
    } as Manga;

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    const baseProps = {
      vm,
      mangas: [manga],
      categories: [],
      categoryMangaMap: new Map<number, Manga[]>(),
      renderLimit: 48,
      viewKey: "library",
      coverCacheGeneration: 0,
    };

    const { container, rerender } = render(ComicsLibraryBody, { props: baseProps });

    await waitFor(() => expect(getCachedLibraryCoverUrl).toHaveBeenCalledTimes(1));
    await rerender({ ...baseProps, coverCacheGeneration: 1 });

    resolveOldCover("cover://old-generation");
    await Promise.resolve();

    expect(container.querySelector("img.cover")?.getAttribute("src")).not.toBe("cover://old-generation");
  });
});
