<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import ePub from "epubjs";
  import {
    ArrowLeft,
    ArrowsOutCardinal,
    BookOpen,
    CaretDown,
    X,
  } from "phosphor-svelte";
  import {
    addToast,
    getBookProgress,
    removeBook,
    setActiveBookId,
    setBookProgress,
    store,
  } from "../../store/state.svelte";
  import {
    getBookSectionCount,
    getBookSectionsSummary,
  } from "../../lib/books/summary";
  import type { BookProgress } from "../../lib/books/types";
  import { BookAssetResolver } from "../../lib/books/assets";
  import { presentBook } from "../../lib/books/presentation";
  import {
    removeBookAssets,
  } from "../../lib/books/storage";

  const SECTIONS_PER_PAGE = 25;

  let previewing = $state(false);
  let previewLoading = $state(false);
  let previewError: string | null = $state(null);
  let previewHost = $state<HTMLDivElement | null>(null);
  let currentBookRef: any = null;
  let currentRendition: any = null;
  let currentPreviewObjectUrl: string | null = null;
  let sectionPage = $state(1);
  let detailsOpen = $state(false);
  let coverBroken = $state(false);

  const activeBook = $derived(store.books.find((book) => book.id === store.activeBookId) ?? null);
  const activeProgress = $derived(activeBook ? getBookProgress(activeBook.id) ?? null : null);
  const activePresentation = $derived(activeBook ? presentBook(activeBook, activeProgress) : null);
  const detailSections = $derived(activeBook ? getBookSectionsSummary(activeBook) : []);
  const totalSectionCount = $derived(activePresentation?.sectionCount ?? (activeBook ? getBookSectionCount(activeBook) : 0));
  const totalSectionPages = $derived(Math.max(1, Math.ceil(detailSections.length / SECTIONS_PER_PAGE)));
  const visibleSections = $derived(
    detailSections.slice((sectionPage - 1) * SECTIONS_PER_PAGE, sectionPage * SECTIONS_PER_PAGE),
  );
  const readPercent = $derived(activePresentation?.readPercent ?? Math.max(0, Math.min(1, activeProgress?.progressPercent ?? 0)));
  const readSectionCount = $derived(activePresentation?.readSectionCount ?? (
    totalSectionCount > 0 ? Math.min(totalSectionCount, Math.round(readPercent * totalSectionCount)) : 0
  ));
  const showProgress = $derived(activePresentation?.showProgress ?? (totalSectionCount > 0 || !!activeProgress));
  const previewHeading = $derived(previewing ? "Preview" : "Book contents");
  const coverSrc = $derived(activePresentation?.coverSrc ?? (activeBook ? BookAssetResolver.resolveCoverSrc(activeBook) : null));

  function revokeObjectUrl(url: string | null | undefined) {
    if (!url?.startsWith("blob:")) return;
    URL.revokeObjectURL(url);
  }

  function closeDetail() {
    closePreview();
    setActiveBookId(null);
  }

  function disposePreview() {
    try {
      currentRendition?.destroy?.();
    } catch {}
    try {
      currentBookRef?.destroy?.();
    } catch {}
    currentRendition = null;
    currentBookRef = null;
    revokeObjectUrl(currentPreviewObjectUrl);
    currentPreviewObjectUrl = null;
    if (previewHost) previewHost.innerHTML = "";
  }

  function goToSectionPage(nextPage: number) {
    sectionPage = Math.max(1, Math.min(totalSectionPages, nextPage));
  }

  async function waitForPreviewHost() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await tick();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      if (previewHost) return previewHost;
      const fallbackHost = document.querySelector(".preview-host");
      if (fallbackHost instanceof HTMLDivElement) {
        previewHost = fallbackHost;
        return fallbackHost;
      }
    }

    throw new Error("Preview surface is not ready.");
  }

  async function openPreview() {
    if (!activeBook) return;
    previewing = true;
    previewLoading = true;
    previewError = null;
    disposePreview();

    try {
      const host = await waitForPreviewHost();
      const previewAsset = await BookAssetResolver.resolvePreviewAsset(activeBook);

      if (previewAsset.subtype === "pdf") {
        currentPreviewObjectUrl = URL.createObjectURL(
          new Blob([previewAsset.bytes], { type: previewAsset.mimeType }),
        );

        const frame = document.createElement("iframe");
        frame.src = `${currentPreviewObjectUrl}#toolbar=0&navpanes=0`;
        frame.title = previewAsset.title;
        frame.style.width = "100%";
        frame.style.height = "100%";
        frame.style.border = "0";
        host.innerHTML = "";
        host.appendChild(frame);
        return;
      }

      const book = ePub(previewAsset.bytes);
      const rendition = book.renderTo(host, {
        width: "100%",
        height: "100%",
        flow: "paginated",
        spread: "none",
      });

      currentBookRef = book;
      currentRendition = rendition;

      rendition.on("relocated", (location: any) => {
        if (!activeBook) return;
        const start = location?.start ?? {};
        const progress: BookProgress = {
          bookId: activeBook.id,
          location: start.cfi ?? null,
          href: start.href ?? null,
          progressPercent:
            typeof location?.percentage === "number"
              ? Math.max(0, Math.min(1, location.percentage))
              : 0,
          lastReadAt: Date.now(),
        };
        setBookProgress(progress);
      });

      await book.ready;
      const targetLocation = activeProgress?.location ?? activeProgress?.href ?? undefined;
      await rendition.display(targetLocation);
    } catch (error) {
      disposePreview();
      previewError = error instanceof Error ? error.message : "Could not open this book.";
    } finally {
      previewLoading = false;
    }
  }

  function closePreview() {
    previewing = false;
    previewLoading = false;
    previewError = null;
    disposePreview();
  }

  async function handleRemove() {
    if (!activeBook) return;
    const removed = activeBook;
    closeDetail();
    removeBook(removed.id);

    try {
      await removeBookAssets(removed.assetPath, removed.coverPath);
      addToast({
        kind: "info",
        title: "Removed from Books",
        body: removed.title,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Book files could not be fully removed.";
      addToast({
        kind: "info",
        title: "Removed from Books",
        body: `${removed.title} (${message})`,
      });
    }
  }

  $effect(() => {
    activeBook?.id;
    sectionPage = 1;
    detailsOpen = false;
    coverBroken = false;
    untrack(() => {
      closePreview();
    });
  });

  $effect(() => {
    if (!store.activeBookId) {
      untrack(() => {
        closePreview();
      });
    }
  });

  onDestroy(() => {
    disposePreview();
  });
</script>

{#if activeBook}
  <div class="root">
    <div class="sidebar">
      <button class="back" onclick={closeDetail}>
        <ArrowLeft size={13} weight="light" />
        Back
      </button>

        <div class="cover-wrap">
        <div class="cover-fallback">
          <BookOpen size={40} weight="duotone" />
          <span>{activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase()}</span>
        </div>
        {#if coverSrc && !coverBroken}
          <img
            src={coverSrc}
            alt=""
            class="cover"
            loading="eager"
            draggable="false"
            onerror={() => {
              BookAssetResolver.dropCoverSrc(activeBook.coverPath);
              coverBroken = true;
            }}
          />
        {/if}
      </div>

      <div class="meta">
        <p class="title">{activePresentation?.title ?? activeBook.title}</p>
        <p class="byline">{activePresentation?.authorLabel ?? activeBook.author ?? "Unknown author"}</p>
        <span class="status-badge" class:epub={activeBook.subtype === "epub"} class:pdf={activeBook.subtype === "pdf"}>
          {activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase()}
        </span>
        {#if activePresentation?.description ?? activeBook.description}
          <p class="desc">{activePresentation?.description ?? activeBook.description}</p>
        {/if}
      </div>

      <div class="cta-section">
        <button class="read-btn" onclick={openPreview} disabled={previewLoading}>
          <ArrowsOutCardinal size={12} weight="bold" />
          {previewLoading ? "Opening..." : previewing ? "Reopen preview" : "Open book"}
        </button>
        <div class="actions">
          <button class="library-btn danger" onclick={handleRemove}>
            <X size={13} weight="light" />
            Remove
          </button>
        </div>
      </div>

      {#if showProgress}
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-label">{activePresentation?.progressSummary ?? `${readSectionCount} / ${totalSectionCount} read`}</span>
            <span class="progress-pct">{activePresentation?.readPercentLabel ?? `${Math.round(readPercent * 100)}%`}</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style={`width:${readPercent * 100}%`}></div>
          </div>
        </div>
      {/if}

      <div class="details-section">
        <button class="details-toggle" onclick={() => (detailsOpen = !detailsOpen)}>
          <span>Details</span>
          <CaretDown
            size={11}
            weight="light"
            style={`transform:${detailsOpen ? "rotate(180deg)" : "rotate(0)"};transition:transform 0.15s ease;`}
          />
        </button>
        {#if detailsOpen}
          <div class="details-body">
            <div class="detail-row">
              <span class="detail-key">Type</span>
              <span class="detail-val">{activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase()}</span>
            </div>
            <div class="detail-row">
              <span class="detail-key">Reading sections</span>
              <span class="detail-val">{activePresentation?.sectionCount ?? totalSectionCount}</span>
            </div>
            {#if activeBook.subtype === "epub"}
              <div class="detail-row">
                <span class="detail-key">Spine items</span>
                <span class="detail-val">{activeBook.spineCount ?? activeBook.spine?.length ?? 0}</span>
              </div>
              <div class="detail-row">
                <span class="detail-key">TOC labels</span>
                <span class="detail-val">{activeBook.tocCount ?? activeBook.toc?.length ?? 0}</span>
              </div>
            {/if}
            {#if activeProgress}
              <div class="detail-row">
                <span class="detail-key">Last progress</span>
                <span class="detail-val">{activePresentation?.readPercentLabel ?? `${Math.round(readPercent * 100)}%`}</span>
              </div>
            {/if}
            <div class="detail-file">
              <span class="detail-key">Source file</span>
              <p class="detail-path">{activeBook.importPath}</p>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="list-wrap">
      <div class="list-header">
        <div class="list-header-left">
          <span class="list-label">{previewHeading}</span>
        </div>
        <div class="list-header-right">
          {#if previewing}
            <button class="sort-btn" onclick={closePreview}>Close preview</button>
          {:else if totalSectionPages > 1}
            <div class="pagination">
              <button class="page-btn" onclick={() => goToSectionPage(sectionPage - 1)} disabled={sectionPage === 1}>
                ←
              </button>
              <span class="page-num">{sectionPage} / {totalSectionPages}</span>
              <button class="page-btn" onclick={() => goToSectionPage(sectionPage + 1)} disabled={sectionPage === totalSectionPages}>
                →
              </button>
            </div>
          {/if}
        </div>
      </div>

      {#if previewing}
        {#if previewError}
          <div class="preview-error">{previewError}</div>
        {:else}
          <div class="preview-frame" class:is-loading={previewLoading}>
            <div class="preview-host" bind:this={previewHost}></div>
            {#if previewLoading}
              <div class="preview-loading">Opening {activePresentation?.subtypeLabel ?? activeBook.subtype.toUpperCase()}...</div>
            {/if}
          </div>
        {/if}
      {:else if visibleSections.length}
        <div class="ch-list">
          {#each visibleSections as item, index (item.id)}
            <div class="ch-row" style={`--toc-depth:${item.depth};`}>
              <div class="ch-left">
                <span class="ch-name">{item.label}</span>
                <div class="ch-meta">
                  <span class="ch-meta-item">
                    Section {(sectionPage - 1) * SECTIONS_PER_PAGE + index + 1}
                  </span>
                  {#if item.depth > 0}
                    <span class="ch-meta-item">Depth {item.depth}</span>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {:else if activeBook.subtype === "pdf"}
        <div class="empty-state">
          This PDF has no chapter outline metadata.
        </div>
      {:else}
        <div class="empty-state">
          No readable spine or TOC metadata was found in this EPUB.
        </div>
      {/if}

      {#if !previewing && totalSectionPages > 1}
        <div class="pagination-bottom">
          <button class="page-btn" onclick={() => goToSectionPage(sectionPage - 1)} disabled={sectionPage === 1}>
            ← Prev
          </button>
          <span class="page-num">{sectionPage} / {totalSectionPages}</span>
          <button class="page-btn" onclick={() => goToSectionPage(sectionPage + 1)} disabled={sectionPage === totalSectionPages}>
            Next →
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .root {
    display: flex;
    height: 100%;
    overflow: hidden;
    animation: fadeIn 0.14s ease both;
  }

  .sidebar {
    width: 240px;
    flex-shrink: 0;
    padding: var(--sp-5);
    border-right: 1px solid var(--border-dim);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    background: var(--bg-base);
  }

  .back {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-family: var(--font-ui);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    transition: color var(--t-base);
  }

  .back:hover {
    color: var(--text-secondary);
  }

  .cover-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    flex-shrink: 0;
  }

  .cover {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
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

  .meta {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .title {
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    color: var(--text-primary);
    line-height: var(--leading-snug);
    letter-spacing: var(--tracking-tight);
  }

  .byline {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-family: var(--font-ui);
  }

  .status-badge {
    display: inline-block;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: var(--radius-sm);
    width: fit-content;
  }

  .status-badge.epub {
    background: var(--accent-muted);
    color: var(--accent-fg);
    border: 1px solid var(--accent-dim);
  }

  .status-badge.pdf {
    background: var(--bg-raised);
    color: var(--text-faint);
    border: 1px solid var(--border-dim);
  }

  .desc {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: var(--leading-base);
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .cta-section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .read-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    width: 100%;
    min-height: 34px;
    padding: 0 var(--sp-3);
    border-radius: var(--radius-md);
    background: var(--accent);
    border: 1px solid var(--accent);
    color: var(--accent-contrast, #fff);
    font-size: var(--text-xs);
    font-family: var(--font-ui);
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
    transition: opacity var(--t-base);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    box-sizing: border-box;
  }

  .read-btn:hover {
    opacity: 0.88;
  }

  .actions {
    display: flex;
    align-items: stretch;
    gap: var(--sp-2);
  }

  .library-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    min-height: 32px;
    font-size: var(--text-xs);
    font-family: var(--font-ui);
    letter-spacing: var(--tracking-wide);
    padding: 0 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    background: var(--bg-raised);
    transition: border-color var(--t-base), color var(--t-base), background var(--t-base);
    flex: 1;
    box-sizing: border-box;
  }

  .library-btn:hover {
    border-color: var(--border-strong);
    color: var(--text-secondary);
  }

  .library-btn.danger {
    color: var(--color-error);
  }

  .library-btn.danger:hover {
    background: var(--color-error-bg);
    border-color: var(--color-error);
    color: var(--color-error);
  }

  .progress-section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .progress-label {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
  }

  .progress-pct {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--accent-fg);
    letter-spacing: var(--tracking-wide);
  }

  .progress-track {
    height: 3px;
    background: var(--border-base);
    border-radius: var(--radius-full);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-full);
    transition: width 0.4s ease;
  }

  .details-section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .details-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
    padding: 4px 0;
    transition: color var(--t-base);
  }

  .details-toggle:hover {
    color: var(--text-muted);
  }

  .details-body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding-top: var(--sp-2);
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--sp-2);
  }

  .detail-key {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
  }

  .detail-val {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-secondary);
    letter-spacing: var(--tracking-wide);
    text-align: right;
  }

  .detail-file {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    padding-top: var(--sp-1);
  }

  .detail-path {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    line-height: var(--leading-base);
    word-break: break-all;
  }

  .list-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
    flex-shrink: 0;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .list-header-left,
  .list-header-right {
    display: flex;
    align-items: stretch;
    gap: var(--sp-2);
  }

  .list-label {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }

  .sort-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 32px;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    padding: 0 var(--sp-2);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    color: var(--text-muted);
    background: var(--bg-raised);
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base);
    box-sizing: border-box;
  }

  .sort-btn:hover {
    color: var(--text-secondary);
    border-color: var(--border-strong);
    background: var(--bg-raised);
  }

  .pagination,
  .pagination-bottom {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .pagination-bottom {
    justify-content: center;
    padding: var(--sp-3);
    border-top: 1px solid var(--border-dim);
    flex-shrink: 0;
  }

  .page-btn {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim);
    color: var(--text-faint);
    background: none;
    cursor: pointer;
    transition: color var(--t-base), border-color var(--t-base);
  }

  .page-btn:hover:not(:disabled) {
    color: var(--text-muted);
    border-color: var(--border-strong);
  }

  .page-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .page-num {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
  }

  .ch-list {
    flex: 1;
    overflow-y: auto;
  }

  .ch-row {
    display: flex;
    align-items: center;
    padding: 10px var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
    gap: var(--sp-3);
  }

  .ch-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-left: calc(var(--toc-depth, 0) * 12px);
  }

  .ch-name {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ch-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .ch-meta-item {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
  }

  .empty-state,
  .preview-loading,
  .preview-error {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: var(--text-sm);
    padding: var(--sp-5);
    text-align: center;
  }

  .preview-frame {
    position: relative;
    flex: 1;
    overflow: hidden;
    background: color-mix(in srgb, var(--bg-raised) 92%, white 8%);
  }

  .preview-host {
    position: absolute;
    inset: 0;
  }

  .preview-frame.is-loading .preview-host {
    opacity: 0.35;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (max-width: 980px) {
    .root {
      flex-direction: column;
    }

    .sidebar {
      width: 100%;
      border-right: none;
      border-bottom: 1px solid var(--border-dim);
    }
  }
</style>
