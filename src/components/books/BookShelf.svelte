<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { BookOpen, UploadSimple } from "phosphor-svelte";
  import {
    addToast,
    getBookProgress,
    setActiveBookId,
    store,
  } from "../../store/state.svelte";
  import type { BookEntry, BookSubtype } from "../../lib/books/types";
  import { parseEpubArchive } from "../../lib/books/epub";
  import { createBookSectionSnapshot } from "../../lib/books/summary";
  import {
    BookAssetResolver,
    computeBookAssetFingerprint,
    createImportedBookId,
  } from "../../lib/books/assets";
  import { findBookByFingerprint } from "../../lib/books/identity";
  import {
    canRenderEmbeddedImage,
    copyImportedBook,
    readFileAsArrayBuffer,
    writeBookCover,
  } from "../../lib/books/storage";
  import { presentBook } from "../../lib/books/presentation";

  type Props = {
    books?: BookEntry[];
    totalBooks?: number;
  };

  let {
    books: visibleBooks = [],
    totalBooks = 0,
  }: Props = $props();

  const win = getCurrentWindow();
  const SUPPORTED_EXTS = new Set(["epub", "pdf"]);

  let dropActive = $state(false);
  let importingDrop = $state(false);
  let brokenCoverKeys = $state(new Set<string>());

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

  const visibleCards = $derived(
    visibleBooks.map((book) => ({
      book,
      coverKey: bookCoverKey(book),
      presentation: presentBook(book, getBookProgress(book.id) ?? null),
    })),
  );

  $effect(() => {
    const liveKeys = new Set(visibleBooks.map(bookCoverKey));
    const current = untrack(() => brokenCoverKeys);
    const next = new Set(
      [...current].filter((key) => liveKeys.has(key)),
    );
    if (!setsEqual(current, next)) {
      brokenCoverKeys = next;
    }
  });

  async function importBookFile(sourcePath: string): Promise<BookEntry> {
    const subtype = extFromPath(sourcePath) as BookSubtype;
    const now = Date.now();
    const buffer = await readFileAsArrayBuffer(sourcePath);
    const assetFingerprint = await computeBookAssetFingerprint(buffer);
    const existing = findBookByFingerprint(store.books, assetFingerprint);
    const id = existing?.id ?? createImportedBookId(subtype, assetFingerprint);
    const assetPath = await copyImportedBook(sourcePath, id);

    if (subtype === "epub") {
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
      title: fileStem(sourcePath) || "Imported PDF",
      author: null,
      description: null,
      coverPath: null,
      subtype: "pdf",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      importPath: sourcePath,
      assetPath,
      sectionsSummary: [],
      sectionCount: 0,
      tocCount: 0,
      spineCount: 0,
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

  function openBook(book: BookEntry) {
    setActiveBookId(book.id);
  }

  onMount(() => {
    let unlisten: (() => void) | undefined;

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

    return () => {
      dropActive = false;
      unlisten?.();
    };
  });
</script>

<div class="books-shell">
  {#if totalBooks === 0}
    <div class="center books-empty">
      <BookOpen size={28} weight="duotone" />
      <span>Drag EPUB or PDF files into the Books shelf to import them.</span>
    </div>
  {:else if visibleBooks.length === 0}
    <div class="center books-empty">
      <BookOpen size={28} weight="duotone" />
      <span>No books match the current search or filters.</span>
    </div>
  {:else}
    <div class="grid">
      {#each visibleCards as card (card.book.id)}
        <button class="card book-card" onclick={() => openBook(card.book)}>
            <div class="cover-wrap">
              <div class="cover-fallback" aria-hidden="true">
                <BookOpen size={28} weight="duotone" />
                <span>{card.presentation.subtypeLabel}</span>
              </div>
              {#if card.presentation.coverSrc && !brokenCoverKeys.has(card.coverKey)}
                <img
                  class="cover"
                  src={card.presentation.coverSrc}
                  alt=""
                  loading="eager"
                  draggable="false"
                  onerror={() => {
                    BookAssetResolver.dropCoverSrc(card.book.coverPath);
                    brokenCoverKeys = new Set([...brokenCoverKeys, card.coverKey]);
                  }}
              />
            {/if}
            <span class="book-badge">{card.presentation.subtypeLabel}</span>
          </div>
          <p class="title">{card.presentation.title}</p>
          <p class="byline">{card.presentation.authorLabel}</p>
          <div class="card-meta">
            <span class="meta-chip">{card.presentation.sectionCountLabel}</span>
            <span class="meta-chip">{card.presentation.progressSummary}</span>
          </div>
        </button>
      {/each}
    </div>
  {/if}

  {#if dropActive || importingDrop}
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

<style>
  .books-shell {
    position: relative;
    z-index: 1;
    min-height: 100%;
    display: grid;
    align-content: start;
    gap: var(--sp-3);
  }

  .grid {
    position: relative;
    z-index: 1;
    isolation: isolate;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: var(--sp-4);
    align-items: start;
  }

  .card {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    min-width: 0;
    color: inherit;
  }

  .card:hover .cover {
    filter: brightness(1.07);
  }

  .card:hover .title {
    color: var(--text-primary);
  }

  .card:hover .byline,
  .card:hover .meta-chip {
    color: var(--text-secondary);
  }

  .cover-wrap {
    position: relative;
    aspect-ratio: 2 / 3;
    overflow: hidden;
    border-radius: var(--radius-md);
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .cover {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transition: filter var(--t-base);
    will-change: filter;
    display: block;
    background: var(--bg-raised);
    object-fit: cover;
    color: transparent;
    font-size: 0;
  }

  .cover-fallback {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--bg-raised) 88%, white 12%),
      var(--bg-base)
    );
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }

  .title {
    margin-top: var(--sp-2);
    min-height: calc(var(--leading-snug) * 2em);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: var(--leading-snug);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    transition: color var(--t-base);
  }

  .byline {
    margin-top: 4px;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-family: var(--font-ui);
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color var(--t-base);
  }

  .card-meta {
    margin-top: var(--sp-2);
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .meta-chip {
    display: inline-flex;
    align-items: center;
    min-height: 18px;
    padding: 0 6px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-faint);
    font-family: var(--font-ui);
    font-size: 10px;
    letter-spacing: var(--tracking-wide);
    transition: color var(--t-base), border-color var(--t-base);
  }

  .book-badge {
    position: absolute;
    left: var(--sp-1);
    top: var(--sp-1);
    min-width: 18px;
    min-height: 18px;
    padding: 0 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: bold;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    background: var(--bg-void);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong);
  }

  .center {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 60%;
    color: var(--text-muted);
    font-size: var(--text-sm);
    gap: var(--sp-2);
    text-align: center;
    line-height: var(--leading-base);
  }

  .books-empty {
    min-height: 320px;
  }

  .book-drop-overlay {
    position: absolute;
    inset: 0;
    z-index: 8;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--accent);
    border-radius: var(--radius-lg);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--accent-muted) 84%, black 16%), rgba(0, 0, 0, 0.65));
    backdrop-filter: blur(10px);
    pointer-events: none;
  }

  .book-drop-panel {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-4) var(--sp-5);
    border-radius: var(--radius-lg);
    border: 1px solid var(--accent-dim);
    background: color-mix(in srgb, var(--bg-overlay) 86%, black 14%);
    box-shadow: var(--shadow-xl);
    color: var(--accent-fg);
  }

  .book-drop-copy {
    display: grid;
    gap: var(--sp-1);
  }

  .book-drop-copy strong {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--accent-fg);
  }

  .book-drop-copy span {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
