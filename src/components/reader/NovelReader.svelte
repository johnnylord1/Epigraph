<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { ArrowLeft, BookmarkSimple, CaretLeft, CaretRight } from "phosphor-svelte";
  import { addToast, bumpContentSetupVersion, closeNovelReader, setActiveNovelDetail, store } from "../../store/state.svelte";
  import {
    buildNovelDetailRecordFromLibrary,
    getNovelBookmarkEntries,
    getNovelLibraryChapters,
    getNovelLibraryEntry,
    getNovelProgressEntry,
    getNovelReadStats,
    loadNovelLibraryState,
    peekNovelLibraryState,
    markNovelChapterRead,
    saveNovelLibraryState,
    toggleNovelChapterBookmark,
  } from "../../lib/novels/libraryState";
  import { readInstalledNovelChapter } from "../../lib/novels/sources";

  let loading = $state(false);
  let error = $state<string | null>(null);
  let chapterHtml = $state("");
  let libraryState = $state(peekNovelLibraryState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));

  const activeReader = $derived(store.activeNovelReader);
  const activeDetail = $derived(store.activeNovelDetail);
  const scopeInput = $derived({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  });
  const currentNovel = $derived.by(() => {
    if (!activeReader) return null;
    if (activeDetail?.novel.id === activeReader.novelId) return activeDetail.novel;
    const entry = getNovelLibraryEntry(libraryState, activeReader.novelId);
    if (!entry) return null;
    return buildNovelDetailRecordFromLibrary(entry, getNovelLibraryChapters(libraryState, activeReader.novelId));
  });
  const currentChapterIndex = $derived.by(() => {
    if (!activeReader || !currentNovel) return -1;
    return currentNovel.chapters.findIndex((entry) => entry.id === activeReader.chapterId);
  });
  const previousChapter = $derived(
    currentNovel && currentChapterIndex > 0 ? currentNovel.chapters[currentChapterIndex - 1] : null,
  );
  const nextChapter = $derived(
    currentNovel && currentChapterIndex >= 0 && currentChapterIndex < currentNovel.chapters.length - 1
      ? currentNovel.chapters[currentChapterIndex + 1]
      : null,
  );
  const currentProgress = $derived.by(() => activeReader ? getNovelProgressEntry(libraryState, activeReader.novelId) : null);
  const currentStats = $derived.by(() => activeReader ? getNovelReadStats(libraryState, activeReader.novelId) : null);
  const currentBookmarks = $derived.by(() => activeReader ? getNovelBookmarkEntries(libraryState, activeReader.novelId) : []);
  const currentChapterBookmarked = $derived.by(() => currentBookmarks.some((entry) => entry.chapterId === activeReader?.chapterId));

  function sanitizeChapterHtml(input: string): string {
    if (typeof DOMParser === "undefined") return input;
    const parser = new DOMParser();
    const doc = parser.parseFromString(input, "text/html");
    doc.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((node) => node.remove());
    doc.querySelectorAll("*").forEach((node) => {
      for (const attribute of [...node.attributes]) {
        if (attribute.name.startsWith("on")) {
          node.removeAttribute(attribute.name);
        }
      }
    });
    return doc.body.innerHTML;
  }

  function syncActiveDetail(state: typeof libraryState) {
    if (!activeDetail || !activeReader || activeDetail.novel.id !== activeReader.novelId) return;
    const entry = getNovelLibraryEntry(state, activeReader.novelId);
    if (!entry) return;
    setActiveNovelDetail({
      novel: buildNovelDetailRecordFromLibrary(entry, getNovelLibraryChapters(state, activeReader.novelId)),
      inLibrary: true,
    });
  }

  async function loadChapter() {
    if (!activeReader) return;
    loading = true;
    error = null;
    try {
      libraryState = await loadNovelLibraryState(scopeInput);
      const result = await readInstalledNovelChapter(scopeInput, activeReader.sourceId, activeReader.chapterPath);
      chapterHtml = sanitizeChapterHtml(result.content);

      if (getNovelLibraryEntry(libraryState, activeReader.novelId)) {
        libraryState = await saveNovelLibraryState(markNovelChapterRead(libraryState, {
          novelId: activeReader.novelId,
          chapterId: activeReader.chapterId,
          chapterTitle: activeReader.chapterTitle,
        }), scopeInput);
        syncActiveDetail(libraryState);
        bumpContentSetupVersion();
      }
    } catch (chapterError) {
      error = chapterError instanceof Error ? chapterError.message : String(chapterError);
      chapterHtml = "";
    } finally {
      loading = false;
    }
  }

  async function toggleCurrentChapterBookmark() {
    if (!activeReader || !getNovelLibraryEntry(libraryState, activeReader.novelId)) return;
    libraryState = await saveNovelLibraryState(toggleNovelChapterBookmark(libraryState, {
      novelId: activeReader.novelId,
      chapterId: activeReader.chapterId,
      chapterTitle: activeReader.chapterTitle,
      locator: activeReader.chapterId,
    }), scopeInput);
    syncActiveDetail(libraryState);
    bumpContentSetupVersion();
    addToast({
      kind: "info",
      title: currentChapterBookmarked ? "Bookmark removed" : "Bookmark saved",
      body: activeReader.chapterTitle,
    });
  }

  function openRelativeChapter(direction: "prev" | "next") {
    const target = direction === "prev" ? previousChapter : nextChapter;
    if (!activeReader || !target) return;
    store.setActiveNovelReader({
      ...activeReader,
      chapterId: target.id,
      chapterPath: target.path,
      chapterTitle: target.title,
    });
  }

  $effect(() => {
    store.runtimeResolvedLocalProfileId;
    store.runtimeServerUrl;
    untrack(() => {
      void loadNovelLibraryState(scopeInput).then((state) => {
        libraryState = state;
      });
    });
  });

  $effect(() => {
    activeReader?.chapterId;
    if (!activeReader) return;
    untrack(() => {
      void loadChapter();
    });
  });

  onMount(() => {
    if (!activeReader) {
      addToast({
        kind: "error",
        title: "Novel reader could not start",
        body: "No active chapter was selected.",
      });
    }
  });
</script>

{#if activeReader}
  <div class="root">
    <div class="reader-header">
      <button class="chrome-btn" onclick={closeNovelReader}>
        <ArrowLeft size={14} weight="bold" />
        Back
      </button>
      <div class="reader-title">
        <strong>{currentNovel?.title ?? "Novel source"}</strong>
        <span>
          {activeReader.chapterTitle}
          {#if currentNovel && currentChapterIndex >= 0}
            · Chapter {currentChapterIndex + 1} of {currentNovel.chapters.length}
          {/if}
          {#if currentStats}
            · {Math.round(currentStats.progressPercent * 100)}%
          {/if}
          {#if currentProgress?.updatedAt}
            · Saved
          {/if}
        </span>
      </div>
      <div class="reader-nav">
        <button
          class="chrome-btn"
          onclick={toggleCurrentChapterBookmark}
          disabled={!getNovelLibraryEntry(libraryState, activeReader.novelId)}
          title={currentChapterBookmarked ? "Remove bookmark" : "Save bookmark"}
        >
          {#if currentChapterBookmarked}
            <BookmarkSimple size={14} weight="fill" />
          {:else}
            <BookmarkSimple size={14} weight="bold" />
          {/if}
          {currentChapterBookmarked ? "Bookmarked" : "Bookmark"}
        </button>
        <button class="chrome-btn" onclick={() => openRelativeChapter("prev")} disabled={!previousChapter}>
          <CaretLeft size={14} weight="bold" />
          Prev
        </button>
        <button class="chrome-btn" onclick={() => openRelativeChapter("next")} disabled={!nextChapter}>
          Next
          <CaretRight size={14} weight="bold" />
        </button>
      </div>
    </div>

    {#if loading}
      <div class="empty">Loading chapter...</div>
    {:else if error}
      <div class="empty error-state">
        <strong>Could not load this chapter.</strong>
        <span>{error}</span>
        <button class="chrome-btn" onclick={loadChapter}>Retry</button>
      </div>
    {:else if !chapterHtml.trim()}
      <div class="empty">This chapter returned no readable content.</div>
    {:else}
      <article class="reader-body prose">{@html chapterHtml}</article>
    {/if}
  </div>
{/if}

<style>
  .root {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-base);
    color: var(--text-primary);
  }

  .reader-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
    background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
  }

  .reader-title {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: center;
  }

  .reader-title strong,
  .reader-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reader-title span {
    font-size: var(--text-xs);
    color: var(--text-faint);
  }

  .reader-nav {
    display: flex;
    gap: var(--sp-2);
  }

  .chrome-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    padding: 7px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-secondary);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
  }

  .chrome-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .reader-body {
    flex: 1;
    overflow-y: auto;
    padding: clamp(20px, 4vw, 40px);
    margin: 0 auto;
    width: min(920px, 100%);
    line-height: 1.9;
    font-size: 1.05rem;
  }

  .reader-body :global(p),
  .reader-body :global(div) {
    color: var(--text-primary);
    margin: 0 0 1.1em;
  }

  .reader-body :global(img) {
    max-width: 100%;
    height: auto;
  }

  .empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: var(--sp-2);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
    padding: var(--sp-5);
  }

  .error-state strong {
    color: var(--text-primary);
  }
</style>
