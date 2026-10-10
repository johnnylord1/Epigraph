<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { formatAppDate, formatWorkStatus } from "../../lib/i18n/format";
  import { _ } from "../../lib/i18n/runtime";
  import { invoke } from "@tauri-apps/api/core";
  import { ArrowSquareOut, ArrowsClockwise, ArrowsLeftRight, BookmarkSimple, CaretDown, ChartLineUp, Check, CheckCircle, Circle, CircleNotch, DownloadSimple, FolderSimplePlus, Link, List, Play, SortAscending, SortDescending, SquaresFour, Trash, X } from "phosphor-svelte";
  import {
    addToast,
    bumpContentSetupVersion,
    setActiveNovelDetail,
    setActiveNovelReader,
    setNovelDownload,
    setSettingsOpen,
    store,
    updateSettings,
  } from "../../store/state.svelte";
  import type { NovelDownloadProgress } from "../../store/state.svelte";
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
    setNovelChaptersRead,
    upsertNovelInLibrary,
  } from "../../lib/novels/libraryState";
  import { loadNovelSourceClassificationState, peekNovelSourceClassificationState, type PersistedNovelSourceClassificationState } from "../../lib/novels/sourceClassificationState";
  import { getNovelMigrationBlockerKind } from "../../lib/novels/migrationSafe";
  import { classifyUnclassifiedNovelSources } from "../../lib/novels/automaticClassification";
  import { loadInstalledNovelSources } from "../../lib/novels/sources";
  import {
    deleteCachedNovelChapters,
    downloadNovelChaptersForOffline,
    listCachedNovelChapterKeys,
    loadCachedNovelChapter,
    novelChapterCacheKey,
  } from "../../lib/novels/offlineChapters";
  import { refreshNovelDetailFromSource } from "../../lib/novels/libraryRefresh";
  import { isConfirmedAntibotChallengeMessage, sourceAccessErrorMessage } from "../../lib/sourceAccess";
  import { NOVEL_READER_CHANGES_SAVED_EVENT } from "../../lib/novels/readerData";
  import { nextChaptersInReadingOrder } from "../../lib/library/nextChapters";
  import {
    createBooksCategory,
    sortBooksCategories,
    toggleBookCategoryAssignment,
  } from "../../lib/library/domainCategories";
  import NovelMigrateModal from "./NovelMigrateModal.svelte";
  import ContextMenu, { type MenuEntry } from "../shared/ContextMenu.svelte";
  import NovelTrackingPanel from "../shared/NovelTrackingPanel.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import SeriesDetailV3Shell from "../shared/SeriesDetailV3Shell.svelte";
  import DetailDownloadMenu from "../shared/DetailDownloadMenu.svelte";

  const CHAPTERS_PER_PAGE = 25;

  const activeDetail = $derived(store.activeNovelDetail);
  const metadataOnly = $derived(activeDetail?.metadataOnly === true);
  let migrateOpen = $state(false);
  let trackingOpen = $state(false);
  let detailsOpen = $state(false);
  let chapterSortDir: "asc" | "desc" = $state("asc");
  let sortMenuOpen = $state(false);
  let viewMode: "list" | "grid" = $state("list");
  let chapterMenu = $state<{ x: number; y: number; chapterId: string } | null>(null);
  let chapterPage = $state(1);
  let folderPickerOpen = $state(false);
  let folderCreating = $state(false);
  let folderNewName = $state("");
  let folderPickerRef: HTMLDivElement | undefined = $state();
  let linkPickerOpen = $state(false);
  let linkSearch = $state("");
  let dlOpen = $state(false);
  // Kept in the store, so leaving this page neither hides a running download nor allows starting it twice.
  const novelDownload = $derived.by(() => {
    const novelId = activeDetail?.novel.id;
    return novelId === undefined ? null : store.novelDownloads.find((entry) => entry.novelId === novelId) ?? null;
  });
  const downloadingNovel = $derived(novelDownload !== null);
  const downloadingIds = $derived(new Set(novelDownload?.pendingIds ?? []));
  const downloadProgress = $derived(novelDownload ? { done: novelDownload.done, total: novelDownload.total } : null);
  let deletingAll = $state(false);
  let refreshing = $state(false);
  // Keys of this source's chapters saved for offline reading (see lib/novels/offlineChapters).
  let cachedKeys = $state(new Set<string>());
  let sourceSite = $state<string | null>(null);
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
  const migrationBlockerKind = $derived(activeDetail ? getNovelMigrationBlockerKind(activeDetail.novel.sourceId, sourceClassificationState) : null);
  const MIGRATION_BLOCKER_KEYS = {
    pending: "novelDetail_migrateBlocked_pending",
    unverified: "novelDetail_migrateBlocked_unverified",
    site: "novelDetail_migrateBlocked_site",
    limited: "novelDetail_migrateBlocked_limited",
  } as const;
  const migrationBlocker = $derived(migrationBlockerKind ? $_(MIGRATION_BLOCKER_KEYS[migrationBlockerKind]) : null);
  const novelUrl = $derived.by(() => {
    const path = displayedNovel?.path ?? activeDetail?.novel.path;
    if (!path) return null;
    try {
      const url = new URL(path, sourceSite ?? undefined);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  });
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
  const downloadedCount = $derived(sortedNovelChapters.filter(isChapterDownloaded).length);
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
    if (!activeDetail || metadataOnly) return;
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
      title: translate("ui_novelAddedToLibrary"),
      body: activeDetail.novel.title,
    });
  }

  async function setChaptersRead(chapterIds: string[], read: boolean) {
    if (!activeDetail?.inLibrary || chapterIds.length === 0) return;
    const novelId = activeDetail.novel.id;
    try {
      const state = await loadNovelLibraryState(scopeInput);
      libraryState = await saveNovelLibraryState(setNovelChaptersRead(state, novelId, chapterIds, read), scopeInput);
    } catch (error) {
      console.error(error);
    }
  }

  function openChapterMenu(event: MouseEvent, chapterId: string) {
    event.preventDefault();
    // Read flags live in the library copy, so a novel only browsed has nothing to mark.
    if (!activeDetail?.inLibrary) return;
    chapterMenu = { x: event.clientX, y: event.clientY, chapterId };
  }

  function buildChapterMenu(chapterId: string): MenuEntry[] {
    const index = sortedNovelChapters.findIndex((chapter) => chapter.id === chapterId);
    const chapter = sortedNovelChapters[index];
    if (!chapter) return [];
    const above = sortedNovelChapters.slice(0, index + 1);
    const below = sortedNovelChapters.slice(index);
    const last = index === sortedNovelChapters.length - 1;
    const withState = (list: typeof sortedNovelChapters, unread: boolean) => list.filter((entry) => entry.unread === unread).map((entry) => entry.id);
    return [
      { label: chapter.unread ? translate("ui_markAsRead") : translate("ui_markAsUnread"), icon: chapter.unread ? CheckCircle : Circle, onClick: () => void setChaptersRead([chapter.id], chapter.unread) },
      { separator: true },
      { label: translate("ui_markAboveAsRead"), icon: CheckCircle, onClick: () => void setChaptersRead(withState(above, true), true), disabled: withState(above, true).length === 0 },
      { label: translate("ui_markAboveAsUnread"), icon: Circle, onClick: () => void setChaptersRead(withState(above, false), false), disabled: withState(above, false).length === 0 },
      { separator: true },
      { label: translate("ui_markBelowAsRead"), icon: CheckCircle, onClick: () => void setChaptersRead(withState(below, true), true), disabled: last || withState(below, true).length === 0 },
      { label: translate("ui_markBelowAsUnread"), icon: Circle, onClick: () => void setChaptersRead(withState(below, false), false), disabled: last || withState(below, false).length === 0 },
    ];
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
      title: translate("ui_novelRemovedFromLibrary"),
      body: activeDetail.novel.title,
    });
  }

  function openChapter(chapterId: string, chapterPath: string, chapterTitle: string) {
    if (!activeDetail || metadataOnly) return;
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
    return formatAppDate(d, { year: "numeric", month: "short", day: "numeric" });
  }

  function localizeNovelStatus(status: string | null): string | null {
    if (!status?.trim()) return null;
    return formatWorkStatus(status);
  }

  function chapterNumberLabel(order: number): string {
    return $_("detail.chapterNumber", { value: order + 1 });
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

  function isChapterDownloaded(chapter: { path: string }): boolean {
    return cachedKeys.has(novelChapterCacheKey(chapter.path));
  }

  async function reloadCachedKeys() {
    const sourceId = activeDetail?.novel.sourceId;
    if (!sourceId || metadataOnly) {
      cachedKeys = new Set();
      return;
    }
    try {
      const keys = await listCachedNovelChapterKeys(scopeInput, sourceId);
      if (activeDetail?.novel.sourceId === sourceId) cachedKeys = keys;
    } catch {
      cachedKeys = new Set();
    }
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function downloadChapters(chaptersToSave: typeof sortedNovelChapters) {
    if (!activeDetail || !displayedNovel || downloadingNovel || metadataOnly) return;
    dlOpen = false;
    if (chaptersToSave.length === 0) {
      addToast({ kind: "info", title: translate("ui_noChaptersToDownload"), body: displayedNovel.title });
      return;
    }
    const pending = chaptersToSave.filter((chapter) => !isChapterDownloaded(chapter));
    if (pending.length === 0) {
      addToast({ kind: "info", title: translate("novelDetail_download_nothingNew"), body: displayedNovel.title });
      return;
    }

    const sourceId = activeDetail.novel.sourceId;
    const title = displayedNovel.title;
    const novelId = activeDetail.novel.id;
    let progress: NovelDownloadProgress = {
      novelId,
      title,
      coverUrl: displayedNovel.coverUrl ?? null,
      pendingIds: pending.map((chapter) => chapter.id),
      done: 0,
      total: pending.length,
    };
    setNovelDownload(novelId, progress);
    try {
      const result = await downloadNovelChaptersForOffline(scopeInput, {
        sourceId,
        novelId,
        chapters: pending.map((chapter) => ({ id: chapter.id, path: chapter.path, title: chapter.title || null })),
      }, (chapterId, ok) => {
        progress = { ...progress, done: progress.done + 1, pendingIds: progress.pendingIds.filter((id) => id !== chapterId) };
        setNovelDownload(novelId, progress);
        const chapter = pending.find((entry) => entry.id === chapterId);
        if (ok && chapter && activeDetail?.novel.sourceId === sourceId) {
          cachedKeys = new Set([...cachedKeys, novelChapterCacheKey(chapter.path)]);
        }
      });
      if (result.failed.length > 0) {
        addToast({
          kind: "error",
          title: translate("novelDetail_download_failedTitle"),
          body: translate("novelDetail_download_failedBody", { count: result.failed.length, saved: result.saved.length }),
          duration: 7000,
        });
      } else {
        addToast({
          kind: "success",
          title: translate("novelDetail_download_savedTitle"),
          body: translate("novelDetail_download_savedBody", { title, count: result.saved.length }),
        });
      }
    } catch (error) {
      addToast({ kind: "error", title: translate("ui_novelDownloadFailed"), body: errorMessage(error) });
    } finally {
      setNovelDownload(novelId, null);
      void reloadCachedKeys();
    }
  }

  async function deleteDownloadedChapters(chaptersToDelete: typeof sortedNovelChapters) {
    if (!activeDetail || chaptersToDelete.length === 0) return;
    try {
      await deleteCachedNovelChapters(scopeInput, activeDetail.novel.sourceId, chaptersToDelete.map((chapter) => chapter.path));
      addToast({
        kind: "info",
        title: translate("novelDetail_download_deletedTitle"),
        body: chaptersToDelete.length === 1 ? chapterPrimaryLabel(chaptersToDelete[0]) : displayedNovel?.title ?? activeDetail.novel.title,
      });
    } catch (error) {
      addToast({ kind: "error", title: translate("novelDetail_download_deleteFailed"), body: errorMessage(error) });
    } finally {
      await reloadCachedKeys();
    }
  }

  async function deleteAllDownloads() {
    if (deletingAll) return;
    dlOpen = false;
    deletingAll = true;
    try {
      await deleteDownloadedChapters(sortedNovelChapters.filter(isChapterDownloaded));
    } finally {
      deletingAll = false;
    }
  }

  // Exports the chapters already saved offline into one HTML file, at a place the user picks.
  async function exportDownloadedAsHtml() {
    if (!activeDetail || !displayedNovel || downloadingNovel) return;
    dlOpen = false;
    const chaptersToExport = [...sortedNovelChapters]
      .sort((left, right) => left.order - right.order)
      .filter(isChapterDownloaded);
    if (chaptersToExport.length === 0) {
      addToast({ kind: "info", title: translate("ui_noChaptersToDownload"), body: translate("novelDetail_download_nothingToExport") });
      return;
    }

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const targetPath = await save({
        defaultPath: `${sanitizeFilename(displayedNovel.title)}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (typeof targetPath !== "string" || !targetPath.trim()) return;
      const parts: string[] = [];
      for (const chapter of chaptersToExport) {
        const result = await loadCachedNovelChapter(scopeInput, activeDetail.novel.sourceId, chapter.path);
        if (!result) continue;
        parts.push(`<section class="chapter"><h2>${escapeHtml(chapterPrimaryLabel(chapter))}</h2>${chapterSecondaryLabel(chapter) ? `<p class="subtitle">${escapeHtml(chapterSecondaryLabel(chapter))}</p>` : ""}<div class="content">${result.content}</div></section>`);
      }

      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(displayedNovel.title)}</title><style>body{margin:0;background:#111;color:#e8e4eb;font-family:Georgia,serif;line-height:1.7}.wrap{max-width:860px;margin:0 auto;padding:48px 28px}h1{font-family:Inter,Arial,sans-serif}h2{margin-top:42px;color:#d3c4ff}.subtitle{color:#9f98ad}.chapter{border-top:1px solid #2c2933}.content img{max-width:100%;height:auto}</style></head><body><main class="wrap"><h1>${escapeHtml(displayedNovel.title)}</h1>${parts.join("\n")}</main></body></html>`;
      await invoke("write_file_base64", { path: targetPath, bytesBase64: encodeBase64Utf8(html) });
      addToast({ kind: "success", title: translate("novelDetail_download_exported"), body: targetPath, duration: 4500 });
    } catch (error) {
      addToast({
        kind: "error",
        title: translate("ui_novelDownloadFailed"),
        body: error instanceof Error ? error.message : translate("ui_epigraphCouldNotExportThisNovel"),
      });
    }
  }

  async function refreshNovel() {
    const current = activeDetail;
    if (!current || metadataOnly || refreshing) return;
    refreshing = true;
    try {
      const result = await refreshNovelDetailFromSource(scopeInput, current.novel, current.inLibrary);
      if (result.state) {
        libraryState = result.state;
        bumpContentSetupVersion();
      }
      const latest = store.activeNovelDetail;
      if (latest && latest.novel.id === current.novel.id && result.detail.id === current.novel.id) {
        setActiveNovelDetail({ ...latest, novel: result.detail });
      }
      addToast({ kind: "success", title: translate("ui_chaptersRefreshed") });
      void reloadCachedKeys();
    } catch (error) {
      const message = sourceAccessErrorMessage(error);
      const challenge = isConfirmedAntibotChallengeMessage(message);
      addToast({
        kind: "error",
        title: translate("ui_refreshFailed"),
        body: challenge
          ? store.settings.flareSolverrEnabled
            ? translate("ui_checkFlaresolverrAndRetryThisSource")
            : translate("novelSources_errors_blockedFlareDisabled")
          : message,
        duration: challenge ? 7000 : undefined,
        action: challenge ? { label: translate("detail_actions_openSettings"), run: () => setSettingsOpen(true) } : undefined,
      });
    } finally {
      refreshing = false;
    }
  }

  function chaptersFromResume(count: number) {
    const readingOrder = [...(displayedNovel?.chapters ?? [])].sort((left, right) => left.order - right.order);
    const start = readingOrder.find((chapter) => chapter.id === resumeChapter?.id) ?? readingOrder[0];
    return nextChaptersInReadingOrder(readingOrder, start, count);
  }

  function downloadNext(count: number) {
    void downloadChapters(chaptersFromResume(count));
  }

  function downloadUnread() {
    void downloadChapters(sortedNovelChapters.filter((chapter) => chapter.unread));
  }

  function downloadAll() {
    void downloadChapters(sortedNovelChapters);
  }

  const downloadNextOptions = $derived(
    resumeChapter
      ? [5, 10, 25].map((amount) => ({
          amount,
          available: chaptersFromResume(amount).filter((chapter) => !isChapterDownloaded(chapter)).length,
        }))
      : [],
  );

  function downloadRange(fromText: string, toText: string) {
    const from = Number(fromText.trim());
    const to = Number(toText.trim());
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      addToast({ kind: "info", title: translate("ui_noChaptersToDownload"), body: displayedNovel?.title });
      return;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const selected = sortedNovelChapters.filter((chapter) => {
      const number = chapter.order + 1;
      return number >= lo && number <= hi;
    });
    void downloadChapters(selected);
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

  // Sources that were installed or updated since the last check get their migration-safety smoke
  // here, so the Migrate button leaves its "still checking" state instead of waiting forever.
  $effect(() => {
    const scope = scopeInput;
    void classifyUnclassifiedNovelSources(scope)
      .then((wrote) => (wrote ? loadNovelSourceClassificationState(scope) : null))
      .then((state) => { if (state) sourceClassificationState = state; })
      .catch(() => {});
  });

  $effect(() => {
    void activeDetail?.novel.sourceId;
    void scopeInput;
    void reloadCachedKeys();
  });

  $effect(() => {
    const sourceId = activeDetail?.novel.sourceId;
    sourceSite = null;
    if (!sourceId || metadataOnly) return;
    void loadInstalledNovelSources(scopeInput)
      .then((sources) => {
        if (activeDetail?.novel.sourceId === sourceId) sourceSite = sources.find((source) => source.pluginId === sourceId)?.site ?? null;
      })
      .catch(() => {});
  });

  // A detached reader window saves through the main window while this page stays open.
  $effect(() => {
    const scope = scopeInput;
    const handleReaderChangesSaved = (event: Event) => {
      if ((event as CustomEvent<{ scopeKey?: string }>).detail?.scopeKey !== libraryState.scopeKey) return;
      libraryState = peekNovelLibraryState(scope);
    };
    globalThis.addEventListener?.(NOVEL_READER_CHANGES_SAVED_EVENT, handleReaderChangesSaved);
    return () => globalThis.removeEventListener?.(NOVEL_READER_CHANGES_SAVED_EVENT, handleReaderChangesSaved);
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
    fallbackLabel={$_("detail.fallbackNovel")}
    statusLabel={localizeNovelStatus(displayedNovel?.status ?? null)}
    sourceLabel={sourceName}
    sourceLine={sourceName ? $_("detail.novelSourceLine", { source: sourceName }) : null}
    languageLabel={activeDetail.novel.source.lang ? activeDetail.novel.source.lang.toUpperCase() : null}
    description={displayedNovel?.description ?? null}
    tags={displayedNovel?.tags ?? []}
    detailsOpen={detailsOpen}
    progressLabel={novelCounts.total > 0 ? $_("detail.novelProgress", { read: novelCounts.read, total: novelCounts.total }) : null}
    progressPercent={(readStats && activeDetail.inLibrary ? readStats.progressPercent : novelCounts.progressPercent) * 100}
    metrics={[
      { label: $_("detail.metric.chapters"), value: String(novelCounts.total) },
      { label: $_("detail.metric.unread"), value: String(novelCounts.unread) },
      { label: $_("detail.stats.downloaded"), value: String(downloadedCount) },
    ]}
    onBack={() => setActiveNovelDetail(null)}
    onDetailsToggle={() => detailsOpen = !detailsOpen}
  >
    {#snippet topbarActions()}
      {#if novelUrl}
        <a href={novelUrl} target="_blank" rel="noreferrer" class="series-icon" title={$_("detail.actions.openInBrowser")}>
          <ArrowSquareOut size={14} weight="light" />
        </a>
      {/if}
      {#if !metadataOnly}
        <button class="series-icon" type="button" onclick={refreshNovel} disabled={refreshing} title={$_("detail.actions.refreshChapters")}>
          <ArrowsClockwise size={14} weight="light" class={refreshing ? "anim-spin" : ""} />
        </button>
      {/if}
    {/snippet}

    {#snippet primaryAction()}
      <button class="series-primary" disabled={!resumeChapter} onclick={() => resumeChapter && openChapter(resumeChapter.id, resumeChapter.path, resumeChapter.title)}>
        <Play size={13} weight="fill" />
        {resumeChapter ? (lastReadChapterId ? $_("detail.continueNovelChapter", { number: resumeChapter.order + 1 }) : $_("detail_actions_startReading")) : $_("detail_empty_noChapters")}
      </button>
    {/snippet}

    {#snippet secondaryActions()}
      {#if !metadataOnly}
        <button class="series-action series-icon-action" class:active={activeDetail.inLibrary} onclick={activeDetail.inLibrary ? removeFromLibrary : addToLibrary} title={activeDetail.inLibrary ? $_("detail.status.inLibrary") : $_("detail.actions.addToLibrary")} aria-label={activeDetail.inLibrary ? $_("detail.status.inLibrary") : $_("detail.actions.addToLibrary")}>
          <BookmarkSimple size={13} weight={activeDetail.inLibrary ? "fill" : "light"} />
        </button>
        <button class="series-action series-icon-action" type="button" onclick={() => trackingOpen = true} title={$_("home_sections_tracking")} aria-label={$_("home_sections_tracking")}>
          <ChartLineUp size={13} weight="light" />
        </button>
      {/if}
    {/snippet}

    {#snippet utilityActions()}
      {#if !metadataOnly}
      <div class="fp-wrap" bind:this={folderPickerRef}>
        <button class="series-utility" class:active={hasFolders} type="button" onclick={() => folderPickerOpen = !folderPickerOpen} title={$_("detail_actions_folders")}>
          <FolderSimplePlus size={13} weight={hasFolders ? "fill" : "light"} />
          {$_("detail_actions_folder")}
        </button>
        {#if folderPickerOpen}
          <div class="fp-menu">
            {#if allBookCategories.length === 0 && !folderCreating}
              <NocturneState layout="compact" tone="info" icon="folder" eyebrow={$_("detail.actions.folders")} title={$_("detail_folders_emptyTitle")} body={$_("feedback.createFolderNovel")} />
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
                <input class="fp-input" placeholder={$_("detail_folders_namePlaceholder")} bind:value={folderNewName} onkeydown={(event) => { if (event.key === "Enter") createFolder(); if (event.key === "Escape") closeFolderPicker(); }} />
                <button class="fp-confirm" type="button" onclick={createFolder} disabled={!folderNewName.trim()}>{$_("detail_folders_add")}</button>
                <button class="fp-cancel" type="button" onclick={() => { folderCreating = false; folderNewName = ""; }} aria-label={$_("detail_folders_cancelCreation")}>
                  <X size={12} weight="light" />
                </button>
              </div>
            {:else}
              <button class="fp-new" type="button" onclick={() => folderCreating = true}>{$_("detail_folders_new")}</button>
            {/if}
          </div>
        {/if}
      </div>
      <button class="series-utility" class:active={linkedNovelIds.length > 0} type="button" onclick={openLinkPicker} title={$_("ui_linkAsSameNovel")}>
        <Link size={13} weight={linkedNovelIds.length > 0 ? "fill" : "light"} />
        {$_("ui_link")}{linkedNovelIds.length > 0 ? ` (${linkedNovelIds.length})` : ""}
      </button>
      <div class="dl-wrap">
        <button class="series-utility dl-unified-btn" class:active={dlOpen || downloadingNovel} class:dl-downloading={downloadingNovel} type="button" onclick={() => dlOpen = !dlOpen} title={$_("detail_download_options")}>
          {#if downloadingNovel}<CircleNotch size={13} weight="light" class="anim-spin" />{:else}<DownloadSimple size={13} weight={downloadedCount > 0 ? "fill" : "light"} />{/if}
          {$_("detail_actions_download")}
          <span class="dl-unified-count" class:dl-unified-count-empty={!downloadingNovel && downloadedCount === 0}>{downloadingNovel ? downloadingIds.size : downloadedCount}</span>
        </button>
        {#if dlOpen}
          <DetailDownloadMenu
            downloaded={downloadedCount}
            total={novelCounts.total}
            status={downloadProgress ? $_("novelDetail_download_progress", { done: downloadProgress.done, total: downloadProgress.total }) : null}
            nextFrom={resumeChapter ? resumeChapter.order + 1 : null}
            nextOptions={downloadNextOptions}
            unreadCount={sortedNovelChapters.filter((chapter) => chapter.unread && !isChapterDownloaded(chapter)).length}
            notDownloadedCount={Math.max(0, novelCounts.total - downloadedCount)}
            busy={downloadingNovel}
            deleting={deletingAll}
            extraActions={[{
              label: $_("novelDetail_download_exportHtml"),
              count: downloadedCount,
              disabled: downloadedCount === 0 || downloadingNovel,
              onSelect: () => void exportDownloadedAsHtml(),
            }]}
            onNext={downloadNext}
            onRange={downloadRange}
            onUnread={downloadUnread}
            onAll={downloadAll}
            onDeleteAll={() => void deleteAllDownloads()}
            onClose={() => dlOpen = false}
          />
        {/if}
      </div>
      <button class="series-utility" disabled={!activeDetail.inLibrary || Boolean(migrationBlocker)} title={migrationBlocker ?? $_("novelDetail_migrateTitle")} aria-label={$_("ui_migrateThisNovelToAnotherSource")} onclick={() => migrateOpen = true}>
        <ArrowsLeftRight size={15} weight="light" />
        {$_("detail_actions_migrate")}
      </button>
      {/if}
    {/snippet}

    {#snippet detailsExtra()}
      <div class="v3-details-stack">
        {#if sourceName}<div class="detail-row"><span class="detail-key">{$_("detail_fields_source")}</span><span class="detail-val">{sourceName}</span></div>{/if}
        {#if displayedNovel?.status}<div class="detail-row"><span class="detail-key">{$_("downloads_summary_status")}</span><span class="detail-val">{localizeNovelStatus(displayedNovel.status)}</span></div>{/if}
        {#if displayedNovel?.author}<div class="detail-row"><span class="detail-key">{$_("library_sort_author")}</span><span class="detail-val">{displayedNovel.author}</span></div>{/if}
        {#if activeDetail.novel.source.lang}<div class="detail-row"><span class="detail-key">{$_("sources_table_language")}</span><span class="detail-val">{activeDetail.novel.source.lang.toUpperCase()}</span></div>{/if}
        {#if activeDetail.inLibrary && lastReadChapterId}<div class="detail-row"><span class="detail-key">{$_("home_continue_resume")}</span><span class="detail-val">{$_("ui_lastSavedChapterAvailable")}</span></div>{/if}
      </div>
    {/snippet}

    {#snippet chapterControls()}
      <div class="list-header-left">
        <div class="sort-wrap">
          <button class="series-toolbar-btn" type="button" onclick={() => sortMenuOpen = !sortMenuOpen}>
            {#if chapterSortDir === "desc"}<SortDescending size={14} weight="light" />{:else}<SortAscending size={14} weight="light" />{/if}
            {$_("library_sort")}
            <CaretDown size={10} weight="light" />
          </button>
          {#if sortMenuOpen}
            <div class="sort-menu" role="presentation" onmouseleave={() => sortMenuOpen = false}>
              <p class="sort-section-label">{$_("bookDetail_chapterOrder")}</p>
              <button class="sort-option" class:active={chapterSortDir === "desc"} onclick={() => setSortDir("desc")}>{$_("library_sort_descending")}</button>
              <button class="sort-option" class:active={chapterSortDir === "asc"} onclick={() => setSortDir("asc")}>{$_("library_sort_ascending")}</button>
            </div>
          {/if}
        </div>
      </div>
      <div class="list-header-right">
        <div class="view-segmented" aria-label={$_("detail_chapterView")}>
          <button class="series-icon" class:active={viewMode === "list"} onclick={() => viewMode = "list"} title={$_("detail_view_list")}><List size={14} weight="light" /></button>
          <button class="series-icon" class:active={viewMode === "grid"} onclick={() => viewMode = "grid"} title={$_("detail_view_grid")}><SquaresFour size={14} weight="light" /></button>
        </div>
      </div>
    {/snippet}

    {#snippet chapterList()}
      {#if !displayedNovel || displayedNovel.chapters.length === 0}
        <NocturneState layout="compact" tone="info" icon="books" eyebrow={$_("detail.stats.chapters")} title={$_("ui_noChapterMetadata")} body={$_("feedback.noChapterMetadataBody")} />
      {:else}
        <div class={viewMode === "grid" ? "ch-grid v3-ch-grid" : "ch-list v3-ch-list"}>
          {#if viewMode === "grid"}
            {#each sortedNovelChapters as chapter (chapter.id)}
              {@const isCurrent = chapter.id === lastReadChapterId}
              {@const isBookmarked = bookmarkedChapterIds.has(chapter.id)}
              <button class="grid-cell novel-grid-cell" class:read={!chapter.unread} class:in-progress={isCurrent} onclick={() => openChapter(chapter.id, chapter.path, chapter.title)} oncontextmenu={(event) => openChapterMenu(event, chapter.id)} title={chapterTitle(chapter)}>
                <span class="grid-cell-title">{chapterPrimaryLabel(chapter)}</span>
                {#if chapterSecondaryLabel(chapter)}<span class="grid-cell-sub">{chapterSecondaryLabel(chapter)}</span>{/if}
                <span class="chapter-progress" class:is-empty={chapter.unread}><span class="chapter-progress__fill" style={`width: ${chapter.unread ? 0 : 100}%`}></span></span>
                {#if downloadingIds.has(chapter.id)}<span class="grid-cell-spinner"><CircleNotch size={10} weight="light" class="anim-spin" /></span>{:else if isChapterDownloaded(chapter)}<span class="grid-cell-dl" title={$_("detail.stats.downloaded")}></span>{/if}
                {#if isCurrent}<span class="grid-cell-mark novel-current-dot" title={$_("bookDetail_filter_current")}></span>{/if}
                {#if isBookmarked}<span class="grid-cell-dot" title={$_("bookDetail_filter_bookmarked")}></span>{/if}
              </button>
            {/each}
          {:else}
            <div class="chapter-table-header">
              <span>{$_("detail_table_chapter")}</span>
              <span>{$_("detail_fields_source")}</span>
              <span>{$_("detail_table_date")}</span>
              <span>{$_("downloads_summary_status")}</span>
            </div>
            {#each pageChapters as chapter (chapter.id)}
              {@const isCurrent = chapter.id === lastReadChapterId}
              {@const isBookmarked = bookmarkedChapterIds.has(chapter.id)}
              {@const isDownloaded = isChapterDownloaded(chapter)}
              <div role="button" tabindex="0" class="ch-row v3-ch-row" class:read={!chapter.unread} onclick={() => openChapter(chapter.id, chapter.path, chapter.title)} onkeydown={(event) => event.key === "Enter" && openChapter(chapter.id, chapter.path, chapter.title)} oncontextmenu={(event) => openChapterMenu(event, chapter.id)}>
                <div class="ch-left">
                  <span class="ch-title">
                    <span class="ch-name">{chapterPrimaryLabel(chapter)}</span>
                    {#if isBookmarked}<span class="ch-bookmark" role="img" title={$_("bookDetail_filter_bookmarked")} aria-label={$_("bookDetail_filter_bookmarked")}><BookmarkSimple size={12} weight="fill" /></span>{/if}
                  </span>
                  {#if chapterSecondaryLabel(chapter) || isCurrent}
                    <div class="ch-meta">
                      {#if chapterSecondaryLabel(chapter)}<span class="ch-meta-item">{chapterSecondaryLabel(chapter)}</span>{/if}
                      {#if isCurrent}<span class="ch-meta-item">{$_("bookDetail_filter_current")}</span>{/if}
                    </div>
                  {/if}
                  <div class="chapter-progress" class:is-empty={chapter.unread}><div class="chapter-progress__fill" style={`width: ${chapter.unread ? 0 : 100}%`}></div></div>
                </div>
                <span class="ch-provider">{sourceName ?? ""}</span>
                <span class="ch-date">{formatDate(chapter.releaseTime)}</span>
                <div class="ch-status" class:ch-status-downloaded-row={isDownloaded} class:ch-status-read-row={!chapter.unread}>
                  <span class="ch-status-read">{#if !chapter.unread}<CheckCircle size={14} weight="fill" class="read-icon" />{/if}</span>
                  <span class="ch-status-main">
                    {#if isDownloaded}
                      <DownloadSimple size={13} weight="fill" title={$_("detail.stats.downloaded")} />
                    {:else if downloadingIds.has(chapter.id)}
                      <CircleNotch size={14} weight="light" class="anim-spin enqueue-icon" />
                    {:else if !metadataOnly}
                      <button class="dl-btn" type="button" disabled={downloadingNovel} onclick={(event) => { event.stopPropagation(); void downloadChapters([chapter]); }} title={$_("detail.actions.download")}><DownloadSimple size={13} weight="light" /></button>
                    {/if}
                  </span>
                  <span class="ch-status-action">
                    {#if isDownloaded}
                      <button class="dl-btn dl-btn-delete" type="button" disabled={downloadingNovel} onclick={(event) => { event.stopPropagation(); void deleteDownloadedChapters([chapter]); }} title={$_("detail.download.delete")}><Trash size={13} weight="light" /></button>
                    {/if}
                  </span>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    {/snippet}

    {#snippet chapterFooter()}
      {#if displayedNovel && displayedNovel.chapters.length > 0 && viewMode === "list" && totalPages >= 1}
        <div class="pagination-bottom v3-pagination">
          <button class="series-page-btn" onclick={() => chapterPage = Math.max(1, chapterPage - 1)} disabled={chapterPage === 1}>{$_("library_pagination_prev")}</button>
          <span class="page-num">{chapterPage} / {totalPages}</span>
          <button class="series-page-btn" onclick={() => chapterPage = Math.min(totalPages, chapterPage + 1)} disabled={chapterPage === totalPages}>{$_("library_pagination_next")}</button>
        </div>
      {/if}
    {/snippet}
  </SeriesDetailV3Shell>
{/if}

{#if chapterMenu}<ContextMenu x={chapterMenu.x} y={chapterMenu.y} items={buildChapterMenu(chapterMenu.chapterId)} onClose={() => chapterMenu = null} />{/if}

{#if trackingOpen && activeDetail && !metadataOnly}
  <NovelTrackingPanel
    title={activeDetail.novel.title}
    sourceNovelId={activeDetail.novel.id}
    contentLabel={$_("ui_novel")}
    onClose={() => trackingOpen = false}
  />
{/if}

{#if linkPickerOpen && activeDetail}
  <div class="link-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) closeLinkPicker(); }}>
    <div class="link-modal" role="dialog" aria-modal="true" aria-label={$_("ui_linkNovels")}>
      <div class="link-header">
        <div>
          <span class="link-title">{$_("ui_linkAsSameNovel")}</span>
          <p class="link-subtitle">{activeDetail.novel.title}</p>
        </div>
        <button class="link-close" type="button" onclick={closeLinkPicker} aria-label={$_("ui_closeLinkPicker")}>
          <X size={14} weight="light" />
        </button>
      </div>
      <div class="link-search-wrap">
        <input class="link-search" placeholder={$_("ui_searchYourNovelLibrary")} bind:value={linkSearch} />
      </div>
      <div class="link-list">
        {#if linkPickerResults.length === 0}
          <NocturneState layout="compact" tone="info" icon="search" eyebrow={$_("feedback.links")} title={$_("ui_noNovelsToLink")} body={$_("feedback.addNovelBeforeLink")} />
        {:else}
          {#each linkPickerResults as novel (novel.id)}
            {@const isLinked = linkedNovelIds.includes(novel.id)}
            <button class="link-row" class:link-row-linked={isLinked} type="button" onclick={() => toggleNovelLink(novel.id)}>
              {#if novel.coverUrl}<img class="link-thumb" src={novel.coverUrl} alt="" />{:else}<span class="link-thumb link-thumb-empty">N</span>{/if}
              <span class="link-info">
                <span class="link-novel-title">{novel.title}</span>
                <span class="link-source">{novel.source?.sourceName ?? novel.source?.pluginName ?? novel.author ?? $_("detail.fallbackNovel")}</span>
              </span>
              <span class="link-status">{isLinked ? $_("detail.link.linked") : $_("detail.link.link")}</span>
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
    border-radius: var(--component-detail-novel-current-dot-border-radius);
    background: var(--component-detail-novel-current-dot-background);
  }

  .grid-cell-dl,
  .grid-cell-dot {
    width: 5px;
    height: 5px;
    border-radius: var(--component-detail-grid-cell-dot-border-radius);
    background: var(--component-detail-grid-cell-dot-background);
  }

  .grid-cell-dl,
  .grid-cell-dot,
  .grid-cell-mark,
  .grid-cell-spinner {
    position: absolute;
    top: 8px;
    right: 8px;
  }

  .grid-cell-mark {
    right: 18px;
  }

  .grid-cell-dot {
    right: 28px;
    opacity: var(--component-detail-grid-cell-dot-opacity);
  }

  .grid-cell-spinner {
    top: 6px;
    right: 6px;
    color: var(--component-detail-grid-cell-spinner-color);
  }

  .dl-wrap {
    position: relative;
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
    border-radius: var(--component-detail-dl-unified-count-border-radius);
    background: var(--component-detail-dl-unified-count-background);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
  }

  .dl-unified-count-empty {
    display: none;
  }

  .link-backdrop {
    position: fixed;
    z-index: var(--component-detail-link-backdrop-z-index);
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--component-detail-link-backdrop-background-2);
    backdrop-filter: var(--component-detail-novel-link-backdrop-blur);
  }

  .link-modal {
    width: min(580px, calc(100vw - 48px));
    max-height: min(680px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: var(--component-detail-link-modal-border-2);
    border-radius: var(--component-detail-link-modal-border-radius-2);
    background: var(--component-detail-link-modal-background-2);
    box-shadow: var(--component-detail-link-modal-box-shadow-2);
  }

  .link-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 16px 18px;
    border-bottom: var(--component-detail-link-header-border-bottom-2);
  }

  .link-title,
  .link-novel-title {
    color: var(--component-detail-link-novel-title-color);
    font-size: 13px;
    font-weight: 800;
  }

  .link-subtitle {
    margin: 4px 0 0;
    color: var(--component-detail-link-subtitle-color);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: none;
  }

  .link-close {
    width: 34px;
    height: 34px;
    border: var(--component-detail-link-close-border-2);
    border-radius: var(--component-detail-link-close-border-radius-2);
    color: var(--component-detail-link-close-color-3);
    background: var(--component-detail-link-close-background-3);
    transition: background 150ms ease, color 150ms ease, transform 150ms ease;
  }

  .link-close:hover {
    color: var(--component-detail-link-close-color-4);
    background: var(--component-detail-link-close-background-2);
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
    border: var(--component-detail-link-search-border-2);
    border-radius: var(--component-detail-link-search-border-radius);
    color: var(--component-detail-link-search-color);
    background: var(--component-detail-link-search-background-2);
    outline: none;
  }

  .link-search:focus {
    border-color: var(--component-detail-link-search-border-color);
    box-shadow: var(--component-detail-link-search-box-shadow);
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
    border-radius: var(--component-detail-link-row-border-radius-2);
    color: var(--component-detail-link-row-color);
    background: transparent;
    text-align: left;
    transition: background 150ms ease, border-color 150ms ease, transform 150ms ease;
  }

  .link-row:hover,
  .link-row-linked {
    background: var(--component-detail-link-row-linked-background-2);
  }

  .link-row:hover {
    border-color: var(--component-detail-link-row-border-color-2);
  }

  .link-row:active {
    transform: scale(0.995);
  }

  .link-thumb {
    width: 36px;
    height: 50px;
    flex: 0 0 auto;
    border-radius: var(--component-detail-link-thumb-border-radius-2);
    object-fit: cover;
    background: var(--component-detail-link-thumb-background);
  }

  .link-thumb-empty {
    display: grid;
    place-items: center;
    color: var(--component-detail-link-thumb-empty-color);
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
    color: var(--component-detail-link-source-color);
    font-size: 11px;
  }

  .link-status {
    color: var(--component-detail-link-status-color-2);
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
