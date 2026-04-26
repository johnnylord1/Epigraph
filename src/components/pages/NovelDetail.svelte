<script lang="ts">
  import { ArrowLeft, ArrowsClockwise, BookOpen, BookmarkSimple, Trash } from "phosphor-svelte";
  import {
    addToast,
    bumpContentSetupVersion,
    setActiveNovelDetail,
    setActiveNovelReader,
    store,
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
  import NovelMigrateModal from "./NovelMigrateModal.svelte";

  const activeDetail = $derived(store.activeNovelDetail);
  let migrateOpen = $state(false);
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

  async function addToLibrary() {
    if (!activeDetail) return;
    const state = await loadNovelLibraryState(scopeInput);
    libraryState = await saveNovelLibraryState(upsertNovelInLibrary(state, activeDetail.novel), scopeInput);
    bumpContentSetupVersion();
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

  $effect(() => {
    void Promise.all([
      loadNovelSourceClassificationState(scopeInput),
      loadNovelLibraryState(scopeInput),
    ]).then(([classificationState, nextLibraryState]) => {
      sourceClassificationState = classificationState;
      libraryState = nextLibraryState;
    });
  });
</script>

{#if activeDetail}
  <div class="root">
    <div class="sidebar">
      <button class="back" onclick={() => setActiveNovelDetail(null)}>
        <ArrowLeft size={13} weight="light" />
        Back
      </button>

      <div class="cover-wrap">
        {#if displayedNovel?.coverUrl}
          <img class="cover" src={displayedNovel.coverUrl} alt={displayedNovel.title} />
        {:else}
          <div class="cover-fallback">
            <BookOpen size={36} weight="duotone" />
            <span>Novel source</span>
          </div>
        {/if}
      </div>

      <div class="meta">
        <p class="title">{displayedNovel?.title ?? activeDetail.novel.title}</p>
        <p class="byline">{displayedNovel?.author ?? activeDetail.novel.source.sourceName ?? activeDetail.novel.source.pluginName ?? "Source novel"}</p>
        <div class="badges">
          <span class="badge">{activeDetail.inLibrary ? "Saved" : "Source"}</span>
          {#if displayedNovel?.status}
            <span class="badge">{displayedNovel.status}</span>
          {/if}
          {#if activeDetail.novel.source.lang}
            <span class="badge">{activeDetail.novel.source.lang.toUpperCase()}</span>
          {/if}
        </div>
        {#if readStats && activeDetail.inLibrary}
          <div class="readingSummary">
            <span>{readStats.read}/{readStats.total} chapters read</span>
            <span>{Math.round(readStats.progressPercent * 100)}% complete</span>
          </div>
        {/if}
        {#if activeDetail.inLibrary && lastReadChapterId}
          <p class="resumeHint">Resume is available from your last saved chapter.</p>
        {/if}
        {#if displayedNovel?.description}
          <p class="desc">{displayedNovel.description}</p>
        {/if}
      </div>

      <div class="cta-section">
        <button class="read-btn" disabled={!resumeChapter} onclick={() => resumeChapter && openChapter(resumeChapter.id, resumeChapter.path, resumeChapter.title)}>
          <BookOpen size={12} weight="bold" />
          {resumeChapter ? (lastReadChapterId ? "Resume novel" : "Start novel") : "No chapters"}
        </button>
        <div class="actions">
          <button class="library-btn" disabled={!activeDetail.inLibrary || Boolean(migrationBlocker)} title={migrationBlocker ?? "Migrate this novel to another source"} onclick={() => migrateOpen = true}>
            <ArrowsClockwise size={13} weight="light" />
            Migrate
          </button>
          {#if activeDetail.inLibrary}
            <button class="library-btn danger" onclick={removeFromLibrary}>
              <Trash size={13} weight="light" />
              Remove
            </button>
          {:else}
            <button class="library-btn" onclick={addToLibrary}>
              <BookmarkSimple size={13} weight="light" />
              Add to Library
            </button>
          {/if}
        </div>
      </div>
    </div>

    <div class="list-wrap">
      <div class="list-header">
        <span class="list-label">Chapters</span>
        <span class="list-count">{displayedNovel?.chapterCount ?? activeDetail.novel.chapterCount} total</span>
      </div>

      {#if !displayedNovel || displayedNovel.chapters.length === 0}
        <div class="empty-state">This source did not expose chapter metadata for this novel.</div>
      {:else}
        <div class="ch-list">
          {#each displayedNovel.chapters as chapter (chapter.id)}
            <button class="ch-row" onclick={() => openChapter(chapter.id, chapter.path, chapter.title)}>
              <div class="ch-left">
                <span class="ch-name">{chapter.title}</span>
                <div class="ch-meta">
                  <span class="ch-meta-item">Chapter {chapter.order + 1}</span>
                  {#if chapter.releaseTime}
                    <span class="ch-meta-item">{new Date(chapter.releaseTime).toLocaleDateString()}</span>
                  {/if}
                  {#if chapter.id === lastReadChapterId}
                    <span class="ch-meta-item current">Current</span>
                  {/if}
                  {#if bookmarkedChapterIds.has(chapter.id)}
                    <span class="ch-meta-item bookmarked">Bookmarked</span>
                  {/if}
                  {#if chapter.unread}
                    <span class="ch-meta-item unread">Unread</span>
                  {:else}
                    <span class="ch-meta-item read">Read</span>
                  {/if}
                </div>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

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

<style>
  .root {
    display: flex;
    height: 100%;
    overflow: hidden;
    animation: fadeIn 0.14s ease both;
  }

  .sidebar {
    width: 260px;
    flex-shrink: 0;
    padding: var(--sp-5);
    border-right: 1px solid var(--border-dim);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    background: var(--bg-base);
  }

  .back,
  .library-btn,
  .read-btn,
  .ch-row {
    cursor: pointer;
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
  }

  .cover-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
  }

  .cover {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .cover-fallback {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
  }

  .meta,
  .cta-section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .readingSummary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-family: var(--font-ui);
  }

  .resumeHint {
    color: var(--text-faint);
    font-size: var(--text-xs);
  }

  .title {
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    color: var(--text-primary);
    line-height: var(--leading-snug);
  }

  .byline,
  .desc,
  .list-count {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .badges,
  .actions,
  .ch-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }

  .badge,
  .ch-meta-item {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    color: var(--text-faint);
  }

  .badge {
    padding: 2px 7px;
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-sm);
    background: var(--bg-raised);
  }

  .read-btn,
  .library-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    min-height: 34px;
    padding: 0 var(--sp-3);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    font-family: var(--font-ui);
    letter-spacing: var(--tracking-wide);
  }

  .read-btn {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: var(--accent-contrast, #fff);
  }

  .library-btn {
    flex: 1;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    background: var(--bg-raised);
  }

  .library-btn.danger {
    color: var(--color-error);
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
  }

  .list-label {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }

  .ch-list {
    flex: 1;
    overflow-y: auto;
  }

  .ch-row {
    width: 100%;
    display: flex;
    align-items: center;
    padding: 10px var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
    gap: var(--sp-3);
    background: transparent;
    border-inline: none;
  }

  .ch-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: left;
  }

  .ch-name {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .unread {
    color: var(--accent-fg);
  }

  .read {
    color: var(--text-faint);
  }

  .current {
    color: var(--color-info);
  }

  .bookmarked {
    color: var(--color-warning);
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: var(--text-sm);
    padding: var(--sp-5);
    text-align: center;
  }
</style>
