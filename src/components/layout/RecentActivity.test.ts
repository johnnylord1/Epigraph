import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import RecentActivity from "./RecentActivity.svelte";
import { store } from "../../store/state.svelte";
import type { BookEntry, BookProgress } from "../../lib/books/types";

function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    id: "book-epub-1",
    subtype: "epub",
    title: "Dune",
    author: "Frank Herbert",
    filePath: "C:/books/dune.epub",
    fileName: "dune.epub",
    fileSize: 1024,
    coverPath: null,
    addedAt: 1_000,
    ...overrides,
  };
}

function makeProgress(overrides: Partial<BookProgress> = {}): BookProgress {
  return {
    bookId: "book-epub-1",
    progressPercent: 0.42,
    lastReadAt: Date.now() - 60_000,
    ...overrides,
  };
}

describe("RecentActivity books integration", () => {
  const original = {
    history: store.history,
    historyClearedAt: store.historyClearedAt,
    books: store.books,
    bookProgress: store.bookProgress,
    libraryUpdateNotifications: store.libraryUpdateNotifications,
    libraryUpdateIssues: store.libraryUpdateIssues,
    systemNotifications: store.systemNotifications,
    activeBookId: store.activeBookId,
    activeBookReaderId: store.activeBookReaderId,
    activityPanelOpen: store.activityPanelOpen,
  };

  beforeEach(() => {
    if (!HTMLElement.prototype.scrollTo) {
      HTMLElement.prototype.scrollTo = () => {};
    }
    store.history = [];
    store.historyClearedAt = 0;
    store.books = [];
    store.bookProgress = [];
    store.libraryUpdateNotifications = [];
    store.libraryUpdateIssues = [];
    store.systemNotifications = [];
    store.activeBookId = null;
    store.activeBookReaderId = null;
    store.activityPanelOpen = true;
  });

  afterEach(() => {
    cleanup();
    store.history = original.history;
    store.historyClearedAt = original.historyClearedAt;
    store.books = original.books;
    store.bookProgress = original.bookProgress;
    store.libraryUpdateNotifications = original.libraryUpdateNotifications;
    store.libraryUpdateIssues = original.libraryUpdateIssues;
    store.systemNotifications = original.systemNotifications;
    store.activeBookId = original.activeBookId;
    store.activeBookReaderId = original.activeBookReaderId;
    store.activityPanelOpen = original.activityPanelOpen;
  });

  it("includes read EPUB/PDF books in All and History tabs and skips unread books", async () => {
    const readBook = makeBook({ id: "book-read", title: "Dune" });
    const readPdf = makeBook({ id: "book-pdf", title: "Read PDF", subtype: "pdf" });
    const unreadBook = makeBook({ id: "book-unread", title: "Unread Book" });
    store.books = [readBook, readPdf, unreadBook];
    store.bookProgress = [
      makeProgress({ bookId: "book-read", progressPercent: 0.35, lastReadAt: Date.now() - 30_000 }),
      makeProgress({ bookId: "book-pdf", progressPercent: 0.8 }),
    ];

    render(RecentActivity);

    expect(screen.getByText("Dune")).toBeTruthy();
    expect(screen.getByText("Read PDF")).toBeTruthy();
    expect(screen.queryByText("Unread Book")).toBeNull();

    const historyTab = screen.getByRole("tab", { name: /History/i });
    await fireEvent.click(historyTab);

    expect(screen.getByText("Dune")).toBeTruthy();
    expect(screen.getByText("Read PDF")).toBeTruthy();
    expect(screen.queryByText("Unread Book")).toBeNull();
  });

  it("hides books read before the history was cleared and preserves their progress", () => {
    store.books = [makeBook(), makeBook({ id: "book-reread", title: "Foundation" })];
    store.bookProgress = [
      makeProgress({ lastReadAt: 1_000 }),
      makeProgress({ bookId: "book-reread", lastReadAt: 3_000 }),
    ];
    store.historyClearedAt = 2_000;

    render(RecentActivity);

    expect(screen.queryByText("Dune")).toBeNull();
    expect(screen.getByText("Foundation")).toBeTruthy();
    expect(store.bookProgress).toHaveLength(2);
  });

  it("opens the book reader when clicking a recent book entry", async () => {
    store.books = [makeBook({ id: "book-click", title: "Foundation" })];
    store.bookProgress = [makeProgress({ bookId: "book-click", progressPercent: 0.5 })];

    render(RecentActivity);

    const button = screen.getByText("Foundation").closest("button");
    expect(button).toBeTruthy();
    await fireEvent.click(button!);

    expect(store.activeBookId).toBe("book-click");
    expect(store.activeBookReaderId).toBe("book-click");
    expect(store.activityPanelOpen).toBe(false);
  });
});
