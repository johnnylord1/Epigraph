<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { registerReaderCloseGuard } from "../../lib/reader/runtime";
  import { ArrowLeft, ArrowRight, BookmarkSimple, BookOpen, CaretLeft, CaretRight, CircleNotch, SlidersHorizontal, X } from "phosphor-svelte";
  import { addToast, bumpContentSetupVersion, closeNovelReader, setActiveNovelDetail, setSettingsOpen, store, updateSettings } from "../../store/state.svelte";
  import {
    buildNovelDetailRecordFromLibrary,
    getNovelBookmarkEntries,
    getNovelLibraryChapters,
    getNovelLibraryEntry,
    getNovelProgressEntry,
    getNovelReadStats,
    loadNovelLibraryState,
    parseNovelScrollLocator,
    peekNovelLibraryState,
    saveNovelLibraryState,
    toggleNovelChapterBookmark,
    updateNovelReadingProgress,
  } from "../../lib/novels/libraryState";
  import {
    loadCachedNovelChapter,
    saveCachedNovelChapter,
  } from "../../lib/novels/offlineChapters";
  import { readInstalledNovelChapter } from "../../lib/novels/sources";
  import NocturneState from "../shared/NocturneState.svelte";
  import ReaderHud from "./ReaderHud.svelte";
  import TtsControls from "./TtsControls.svelte";
  import { createDomTtsTextProvider, createTtsController } from "../../lib/reader/tts";
  import { setGenericReading, setTtsPresence } from "../../lib/discord";
  import { getServerUrl } from "../../lib/client";
  import { canResolveDiscordCover, canRunDiscordCoverImprovement } from "../../lib/discord/coverImprovementGate";
  import { isDiscordPublicImageUrl } from "../../lib/discord/coverResolver";
  import { discordCoverService, type DiscordCoverSource } from "../../lib/discord/discordCoverService";
  import { discordPublicCoverResolver } from "../../lib/discord/discordPublicCoverResolver";
  import { resolveHardcoverNovelDiscordCover } from "../../lib/discord/trackerCoverResolver";
  import { startLocalFlareSolverrAndEnable } from "../../lib/flaresolverr";
  import { isSourceChallengeMessage } from "../../lib/sourceAccess";
  import { matchesKeybind, toggleFullscreen, DEFAULT_KEYBINDS } from "../../lib/keybinds";
  import { isReaderControlKeyboardTarget, registerReaderCommandHandler } from "../../lib/reader/commands";
  import {
    DEFAULT_PROSE_READER_BACKGROUND_COLOR,
    DEFAULT_PROSE_READER_TEXT_COLOR,
    proseReaderThemeSwatch,
    resolveProseReaderPalette,
  } from "../../lib/reader/prosePalette";

  let loading = $state(false);
  let error = $state<string | null>(null);
  let chapterHtml = $state("");
  let toolsOpen = $state(false);
  let activeSubPanel = $state<"main" | "appearance" | "typography" | "layout" | "tts">("main");

  $effect(() => {
    if (!toolsOpen) {
      activeSubPanel = "main";
    }
  });
  let readerBodyEl: HTMLElement | null = $state(null);
  let viewerEl: HTMLElement | null = $state(null);
  let progressSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let progressSaveChain = Promise.resolve();
  let progressVersion = 0;
  let persistedProgressVersion = 0;
  let restoredChapterKey: string | null = null;
  let restoringScrollPosition = false;
  let loadedChapterKey: string | null = null;
  const tts = createTtsController();
  let ttsStateVersion = $state(0);
  let lastDiscordTtsPlaying = false;
  let lastDiscordNovelId: string | null = null;
  let lastDiscordNovelChapterId: string | null = null;
  let lastDiscordPrivacySignature: string | null = null;
  let hardcoverStateVersion = $state(0);
  let discordCoverNovelId: string | null = null;
  let discordCoverLookupKey: string | null = null;
  let discordCoverLookupVersion = 0;
  let discordPublicCoverUrl: string | null = null;
  let chapterLoadGeneration = 0;
  let scopeLoadGeneration = 0;
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

  function currentChapterScrollProgress(): number {
    if (!viewerEl) return 0;
    const scrollable = Math.max(0, viewerEl.scrollHeight - viewerEl.clientHeight);
    if (scrollable === 0) return chapterHtml.trim() ? 1 : 0;
    return Math.max(0, Math.min(1, viewerEl.scrollTop / scrollable));
  }

  async function flushNovelProgress() {
    if (progressSaveTimer) {
      clearTimeout(progressSaveTimer);
      progressSaveTimer = null;
    }
    const version = progressVersion;
    if (version === persistedProgressVersion) return progressSaveChain;
    const snapshot = libraryState;
    const requestScope = { ...scopeInput };
    const operation = progressSaveChain.then(async () => {
      const saved = await saveNovelLibraryState(snapshot, requestScope);
      persistedProgressVersion = version;
      if (version === progressVersion) libraryState = saved;
    });
    progressSaveChain = operation.catch(() => {});
    await operation;
  }

  function recordNovelProgress(chapterProgress: number, completed = false) {
    const reader = activeReader;
    if (!reader || !getNovelLibraryEntry(libraryState, reader.novelId)) return;
    const normalized = Math.max(0, Math.min(1, chapterProgress));
    if (normalized <= 0 && !completed) return;
    libraryState = updateNovelReadingProgress(libraryState, {
      novelId: reader.novelId,
      chapterId: reader.chapterId,
      chapterTitle: reader.chapterTitle,
      chapterProgress: normalized,
      completed,
    });
    progressVersion += 1;
    syncActiveDetail(libraryState);
    bumpContentSetupVersion();
    if (progressSaveTimer) clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(() => {
      progressSaveTimer = null;
      void flushNovelProgress().catch(console.error);
    }, 450);
  }

  function handleNovelScroll() {
    const key = activeReader ? `${activeReader.novelId}:${activeReader.chapterId}` : null;
    if (loading || error || restoringScrollPosition || !chapterHtml.trim()
      || !key || loadedChapterKey !== key || restoredChapterKey !== key) return;
    recordNovelProgress(currentChapterScrollProgress());
  }
  $effect(() => {
    const unsubscribe = tts.subscribe(() => {
      ttsStateVersion += 1;
    });
    return unsubscribe;
  });

  $effect(() => {
    const handleHardcoverStateChanged = () => {
      hardcoverStateVersion += 1;
    };
    globalThis.addEventListener?.("epigraph-hardcover-state-changed", handleHardcoverStateChanged);
    return () => {
      globalThis.removeEventListener?.("epigraph-hardcover-state-changed", handleHardcoverStateChanged);
    };
  });

  $effect(() => {
    hardcoverStateVersion;
    const novelId = currentNovel?.id ?? null;
    const title = currentNovel?.title;
    const chapter = currentNovel && currentChapterIndex >= 0 ? currentNovel.chapters[currentChapterIndex] : null;
    if (!store.settings.discordRpc || !novelId || !title) {
      lastDiscordNovelId = novelId;
      lastDiscordNovelChapterId = chapter?.id ?? null;
      lastDiscordPrivacySignature = null;
      return;
    }
    refreshDiscordCoverForNovel(currentNovel);
    const privacySignature = discordPrivacySignature();
    const reason = novelId !== lastDiscordNovelId
      ? "work-change"
      : chapter?.id !== lastDiscordNovelChapterId
        ? "chapter-change"
        : privacySignature !== lastDiscordPrivacySignature
          ? "privacy-change"
          : "progress";
    lastDiscordNovelId = novelId;
    lastDiscordNovelChapterId = chapter?.id ?? null;
    lastDiscordPrivacySignature = privacySignature;
    void setGenericReading(
      title,
      store.settings,
      reason,
      novelDiscordState(chapter),
      discordPublicCoverUrl,
      novelDiscordProgressPercent(),
    );
  });

  $effect(() => {
    ttsStateVersion;
    const playing = tts.state.isPlaying;
    const title = currentNovel?.title;
    if (store.settings.discordRpc && title && playing !== lastDiscordTtsPlaying) {
      void setTtsPresence(title, playing, store.settings, discordPublicCoverUrl);
    }
    lastDiscordTtsPlaying = playing;
  });

  function novelDiscordCoverSource(novel: NonNullable<typeof currentNovel>): DiscordCoverSource | null {
    if (!isDiscordPublicImageUrl(novel.coverUrl)) return null;
    return { type: "public-url", value: novel.coverUrl };
  }

  function coverSourceKey(source: DiscordCoverSource | null): string | null {
    if (!source?.value) return null;
    return `${source.type}:${source.value}`;
  }

  function refreshDiscordCoverForNovel(novel: NonNullable<typeof currentNovel>) {
    const canShowCover = canResolveDiscordCover(store.settings);
    const shouldImproveCover = canRunDiscordCoverImprovement(store.settings);
    const fallbackCover = isDiscordPublicImageUrl(novel.coverUrl) ? novel.coverUrl : null;
    if (!canShowCover) {
      discordCoverLookupKey = null;
      discordPublicCoverUrl = null;
      return;
    }
    if (novel.id !== discordCoverNovelId) {
      discordCoverNovelId = novel.id;
      discordCoverLookupKey = null;
      discordPublicCoverUrl = fallbackCover;
      discordCoverLookupVersion += 1;
    }

    const source = novelDiscordCoverSource(novel);
    const hardcoverScopeInput = {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl ?? getServerUrl(),
    };
    const trackerKey = [
      "hardcover",
      hardcoverScopeInput.profileId ?? "",
      hardcoverScopeInput.serverUrl ?? "",
      hardcoverStateVersion,
    ].join(":");
    const key = [
      "tracker-first",
      fallbackCover ?? "",
      trackerKey,
      coverSourceKey(source) ?? "",
    ].join(":");
    if (discordCoverLookupKey === key) return;

    const lookupVersion = ++discordCoverLookupVersion;
    discordCoverLookupKey = key;
    void discordPublicCoverResolver.resolve({
      settings: store.settings,
      workKind: "novel",
      workId: novel.id,
      existingPublicCoverUrl: fallbackCover,
      trackerKey,
      resolveTrackerCover: () => resolveHardcoverNovelDiscordCover({
        novelId: novel.id,
        title: novel.title,
        scopeInput: hardcoverScopeInput,
      }),
      workerSource: shouldImproveCover ? source : null,
      resolveWorkerCover: shouldImproveCover && source
        ? (candidate) => discordCoverService.resolveOptimizedCover({
            settings: store.settings,
            workKind: "novel",
            workId: novel.id,
            source: candidate,
          })
        : null,
    }).then((result) => {
      const coverUrl = result?.url ?? null;
      if (!coverUrl || lookupVersion !== discordCoverLookupVersion) return;
      if (currentNovel?.id !== novel.id || !canResolveDiscordCover(store.settings)) return;
      const chapter = currentNovel && currentChapterIndex >= 0 ? currentNovel.chapters[currentChapterIndex] : null;
      discordPublicCoverUrl = coverUrl;
      void setGenericReading(
        novel.title,
        store.settings,
        "work-change",
        novelDiscordState(chapter),
        coverUrl,
        novelDiscordProgressPercent(),
      );
      if (tts.state.isPlaying) void setTtsPresence(novel.title, true, store.settings, coverUrl);
    });
  }

  const progressLabel = $derived.by(() => {
    if (!currentNovel || currentChapterIndex < 0) return $_("ui_chapter");
    const percent = currentStats ? Math.round(currentStats.progressPercent * 100) : Math.round((sliderValue / sliderMax) * 100);
    return `${sliderValue} / ${sliderMax} - ${percent}%`;
  });

  function discordPrivacySignature() {
    const settings = store.settings;
    return JSON.stringify({
      privateMode: settings.discordRpcPrivateMode,
      showCover: settings.discordRpcShowCover,
      improveCovers: settings.discordRpcImproveCovers,
      showProgress: settings.discordRpcShowProgress,
      showTitle: settings.discordRpcShowTitle,
    });
  }

  function novelDiscordState(chapter: NonNullable<typeof currentNovel>["chapters"][number] | null): string | undefined {
    return chapter ? `Chapter ${chapter.order}` : undefined;
  }

  function novelDiscordProgressPercent(): number | undefined {
    if (currentStats && Number.isFinite(currentStats.progressPercent)) return currentStats.progressPercent * 100;
    return Number.isFinite(sliderPct) ? sliderPct : undefined;
  }

  const proseTheme = $derived(store.settings.proseReaderTheme ?? "nocturne");
  const proseFontSize = $derived(store.settings.proseReaderFontSize ?? 18);
  const proseLineHeight = $derived(store.settings.proseReaderLineHeight ?? 1.75);
  const proseParagraphSpacing = $derived(store.settings.proseReaderParagraphSpacing ?? 1.1);
  const proseContentWidth = $derived(store.settings.proseReaderContentWidth ?? 760);
  const proseFontFamily = $derived(store.settings.proseReaderFontFamily || "Georgia, serif");
  const proseTextAlign = $derived(store.settings.proseReaderTextAlign ?? "left");
  const prosePalette = $derived.by(() => {
    const textColor: string = store.settings.proseReaderTextColor ?? DEFAULT_PROSE_READER_TEXT_COLOR;
    const backgroundColor: string = store.settings.proseReaderBackgroundColor ?? DEFAULT_PROSE_READER_BACKGROUND_COLOR;
    return resolveProseReaderPalette(
      proseTheme,
      textColor,
      backgroundColor,
    );
  });
  const readerErrorIsSourceChallenge = $derived(error ? isSourceChallengeMessage(error) : false);
  const readerErrorBody = $derived.by(() => {
    if (!error) return "";
    if (!readerErrorIsSourceChallenge) return error;
    return store.settings.flareSolverrEnabled
      ? $_("reader.novel.sourceStillBlocked")
      : $_("reader.novel.sourceNeedsFlaresolverr");
  });

  async function startFlareSolverrForChapter() {
    try {
      await startLocalFlareSolverrAndEnable();
      addToast({
        kind: "success",
        title: translate("ui_flaresolverrEnabled"),
        body: translate("ui_retryTheChapterAfterTheLocalServiceIs"),
      });
    } catch (startError) {
      addToast({
        kind: "error",
        title: translate("ui_flaresolverrUnavailable"),
        body: startError instanceof Error ? startError.message : translate("ui_openSettingsToConfigureFlaresolverr"),
        duration: 7000,
        action: { label: translate("detail_actions_openSettings"), run: () => setSettingsOpen(true) },
      });
    }
  }

  function cycleProseTheme() {
    const themes = ["nocturne", "dark", "sepia", "light", "oled", "slate", "forest", "nord", "warm"] as const;
    const current = themes.findIndex((theme) => theme === proseTheme);
    updateSettings({ proseReaderTheme: themes[(current + 1) % themes.length] });
  }

  function updateFontSize(delta: number) {
    updateSettings({ proseReaderFontSize: Math.max(12, Math.min(32, proseFontSize + delta)) });
  }

  function onKey(event: KeyboardEvent) {
    if (isReaderControlKeyboardTarget(event.target)) return;
    const keybinds = store.settings.keybinds ?? DEFAULT_KEYBINDS;
    if (event.key === "Escape" || matchesKeybind(event, keybinds.exitReader)) {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.ctrlKey && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      updateFontSize(1);
      return;
    }
    if (event.ctrlKey && event.key === "-") {
      event.preventDefault();
      updateFontSize(-1);
      return;
    }
    if (event.ctrlKey && event.key === "0") {
      event.preventDefault();
      updateSettings({ proseReaderFontSize: 18 });
      return;
    }
    if (matchesKeybind(event, keybinds.toggleFullscreen)) {
      event.preventDefault();
      void toggleFullscreen();
      return;
    }
    if (matchesKeybind(event, keybinds.toggleBookmark)) {
      event.preventDefault();
      toggleCurrentChapterBookmark();
    }
  }

  function updateLineHeight(delta: number) {
    updateSettings({ proseReaderLineHeight: Math.round(Math.max(1.2, Math.min(2.4, proseLineHeight + delta)) * 100) / 100 });
  }

  function updateContentWidth(delta: number) {
    updateSettings({ proseReaderContentWidth: Math.max(520, Math.min(1600, proseContentWidth + delta)) });
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
    const generation = ++chapterLoadGeneration;
    const reader = { ...activeReader };
    const nextChapterKey = `${reader.novelId}:${reader.chapterId}`;
    loading = true;
    restoredChapterKey = null;
    if (loadedChapterKey && loadedChapterKey !== nextChapterKey) {
      await flushNovelProgress().catch(console.error);
    }
    loadedChapterKey = nextChapterKey;
    restoredChapterKey = null;
    const requestScope = { ...scopeInput };
    const isCurrent = () => (
      generation === chapterLoadGeneration
      && activeReader?.novelId === reader.novelId
      && activeReader?.chapterId === reader.chapterId
    );
    loading = true;
    error = null;
    try {
      const nextLibraryState = await loadNovelLibraryState(requestScope);
      if (!isCurrent()) return;
      libraryState = nextLibraryState;
      const cached = await loadCachedNovelChapter(requestScope, reader.sourceId, reader.chapterPath);
      if (!isCurrent()) return;
      if (cached) {
        chapterHtml = sanitizeChapterHtml(cached.content);
      } else {
        const result = await readInstalledNovelChapter(requestScope, reader.sourceId, reader.chapterPath);
        if (!isCurrent()) return;
        chapterHtml = sanitizeChapterHtml(result.content);
        await saveCachedNovelChapter(requestScope, {
          sourceId: reader.sourceId,
          novelId: reader.novelId,
          chapterId: reader.chapterId,
          chapterPath: reader.chapterPath,
          chapterTitle: reader.chapterTitle,
          content: result.content,
        }).catch(() => null);
        if (!isCurrent()) return;
      }

    } catch (chapterError) {
      if (!isCurrent()) return;
      error = chapterError instanceof Error ? chapterError.message : String(chapterError);
      chapterHtml = "";
    } finally {
      if (isCurrent()) loading = false;
    }
  }

  async function refreshTtsProvider() {
    await tick();
    if (!readerBodyEl || loading || error || !chapterHtml.trim()) {
      tts.setProvider(null);
      return;
    }
    tts.setProvider(createDomTtsTextProvider(readerBodyEl, "p, li, blockquote, h1, h2, h3, h4, h5, h6"));
  }

  async function restoreNovelScrollPosition() {
    const reader = activeReader;
    if (!reader || loading || error || !chapterHtml.trim()) return;
    const key = `${reader.novelId}:${reader.chapterId}`;
    if (restoredChapterKey === key) return;
    await tick();
    if (!viewerEl || activeReader?.chapterId !== reader.chapterId) return;
    const progress = getNovelProgressEntry(libraryState, reader.novelId);
    const fraction = progress?.chapterId === reader.chapterId
      ? parseNovelScrollLocator(progress.locator, reader.chapterId)
      : null;
    restoringScrollPosition = true;
    if (fraction && fraction > 0) {
      const scrollable = Math.max(0, viewerEl.scrollHeight - viewerEl.clientHeight);
      viewerEl.scrollTop = scrollable * fraction;
    } else {
      viewerEl.scrollTop = 0;
    }
    restoredChapterKey = key;
    requestAnimationFrame(() => { restoringScrollPosition = false; });
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
      title: currentChapterBookmarked ? translate("ui_bookmarkRemoved") : translate("ui_bookmarkSaved"),
      body: activeReader.chapterTitle,
    });
  }

  async function openChapter(target: NonNullable<typeof currentNovel>["chapters"][number] | null) {
    if (!activeReader || !target || loading) return;
    const fraction = currentChapterScrollProgress();
    if (target.id === nextChapter?.id && fraction >= 0.95) recordNovelProgress(1, true);
    try { await flushNovelProgress(); }
    catch (saveError) { reportProgressSaveError(saveError); return; }
    tts.stop();
    restoredChapterKey = null;
    store.setActiveNovelReader({
      ...activeReader,
      chapterId: target.id,
      chapterPath: target.path,
      chapterTitle: target.title,
    });
  }

  function openRelativeChapter(direction: "prev" | "next") {
    void openChapter(direction === "prev" ? previousChapter : nextChapter);
  }

  async function requestClose() {
    try { await flushNovelProgress(); }
    catch (saveError) { reportProgressSaveError(saveError); return; }
    tts.stop();
    closeNovelReader();
  }

  function reportProgressSaveError(saveError: unknown) {
    console.error(saveError);
    addToast({
      kind: "error",
      title: translate("feedback_readingProgressNotSaved"),
      body: translate("feedback_readingProgressRetryBody"),
    });
  }

  function openChapterByIndex(index: number) {
    if (!currentNovel) return;
    void openChapter(currentNovel.chapters[index] ?? null);
  }

  $effect(() => {
    store.runtimeResolvedLocalProfileId;
    store.runtimeServerUrl;
    const generation = ++scopeLoadGeneration;
    const requestScope = { ...scopeInput };
    untrack(() => {
      void loadNovelLibraryState(requestScope).then((state) => {
        if (
          generation !== scopeLoadGeneration
          || requestScope.profileId !== store.runtimeResolvedLocalProfileId
          || requestScope.serverUrl !== store.runtimeServerUrl
        ) return;
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

  $effect(() => {
    chapterHtml;
    loading;
    error;
    readerBodyEl;
    untrack(() => {
      void refreshTtsProvider();
      void restoreNovelScrollPosition();
    });
  });

  onMount(() => {
    const unregisterCommands = registerReaderCommandHandler("novel", onKey);
    const unregisterCloseGuard = registerReaderCloseGuard(flushNovelProgress, reportProgressSaveError);
    const flushProgress = () => { void flushNovelProgress().catch(console.error); };
    window.addEventListener("pagehide", flushProgress);
    window.addEventListener("beforeunload", flushProgress);
    if (!activeReader) {
      addToast({
        kind: "error",
        title: translate("ui_novelReaderCouldNotStart"),
        body: translate("ui_noActiveChapterWasSelected"),
      });
    }
    return () => {
      unregisterCommands();
      unregisterCloseGuard();
      window.removeEventListener("pagehide", flushProgress);
      window.removeEventListener("beforeunload", flushProgress);
    };
  });

  onDestroy(() => {
    void flushNovelProgress().catch(console.error);
    chapterLoadGeneration += 1;
    scopeLoadGeneration += 1;
    tts.destroy();
  });
</script>

{#if activeReader}
  <ReaderHud
    bind:toolsOpen={toolsOpen}
    title={currentNovel?.title ?? $_("ui_novel")}
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
    onclose={requestClose}
    onprev={() => openRelativeChapter("prev")}
    onnext={() => openRelativeChapter("next")}
    onjump={(val) => openChapterByIndex(val - 1)}
    onbookmark={toggleCurrentChapterBookmark}
  >
    {#snippet settingsPopover()}
      {#if activeSubPanel === "tts"}
        <TtsControls controller={tts} onback={() => activeSubPanel = "main"} />
      {:else}
        <dl>
          {#if activeSubPanel === "main"}
            <div class="popover-tts-row" onclick={() => activeSubPanel = "appearance"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "appearance"; }}>
              <dt>{$_("ui_appearance")}</dt>
              <dd>{proseTheme} <span class="popover-chevron">&gt;</span></dd>
            </div>
            <div class="popover-tts-row" onclick={() => activeSubPanel = "typography"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "typography"; }}>
              <dt>{$_("ui_typography")}</dt>
              <dd>{proseFontSize}{$_("ui_px")} {proseLineHeight.toFixed(2)} <span class="popover-chevron">&gt;</span></dd>
            </div>
            <div class="popover-tts-row" onclick={() => activeSubPanel = "layout"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "layout"; }}>
              <dt>{$_("library_display_layout")}</dt>
              <dd>{store.settings.proseReaderFullWidth ? $_("ui_full") : `${proseContentWidth}px`} · {proseTextAlign} <span class="popover-chevron">&gt;</span></dd>
            </div>
            <div class="popover-tts-row" onclick={() => activeSubPanel = "tts"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "tts"; }}>
              <dt>{$_("ui_textToSpeech")}</dt>
              <dd>{$_("ui_configure")} <span class="popover-chevron">&gt;</span></dd>
            </div>
          {:else if activeSubPanel === "appearance"}
            <div class="popover-tts-row" onclick={() => activeSubPanel = "main"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
              <dt>{$_("ui_back_f13dfaca")}</dt>
              <dd>{$_("ui_appearance")}</dd>
            </div>
            <div>
              <dt>{$_("ui_theme")}</dt>
              <dd>
                <div class="popover-color-swatches" style="display: flex; flex-wrap: wrap; gap: 4px; max-width: 150px;">
                  <button class="popover-swatch" style:background={proseReaderThemeSwatch("sepia")} class:active={proseTheme === "sepia"} onclick={() => updateSettings({ proseReaderTheme: "sepia" })} title={$_("ui_sepia")}></button>
                  <button class="popover-swatch" style:background={proseReaderThemeSwatch("oled")} class:active={proseTheme === "oled"} onclick={() => updateSettings({ proseReaderTheme: "oled" })} title={$_("ui_oled")}></button>
                  <button class="popover-swatch" style:background={proseReaderThemeSwatch("dark")} class:active={proseTheme === "dark"} onclick={() => updateSettings({ proseReaderTheme: "dark" })} title={$_("ui_dark")}></button>
                  <button class="popover-swatch" style:background={proseReaderThemeSwatch("light")} class:active={proseTheme === "light"} onclick={() => updateSettings({ proseReaderTheme: "light" })} title={$_("ui_light")}></button>
                  <button class="popover-swatch" style:background={proseReaderThemeSwatch("nocturne")} class:active={proseTheme === "nocturne"} onclick={() => updateSettings({ proseReaderTheme: "nocturne" })} title={$_("ui_nocturne")}></button>
                  <button class="popover-swatch" style:background={proseReaderThemeSwatch("slate")} class:active={proseTheme === "slate"} onclick={() => updateSettings({ proseReaderTheme: "slate" })} title={$_("ui_slate")}></button>
                  <button class="popover-swatch" style:background={proseReaderThemeSwatch("forest")} class:active={proseTheme === "forest"} onclick={() => updateSettings({ proseReaderTheme: "forest" })} title={$_("ui_forest")}></button>
                  <button class="popover-swatch" style:background={proseReaderThemeSwatch("nord")} class:active={proseTheme === "nord"} onclick={() => updateSettings({ proseReaderTheme: "nord" })} title={$_("ui_nord")}></button>
                  <button class="popover-swatch" style:background={proseReaderThemeSwatch("warm")} class:active={proseTheme === "warm"} onclick={() => updateSettings({ proseReaderTheme: "warm" })} title={$_("ui_warm")}></button>
                </div>
              </dd>
            </div>
            <div>
              <dt>{$_("ui_textColor")}</dt>
              <dd>
                <input class="popover-color-picker" type="color" value={prosePalette.text} onchange={(event) => updateProseColor("text", event.currentTarget.value)} title={$_("ui_textColor_1c7a30e5")} />
              </dd>
            </div>
            <div>
              <dt>{$_("ui_paperColor")}</dt>
              <dd>
                <input class="popover-color-picker" type="color" value={prosePalette.surface} onchange={(event) => updateProseColor("background", event.currentTarget.value)} title={$_("ui_pageBackground")} />
              </dd>
            </div>
          {:else if activeSubPanel === "typography"}
            <div class="popover-tts-row" onclick={() => activeSubPanel = "main"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
              <dt>{$_("ui_back_f13dfaca")}</dt>
              <dd>{$_("ui_typography")}</dd>
            </div>
            <div>
              <dt>{$_("ui_font")}</dt>
              <dd>
                <select class="popover-select" value={proseFontFamily} onchange={(event) => updateSettings({ proseReaderFontFamily: event.currentTarget.value })}>
                  <option value="Georgia, serif">Georgia</option>
                  <option value="Merriweather, Georgia, serif">Merriweather</option>
                  <option value="'EB Garamond', serif">EB Garamond</option>
                  <option value="Lora, serif">Lora</option>
                  <option value="Literata, serif">Literata</option>
                  <option value="Inter, sans-serif">Inter</option>
                  <option value="Atkinson Hyperlegible, Inter, sans-serif">Atkinson</option>
                  <option value='"Segoe UI", sans-serif'>Segoe UI</option>
                </select>
              </dd>
            </div>
            <div>
              <dt>{$_("ui_size")}</dt>
              <dd>
                <div class="popover-stepper">
                  <button class="popover-step-btn" onclick={() => updateFontSize(-1)} disabled={proseFontSize <= 12}>-</button>
                  <span class="popover-step-val">{proseFontSize}{$_("ui_px_07a65dd6")}</span>
                  <button class="popover-step-btn" onclick={() => updateFontSize(1)} disabled={proseFontSize >= 32}>+</button>
                </div>
              </dd>
            </div>
            <div>
              <dt>{$_("ui_line")}</dt>
              <dd>
                <div class="popover-stepper">
                  <button class="popover-step-btn" onclick={() => updateLineHeight(-0.05)} disabled={proseLineHeight <= 1.2}>-</button>
                  <span class="popover-step-val">{proseLineHeight.toFixed(2)}</span>
                  <button class="popover-step-btn" onclick={() => updateLineHeight(0.05)} disabled={proseLineHeight >= 2.4}>+</button>
                </div>
              </dd>
            </div>
          {:else if activeSubPanel === "layout"}
            <div class="popover-tts-row" onclick={() => activeSubPanel = "main"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") activeSubPanel = "main"; }}>
              <dt>{$_("ui_back_f13dfaca")}</dt>
              <dd>{$_("library_display_layout")}</dd>
            </div>
            <div>
              <dt>{$_("ui_align")}</dt>
              <dd>
                <div class="popover-segmented">
                  <button class="popover-segment" class:active={proseTextAlign === "left"} onclick={() => updateSettings({ proseReaderTextAlign: "left" })}>{$_("ui_left")}</button>
                  <button class="popover-segment" class:active={proseTextAlign === "justify"} onclick={() => updateSettings({ proseReaderTextAlign: "justify" })}>{$_("ui_justified")}</button>
                </div>
              </dd>
            </div>
            <div>
              <dt>{$_("ui_width")}</dt>
              <dd style="display: flex; align-items: center; gap: 8px;">
                <div class="popover-stepper">
                  <button class="popover-step-btn" onclick={() => updateContentWidth(-40)} disabled={store.settings.proseReaderFullWidth}>-</button>
                  <span class="popover-step-val" style={store.settings.proseReaderFullWidth ? "opacity: var(--component-reader-core-disabled-step-opacity);" : ""}>
                    {store.settings.proseReaderFullWidth ? $_("ui_full") : `${proseContentWidth}px`}
                  </span>
                  <button class="popover-step-btn" onclick={() => updateContentWidth(40)} disabled={store.settings.proseReaderFullWidth}>+</button>
                </div>
                <button class="popover-btn" class:active={store.settings.proseReaderFullWidth} onclick={() => updateSettings({ proseReaderFullWidth: !store.settings.proseReaderFullWidth })}>{$_("ui_full")}</button>
              </dd>
            </div>
          {:else if false}
          <div>
            <dt>{$_("ui_theme")}</dt>
            <dd>
              <div class="popover-color-swatches" style="display: flex; flex-wrap: wrap; gap: 4px; max-width: 150px;">
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("sepia")} class:active={proseTheme === "sepia"} onclick={() => updateSettings({ proseReaderTheme: "sepia" })} title={$_("ui_sepia")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("oled")} class:active={proseTheme === "oled"} onclick={() => updateSettings({ proseReaderTheme: "oled" })} title={$_("ui_oled")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("dark")} class:active={proseTheme === "dark"} onclick={() => updateSettings({ proseReaderTheme: "dark" })} title={$_("ui_dark")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("light")} class:active={proseTheme === "light"} onclick={() => updateSettings({ proseReaderTheme: "light" })} title={$_("ui_light")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("nocturne")} class:active={proseTheme === "nocturne"} onclick={() => updateSettings({ proseReaderTheme: "nocturne" })} title={$_("ui_nocturne")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("slate")} class:active={proseTheme === "slate"} onclick={() => updateSettings({ proseReaderTheme: "slate" })} title={$_("ui_slate")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("forest")} class:active={proseTheme === "forest"} onclick={() => updateSettings({ proseReaderTheme: "forest" })} title={$_("ui_forest")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("nord")} class:active={proseTheme === "nord"} onclick={() => updateSettings({ proseReaderTheme: "nord" })} title={$_("ui_nord")}></button>
                <button class="popover-swatch" style:background={proseReaderThemeSwatch("warm")} class:active={proseTheme === "warm"} onclick={() => updateSettings({ proseReaderTheme: "warm" })} title={$_("ui_warm")}></button>
              </div>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_textColor")}</dt>
            <dd>
              <input
                class="popover-color-picker"
                type="color"
                value={prosePalette.text}
                onchange={(event) => updateProseColor("text", event.currentTarget.value)}
                title={$_("ui_textColor_1c7a30e5")}
              />
            </dd>
          </div>
          <div>
            <dt>{$_("ui_paperColor")}</dt>
            <dd>
              <input
                class="popover-color-picker"
                type="color"
                value={prosePalette.surface}
                onchange={(event) => updateProseColor("background", event.currentTarget.value)}
                title={$_("ui_pageBackground")}
              />
            </dd>
          </div>
          <div>
            <dt>{$_("ui_font")}</dt>
            <dd>
              <select
                class="popover-select"
                value={proseFontFamily}
                onchange={(event) => updateSettings({ proseReaderFontFamily: event.currentTarget.value })}
              >
                <option value="Georgia, serif">Georgia</option>
                <option value="Merriweather, Georgia, serif">Merriweather</option>
                <option value="'EB Garamond', serif">EB Garamond</option>
                <option value="Lora, serif">Lora</option>
                <option value="Literata, serif">Literata</option>
                <option value="Inter, sans-serif">Inter</option>
                <option value="Atkinson Hyperlegible, Inter, sans-serif">Atkinson</option>
                <option value='"Segoe UI", sans-serif'>Segoe UI</option>
              </select>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_size")}</dt>
            <dd>
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateFontSize(-1)}>−</button>
                <span class="popover-step-val">{proseFontSize}{$_("ui_px_07a65dd6")}</span>
                <button class="popover-step-btn" onclick={() => updateFontSize(1)}>+</button>
              </div>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_line")}</dt>
            <dd>
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateLineHeight(-0.05)}>−</button>
                <span class="popover-step-val">{proseLineHeight.toFixed(2)}</span>
                <button class="popover-step-btn" onclick={() => updateLineHeight(0.05)}>+</button>
              </div>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_align")}</dt>
            <dd>
              <button class="popover-btn" onclick={() => updateSettings({ proseReaderTextAlign: proseTextAlign === "justify" ? "left" : "justify" })}>{proseTextAlign}</button>
            </dd>
          </div>
          <div>
            <dt>{$_("ui_width")}</dt>
            <dd style="display: flex; align-items: center; gap: 8px;">
              <div class="popover-stepper">
                <button class="popover-step-btn" onclick={() => updateContentWidth(-40)} disabled={store.settings.proseReaderFullWidth}>−</button>
                <span class="popover-step-val" style={store.settings.proseReaderFullWidth ? "opacity: var(--component-reader-core-disabled-step-opacity);" : ""}>
                  {store.settings.proseReaderFullWidth ? $_("ui_full") : `${proseContentWidth}px`}
                </span>
                <button class="popover-step-btn" onclick={() => updateContentWidth(40)} disabled={store.settings.proseReaderFullWidth}>+</button>
              </div>
              <button class="popover-btn" class:active={store.settings.proseReaderFullWidth} onclick={() => updateSettings({ proseReaderFullWidth: !store.settings.proseReaderFullWidth })}>{$_("ui_full")}</button>
            </dd>
          </div>
          <div class="popover-tts-row" onclick={() => activeSubPanel = "tts"} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') activeSubPanel = "tts"; }}>
            <dt style="color: var(--reader-text);">{$_("ui_textToSpeech")}</dt>
            <dd style="color: var(--reader-accent-bright); font-weight: 600; display: flex; align-items: center; gap: 4px;">
              <span>{$_("ui_configure")}</span>
              <span class="popover-chevron">&gt;</span>
            </dd>
          </div>
          {/if}
        </dl>
      {/if}
    {/snippet}

    <div
      class="viewer novel-viewer"
      class:full-width-panel={store.settings.proseReaderFullWidth}
      style={`--prose-page-bg:${prosePalette.bg};`}
      bind:this={viewerEl}
      onscroll={handleNovelScroll}
    >
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
            eyebrow={$_("ui_reader")}
            title={$_("ui_couldNotLoadThisChapter")}
            body={readerErrorBody}
            detail={readerErrorIsSourceChallenge ? error : ""}
            actions={readerErrorIsSourceChallenge ? [
              {
                label: store.settings.flareSolverrEnabled ? $_("ui_openSettings") : $_("ui_startFlaresolverr"),
                kind: "primary",
                icon: "plug",
                onClick: store.settings.flareSolverrEnabled ? () => setSettingsOpen(true) : startFlareSolverrForChapter,
              },
              {
                label: $_("ui_retryChapter"),
                kind: "secondary",
                icon: "retry",
                onClick: loadChapter,
              },
            ] : [{
              label: $_("ui_retryChapter"),
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
            eyebrow={$_("ui_reader")}
            title={$_("ui_noReadableContent")}
            body={$_("ui_emptyChapterReturned")}
          />
        </div>
      {:else}
        <article
          class="reader-body prose"
          bind:this={readerBodyEl}
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
    background: var(--component-reader-core-prose-viewer-bg);
    color: var(--component-reader-core-prose-viewer-fg);
  }

  .reader-body {
    padding: clamp(42px, 6vw, 72px);
    margin: var(--sp-3) auto;
    width: min(var(--prose-content-width, 760px), calc(100% - 40px));
    min-height: calc(100% - var(--sp-6));
    border: var(--component-reader-core-prose-panel-border);
    border-radius: var(--component-reader-core-prose-panel-radius);
    background: var(--component-reader-core-prose-panel-bg);
    box-shadow: var(--component-reader-core-prose-panel-shadow);
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
    border-radius: var(--component-reader-core-prose-panel-full-radius);
    box-shadow: var(--component-reader-core-prose-panel-full-shadow);
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

  .reader-body :global(.tts-active-segment) {
    border-radius: var(--component-reader-core-prose-tts-radius);
    background: var(--component-reader-core-prose-tts-bg);
    box-shadow: var(--component-reader-core-prose-tts-shadow);
    transition: var(--component-reader-core-prose-tts-transition);
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
