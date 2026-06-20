<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { ArrowsClockwise, ArrowsLeftRight, BookOpen, BookmarkSimple, CaretDown, ChartLineUp, Check, CheckCircle, Circle, DownloadSimple, FolderSimplePlus, Link, List, Play, SortAscending, SortDescending, SquaresFour, X } from "phosphor-svelte";
  import {
    addToast,
    bumpContentSetupVersion,
    setActiveNovelDetail,
    setActiveNovelReader,
    store,
    updateSettings,
  } from "../../store/state.svelte";
  import {
    buildNovelDetailRecordFromLibrary,
    getNovelBookmarkEntries,
    getNovelLastReadChapterId,
    getNovelLibraryChapters,
    getNovelLibraryEntry,
    getNovelReadStats,
    getNovelResumeChapter,
    loadNovelLibraryState,
    peekNovelLibraryState,
    removeNovelFromLibraryState,
    saveNovelLibraryState,
    upsertNovelInLibrary,
  } from "../../lib/novels/libraryState";
  import { loadNovelSourceClassificationState, peekNovelSourceClassificationState, type PersistedNovelSourceClassificationState } from "../../lib/novels/sourceClassificationState";
  import { getNovelMigrationBlocker } from "../../lib/novels/migrationSafe";
  import { readInstalledNovelChapter } from "../../lib/novels/sources";
  import {
    createBooksCategory,
    sortBooksCategories,
    toggleBookCategoryAssignment,
  } from "../../lib/library/domainCategories";
  import NovelMigrateModal from "./NovelMigrateModal.svelte";
  import NovelTrackingPanel from "../shared/NovelTrackingPanel.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import SeriesDetailV3Shell from "../shared/SeriesDetailV3Shell.svelte";

  const CHAPTERS_PER_PAGE = 25;

  const activeDetail = $derived(store.activeNovelDetail);
  let migrateOpen = $state(false);
  let trackingOpen = $state(false);
  let detailsOpen = $state(false);
  let chapterSortDir: "asc" | "desc" = $state("asc");
  let sortMenuOpen = $state(false);
  let viewMode: "list" | "grid" = $state("list");
  let chapterPage = $state(1);
  let folderPickerOpen = $state(false);
  let folderCreating = $state(false);
  let folderNewName = $state("");
  let folderPickerRef: HTMLDivElement | undefined = $state();
  let linkPickerOpen = $state(false);
  let linkSearch = $state("");
  let dlOpen = $state(false);
  let downloadingNovel = $state(false);
  let showRange = $state(false);
  let rangeFrom = $state("");
  let rangeTo = $state("");
  let sourceClassificationState = $state<PersistedNovelSourceClassificationState>(peekNovelSourceClassificationState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));
  const scopeInput = $derived({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  });
  let libraryState = $state(peekNovelLibraryState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));
  const displayedNovel = $derived.by(() => {
    if (!activeDetail) return null;
    if (!activeDetail.inLibrary) return activeDetail.novel;
    const entry = getNovelLibraryEntry(libraryState, activeDetail.novel.id);
    if (!entry) return activeDetail.novel;
    return buildNovelDetailRecordFromLibrary(entry, getNovelLibraryChapters(libraryState, activeDetail.novel.id));
  });
  const readStats = $derived.by(() => activeDetail ? getNovelReadStats(libraryState, activeDetail.novel.id) : null);
  const resumeChapter = $derived.by(() => {
    if (!activeDetail) return null;
    if (activeDetail.inLibrary) {
      return getNovelResumeChapter(libraryState, activeDetail.novel.id);
    }
    return activeDetail.novel.chapters.find((chapter) => chapter.unread) ?? activeDetail.novel.chapters[0] ?? null;
  });
  const lastReadChapterId = $derived.by(() => activeDetail ? getNovelLastReadChapterId(libraryState, activeDetail.novel.id) : null);
  const bookmarkedChapterIds = $derived.by(() => {
    if (!activeDetail) return new Set<string>();
    return new Set(
      getNovelBookmarkEntries(libraryState, activeDetail.novel.id)
        .map((entry) => entry.chapterId)
        .filter((entry): entry is string => Boolean(entry)),
    );
  });
  const migrationBlocker = $derived(activeDetail ? getNovelMigrationBlocker(activeDetail.novel.sourceId, sourceClassificationState) : null);
  const sortedNovelChapters = $derived.by(() => {
    const chapters = displayedNovel?.chapters ?? [];
    return [...chapters].sort((left, right) => chapterSortDir === "asc" ? left.order - right.order : right.order - left.order);
  });
  const totalPages = $derived(Math.max(1, Math.ceil(sortedNovelChapters.length / CHAPTERS_PER_PAGE)));
  const pageChapters = $derived(sortedNovelChapters.slice((chapterPage - 1) * CHAPTERS_PER_PAGE, chapterPage * CHAPTERS_PER_PAGE));
  const novelCounts = $derived.by(() => {
    const chapters = displayedNovel?.chapters ?? [];
    const summaryTotal = displayedNovel?.chapterCount ?? activeDetail?.novel.chapterCount ?? 0;
    const total = chapters.length > 0 ? chapters.length : summaryTotal;
    const unread = chapters.length > 0 ? chapters.filter((chapter) => chapter.unread).length : total;
    const read = Math.max(0, total - unread);
    return {
      total,
      unread,
      read,
      progressPercent: total > 0 ? read / total : 0,
    };
  });
  const sourceName = $derived(activeDetail?.novel.source.sourceName ?? activeDetail?.novel.source.pluginName ?? null);
  const allBookCategories = $derived(sortBooksCategories(store.settings.booksCategories ?? []));
  const assignedNovelCategoryIds = $derived(activeDetail ? store.settings.booksCategoryAssignments[activeDetail.novel.id] ?? [] : []);
  const hasFolders = $derived(assignedNovelCategoryIds.length > 0);
  const linkedNovelIds = $derived(activeDetail ? store.settings.novelLinks?.[activeDetail.novel.id] ?? [] : []);
  const linkPickerResults = $derived.by(() => {
    if (!activeDetail) return [];
    const query = linkSearch.trim().toLowerCase();
    const candidates = libraryState.entries
      .filter((entry) => entry.id !== activeDetail.novel.id)
      .filter((entry) => !query || entry.title.toLowerCase().includes(query) || (entry.author ?? "").toLowerCase().includes(query));
    const linked = candidates.filter((entry) => linkedNovelIds.includes(entry.id));
    const rest = candidates.filter((entry) => !linkedNovelIds.includes(entry.id)).slice(0, 40);
    return [...linked, ...rest];
  });

  async function addToLibrary() {
    if (!activeDetail) return;
    const state = await loadNovelLibraryState(scopeInput);
    libraryState = await saveNovelLibraryState(upsertNovelInLibrary(state, activeDetail.novel), scopeInput);
    bumpContentSetupVersion();
    updateSettings({
      booksLibraryUi: {
        ...store.settings.booksLibraryUi,
        activeCategoryId: null,
        typeFilter: "all",
        search: "",
      },
    });
    setActiveNovelDetail({
      ...activeDetail,
      inLibrary: true,
    });
    addToast({
      kind: "success",
      title: "Novel added to Library",
      body: activeDetail.novel.title,
    });
  }

  async function removeFromLibrary() {
    if (!activeDetail) return;
    const state = await loadNovelLibraryState(scopeInput);
    libraryState = await saveNovelLibraryState(removeNovelFromLibraryState(state, activeDetail.novel.id), scopeInput);
    bumpContentSetupVersion();
    setActiveNovelDetail({
      ...activeDetail,
      inLibrary: false,
    });
    addToast({
      kind: "info",
      title: "Novel removed from Library",
      body: activeDetail.novel.title,
    });
  }

  function openChapter(chapterId: string, chapterPath: string, chapterTitle: string) {
    if (!activeDetail) return;
    setActiveNovelReader({
      novelId: activeDetail.novel.id,
      chapterId,
      chapterPath,
      chapterTitle,
      sourceId: activeDetail.novel.sourceId,
    });
  }

  function formatDate(ts: number | null | undefined): string {
    if (!ts) return "";
    const d = new Date(ts > 1e10 ? ts : ts * 1000);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function chapterNumberLabel(order: number): string {
    return `Chapter ${order + 1}`;
  }

  function chapterTitle(chapter: { title: string; order: number }): string {
    return chapter.title?.trim() || chapterNumberLabel(chapter.order);
  }

  function shouldShowChapterNumber(chapter: { title: string; order: number }): boolean {
    return chapterTitle(chapter).trim().toLowerCase() !== chapterNumberLabel(chapter.order).toLowerCase();
  }

  function chapterPrimaryLabel(chapter: { title: string; order: number }): string {
    return shouldShowChapterNumber(chapter) ? chapterNumberLabel(chapter.order) : chapterTitle(chapter);
  }

  function chapterSecondaryLabel(chapter: { title: string; order: number }): string {
    return shouldShowChapterNumber(chapter) ? chapterTitle(chapter) : "";
  }

  function closeFolderPicker() {
    folderPickerOpen = false;
    folderCreating = false;
    folderNewName = "";
  }

  function handleFolderOutside(event: MouseEvent) {
    if (folderPickerRef && !folderPickerRef.contains(event.target as Node)) {
      closeFolderPicker();
    }
  }

  function toggleNovelFolder(categoryId: string) {
    if (!activeDetail) return;
    updateSettings({
      booksCategoryAssignments: toggleBookCategoryAssignment(
        store.settings.booksCategoryAssignments,
        activeDetail.novel.id,
        categoryId,
      ),
    });
  }

  function createFolder() {
    if (!activeDetail) return;
    const name = folderNewName.trim();
    if (!name) return;
    const category = createBooksCategory(allBookCategories, name);
    updateSettings({
      booksCategories: sortBooksCategories([...allBookCategories, category]),
      booksCategoryAssignments: toggleBookCategoryAssignment(
        store.settings.booksCategoryAssignments,
        activeDetail.novel.id,
        category.id,
      ),
    });
    folderNewName = "";
    folderCreating = false;
  }

  async function openLinkPicker() {
    libraryState = await loadNovelLibraryState(scopeInput);
    linkSearch = "";
    linkPickerOpen = true;
  }

  function closeLinkPicker() {
    linkPickerOpen = false;
    linkSearch = "";
  }

  function toggleNovelLink(otherNovelId: string) {
    if (!activeDetail) return;
    const currentId = activeDetail.novel.id;
    const links = { ...(store.settings.novelLinks ?? {}) };
    const currentLinks = new Set(links[currentId] ?? []);
    const otherLinks = new Set(links[otherNovelId] ?? []);

    if (currentLinks.has(otherNovelId)) {
      currentLinks.delete(otherNovelId);
      otherLinks.delete(currentId);
    } else {
      currentLinks.add(otherNovelId);
      otherLinks.add(currentId);
    }

    const nextLinks: Record<string, string[]> = { ...links };
    if (currentLinks.size) nextLinks[currentId] = [...currentLinks];
    else delete nextLinks[currentId];
    if (otherLinks.size) nextLinks[otherNovelId] = [...otherLinks];
    else delete nextLinks[otherNovelId];

    updateSettings({ novelLinks: nextLinks });
  }

  function sanitizeFilename(input: string): string {
    return input
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ")
      .slice(0, 80) || "novel";
  }

  function encodeBase64Utf8(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function escapeHtml(input: string): string {
    return input.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[char] ?? char));
  }

  async function exportNovelChapterBatch(chaptersToExport: typeof sortedNovelChapters, label: string) {
    if (!activeDetail || !displayedNovel || downloadingNovel) return;
    if (chaptersToExport.length === 0) {
      addToast({ kind: "info", title: "No chapters to download", body: displayedNovel.title });
      return;
    }

    downloadingNovel = true;
    dlOpen = false;
    try {
      const parts: string[] = [];
      for (const chapter of chaptersToExport) {
        const result = await readInstalledNovelChapter(scopeInput, activeDetail.novel.sourceId, chapter.path);
        parts.push(`<section class="chapter"><h2>${escapeHtml(chapterPrimaryLabel(chapter))}</h2>${chapterSecondaryLabel(chapter) ? `<p class="subtitle">${escapeHtml(chapterSecondaryLabel(chapter))}</p>` : ""}<div class="content">${result.content}</div></section>`);
      }

      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(displayedNovel.title)}</title><style>body{margin:0;background:#111;color:#e8e4eb;font-family:Georgia,serif;line-height:1.7}.wrap{max-width:860px;margin:0 auto;padding:48px 28px}h1{font-family:Inter,Arial,sans-serif}h2{margin-top:42px;color:#d3c4ff}.subtitle{color:#9f98ad}.chapter{border-top:1px solid #2c2933}.content img{max-width:100%;height:auto}</style></head><body><main class="wrap"><h1>${escapeHtml(displayedNovel.title)}</h1>${parts.join("\n")}</main></body></html>`;
      const { downloadDir, join } = await import("@tauri-apps/api/path");
      const fileName = `${sanitizeFilename(displayedNovel.title)}-${sanitizeFilename(label).toLowerCase()}-${Date.now()}.html`;
      const targetPath = await join(await downloadDir(), fileName);
      await invoke("write_file_base64", { path: targetPath, bytesBase64: encodeBase64Utf8(html) });
      addToast({ kind: "success", title: "Novel downloaded", body: fileName, duration: 4500 });
    } catch (error) {
      addToast({
        kind: "error",
        title: "Novel download failed",
        body: error instanceof Error ? error.message : "Aethon could not export this novel.",
      });
    } finally {
      downloadingNovel = false;
    }
  }

  function chaptersFromResume(count: number) {
    const startChapter = resumeChapter ?? sortedNovelChapters[0] ?? null;
    const startIndex = startChapter ? sortedNovelChapters.findIndex((chapter) => chapter.id === startChapter.id) : 0;
    return sortedNovelChapters.slice(Math.max(0, startIndex), Math.max(0, startIndex) + count);
  }

  function downloadNext(count: number) {
    void exportNovelChapterBatch(chaptersFromResume(count), `next-${count}`);
  }

  function downloadUnread() {
    void exportNovelChapterBatch(sortedNovelChapters.filter((chapter) => chapter.unread), "unread");
  }

  function downloadAll() {
    void exportNovelChapterBatch(sortedNovelChapters, "all");
  }

  function downloadRange() {
    const from = Number(rangeFrom.trim());
    const to = Number(rangeTo.trim());
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const selected = sortedNovelChapters.filter((chapter) => {
      const number = chapter.order + 1;
      return number >= lo && number <= hi;
    });
    void exportNovelChapterBatch(selected, `ch-${lo}-${hi}`);
    rangeFrom = "";
    rangeTo = "";
    showRange = false;
  }

  function setSortDir(next: "asc" | "desc") {
    chapterSortDir = next;
    chapterPage = 1;
    sortMenuOpen = false;
  }

  $effect(() => {
    void Promise.all([
      loadNovelSourceClassificationState(scopeInput),
      loadNovelLibraryState(scopeInput),
    ]).then(([classificationState, nextLibraryState]) => {
      sourceClassificationState = classificationState;
      libraryState = nextLibraryState;
    });
  });

  $effect(() => {
    if (chapterPage > totalPages) chapterPage = totalPages;
    if (chapterPage < 1) chapterPage = 1;
  });

  $effect(() => {
    if (!folderPickerOpen) return;
    setTimeout(() => document.addEventListener("mousedown", handleFolderOutside, true), 0);
    return () => document.removeEventListener("mousedown", handleFolderOutside, true);
  });
</script>

{#if activeDetail}
  <SeriesDetailV3Shell
    mediaKind="novel"
    title={displayedNovel?.title ?? activeDetail.novel.title}
    subtitle={displayedNovel?.author ?? null}
    coverUrl={displayedNovel?.coverUrl ?? null}
    fallbackLabel="Novel"
    statusLabel={displayedNovel?.status ?? null}
    sourceLabel={sourceName}
    sourceLine={sourceName ? `Novel - ${sourceName}` : null}
    languageLabel={activeDetail.novel.source.lang ? activeDetail.novel.source.lang.toUpperCase() : null}
    description={displayedNovel?.description ?? null}
    tags={displayedNovel?.tags ?? []}
    detailsOpen={detailsOpen}
    progressLabel={novelCounts.total > 0 ? `${novelCounts.read} / ${novelCounts.total} chapters read` : null}
    progressPercent={(readStats && activeDetail.inLibrary ? readStats.progressPercent : novelCounts.progressPercent) * 100}
    metrics={[
      { label: "Chapters", value: String(novelCounts.total) },
      { label: "Unread", value: String(novelCounts.unread) },
      { label: "Bookmarks", value: String(bookmarkedChapterIds.size) },
    ]}
    onBack={() => setActiveNovelDetail(null)}
    onDetailsToggle={() => detailsOpen = !detailsOpen}
  >
    {#snippet primaryAction()}
      <button class="series-primary" disabled={!resumeChapter} onclick={() => resumeChapter && openChapter(resumeChapter.id, resumeChapter.path, resumeChapter.title)}>
        <Play size={13} weight="fill" />
        {resumeChapter ? (lastReadChapterId ? `Continue Ch.${resumeChapter.order + 1}` : "Start reading") : "No chapters"}
      </button>
    {/snippet}

    {#snippet secondaryActions()}
      <button class="series-action series-icon-action" class:active={activeDetail.inLibrary} onclick={activeDetail.inLibrary ? removeFromLibrary : addToLibrary} title={activeDetail.inLibrary ? "In Library" : "Add to Library"} aria-label={activeDetail.inLibrary ? "In Library" : "Add to Library"}>
        <BookmarkSimple size={13} weight={activeDetail.inLibrary ? "fill" : "light"} />
      </button>
      <button class="series-action series-icon-action" type="button" onclick={() => trackingOpen = true} title="Tracking" aria-label="Tracking">
        <ChartLineUp size={13} weight="light" />
      </button>
    {/snippet}

    {#snippet utilityActions()}
      <div class="fp-wrap" bind:this={folderPickerRef}>
        <button class="series-utility" class:active={hasFolders} type="button" onclick={() => folderPickerOpen = !folderPickerOpen} title="Folders">
          <FolderSimplePlus size={13} weight={hasFolders ? "fill" : "light"} />
          Folder
        </button>
        {#if folderPickerOpen}
          <div class="fp-menu">
            {#if allBookCategories.length === 0 && !folderCreating}
              <NocturneState layout="compact" tone="info" icon="folder" eyebrow="Folders" title="No folders yet" body="Create a folder in Settings to organize this novel." />
            {/if}
            {#each allBookCategories as category}
              <button class="fp-item" class:fp-item-active={assignedNovelCategoryIds.includes(category.id)} type="button" onclick={() => toggleNovelFolder(category.id)}>
                <span>{category.name}</span>
                {#if assignedNovelCategoryIds.includes(category.id)}
                  <Check size={12} weight="bold" class="fp-check" />
                {/if}
              </button>
            {/each}
            <div class="fp-div"></div>
            {#if folderCreating}
              <div class="fp-create">
                <input class="fp-input" placeholder="Folder name..." bind:value={folderNewName} onkeydown={(event) => { if (event.key === "Enter") createFolder(); if (event.key === "Escape") closeFolderPicker(); }} />
                <button class="fp-confirm" type="button" onclick={createFolder} disabled={!folderNewName.trim()}>Add</button>
                <button class="fp-cancel" type="button" onclick={() => { folderCreating = false; folderNewName = ""; }} aria-label="Cancel folder creation">
                  <X size={12} weight="light" />
                </button>
              </div>
            {:else}
              <button class="fp-new" type="button" onclick={() => folderCreating = true}>+ New folder</button>
            {/if}
          </div>
        {/if}
      </div>
      <button class="series-utility" class:active={linkedNovelIds.length > 0} type="button" onclick={openLinkPicker} title="Link as same novel">
        <Link size={13} weight={linkedNovelIds.length > 0 ? "fill" : "light"} />
        Link{linkedNovelIds.length > 0 ? ` (${linkedNovelIds.length})` : ""}
      </button>
      <div class="dl-wrap">
        <button class="series-utility dl-unified-btn" class:active={dlOpen || downloadingNovel} class:dl-downloading={downloadingNovel} type="button" onclick={() => dlOpen = !dlOpen} title="Download options">
          <DownloadSimple size={13} weight={downloadingNovel ? "fill" : "light"} />
          Download
          <span class="dl-unified-count" class:dl-unified-count-empty={!downloadingNovel}>{downloadingNovel ? 1 : 0}</span>
        </button>
        {#if dlOpen}
          <div class="dl-dropdown">
            <div class="dl-pop-head">
              <div>
                <span class="dl-kicker">Downloads</span>
                <strong>0 / {novelCounts.total}</strong>
              </div>
              <span class="dl-state-label">{downloadingNovel ? "Working" : "Ready"}</span>
            </div>
            {#if resumeChapter}
              <div class="dl-section">
                <p class="dl-section-label">From Ch.{resumeChapter.order + 1}</p>
                <div class="dl-next-row">
                  {#each [5, 10, 25] as amount}
                    {@const available = chaptersFromResume(amount).length}
                    <button class="dl-next-btn" type="button" disabled={available === 0 || downloadingNovel} onclick={() => downloadNext(amount)}>
                      <span>Next {amount}</span>
                      <span class="dl-next-sub">{available} new</span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
            <div class="dl-section dl-section-compact">
              {#if !showRange}
                <button class="dl-item dl-range-trigger" type="button" onclick={() => showRange = true}>
                  <span>Custom range</span>
                  <span class="dl-item-sub">Choose chapters</span>
                </button>
              {:else}
                <div class="dl-range-row">
                  <button class="dl-range-back" type="button" onclick={() => showRange = false} aria-label="Close custom range">&lt;</button>
                  <input class="dl-range-input" placeholder="From" bind:value={rangeFrom} onkeydown={(event) => event.key === "Enter" && downloadRange()} />
                  <span class="dl-range-sep">-</span>
                  <input class="dl-range-input" placeholder="To" bind:value={rangeTo} onkeydown={(event) => event.key === "Enter" && downloadRange()} />
                  <button class="dl-range-go" type="button" disabled={!rangeFrom.trim() || !rangeTo.trim() || downloadingNovel} onclick={downloadRange}>Go</button>
                </div>
              {/if}
            </div>
            <div class="dl-section dl-actions">
              <button class="dl-item" type="button" onclick={downloadUnread} disabled={novelCounts.unread === 0 || downloadingNovel}>
                <span>Unread chapters</span>
                <span class="dl-item-sub">{novelCounts.unread} remaining</span>
              </button>
              <button class="dl-item dl-item-primary" type="button" onclick={downloadAll} disabled={novelCounts.total === 0 || downloadingNovel}>
                <span>Download all</span>
                <span class="dl-item-sub">{novelCounts.total} not downloaded</span>
              </button>
            </div>
            <div class="dl-section dl-danger-zone dl-danger-zone-empty">
              <button class="dl-item dl-item-danger" type="button" disabled>
                <span>Delete all downloads</span>
                <span class="dl-item-sub">0 downloaded</span>
              </button>
            </div>
          </div>
        {/if}
      </div>
      <button class="series-utility" disabled={!activeDetail.inLibrary || Boolean(migrationBlocker)} title={migrationBlocker ?? "Migrate this novel to another source"} aria-label="Migrate this novel to another source" onclick={() => migrateOpen = true}>
        <ArrowsLeftRight size={15} weight="light" />
        Migrate
      </button>
    {/snippet}

    {#snippet detailsExtra()}
      <div class="v3-details-stack">
        {#if sourceName}<div class="detail-row"><span class="detail-key">Source</span><span class="detail-val">{sourceName}</span></div>{/if}
        {#if displayedNovel?.status}<div class="detail-row"><span class="detail-key">Status</span><span class="detail-val">{displayedNovel.status}</span></div>{/if}
        {#if displayedNovel?.author}<div class="detail-row"><span class="detail-key">Author</span><span class="detail-val">{displayedNovel.author}</span></div>{/if}
        {#if activeDetail.novel.source.lang}<div class="detail-row"><span class="detail-key">Language</span><span class="detail-val">{activeDetail.novel.source.lang.toUpperCase()}</span></div>{/if}
        {#if activeDetail.inLibrary && lastReadChapterId}<div class="detail-row"><span class="detail-key">Resume</span><span class="detail-val">Last saved chapter available</span></div>{/if}
      </div>
    {/snippet}

    {#snippet chapterControls()}
      <div class="list-header-left">
        <div class="sort-wrap">
          <button class="series-toolbar-btn" type="button" onclick={() => sortMenuOpen = !sortMenuOpen}>
            {#if chapterSortDir === "desc"}<SortDescending size={14} weight="light" />{:else}<SortAscending size={14} weight="light" />{/if}
            Sort
            <CaretDown size={10} weight="light" />
          </button>
          {#if sortMenuOpen}
            <div class="sort-menu" role="presentation" onmouseleave={() => sortMenuOpen = false}>
              <p class="sort-section-label">Chapter order</p>
              <button class="sort-option" class:active={chapterSortDir === "desc"} onclick={() => setSortDir("desc")}>Descending</button>
              <button class="sort-option" class:active={chapterSortDir === "asc"} onclick={() => setSortDir("asc")}>Ascending</button>
            </div>
          {/if}
        </div>
      </div>
      <div class="list-header-right">
        <div class="view-segmented" aria-label="Chapter view">
          <button class="series-icon" class:active={viewMode === "list"} onclick={() => viewMode = "list"} title="List view"><List size={14} weight="light" /></button>
          <button class="series-icon" class:active={viewMode === "grid"} onclick={() => viewMode = "grid"} title="Grid view"><SquaresFour size={14} weight="light" /></button>
        </div>
      </div>
    {/snippet}

    {#snippet chapterList()}
      {#if !displayedNovel || displayedNovel.chapters.length === 0}
        <NocturneState layout="compact" tone="info" icon="books" eyebrow="Chapters" title="No chapter metadata" body="This source did not expose chapter metadata for this novel." />
      {:else}
        <div class={viewMode === "grid" ? "ch-grid v3-ch-grid" : "ch-list v3-ch-list"}>
          {#if viewMode === "grid"}
            {#each sortedNovelChapters as chapter (chapter.id)}
              {@const isCurrent = chapter.id === lastReadChapterId}
              {@const isBookmarked = bookmarkedChapterIds.has(chapter.id)}
              <button class="grid-cell novel-grid-cell" class:read={!chapter.unread} class:in-progress={isCurrent} onclick={() => openChapter(chapter.id, chapter.path, chapter.title)} title={chapterTitle(chapter)}>
                <span class="grid-cell-title">{chapterPrimaryLabel(chapter)}</span>
                {#if chapterSecondaryLabel(chapter)}<span class="grid-cell-sub">{chapterSecondaryLabel(chapter)}</span>{/if}
                <span class="chapter-progress"><span class="chapter-progress__fill" style={`width: ${chapter.unread ? 0 : 100}%`}></span></span>
                {#if isCurrent}<span class="grid-cell-dl novel-current-dot" title="Current"></span>{/if}
                {#if isBookmarked}<span class="grid-cell-dot" title="Bookmarked"></span>{/if}
              </button>
            {/each}
          {:else}
            <div class="chapter-table-header">
              <span>Chapter</span>
              <span>Source</span>
              <span>Date</span>
              <span>Status</span>
            </div>
            {#each pageChapters as chapter (chapter.id)}
              {@const isCurrent = chapter.id === lastReadChapterId}
              {@const isBookmarked = bookmarkedChapterIds.has(chapter.id)}
              <button class="ch-row v3-ch-row" class:read={!chapter.unread} onclick={() => openChapter(chapter.id, chapter.path, chapter.title)}>
                <div class="ch-left">
                  <span class="ch-name">{chapterPrimaryLabel(chapter)}</span>
                  <div class="ch-meta">
                    {#if chapterSecondaryLabel(chapter)}<span class="ch-meta-item">{chapterSecondaryLabel(chapter)}</span>{/if}
                    {#if isCurrent}<span class="ch-meta-item current">Current</span>{/if}
                    {#if isBookmarked}<span class="ch-meta-item bookmarked">Bookmarked</span>{/if}
                    {#if chapter.unread}<span class="ch-meta-item unread">Unread</span>{/if}
                  </div>
                  <div class="chapter-progress"><div class="chapter-progress__fill" style={`width: ${chapter.unread ? 0 : 100}%`}></div></div>
                </div>
                <span class="ch-provider">{sourceName ?? ""}</span>
                <span class="ch-date">{formatDate(chapter.releaseTime)}</span>
                <div class="ch-status">
                  <span class="ch-status-read"></span>
                  <span class="ch-status-main">
                    {#if isCurrent}
                      <BookOpen size={14} weight="fill" class="read-icon" title="Current" />
                    {:else if isBookmarked}
                      <BookmarkSimple size={14} weight="fill" class="read-icon" title="Bookmarked" />
                    {:else if !chapter.unread}
                      <CheckCircle size={14} weight="fill" class="read-icon" title="Read" />
                    {:else if chapter.unread}
                      <Circle size={14} weight="regular" class="unread-icon" title="Unread" />
                    {/if}
                  </span>
                  <span class="ch-status-action"></span>
                </div>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    {/snippet}

    {#snippet chapterFooter()}
      {#if displayedNovel && displayedNovel.chapters.length > 0 && viewMode === "list" && totalPages >= 1}
        <div class="pagination-bottom v3-pagination">
          <button class="series-page-btn" onclick={() => chapterPage = Math.max(1, chapterPage - 1)} disabled={chapterPage === 1}>Prev</button>
          <span class="page-num">{chapterPage} / {totalPages}</span>
          <button class="series-page-btn" onclick={() => chapterPage = Math.min(totalPages, chapterPage + 1)} disabled={chapterPage === totalPages}>Next</button>
        </div>
      {/if}
    {/snippet}
  </SeriesDetailV3Shell>
{/if}

{#if trackingOpen && activeDetail}
  <NovelTrackingPanel
    title={activeDetail.novel.title}
    sourceNovelId={activeDetail.novel.id}
    contentLabel="Novel"
    onClose={() => trackingOpen = false}
  />
{/if}

{#if linkPickerOpen && activeDetail}
  <div class="link-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) closeLinkPicker(); }}>
    <div class="link-modal" role="dialog" aria-modal="true" aria-label="Link novels">
      <div class="link-header">
        <div>
          <span class="link-title">Link as same novel</span>
          <p class="link-subtitle">{activeDetail.novel.title}</p>
        </div>
        <button class="link-close" type="button" onclick={closeLinkPicker} aria-label="Close link picker">
          <X size={14} weight="light" />
        </button>
      </div>
      <div class="link-search-wrap">
        <input class="link-search" placeholder="Search your novel library..." bind:value={linkSearch} />
      </div>
      <div class="link-list">
        {#if linkPickerResults.length === 0}
          <NocturneState layout="compact" tone="info" icon="search" eyebrow="Links" title="No novels to link" body="Add another novel to your library before linking duplicates." />
        {:else}
          {#each linkPickerResults as novel (novel.id)}
            {@const isLinked = linkedNovelIds.includes(novel.id)}
            <button class="link-row" class:link-row-linked={isLinked} type="button" onclick={() => toggleNovelLink(novel.id)}>
              {#if novel.coverUrl}<img class="link-thumb" src={novel.coverUrl} alt="" />{:else}<span class="link-thumb link-thumb-empty">N</span>{/if}
              <span class="link-info">
                <span class="link-novel-title">{novel.title}</span>
                <span class="link-source">{novel.source?.sourceName ?? novel.source?.pluginName ?? novel.author ?? "Novel"}</span>
              </span>
              <span class="link-status">{isLinked ? "Linked" : "Link"}</span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .novel-current-dot {
    width: 5px;
    height: 5px;
    border-radius: 999px;
    background: #d3c4ff;
  }

  .dl-wrap {
    position: relative;
  }

  .dl-dropdown {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 80;
    right: 0;
    top: calc(100% + 12px);
    width: min(360px, calc(100vw - 42px));
    padding: 10px;
    color: #e5e2e1;
    border: 1px solid rgba(92, 88, 103, 0.54);
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(23, 22, 29, 0.98), rgba(17, 17, 22, 0.99));
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
  }

  .dl-pop-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 42px;
    padding: 2px 2px 9px;
    border-bottom: 1px solid rgba(202, 196, 208, 0.075);
    background: transparent;
  }

  .dl-pop-head > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
  }

  .dl-pop-head strong {
    color: #e8e4eb;
    font: 800 15px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
  }

  .dl-kicker,
  .dl-state-label {
    color: rgba(202, 196, 208, 0.46);
    font: 800 9px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .dl-state-label {
    flex: 0 0 auto;
    width: 76px;
    padding: 5px 9px;
    border: 1px solid rgba(201, 181, 255, 0.18);
    border-radius: 999px;
    background: rgba(13, 13, 16, 0.28);
    color: rgba(216, 203, 255, 0.78);
    text-align: center;
    white-space: nowrap;
  }

  .dl-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 9px 0 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .dl-section-compact {
    padding-top: 9px;
    border-top: 1px solid rgba(202, 196, 208, 0.055);
  }

  .dl-actions {
    gap: 4px;
    border-top: 1px solid rgba(202, 196, 208, 0.055);
  }

  .dl-danger-zone {
    border-top: 1px solid rgba(240, 143, 155, 0.095);
  }

  .dl-danger-zone-empty {
    border-top-color: rgba(202, 196, 208, 0.045);
  }

  .dl-item,
  .dl-next-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 34px;
    width: 100%;
    padding: 0 10px;
    border: 0;
    border-radius: 10px;
    color: rgba(202, 196, 208, 0.72);
    background: transparent;
    font: 700 11px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.03em;
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease, transform 140ms ease;
  }

  .dl-item:hover,
  .dl-next-btn:hover:not(:disabled) {
    color: #e8e4eb;
    background: rgba(201, 181, 255, 0.12);
  }

  .dl-item:active,
  .dl-next-btn:active:not(:disabled) {
    transform: scale(0.985);
  }

  .dl-item:disabled,
  .dl-next-btn:disabled {
    opacity: 0.38;
    cursor: default;
  }

  .dl-section-label,
  .dl-item-sub,
  .dl-next-sub {
    margin: 5px 8px;
    color: rgba(202, 196, 208, 0.44);
    font: 800 9px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .dl-section-label {
    margin: 0 2px 3px;
  }

  .dl-next-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    align-items: center;
    gap: 6px;
    padding: 0;
  }

  .dl-next-btn {
    min-height: 46px;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 4px;
    padding: 0 10px;
    border: 1px solid rgba(92, 88, 103, 0.26);
    background: rgba(13, 13, 16, 0.18);
  }

  .dl-next-sub {
    margin: 0;
    color: rgba(202, 196, 208, 0.42);
    font-size: 8px;
  }

  .dl-item {
    min-height: 36px;
    padding: 0 8px;
  }

  .dl-item-sub {
    margin: 0;
    flex: 0 0 auto;
    color: rgba(202, 196, 208, 0.42);
    font-size: 8px;
  }

  .dl-range-trigger {
    border: 1px solid transparent;
  }

  .dl-item-primary {
    color: #d8cbff;
  }

  .dl-item-primary .dl-item-sub {
    color: rgba(216, 203, 255, 0.54);
  }

  .dl-range-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px;
    border-radius: 11px;
    background: rgba(13, 13, 16, 0.2);
  }

  .dl-range-input {
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    border: 1px solid rgba(92, 88, 103, 0.42);
    border-radius: 10px;
    color: #e5e2e1;
    background: rgba(13, 13, 16, 0.92);
    font-size: 11px;
    outline: none;
  }

  .dl-range-input:focus {
    border-color: rgba(201, 181, 255, 0.45);
    box-shadow: 0 0 0 3px rgba(201, 181, 255, 0.08);
  }

  .dl-range-sep {
    color: rgba(202, 196, 208, 0.36);
    font-size: 12px;
    font-weight: 800;
  }

  .dl-range-back,
  .dl-range-go {
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid rgba(92, 88, 103, 0.42);
    border-radius: 10px;
    color: rgba(202, 196, 208, 0.76);
    background: rgba(25, 24, 29, 0.92);
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease, transform 140ms ease;
  }

  .dl-range-back:hover,
  .dl-range-go:hover:not(:disabled) {
    color: #e8e4eb;
    background: rgba(201, 181, 255, 0.12);
  }

  .dl-range-back:active,
  .dl-range-go:active:not(:disabled) {
    transform: scale(0.97);
  }

  .dl-range-go:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .dl-unified-btn {
    min-width: 0;
  }

  .dl-unified-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.22);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
  }

  .dl-unified-count-empty {
    display: none;
  }

  .dl-item-danger {
    color: #ffb3b3;
    border: 1px solid transparent;
    background: transparent;
  }

  .dl-item-danger:disabled {
    color: rgba(202, 196, 208, 0.34);
    cursor: default;
  }

  .dl-item-danger:disabled .dl-item-sub {
    color: rgba(202, 196, 208, 0.28);
  }

  .link-backdrop {
    position: fixed;
    z-index: 90;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(3, 3, 5, 0.74);
    backdrop-filter: blur(7px);
  }

  .link-modal {
    width: min(580px, calc(100vw - 48px));
    max-height: min(680px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(92, 88, 103, 0.54);
    border-radius: 17px;
    background: linear-gradient(180deg, rgba(22, 21, 28, 0.98), rgba(15, 15, 20, 0.98));
    box-shadow: 0 26px 90px rgba(0, 0, 0, 0.55);
  }

  .link-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 16px 18px;
    border-bottom: 1px solid rgba(92, 88, 103, 0.35);
  }

  .link-title,
  .link-novel-title {
    color: #e8e4eb;
    font-size: 13px;
    font-weight: 800;
  }

  .link-subtitle {
    margin: 4px 0 0;
    color: rgba(202, 196, 208, 0.55);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .link-close {
    width: 34px;
    height: 34px;
    border: 1px solid rgba(92, 88, 103, 0.52);
    border-radius: 11px;
    color: rgba(202, 196, 208, 0.76);
    background: rgba(255, 255, 255, 0.025);
    transition: background 150ms ease, color 150ms ease, transform 150ms ease;
  }

  .link-close:hover {
    color: #f1edf5;
    background: rgba(201, 181, 255, 0.1);
  }

  .link-close:active {
    transform: scale(0.96);
  }

  .link-search-wrap {
    padding: 14px 16px;
  }

  .link-search {
    width: 100%;
    height: 40px;
    padding: 0 13px;
    border: 1px solid rgba(92, 88, 103, 0.5);
    border-radius: 12px;
    color: #e8e4eb;
    background: rgba(8, 8, 12, 0.72);
    outline: none;
  }

  .link-search:focus {
    border-color: rgba(201, 181, 255, 0.45);
    box-shadow: 0 0 0 3px rgba(201, 181, 255, 0.08);
  }

  .link-list {
    min-height: 0;
    overflow: auto;
    padding: 0 10px 12px;
  }

  .link-row {
    width: 100%;
    min-height: 62px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border: 1px solid transparent;
    border-radius: 13px;
    color: #e5e2e1;
    background: transparent;
    text-align: left;
    transition: background 150ms ease, border-color 150ms ease, transform 150ms ease;
  }

  .link-row:hover,
  .link-row-linked {
    background: rgba(201, 181, 255, 0.11);
  }

  .link-row:hover {
    border-color: rgba(201, 181, 255, 0.17);
  }

  .link-row:active {
    transform: scale(0.995);
  }

  .link-thumb {
    width: 36px;
    height: 50px;
    flex: 0 0 auto;
    border-radius: 7px;
    object-fit: cover;
    background: rgba(201, 181, 255, 0.12);
  }

  .link-thumb-empty {
    display: grid;
    place-items: center;
    color: #d3c4ff;
    font-weight: 900;
  }

  .link-info {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .link-novel-title,
  .link-source,
  .link-status {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-source {
    color: rgba(202, 196, 208, 0.62);
    font-size: 11px;
  }

  .link-status {
    color: #d3c4ff;
    font-size: 11px;
    font-weight: 800;
  }

</style>

{#if migrateOpen && activeDetail}
  <NovelMigrateModal
    active={activeDetail}
    onClose={() => migrateOpen = false}
    onMigrated={(next) => {
      setActiveNovelDetail(next);
      migrateOpen = false;
      bumpContentSetupVersion();
    }}
  />
{/if}
