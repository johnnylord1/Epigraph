<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { ArrowLeft, ArrowRight, BookmarkSimple, BookOpen, CaretLeft, CaretRight, CircleNotch, SlidersHorizontal, X } from "phosphor-svelte";
  import { addToast, bumpContentSetupVersion, closeNovelReader, setActiveNovelDetail, store, updateSettings } from "../../store/state.svelte";
  import {
    buildNovelDetailRecordFromLibrary,
    getNovelBookmarkEntries,
    getNovelLibraryChapters,
    getNovelLibraryEntry,
    getNovelReadStats,
    loadNovelLibraryState,
    markNovelChapterRead,
    peekNovelLibraryState,
    saveNovelLibraryState,
    toggleNovelChapterBookmark,
  } from "../../lib/novels/libraryState";
  import { readInstalledNovelChapter } from "../../lib/novels/sources";
  import NocturneState from "../shared/NocturneState.svelte";
  import ReaderBrightnessControl from "./ReaderBrightnessControl.svelte";
  import ReaderHud from "./ReaderHud.svelte";

  let loading = $state(false);
  let error = $state<string | null>(null);
  let chapterHtml = $state("");
  let toolsOpen = $state(false);
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
  const currentStats = $derived.by(() => activeReader ? getNovelReadStats(libraryState, activeReader.novelId) : null);
  const currentBookmarks = $derived.by(() => activeReader ? getNovelBookmarkEntries(libraryState, activeReader.novelId) : []);
  const currentChapterBookmarked = $derived.by(() => currentBookmarks.some((entry) => entry.chapterId === activeReader?.chapterId));
  const sliderMax = $derived(Math.max(1, currentNovel?.chapters.length ?? 1));
  const sliderValue = $derived(Math.max(1, currentChapterIndex + 1));
  const sliderPct = $derived(sliderMax > 1 ? ((sliderValue - 1) / (sliderMax - 1)) * 100 : 0);
  const progressLabel = $derived.by(() => {
    if (!currentNovel || currentChapterIndex < 0) return "Chapter";
    const percent = currentStats ? Math.round(currentStats.progressPercent * 100) : Math.round((sliderValue / sliderMax) * 100);
    return `${sliderValue} / ${sliderMax} - ${percent}%`;
  });
  const proseTheme = $derived(store.settings.proseReaderTheme ?? "nocturne");
  const proseFontSize = $derived(store.settings.proseReaderFontSize ?? 18);
  const proseLineHeight = $derived(store.settings.proseReaderLineHeight ?? 1.75);
  const proseParagraphSpacing = $derived(store.settings.proseReaderParagraphSpacing ?? 1.1);
  const proseContentWidth = $derived(store.settings.proseReaderContentWidth ?? 760);
  const proseFontFamily = $derived(store.settings.proseReaderFontFamily || "Georgia, serif");
  const proseTextAlign = $derived(store.settings.proseReaderTextAlign ?? "left");
  const prosePalette = $derived.by(() => {
    if (proseTheme === "light") return { text: "#19151d", bg: "#f5f1ea", surface: "#f8f4ec" };
    if (proseTheme === "sepia") return { text: "#2b2118", bg: "#efe1c9", surface: "#f6ead4" };
    if (proseTheme === "oled") return { text: "#e8e2f4", bg: "#000000", surface: "#050507" };
    if (proseTheme === "dark") return { text: "#ece7f5", bg: "#09080d", surface: "#111019" };
    return {
      text: store.settings.proseReaderTextColor ?? "#efe9de",
      bg: store.settings.proseReaderBackgroundColor ?? "#17121c",
      surface: store.settings.proseReaderBackgroundColor ?? "#17121c",
    };
  });

  function cycleProseTheme() {
    const themes = ["nocturne", "dark", "sepia", "light", "oled"] as const;
    const current = themes.indexOf(proseTheme as any);
    updateSettings({ proseReaderTheme: themes[(current + 1) % themes.length] });
  }

  function updateFontSize(delta: number) {
    updateSettings({ proseReaderFontSize: Math.max(12, Math.min(32, proseFontSize + delta)) });
  }

  function updateLineHeight(delta: number) {
    updateSettings({ proseReaderLineHeight: Math.round(Math.max(1.2, Math.min(2.4, proseLineHeight + delta)) * 100) / 100 });
  }

  function updateContentWidth(delta: number) {
    updateSettings({ proseReaderContentWidth: Math.max(520, Math.min(980, proseContentWidth + delta)) });
  }

  function updateProseColor(key: "text" | "background", value: string) {
    updateSettings(key === "text"
      ? { proseReaderTheme: "nocturne", proseReaderTextColor: value }
      : { proseReaderTheme: "nocturne", proseReaderBackgroundColor: value });
  }

  function sanitizeChapterHtml(input: string): string {
    if (typeof DOMParser === "undefined") return input;
    const parser = new DOMParser();
    const doc = parser.parseFromString(input, "text/html");
    doc.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((node) => node.remove());
    doc.querySelectorAll("*").forEach((node) => {
      for (const attribute of [...node.attributes]) {
        if (attribute.name.startsWith("on")) node.removeAttribute(attribute.name);
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

  function openChapter(target: NonNullable<typeof currentNovel>["chapters"][number] | null) {
    if (!activeReader || !target) return;
    store.setActiveNovelReader({
      ...activeReader,
      chapterId: target.id,
      chapterPath: target.path,
      chapterTitle: target.title,
    });
  }

  function openRelativeChapter(direction: "prev" | "next") {
    openChapter(direction === "prev" ? previousChapter : nextChapter);
  }

  function openChapterByIndex(index: number) {
    if (!currentNovel) return;
    openChapter(currentNovel.chapters[index] ?? null);
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
  <ReaderHud
    bind:toolsOpen={toolsOpen}
    title={currentNovel?.title ?? "Novel"}
    chapterTitle={activeReader?.chapterTitle ?? ""}
    progressLabel={progressLabel}
    sliderValue={sliderValue}
    sliderMax={sliderMax}
    sliderPct={sliderPct}
    bookmarkPct={currentChapterBookmarked ? sliderPct : null}
    isBookmarked={currentChapterBookmarked}
    prevDisabled={loading || !previousChapter}
    nextDisabled={loading || !nextChapter}
    uiVisible={true}
    onclose={closeNovelReader}
    onprev={() => openRelativeChapter("prev")}
    onnext={() => openRelativeChapter("next")}
    onjump={(val) => openChapterByIndex(val - 1)}
    onbookmark={toggleCurrentChapterBookmark}
  >
    {#snippet settingsPopover()}
      <dl>
        <ReaderBrightnessControl />
        <div>
          <dt>Theme</dt>
          <dd>
            <div class="popover-color-swatches">
              <button class="popover-swatch" style="background:#efe1c9;" class:active={proseTheme === "sepia"} onclick={() => updateSettings({ proseReaderTheme: "sepia" })} title="Sepia"></button>
              <button class="popover-swatch" style="background:#000000;" class:active={proseTheme === "oled"} onclick={() => updateSettings({ proseReaderTheme: "oled" })} title="OLED"></button>
              <button class="popover-swatch" style="background:#09080d;" class:active={proseTheme === "dark"} onclick={() => updateSettings({ proseReaderTheme: "dark" })} title="Dark"></button>
              <button class="popover-swatch" style="background:#f5f1ea;" class:active={proseTheme === "light"} onclick={() => updateSettings({ proseReaderTheme: "light" })} title="Light"></button>
              <button class="popover-swatch" style="background:#17121c;" class:active={proseTheme === "nocturne"} onclick={() => updateSettings({ proseTheme: "nocturne" })} title="Nocturne"></button>
            </div>
          </dd>
        </div>
        <div>
          <dt>Text Color</dt>
          <dd>
            <input
              class="popover-color-picker"
              type="color"
              value={prosePalette.text}
              onchange={(event) => updateProseColor("text", event.currentTarget.value)}
              title="Text color"
            />
          </dd>
        </div>
        <div>
          <dt>Paper Color</dt>
          <dd>
            <input
              class="popover-color-picker"
              type="color"
              value={prosePalette.surface}
              onchange={(event) => updateProseColor("background", event.currentTarget.value)}
              title="Page background"
            />
          </dd>
        </div>
        <div>
          <dt>Font</dt>
          <dd>
            <select
              class="popover-select"
              value={proseFontFamily}
              onchange={(event) => updateSettings({ proseReaderFontFamily: event.currentTarget.value })}
            >
              <option value="Georgia, serif">Georgia</option>
              <option value="Merriweather, Georgia, serif">Merriweather</option>
              <option value="Inter, sans-serif">Inter</option>
              <option value="Atkinson Hyperlegible, Inter, sans-serif">Atkinson</option>
              <option value='"Segoe UI", sans-serif'>Segoe UI</option>
            </select>
          </dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>
            <div class="popover-stepper">
              <button class="popover-step-btn" onclick={() => updateFontSize(-1)}>−</button>
              <span class="popover-step-val">{proseFontSize}px</span>
              <button class="popover-step-btn" onclick={() => updateFontSize(1)}>+</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>Line</dt>
          <dd>
            <div class="popover-stepper">
              <button class="popover-step-btn" onclick={() => updateLineHeight(-0.05)}>−</button>
              <span class="popover-step-val">{proseLineHeight.toFixed(2)}</span>
              <button class="popover-step-btn" onclick={() => updateLineHeight(0.05)}>+</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>Align</dt>
          <dd>
            <button class="popover-btn" onclick={() => updateSettings({ proseReaderTextAlign: proseTextAlign === "justify" ? "left" : "justify" })}>{proseTextAlign}</button>
          </dd>
        </div>
        <div>
          <dt>Width</dt>
          <dd>
            <div class="popover-stepper">
              <button class="popover-step-btn" onclick={() => updateContentWidth(-40)}>−</button>
              <span class="popover-step-val">{proseContentWidth}px</span>
              <button class="popover-step-btn" onclick={() => updateContentWidth(40)}>+</button>
            </div>
          </dd>
        </div>
        <div>
          <dt>Full Width</dt>
          <dd>
            <button class="popover-toggle" type="button" aria-label="Toggle full width reading" title="Toggle full width reading" class:active={store.settings.proseReaderFullWidth} onclick={() => updateSettings({ proseReaderFullWidth: !store.settings.proseReaderFullWidth })}></button>
          </dd>
        </div>
      </dl>
    {/snippet}

    <div class="viewer novel-viewer" class:full-width-panel={store.settings.proseReaderFullWidth} style={`--prose-page-bg:${prosePalette.bg};`}>
      {#if loading}
        <div class="center-overlay">
          <CircleNotch size={20} weight="light" class="anim-spin" style="color:var(--text-faint)" />
        </div>
      {:else if error}
        <div class="center-overlay error-stack">
          <NocturneState
            layout="center"
            tone="danger"
            icon="warning"
            eyebrow="Reader"
            title="Could not load this chapter"
            body={error}
            actions={[{
              label: "Retry chapter",
              kind: "primary",
              icon: "retry",
              onClick: loadChapter,
            }]}
          />
        </div>
      {:else if !chapterHtml.trim()}
        <div class="center-overlay error-stack">
          <NocturneState
            layout="center"
            tone="warning"
            icon="info"
            eyebrow="Reader"
            title="No readable content"
            body="This source returned an empty chapter."
          />
        </div>
      {:else}
        <article
          class="reader-body prose"
          style={`--prose-font-size:${proseFontSize}px;--prose-line-height:${proseLineHeight};--prose-paragraph-spacing:${proseParagraphSpacing}em;--prose-content-width:${proseContentWidth}px;--prose-font-family:${proseFontFamily};--prose-text:${prosePalette.text};--prose-bg:${prosePalette.surface};--prose-page-bg:${prosePalette.bg};--prose-align:${proseTextAlign};`}
        >{@html chapterHtml}</article>
      {/if}
    </div>
  </ReaderHud>
{/if}

<style>
  .novel-viewer {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
    background:
      radial-gradient(circle at 45% 18%, rgba(255, 255, 255, 0.015), transparent 30%),
      linear-gradient(180deg, var(--prose-page-bg, var(--bg-void)), #050505 62%, var(--prose-page-bg, var(--bg-void)));
    color: var(--prose-text, var(--text-primary));
  }

  .reader-body {
    padding: clamp(42px, 6vw, 72px);
    margin: var(--sp-3) auto;
    width: min(var(--prose-content-width, 760px), calc(100% - 40px));
    min-height: calc(100% - var(--sp-6));
    border: 1px solid color-mix(in srgb, var(--border-base) 68%, transparent);
    border-radius: 14px;
    background: var(--prose-bg, color-mix(in srgb, var(--bg-base) 88%, #d7d0c2 12%));
    box-shadow: 0 44px 110px rgba(0, 0, 0, 0.5);
    color: var(--prose-text, var(--text-primary));
    font-family: var(--prose-font-family, Georgia, serif);
    line-height: var(--prose-line-height, 1.75);
    font-size: var(--prose-font-size, 18px);
    text-align: var(--prose-align, left);
  }

  .novel-viewer.full-width-panel .reader-body {
    width: 100%;
    max-width: 100%;
    min-height: 100%;
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }

  .reader-body :global(p),
  .reader-body :global(div) {
    color: var(--prose-text, var(--text-primary));
    margin: 0 0 var(--prose-paragraph-spacing, 1.1em);
  }

  .reader-body :global(img) {
    max-width: 100%;
    height: auto;
  }

  .center-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .error-stack {
    padding: var(--sp-5);
  }
</style>
