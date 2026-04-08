<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { BookOpen, Folder, FolderSimplePlus, UploadSimple } from "phosphor-svelte";
  import { addToast, setActiveBookId, setLibraryScrollTop, store, updateSettings, upsertBook } from "../../store/state.svelte";
  import { hasBookLocalAsset, MISSING_BOOK_ASSET_MESSAGE } from "../../lib/books/availability";
  import { BookAssetResolver, createImportedBookId } from "../../lib/books/assets";
  import { resolveImportedBookFingerprint } from "../../lib/books/import";
  import { parseEpubArchive } from "../../lib/books/epub";
  import { extractPdfBookData } from "../../lib/books/pdf";
  import { findBookByFingerprint } from "../../lib/books/identity";
  import { createBookSectionSnapshot } from "../../lib/books/summary";
  import {
    canRenderEmbeddedImage,
    computeFileSha256,
    copyImportedBook,
    readFileAsArrayBuffer,
    writeBookCover,
  } from "../../lib/books/storage";
  import type { BookEntry, BookSubtype } from "../../lib/books/types";
  import { createBookLibraryCardId } from "../../lib/library/cardIdentity";
  import {
    createBooksCategory,
    isBookAssignedToCategory,
    sortBooksCategories,
    toggleBookCategoryAssignment,
  } from "../../lib/library/domainCategories";
  import { computeLibraryLayout, type LibraryPreferredGridColumns, type LibraryViewMode } from "../../lib/libraryDisplay";
  import type { BooksSectionVM } from "../../lib/library/contracts";
  import ContextMenu, { type MenuEntry } from "../shared/ContextMenu.svelte";
  import LibraryCardGrid from "./LibraryCardGrid.svelte";

  type Props = {
    vm: BooksSectionVM;
    books: BookEntry[];
    totalBooks: number;
    viewKey: string;
    viewMode: LibraryViewMode;
    preferredColumns: LibraryPreferredGridColumns;
    showProgress: boolean;
    showOutline: boolean;
  };

  let {
    vm,
    books,
    totalBooks,
    viewKey,
    viewMode = "grid",
    preferredColumns = "auto",
    showProgress = true,
    showOutline = true,
  }: Props = $props();

  const win = getCurrentWindow();
  const SUPPORTED_EXTS = new Set(["epub", "pdf"]);

  let contentEl: HTMLDivElement | null = $state(null);
  let dropActive = $state(false);
  let importingDrop = $state(false);
  let brokenCoverKeys = $state(new Set<string>());
  let contentWidth = $state(0);
  let ctx: { x: number; y: number; book: BookEntry } | null = $state(null);
  let scrollReady = false;

  const bookByCardId = $derived(
    new Map(books.map((book) => [createBookLibraryCardId(book.id), book])),
  );

  const visibleCards = $derived(
    vm.cards.map((card) => {
      const book = bookByCardId.get(card.id);
      if (!book) return card;

      return {
        ...card,
        coverSrc: brokenCoverKeys.has(bookCoverKey(book)) ? null : card.coverSrc,
      };
    }),
  );
  const layout = $derived(
    computeLibraryLayout({
      availableWidth: contentWidth,
      preferredColumns,
      mode: viewMode,
    }),
  );

  function bookCoverKey(book: Pick<BookEntry, "id" | "coverPath" | "updatedAt">): string {
    return `${book.id}:${book.coverPath ?? "none"}:${book.updatedAt}`;
  }

  function fileBasename(path: string): string {
    return path.split(/[\\/]/).pop() ?? "Imported book";
  }

  function fileStem(path: string): string {
    return fileBasename(path).replace(/\.[^.]+$/i, "");
  }

  function extFromPath(path: string): string {
    const match = path.match(/\.([^.\\/]+)$/i);
    return match?.[1]?.toLowerCase() ?? "";
  }

  function isSupportedBookPath(path: string): boolean {
    return SUPPORTED_EXTS.has(extFromPath(path));
  }

  function setsEqual<T>(left: Set<T>, right: Set<T>): boolean {
    if (left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }

  $effect(() => {
    const liveKeys = new Set(books.map(bookCoverKey));
    const next = new Set([...brokenCoverKeys].filter((key) => liveKeys.has(key)));
    if (!setsEqual(brokenCoverKeys, next)) {
      brokenCoverKeys = next;
    }
  });

  $effect(() => {
    viewKey;
    if (!scrollReady) {
      scrollReady = true;
      return;
    }
    setLibraryScrollTop(0);
    if (contentEl) contentEl.scrollTo({ top: 0 });
  });

  async function importBookFile(sourcePath: string): Promise<BookEntry> {
    const subtype = extFromPath(sourcePath) as BookSubtype;
    const now = Date.now();
    const { assetFingerprint } = await resolveImportedBookFingerprint(sourcePath, subtype, {
      computeFileSha256,
    });
    const existing = findBookByFingerprint(store.books, assetFingerprint);
    const id = existing?.id ?? createImportedBookId(subtype, assetFingerprint);
    const assetPath = await copyImportedBook(sourcePath, id);

    if (subtype === "epub") {
      const buffer = await readFileAsArrayBuffer(assetPath);
      const parsed = await parseEpubArchive(buffer, fileStem(sourcePath));

      let coverPath: string | null = existing?.coverPath ?? null;
      if (parsed.cover) {
        const isRenderableCover = await canRenderEmbeddedImage(
          parsed.cover.bytesBase64,
          parsed.cover.mediaType,
        );
        if (isRenderableCover) {
          try {
            coverPath = await writeBookCover(id, parsed.cover.bytesBase64, parsed.cover.ext);
          } catch {
            coverPath = existing?.coverPath ?? null;
          }
        } else {
          coverPath = null;
        }
      }

      const entry: BookEntry = {
        id,
        assetFingerprint,
        title: parsed.title,
        author: parsed.author,
        description: parsed.description,
        coverPath,
        subtype,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        importPath: sourcePath,
        assetPath,
        ...createBookSectionSnapshot(parsed.toc, parsed.spine),
      };

      upsertBook(entry);
      addToast({
        kind: "success",
        title: existing ? "Updated EPUB" : "Imported EPUB",
        body: entry.title,
      });
      return entry;
    }

    const entry: BookEntry = {
      id,
      assetFingerprint,
      ...(await extractPdfBookData(assetPath, id, fileStem(sourcePath) || "Imported PDF")),
      subtype: "pdf",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      importPath: sourcePath,
      assetPath,
    };

    upsertBook(entry);
    addToast({
      kind: "success",
      title: existing ? "Updated PDF" : "Imported PDF",
      body: entry.title,
    });
    return entry;
  }

  async function importDroppedPaths(paths: string[]) {
    const deduped = [...new Set(paths)];
    const supported = deduped.filter(isSupportedBookPath);
    const skipped = deduped.filter((path) => !isSupportedBookPath(path));

    if (!supported.length) {
      addToast({
        kind: "info",
        title: "No supported books detected",
        body: "Drop EPUB or PDF files into the Books shelf.",
      });
      return;
    }

    if (skipped.length) {
      addToast({
        kind: "info",
        title: "Some files were skipped",
        body: "Only EPUB and PDF files can be imported into Books.",
      });
    }

    importingDrop = true;
    try {
      for (const path of supported) {
        try {
          await importBookFile(path);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : `Could not import ${fileBasename(path)}.`;
          addToast({
            kind: "error",
            title: `Import failed: ${fileBasename(path)}`,
            body: message,
          });
        }
      }
    } finally {
      importingDrop = false;
    }
  }

  function openBook(cardId: string) {
    const book = bookByCardId.get(cardId);
    if (!book) return;
    if (!hasBookLocalAsset(book)) {
      addToast({
        kind: "info",
        title: "File missing",
        body: MISSING_BOOK_ASSET_MESSAGE,
      });
      return;
    }
    setActiveBookId(book.id);
  }

  function openBookContext(cardId: string, event: MouseEvent) {
    const book = bookByCardId.get(cardId);
    if (!book) return;
    event.preventDefault();
    ctx = { x: event.clientX, y: event.clientY, book };
  }

  function toggleCategory(book: BookEntry, categoryId: string) {
    updateSettings({
      booksCategoryAssignments: toggleBookCategoryAssignment(
        store.settings.booksCategoryAssignments,
        book.id,
        categoryId,
      ),
    });
  }

  function createCategoryAndAssign(book: BookEntry) {
    const name = prompt("Category name:");
    if (!name?.trim()) return;

    const nextCategory = createBooksCategory(store.settings.booksCategories, name);
    updateSettings({
      booksCategories: sortBooksCategories([...store.settings.booksCategories, nextCategory]),
      booksCategoryAssignments: toggleBookCategoryAssignment(
        store.settings.booksCategoryAssignments,
        book.id,
        nextCategory.id,
      ),
    });
  }

  function buildContextItems(book: BookEntry): MenuEntry[] {
    const categoryItems: MenuEntry[] = store.settings.booksCategories.map((category) => {
      const assigned = isBookAssignedToCategory(
        book.id,
        category.id,
        store.settings.booksCategoryAssignments,
      );

      return {
        label: assigned ? `Remove from ${category.name}` : `Add to ${category.name}`,
        icon: Folder,
        onClick: () => toggleCategory(book, category.id),
      };
    });

    return [
      ...categoryItems,
      ...(categoryItems.length ? ([{ separator: true } as MenuEntry]) : []),
      {
        label: "New category",
        icon: FolderSimplePlus,
        onClick: () => createCategoryAndAssign(book),
      },
    ];
  }

  function handleCoverError(cardId: string) {
    const book = bookByCardId.get(cardId);
    if (!book) return;

    BookAssetResolver.dropCoverSrc(book.coverPath);
    brokenCoverKeys = new Set([...brokenCoverKeys, bookCoverKey(book)]);
  }

  function handleContentScroll() {
    if (!contentEl) return;
    setLibraryScrollTop(contentEl.scrollTop);
  }

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let resizeObserver: ResizeObserver | null = null;

    void (async () => {
      unlisten = await win.onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          dropActive = event.payload.paths.some(isSupportedBookPath);
          return;
        }

        if (event.payload.type === "leave") {
          dropActive = false;
          return;
        }

        if (event.payload.type === "drop") {
          dropActive = false;
          void importDroppedPaths(event.payload.paths);
        }
      });
    })();

    queueMicrotask(() => {
      if (contentEl) {
        contentWidth = contentEl.clientWidth;
        resizeObserver = new ResizeObserver((entries) => {
          const nextWidth = entries[0]?.contentRect.width ?? contentEl?.clientWidth ?? 0;
          contentWidth = nextWidth;
        });
        resizeObserver.observe(contentEl);
      }
      if (store.libraryScrollTop > 0 && contentEl) {
        contentEl.scrollTo({ top: store.libraryScrollTop });
      }
    });

    return () => {
      dropActive = false;
      resizeObserver?.disconnect();
      unlisten?.();
    };
  });
</script>

<div class="content" bind:this={contentEl} onscroll={handleContentScroll}>
  {#if totalBooks === 0 || books.length === 0}
    <div class="center books-empty">
      <BookOpen size={28} weight="duotone" />
      <span>{vm.emptyMessage}</span>
    </div>
  {:else}
    <LibraryCardGrid
      items={visibleCards}
      {viewMode}
      effectiveColumns={layout.effectiveColumns}
      {showProgress}
      {showOutline}
      onOpen={(cardId) => openBook(cardId)}
      onContextMenu={openBookContext}
      onCoverError={handleCoverError}
    />
  {/if}

  {#if vm.dragDropEnabled && (dropActive || importingDrop)}
    <div class="book-drop-overlay" aria-hidden="true">
      <div class="book-drop-panel">
        <UploadSimple size={22} weight="bold" />
        <div class="book-drop-copy">
          <strong>{importingDrop ? "Importing books..." : "Drop EPUB or PDF files here"}</strong>
          <span>{importingDrop ? "Aethon is adding them to the Books shelf." : "Imported books stay separate from Comics."}</span>
        </div>
      </div>
    </div>
  {/if}
</div>

{#if ctx}
  <ContextMenu x={ctx.x} y={ctx.y} items={buildContextItems(ctx.book)} onClose={() => ctx = null} />
{/if}

<style>
  .content {
    position: relative;
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-5) var(--sp-6) var(--sp-6);
    min-height: 0;
    will-change: scroll-position;
    -webkit-overflow-scrolling: touch;
  }

  .center {
    position: relative;
    z-index: 1;
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3);
    text-align: center;
    color: var(--text-muted);
  }

  .books-empty {
    font-size: var(--text-sm);
    line-height: var(--leading-base);
  }

  .book-drop-overlay {
    position: absolute;
    inset: 0;
    background: rgba(5, 8, 6, 0.78);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 6;
  }

  .book-drop-panel {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-4) var(--sp-5);
    border: 1px solid var(--accent-dim);
    border-radius: var(--radius-lg);
    background: linear-gradient(180deg, var(--bg-overlay), color-mix(in srgb, var(--bg-overlay) 70%, var(--accent-muted)));
    box-shadow: 0 16px 42px rgba(0, 0, 0, 0.42);
    color: var(--accent-fg);
  }

  .book-drop-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .book-drop-copy strong {
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }

  .book-drop-copy span {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    letter-spacing: var(--tracking-wide);
  }
</style>
