<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { formatWorkStatus } from "../../lib/i18n/format";
  import { onMount, onDestroy } from "svelte";
  import { X, BookmarkSimple, ArrowSquareOut, Play, CircleNotch, Books, CaretDown, FolderSimplePlus, Folder, LinkSimpleHorizontalBreak } from "phosphor-svelte";
  import { gql } from "../../lib/client";
  import { GET_MANGA, GET_CHAPTERS, UPDATE_MANGA, ENQUEUE_CHAPTERS_DOWNLOAD, GET_CATEGORIES, CREATE_CATEGORY, UPDATE_MANGA_CATEGORIES } from "../../lib/queries";
  import { GET_ALL_MANGA } from "../../lib/queries";
  import { cache, CACHE_KEYS } from "../../lib/cache";
  import { getCategoryDisplayName, isCompletedCategory, normalizeCategories } from "../../lib/library/categories";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { fetchSourceMangaChapters, fetchSourceMangaDetails } from "../../lib/manga/runtime";
  import { store, openReader, addToast, linkManga, unlinkManga, setPreviewManga, openMangaDetail, openSearchBrowseFeatured, checkAndMarkCompleted as storeCheckAndMarkCompleted } from "../../store/state.svelte";
  import NocturneState from "./NocturneState.svelte";
  import type { Manga, Chapter, Category } from "../../lib/types";

  let manga: Manga | null      = $state(null);
  let chapters: Chapter[]      = $state([]);
  let loadingDetail            = $state(false);
  let loadingChapters          = $state(false);
  let togglingLib              = $state(false);
  let descExpanded             = $state(false);
  let folderOpen               = $state(false);
  let newFolderName            = $state("");
  let creatingFolder           = $state(false);
  let allCategories:  Category[] = $state([]);
  let mangaCategories: Category[] = $state([]);
  let catsLoading:    boolean    = $state(false);
  let queueingAll              = $state(false);
  let fetchError: string|null  = $state(null);
  let folderRef: HTMLDivElement | undefined = $state();

  let linkPickerOpen  = $state(false);
  let linkSearch      = $state("");
  let allMangaForLink: Manga[] = $state([]);
  let loadingLinkList = $state(false);

  const linkedIds = $derived(store.previewManga ? (store.settings.mangaLinks?.[store.previewManga.id] ?? []) : []);

  const linkPickerResults = $derived.by(() => {
    const others   = allMangaForLink.filter((m) => m.id !== store.previewManga?.id);
    const q        = linkSearch.trim().toLowerCase();
    const filtered = q ? others.filter(m => m.title.toLowerCase().includes(q)) : others;
    const linked   = filtered.filter(m => linkedIds.includes(m.id));
    const rest     = filtered.filter(m => !linkedIds.includes(m.id)).slice(0, 30);
    return [...linked, ...rest];
  });

  async function openLinkPicker() {
    linkPickerOpen = true; linkSearch = "";
    if (allMangaForLink.length) return;
    loadingLinkList = true;
    gql<{ mangas: { nodes: Manga[] } }>(GET_ALL_MANGA)
      .then(d => { allMangaForLink = d.mangas.nodes; })
      .catch(console.error)
      .finally(() => { loadingLinkList = false; });
  }

  function closeLinkPicker() { linkPickerOpen = false; linkSearch = ""; }

  function handleLink(other: Manga) {
    if (!store.previewManga) return;
    if (linkedIds.includes(other.id)) unlinkManga(store.previewManga.id, other.id);
    else linkManga(store.previewManga.id, other.id);
  }

  let detailAbort: AbortController | null  = null;
  let chapterAbort: AbortController | null = null;

  function close() {
    detailAbort?.abort(); chapterAbort?.abort();
    setPreviewManga(null);
    manga = null; chapters = []; descExpanded = false;
    folderOpen = false; creatingFolder = false; newFolderName = ""; fetchError = null;
  }

  function formatDate(d: Date) { return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }

  const displayManga    = $derived(manga ?? store.previewManga);
  const totalCount      = $derived(chapters.length);
  const readCount       = $derived(chapters.filter((c) => c.isRead).length);
  const unreadCount     = $derived(totalCount - readCount);
  const downloadedCount = $derived(chapters.filter((c) => c.isDownloaded).length);
  const bookmarkCount   = $derived(chapters.filter((c) => c.isBookmarked).length);
  const inLibrary       = $derived(resolveLibraryMembership(manga, store.previewManga));
  const scanlators      = $derived([...new Set(chapters.map((c) => c.scanlator).filter((s): s is string => !!s?.trim()))]);
  const uploadDates     = $derived(chapters.map((c) => c.uploadDate ? new Date(c.uploadDate).getTime() : null).filter((d): d is number => d !== null && !isNaN(d)));
  const firstUpload     = $derived(uploadDates.length ? new Date(Math.min(...uploadDates)) : null);
  const lastUpload      = $derived(uploadDates.length ? new Date(Math.max(...uploadDates)) : null);
  const statusLabel     = $derived(displayManga?.status ? formatWorkStatus(displayManga.status) : null);
  const assignedFolders = $derived(normalizeCategories(mangaCategories).filter(c => c.id !== 0));

  function resolveLibraryMembership(loadedManga: Manga | null, previewManga: Manga | null): boolean {
    return loadedManga?.inLibrary ?? previewManga?.inLibrary ?? false;
  }

  const continueChapter = $derived.by(() => {
    if (!chapters.length) return null;
    const inProgress = chapters.find((c) => !c.isRead && (c.lastPageRead ?? 0) > 0);
    if (inProgress) return { ch: inProgress, label: `Continue · Ch.${inProgress.chapterNumber}` };
    const firstUnread = chapters.find((c) => !c.isRead);
    if (firstUnread) return { ch: firstUnread, label: `Start · Ch.${firstUnread.chapterNumber}` };
    return { ch: chapters[0], label: translate("detail_actions_readAgain") };
  });

  $effect(() => { if (store.previewManga) { load(store.previewManga.id); loadCategories(store.previewManga.id); } });

  async function load(id: number) {
    detailAbort?.abort(); chapterAbort?.abort();
    const dCtrl = new AbortController(), cCtrl = new AbortController();
    detailAbort = dCtrl; chapterAbort = cCtrl;
    manga = store.previewManga as Manga;
    chapters = []; descExpanded = false; fetchError = null;
    loadingDetail = true; loadingChapters = true;

    (async (): Promise<Manga> => {
      const key = CACHE_KEYS.MANGA(id);
      if (cache.has(key)) return cache.get(key, () => Promise.resolve(store.previewManga as Manga)) as Promise<Manga>;
      try {
        const d = await fetchSourceMangaDetails({ id, sourceId: store.previewManga?.source?.id }, dCtrl.signal);
        return d.fetchManga.manga;
      } catch (e: any) {
        if (e?.name === "AbortError") throw e;
        const local = await gql<{ manga: Manga }>(GET_MANGA, { id }, dCtrl.signal).then((d) => d.manga);
        if (local) return local;
        throw new Error("Could not load manga details");
      }
    })().then((fullManga) => {
      if (dCtrl.signal.aborted) return;
      if (!cache.has(CACHE_KEYS.MANGA(id))) cache.get(CACHE_KEYS.MANGA(id), () => Promise.resolve(fullManga));
      manga = fullManga; loadingDetail = false;
    }).catch((e) => {
      if (e?.name === "AbortError") return;
      manga = store.previewManga as Manga;
      fetchError = translate("preview_cachedDetails");
      loadingDetail = false;
    });

    gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: id }, cCtrl.signal)
      .then(async (d) => {
        if (cCtrl.signal.aborted) return;
        let nodes = [...d.chapters.nodes].sort((a, b) => a.sourceOrder - b.sourceOrder);
        if (nodes.length === 0) {
          try {
            const fetched = await fetchSourceMangaChapters({ mangaId: id, sourceId: manga?.source?.id }, cCtrl.signal);
            if (!cCtrl.signal.aborted) nodes = [...fetched.fetchChapters.chapters].sort((a, b) => a.sourceOrder - b.sourceOrder);
          } catch (e: any) { if (e?.name === "AbortError") return; }
        }
        if (!cCtrl.signal.aborted) {
          chapters = nodes;
          if (nodes.length > 0) checkAndMarkCompleted(id, nodes);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cCtrl.signal.aborted) loadingChapters = false; });
  }

  async function toggleLibrary() {
    if (!manga) return;
    togglingLib = true;
    const next = !manga.inLibrary;
    await gql(UPDATE_MANGA, { id: manga.id, inLibrary: next }).catch(console.error);
    manga = { ...manga, inLibrary: next };
    cache.clear(CACHE_KEYS.MANGA(manga.id));
    cache.get(CACHE_KEYS.MANGA(manga.id), () => Promise.resolve(manga!));
    cache.clear(CACHE_KEYS.LIBRARY);
    togglingLib = false;
    addToast({ kind: "success", title: next ? translate("ui_addedToLibrary") : translate("ui_removedFromLibrary_520e5a01") });
  }

  async function downloadAll() {
    const ids = chapters.filter((c) => !c.isDownloaded && !c.isRead).map((c) => c.id);
    if (!ids.length) return;
    queueingAll = true;
    await gql(ENQUEUE_CHAPTERS_DOWNLOAD, { chapterIds: ids }).catch(console.error);
    addToast({ kind: "download", title: translate("ui_downloading"), body: translate("preview_chaptersQueued", { count: ids.length }) });
    queueingAll = false;
  }

  function openSeriesDetail() {
    if (!displayManga) return;
    openMangaDetail(displayManga);
    close();
  }

  function loadCategories(mangaId: number) {
    catsLoading = true;
    gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)
      .then(d => {
        allCategories   = normalizeCategories(d.categories.nodes.filter(c => c.id !== 0));
        mangaCategories = normalizeCategories(allCategories.filter(c => c.mangas?.nodes.some(m => m.id === mangaId)));
      })
      .catch(console.error)
      .finally(() => { catsLoading = false; });
  }

  async function checkAndMarkCompleted(mangaId: number, chaps: Chapter[]) {
    await storeCheckAndMarkCompleted(mangaId, chaps, allCategories, gql, UPDATE_MANGA_CATEGORIES, UPDATE_MANGA);
    // Sync local mangaCategories state after the mutation
    if (chaps.length) {
      const allRead   = chaps.every(c => c.isRead);
      const completed = allCategories.find(isCompletedCategory);
      if (completed) {
        const inCompleted = mangaCategories.some(c => c.id === completed.id);
        if (allRead && !inCompleted)  mangaCategories = normalizeCategories([...mangaCategories, completed]);
        else if (!allRead && inCompleted) mangaCategories = mangaCategories.filter(c => c.id !== completed.id);
      }
    }
  }

  async function toggleCategory(cat: Category) {
    if (!store.previewManga) return;
    const mangaId = store.previewManga.id;
    const inCat   = mangaCategories.some(c => c.id === cat.id);
    await gql(UPDATE_MANGA_CATEGORIES, {
      mangaId,
      addTo:      inCat ? [] : [cat.id],
      removeFrom: inCat ? [cat.id] : [],
    }).catch(console.error);
    mangaCategories = normalizeCategories(
      inCat
        ? mangaCategories.filter(c => c.id !== cat.id)
        : [...mangaCategories, cat]
    );
  }

  async function handleFolderCreate() {
    const name = newFolderName.trim();
    if (!name || !store.previewManga) return;
    try {
      const res = await gql<{ createCategory: { category: Category } }>(CREATE_CATEGORY, { name });
      const cat = res.createCategory.category;
      allCategories = normalizeCategories([...allCategories, cat]);
      await gql(UPDATE_MANGA_CATEGORIES, { mangaId: store.previewManga.id, addTo: [cat.id], removeFrom: [] });
      mangaCategories = normalizeCategories([...mangaCategories, cat]);
    } catch (e) { console.error(e); }
    newFolderName = ""; creatingFolder = false;
  }

  function handleFolderOutside(e: MouseEvent) {
    if (folderRef && !folderRef.contains(e.target as Node)) { folderOpen = false; creatingFolder = false; newFolderName = ""; }
  }

  $effect(() => {
    if (folderOpen) {
      setTimeout(() => document.addEventListener("mousedown", handleFolderOutside), 0);
      return () => document.removeEventListener("mousedown", handleFolderOutside);
    }
  });

  function onKey(e: KeyboardEvent) { if (e.key === "Escape") close(); }
  onMount(() => window.addEventListener("keydown", onKey));
  onDestroy(() => { window.removeEventListener("keydown", onKey); detailAbort?.abort(); chapterAbort?.abort(); });
</script>

{#if store.previewManga}
<div class="backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) close(); }} onkeydown={(e) => { if (e.key === "Escape") close(); }}>
  <div class="modal" role="dialog" aria-label={$_("ui_mangaPreview")}>

    <div class="cover-col">
      <div class="cover-wrap">
        <img
          src={resolveMangaCoverUrl(store.previewManga, {
            context: "preview",
            persistence: inLibrary ? "persistent" : "memory",
            cacheGeneration: store.libraryCoverCacheGeneration,
          })}
          alt={displayManga?.title}
          class="cover"
        />
        {#if loadingDetail}
          <div class="cover-spinner"><CircleNotch size={18} weight="light" class="anim-spin" /></div>
        {/if}
      </div>
      <div class="cover-actions">

        <button class="action-btn" class:active={inLibrary} onclick={toggleLibrary} disabled={togglingLib || loadingDetail}>
          <span class="action-icon"><BookmarkSimple size={13} weight={inLibrary ? "fill" : "light"} /></span>
          <span class="action-label">{togglingLib ? "…" : inLibrary ? $_("detail_status_inLibrary") : $_("detail_actions_addToLibrary")}</span>
        </button>

        <button class="action-btn" onclick={openSeriesDetail}>
          <span class="action-icon"><Books size={13} weight="light" /></span>
          <span class="action-label">{$_("ui_seriesDetail")}</span>
        </button>

        <div class="folder-wrap" bind:this={folderRef}>
          <button class="action-btn" class:active={assignedFolders.length > 0} onclick={() => folderOpen = !folderOpen}>
            <span class="action-icon"><FolderSimplePlus size={13} weight={assignedFolders.length > 0 ? "fill" : "light"} /></span>
            <span class="action-label">{assignedFolders.length > 0 ? assignedFolders.map((f) => getCategoryDisplayName(f)).join(", ") : $_("ui_addToFolder")}</span>
          </button>
          {#if folderOpen}
            <div class="folder-menu">
              {#if catsLoading}
                <NocturneState layout="compact" tone="info" icon="folder" eyebrow={$_("detail.actions.folders")} title={$_("detail_folders_loading")} />
              {:else if allCategories.length === 0 && !creatingFolder}
                <NocturneState layout="compact" tone="info" icon="folder" eyebrow={$_("detail.actions.folders")} title={$_("detail_folders_emptyTitle")} body={$_("detail.folders.emptyBody")} />
              {/if}
              {#each allCategories as cat}
                {@const isIn = mangaCategories.some(c => c.id === cat.id)}
                <button class="folder-item" class:folder-item-on={isIn} onclick={() => toggleCategory(cat)}>
                  <Folder size={12} weight={isIn ? "fill" : "light"} />{isIn ? "✓ " : ""}{getCategoryDisplayName(cat)}
                </button>
              {/each}
              <div class="folder-divider"></div>
              {#if creatingFolder}
                <div class="folder-create-row">
                  <input class="folder-input" placeholder={$_("ui_folderName")} bind:value={newFolderName}
                    onkeydown={(e) => { if (e.key === "Enter") handleFolderCreate(); if (e.key === "Escape") { creatingFolder = false; newFolderName = ""; } }}
                    use:focusAction />
                  <button class="folder-ok" onclick={handleFolderCreate} disabled={!newFolderName.trim()}>{$_("detail_folders_add")}</button>
                </div>
              {:else}
                <button class="folder-new" onclick={() => creatingFolder = true}>{$_("detail_folders_new")}</button>
              {/if}
            </div>
          {/if}
        </div>

        <button class="action-btn" class:active={linkedIds.length > 0} onclick={openLinkPicker}>
          <span class="action-icon"><LinkSimpleHorizontalBreak size={13} weight={linkedIds.length > 0 ? "fill" : "light"} /></span>
          <span class="action-label">{linkedIds.length > 0 ? `Series Link (${linkedIds.length})` : $_("ui_seriesLink")}</span>
        </button>

      </div>
    </div>

    <div class="content">
      <div class="content-header">
        <div class="title-block">
          <h2 class="title">{displayManga?.title}</h2>
          {#if loadingDetail}
            <div class="sk-byline"></div>
          {:else if displayManga?.author || displayManga?.artist}
            <p class="byline">{[displayManga?.author, displayManga?.artist].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ")}</p>
          {/if}
        </div>
        <button class="close-btn" onclick={close}><X size={15} weight="light" /></button>
      </div>

      <div class="content-body">
        {#if fetchError}
          <NocturneState
            layout="compact"
            tone="warning"
            icon="warning"
            eyebrow={$_("bookDetail.preview")}
            title={$_("ui_couldNotRefreshThisManga")}
            body={fetchError}
          />
        {/if}

        {#if loadingDetail}
          <div class="sk-row"><div class="sk-badge"></div><div class="sk-badge sk-badge-wide"></div></div>
        {:else}
          <div class="badges">
            {#if statusLabel}<span class="badge" class:badge-green={displayManga?.status === "ONGOING"}>{statusLabel}</span>{/if}
            {#if displayManga?.source}<span class="badge">{displayManga.source.displayName}</span>{/if}
            {#if inLibrary}<span class="badge badge-accent">{$_("detail_status_inLibrary")}</span>{/if}
            {#if !loadingChapters && unreadCount > 0}<span class="badge badge-unread">{unreadCount} {$_("ui_unread")}</span>{/if}
            {#if !loadingChapters && bookmarkCount > 0}<span class="badge">{bookmarkCount} {$_("ui_bookmarked")}</span>{/if}
          </div>
        {/if}

        <div class="chapter-box">
          {#if loadingChapters}
            <div class="chapter-loading">
              <span class="chapter-loading-icon"><CircleNotch size={13} weight="light" class="anim-spin" /></span>
              <span class="chapter-loading-label">{$_("ui_loadingChapters")}</span>
            </div>
          {:else if totalCount > 0}
            <div class="chapter-meta">
              <span class="chapter-label">
                {totalCount === 1 ? $_("preview_chapterCountOne") : $_("home_chapterCount", { count: totalCount })}{readCount > 0 ? ` · ${$_("preview_readCount", { count: readCount })}` : ""}{unreadCount > 0 && readCount > 0 ? ` · ${$_("preview_leftCount", { count: unreadCount })}` : ""}{downloadedCount > 0 ? ` · ${$_("preview_downloadedCount", { count: downloadedCount })}` : ""}
              </span>
              {#if unreadCount > 0}
                <button class="dl-all-btn" onclick={downloadAll} disabled={queueingAll}>
                  {#if queueingAll}<CircleNotch size={11} weight="light" class="anim-spin" />{/if}
                  {queueingAll ? $_("preview_queuing") : $_("ui_downloadUnread")}
                </button>
              {/if}
            </div>
            {#if readCount > 0}
              <div class="progress-track"><div class="progress-fill" style="width:{(readCount / totalCount) * 100}%"></div></div>
            {/if}
            {#if continueChapter}
              <button class="read-btn" onclick={() => { openReader(continueChapter!.ch, chapters, displayManga); close(); }}>
                <Play size={12} weight="fill" />{continueChapter.label}
              </button>
            {/if}
          {:else if !loadingDetail}
            <span class="chapter-label chapter-label-faint">{$_("ui_noChaptersInLocalLibrary")}</span>
          {/if}
        </div>

        {#if loadingDetail}
          <div class="sk-desc">
            <div class="sk-line sk-line-full"></div>
            <div class="sk-line sk-line-long"></div>
            <div class="sk-line sk-line-medium"></div>
          </div>
        {:else if displayManga?.description}
          <div class="desc-block">
            <p class="desc" class:desc-open={descExpanded}>{displayManga.description}</p>
            {#if displayManga.description.length > 220}
              <button class="desc-toggle" onclick={() => descExpanded = !descExpanded}>
                {descExpanded ? $_("ui_showLess") : $_("ui_showMore")}
                <span class="desc-caret" class:desc-caret-open={descExpanded}>
                  <CaretDown size={10} weight="light" />
                </span>
              </button>
            {/if}
          </div>
        {/if}

        {#if !loadingDetail && displayManga?.genre?.length}
          <div class="genres">
            {#each displayManga.genre as g}
              <button class="genre-tag" onclick={() => { openSearchBrowseFeatured(g); close(); }}>{g}</button>
            {/each}
          </div>
        {/if}

        {#if !loadingDetail}
          <div class="meta-table">
            {#if displayManga?.author}<div class="meta-row"><span class="meta-key">{$_("library_sort_author")}</span><span class="meta-val">{displayManga.author}</span></div>{/if}
            {#if displayManga?.artist && displayManga.artist !== displayManga.author}<div class="meta-row"><span class="meta-key">{$_("ui_artist")}</span><span class="meta-val">{displayManga.artist}</span></div>{/if}
            {#if statusLabel}<div class="meta-row"><span class="meta-key">{$_("downloads_summary_status")}</span><span class="meta-val">{statusLabel}</span></div>{/if}
            {#if displayManga?.source}<div class="meta-row"><span class="meta-key">{$_("detail_fields_source")}</span><span class="meta-val">{displayManga.source.displayName}</span></div>{/if}
            {#if !loadingChapters && scanlators.length > 0}<div class="meta-row"><span class="meta-key">{scanlators.length === 1 ? $_("preview_scanlator") : $_("preview_scanlators")}</span><span class="meta-val">{scanlators.join(", ")}</span></div>{/if}
            {#if !loadingChapters && firstUpload && lastUpload}
              <div class="meta-row">
                <span class="meta-key">{$_("ui_published")}</span>
                <span class="meta-val">{firstUpload.getTime() === lastUpload.getTime() ? formatDate(firstUpload) : `${formatDate(firstUpload)} – ${formatDate(lastUpload)}`}</span>
              </div>
            {/if}
            {#if !loadingChapters && downloadedCount > 0}<div class="meta-row"><span class="meta-key">{$_("detail_stats_downloaded")}</span><span class="meta-val">{downloadedCount} / {totalCount} {$_("ui_chapters")}</span></div>{/if}
            {#if displayManga?.realUrl}<div class="meta-row"><span class="meta-key">{$_("ui_link")}</span><a href={displayManga.realUrl} target="_blank" rel="noreferrer" class="meta-link">{$_("ui_open")} <ArrowSquareOut size={11} weight="light" /></a></div>{/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

{#if linkPickerOpen}
  <div class="link-backdrop" role="presentation"
    onclick={(e) => { if (e.target === e.currentTarget) closeLinkPicker(); }}
    onkeydown={(e) => e.key === "Escape" && closeLinkPicker()}>
    <div class="link-modal">
      <div class="link-header">
        <span class="link-title">{$_("ui_linkAsSameSeries")}</span>
        <button class="close-btn" onclick={closeLinkPicker}><X size={14} weight="light" /></button>
      </div>
      <p class="link-hint">
        {$_("ui_markTwoMangaAsTheSameSeriesSo")}
      </p>
      <div class="link-search-wrap">
        <input class="link-search" placeholder={$_("ui_searchYourLibrary_4b07d7e6")} bind:value={linkSearch} use:focusAction />
        </div>
        <div class="link-list">
        {#if loadingLinkList}
          <NocturneState layout="compact" tone="info" icon="search" eyebrow={$_("feedback.links")} title={$_("ui_loadingLibrary")} />
        {:else if linkPickerResults.length === 0}
          <NocturneState layout="compact" tone="info" icon="search" eyebrow={$_("feedback.links")} title={$_("ui_noMatchingManga")} body={$_("feedback.tryAnotherLibraryTitle")} />
        {:else}
          {#each linkPickerResults as m (m.id)}
            {@const isLinked = linkedIds.includes(m.id)}
            <button class="link-row" class:link-row-linked={isLinked} onclick={() => handleLink(m)}>
              <img src={resolveMangaCoverUrl(m, { context: "preview", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt={m.title} class="link-thumb" loading="lazy" decoding="async" />
              <div class="link-info">
                <span class="link-manga-title">{m.title}</span>
                {#if m.source?.displayName}<span class="link-source">{m.source.displayName}</span>{/if}
              </div>
              <span class="link-status">{isLinked ? $_("ui_linked") : $_("preview_link")}</span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

{/if}

<script module lang="ts">
  function focusAction(node: HTMLElement) { node.focus(); }
</script>

<style>
  .backdrop { position: fixed; inset: 0; background: var(--component-manga-preview-backdrop-bg); z-index: var(--component-manga-preview-backdrop-z-index); display: flex; align-items: center; justify-content: center; animation: fadeIn var(--component-manga-preview-backdrop-animation) both; backdrop-filter: var(--component-manga-preview-backdrop-blur); -webkit-backdrop-filter: var(--component-manga-preview-backdrop-blur); }
  .modal { width: var(--component-manga-preview-modal-width); height: var(--component-manga-preview-modal-height); display: flex; background: var(--component-manga-preview-modal-bg); border: 1px solid var(--component-manga-preview-modal-border); border-radius: var(--component-manga-preview-modal-radius); overflow: hidden; animation: scaleIn var(--component-manga-preview-modal-animation) both; box-shadow: var(--component-manga-preview-modal-shadow); }
  .cover-col { width: var(--component-manga-preview-cover-column-width); flex-shrink: 0; background: var(--component-manga-preview-cover-column-bg); border-right: 1px solid var(--component-manga-preview-cover-column-border); display: flex; flex-direction: column; padding: var(--component-manga-preview-cover-column-padding); gap: var(--component-manga-preview-cover-column-gap); overflow: hidden; }
  .cover-wrap { position: relative; width: 100%; }
  .cover { width: 100%; aspect-ratio: var(--component-manga-preview-cover-aspect-ratio); object-fit: cover; border-radius: var(--component-manga-preview-cover-radius); border: 1px solid var(--component-manga-preview-cover-border); display: block; }
  .cover-spinner { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--component-manga-preview-cover-spinner-bg); border-radius: var(--component-manga-preview-cover-radius); color: var(--component-manga-preview-muted-fg); }
  .cover-actions { display: flex; flex-direction: column; gap: var(--component-manga-preview-action-gap); }
  .action-btn { display: flex; align-items: center; gap: var(--component-manga-preview-action-icon-gap); width: 100%; padding: var(--component-manga-preview-action-padding); border-radius: var(--component-manga-preview-action-radius); font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); letter-spacing: var(--component-manga-preview-action-letter-spacing); border: 1px solid var(--component-manga-preview-action-border); background: transparent; color: var(--component-manga-preview-action-fg); cursor: pointer; text-align: left; transition: color var(--component-manga-preview-transition-normal), border-color var(--component-manga-preview-transition-normal), background var(--component-manga-preview-transition-normal); }
  .action-btn:hover:not(:disabled) { color: var(--component-manga-preview-action-hover-fg); border-color: var(--component-manga-preview-action-hover-border); background: var(--component-manga-preview-action-hover-bg); }
  .action-btn:disabled { opacity: var(--component-manga-preview-disabled-opacity); cursor: default; }
  .action-btn.active { background: var(--component-manga-preview-action-active-bg); border-color: var(--component-manga-preview-action-active-border); color: var(--component-manga-preview-action-active-fg); }
  .action-icon { display: flex; align-items: center; justify-content: center; width: var(--component-manga-preview-action-icon-width); flex-shrink: 0; }
  .action-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .folder-wrap { position: relative; width: 100%; }
  .folder-menu { position: absolute; bottom: calc(100% + var(--component-manga-preview-folder-menu-offset)); left: 0; right: 0; background: var(--component-manga-preview-menu-bg); border: 1px solid var(--component-manga-preview-menu-border); border-radius: var(--component-manga-preview-menu-radius); padding: var(--component-manga-preview-menu-padding); display: flex; flex-direction: column; gap: var(--component-manga-preview-menu-gap); box-shadow: var(--component-manga-preview-menu-shadow); z-index: var(--component-manga-preview-menu-z-index); animation: scaleIn var(--component-manga-preview-menu-animation) both; transform-origin: bottom center; }
  .folder-item { display: flex; align-items: center; gap: var(--component-manga-preview-folder-item-gap); padding: var(--component-manga-preview-folder-item-padding); border-radius: var(--component-manga-preview-folder-item-radius); font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); color: var(--component-manga-preview-action-fg); background: transparent; border: none; cursor: pointer; text-align: left; transition: background var(--component-manga-preview-transition-fast), color var(--component-manga-preview-transition-fast); }
  .folder-item:hover { background: var(--component-manga-preview-menu-item-hover-bg); color: var(--component-manga-preview-menu-item-hover-fg); }
  .folder-item.folder-item-on { color: var(--component-manga-preview-accent-fg); }
  .folder-divider { height: var(--component-manga-preview-divider-size); background: var(--component-manga-preview-divider); margin: var(--component-manga-preview-divider-margin); }
  .folder-create-row { display: flex; gap: var(--component-manga-preview-folder-create-gap); padding: var(--component-manga-preview-folder-create-padding); }
  .folder-input { flex: 1; background: var(--component-manga-preview-input-bg); border: 1px solid var(--component-manga-preview-input-border); border-radius: var(--component-manga-preview-input-radius); padding: var(--component-manga-preview-input-padding); color: var(--component-manga-preview-input-fg); font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); outline: none; min-width: 0; }
  .folder-input:focus { border-color: var(--component-manga-preview-input-focus-border); }
  .folder-ok { font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); padding: var(--component-manga-preview-input-padding); border-radius: var(--component-manga-preview-input-radius); border: 1px solid var(--component-manga-preview-input-border); background: transparent; color: var(--component-manga-preview-action-fg); cursor: pointer; flex-shrink: 0; transition: color var(--component-manga-preview-transition-normal), border-color var(--component-manga-preview-transition-normal); }
  .folder-ok:disabled { opacity: var(--component-manga-preview-disabled-opacity); cursor: default; }
  .folder-ok:not(:disabled):hover { color: var(--component-manga-preview-action-hover-fg); border-color: var(--component-manga-preview-action-hover-border); }
  .folder-new { padding: var(--component-manga-preview-folder-item-padding); border-radius: var(--component-manga-preview-folder-item-radius); font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); color: var(--component-manga-preview-muted-fg); background: transparent; border: none; cursor: pointer; text-align: left; width: 100%; transition: color var(--component-manga-preview-transition-fast); }
  .folder-new:hover { color: var(--component-manga-preview-accent-fg); }
  .content { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
  .content-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--component-manga-preview-content-header-gap); padding: var(--component-manga-preview-content-header-padding); border-bottom: 1px solid var(--component-manga-preview-divider); flex-shrink: 0; }
  .title-block { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--component-manga-preview-title-gap); }
  .title { font-size: var(--component-manga-preview-title-font-size); font-weight: var(--component-manga-preview-title-font-weight); color: var(--component-manga-preview-title-fg); letter-spacing: var(--component-manga-preview-title-letter-spacing); line-height: var(--component-manga-preview-title-line-height); }
  .byline { font-size: var(--component-manga-preview-body-font-size); color: var(--component-manga-preview-muted-fg); line-height: var(--component-manga-preview-body-line-height); }
  .sk-byline { height: var(--component-manga-preview-skeleton-byline-height); width: var(--component-manga-preview-skeleton-byline-width); background: var(--component-manga-preview-skeleton-bg); border-radius: var(--component-manga-preview-skeleton-radius); animation: pulse var(--component-manga-preview-skeleton-animation) infinite; }
  .close-btn { display: flex; align-items: center; justify-content: center; width: var(--component-manga-preview-close-size); height: var(--component-manga-preview-close-size); border-radius: var(--component-manga-preview-close-radius); color: var(--component-manga-preview-close-fg); background: transparent; border: none; cursor: pointer; flex-shrink: 0; transition: color var(--component-manga-preview-transition-normal), background var(--component-manga-preview-transition-normal); }
  .close-btn:hover { color: var(--component-manga-preview-close-hover-fg); background: var(--component-manga-preview-close-hover-bg); }
  .content-body { flex: 1; overflow-y: auto; padding: var(--component-manga-preview-content-body-padding); display: flex; flex-direction: column; gap: var(--component-manga-preview-content-body-gap); scrollbar-width: none; }
  .content-body::-webkit-scrollbar { display: none; }
  .sk-row { display: flex; gap: var(--component-manga-preview-skeleton-row-gap); align-items: center; }
  .sk-badge { height: var(--component-manga-preview-skeleton-badge-height); width: var(--component-manga-preview-skeleton-badge-width); background: var(--component-manga-preview-skeleton-bg); border-radius: var(--component-manga-preview-skeleton-radius); animation: pulse var(--component-manga-preview-skeleton-animation) infinite; }
  .sk-badge-wide { width: var(--component-manga-preview-skeleton-badge-wide-width); }
  .sk-desc { display: flex; flex-direction: column; gap: var(--component-manga-preview-skeleton-desc-gap); padding: var(--component-manga-preview-skeleton-desc-padding); }
  .sk-line { height: var(--component-manga-preview-skeleton-line-height); background: var(--component-manga-preview-skeleton-bg); border-radius: var(--component-manga-preview-skeleton-radius); animation: pulse var(--component-manga-preview-skeleton-animation) infinite; }
  .sk-line-full { width: var(--component-manga-preview-skeleton-line-full-width); }
  .sk-line-long { width: var(--component-manga-preview-skeleton-line-long-width); }
  .sk-line-medium { width: var(--component-manga-preview-skeleton-line-medium-width); }
  .badges { display: flex; flex-wrap: wrap; gap: var(--component-manga-preview-badge-gap); }
  .badge { font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-badge-font-size); letter-spacing: var(--component-manga-preview-badge-letter-spacing); text-transform: none; padding: var(--component-manga-preview-badge-padding); border-radius: var(--component-manga-preview-badge-radius); border: 1px solid var(--component-manga-preview-badge-border); background: var(--component-manga-preview-badge-bg); color: var(--component-manga-preview-badge-fg); }
  .badge-green { background: var(--component-manga-preview-status-success-bg); border-color: var(--component-manga-preview-status-success-border); color: var(--component-manga-preview-status-success-fg); }
  .badge-accent { background: var(--component-manga-preview-accent-bg); border-color: var(--component-manga-preview-accent-border); color: var(--component-manga-preview-accent-fg); }
  .badge-unread { background: var(--component-manga-preview-status-warning-bg); border-color: var(--component-manga-preview-status-warning-border); color: var(--component-manga-preview-status-warning-fg); }
  .chapter-box { display: flex; flex-direction: column; gap: var(--component-manga-preview-chapter-gap); padding: var(--component-manga-preview-chapter-padding); background: var(--component-manga-preview-chapter-bg); border: 1px solid var(--component-manga-preview-chapter-border); border-radius: var(--component-manga-preview-chapter-radius); }
  .chapter-loading { display: flex; align-items: center; gap: var(--component-manga-preview-chapter-loading-gap); }
  .chapter-loading-icon { color: var(--component-manga-preview-muted-fg); }
  .chapter-loading-label { font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); color: var(--component-manga-preview-muted-fg); letter-spacing: var(--component-manga-preview-action-letter-spacing); }
  .chapter-meta { display: flex; align-items: center; justify-content: space-between; gap: var(--component-manga-preview-chapter-meta-gap); }
  .chapter-label { font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); color: var(--component-manga-preview-action-fg); letter-spacing: var(--component-manga-preview-action-letter-spacing); }
  .chapter-label-faint { color: var(--component-manga-preview-muted-fg); }
  .dl-all-btn { display: flex; align-items: center; gap: var(--component-manga-preview-download-gap); font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-badge-font-size); letter-spacing: var(--component-manga-preview-action-letter-spacing); padding: var(--component-manga-preview-download-padding); border-radius: var(--component-manga-preview-download-radius); border: 1px solid var(--component-manga-preview-download-border); background: transparent; color: var(--component-manga-preview-download-fg); cursor: pointer; flex-shrink: 0; transition: color var(--component-manga-preview-transition-normal), border-color var(--component-manga-preview-transition-normal); }
  .dl-all-btn:hover:not(:disabled) { color: var(--component-manga-preview-download-hover-fg); border-color: var(--component-manga-preview-download-hover-border); }
  .dl-all-btn:disabled { opacity: var(--component-manga-preview-disabled-opacity-strong); cursor: default; }
  .progress-track { height: var(--component-manga-preview-progress-height); background: var(--component-manga-preview-progress-track-bg); border-radius: var(--component-manga-preview-progress-radius); overflow: hidden; }
  .progress-fill { height: 100%; background: var(--component-manga-preview-progress-fill-bg); border-radius: var(--component-manga-preview-progress-radius); transition: width var(--component-manga-preview-progress-transition); }
  .read-btn { display: flex; align-items: center; gap: var(--component-manga-preview-read-gap); padding: var(--component-manga-preview-read-padding); border-radius: var(--component-manga-preview-read-radius); font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); letter-spacing: var(--component-manga-preview-action-letter-spacing); background: var(--component-manga-preview-read-bg); border: 1px solid var(--component-manga-preview-read-border); color: var(--component-manga-preview-read-fg); cursor: pointer; align-self: flex-start; transition: filter var(--component-manga-preview-transition-normal); }
  .read-btn:hover { filter: var(--component-manga-preview-read-hover-filter); }
  .desc-block { display: flex; flex-direction: column; gap: var(--component-manga-preview-desc-gap); border-top: 1px solid var(--component-manga-preview-divider); padding-top: var(--component-manga-preview-desc-padding-top); }
  .desc { font-size: var(--component-manga-preview-body-font-size); color: var(--component-manga-preview-action-fg); line-height: var(--component-manga-preview-description-line-height); display: -webkit-box; line-clamp: var(--component-manga-preview-description-line-clamp); -webkit-line-clamp: var(--component-manga-preview-description-line-clamp); -webkit-box-orient: vertical; overflow: hidden; }
  .desc.desc-open { display: block; line-clamp: unset; -webkit-line-clamp: unset; overflow: visible; }
  .desc-toggle { display: flex; align-items: center; gap: var(--component-manga-preview-desc-toggle-gap); font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); color: var(--component-manga-preview-muted-fg); background: transparent; border: none; cursor: pointer; padding: 0; align-self: flex-start; transition: color var(--component-manga-preview-transition-normal); }
  .desc-toggle:hover { color: var(--component-manga-preview-accent-fg); }
  .desc-caret { display: inline-flex; transition: transform var(--component-manga-preview-transition-normal); }
  .desc-caret-open { transform: rotate(var(--component-manga-preview-caret-open-rotation)); }
  .genres { display: flex; flex-wrap: wrap; gap: var(--component-manga-preview-genre-gap); }
  .genre-tag { font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-badge-font-size); letter-spacing: var(--component-manga-preview-action-letter-spacing); padding: var(--component-manga-preview-badge-padding); border-radius: var(--component-manga-preview-badge-radius); border: 1px solid var(--component-manga-preview-badge-border); background: var(--component-manga-preview-badge-bg); color: var(--component-manga-preview-badge-fg); cursor: pointer; transition: color var(--component-manga-preview-transition-normal), border-color var(--component-manga-preview-transition-normal), background var(--component-manga-preview-transition-normal); }
  .genre-tag:hover { color: var(--component-manga-preview-accent-fg); border-color: var(--component-manga-preview-accent-border); background: var(--component-manga-preview-accent-bg); }
  .meta-table { display: flex; flex-direction: column; gap: var(--component-manga-preview-meta-gap); border-top: 1px solid var(--component-manga-preview-divider); padding-top: var(--component-manga-preview-meta-padding-top); }
  .meta-row { display: flex; align-items: baseline; gap: var(--component-manga-preview-meta-row-gap); padding: var(--component-manga-preview-meta-row-padding); }
  .meta-key { font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); color: var(--component-manga-preview-muted-fg); letter-spacing: var(--component-manga-preview-action-letter-spacing); text-transform: none; min-width: var(--component-manga-preview-meta-key-width); flex-shrink: 0; }
  .meta-val { font-size: var(--component-manga-preview-body-font-size); color: var(--component-manga-preview-body-fg); line-height: var(--component-manga-preview-body-line-height); }
  .meta-link { display: inline-flex; align-items: center; gap: var(--component-manga-preview-meta-link-gap); font-size: var(--component-manga-preview-body-font-size); color: var(--component-manga-preview-accent-fg); text-decoration: none; transition: opacity var(--component-manga-preview-transition-normal); }
  .meta-link:hover { opacity: var(--component-manga-preview-link-hover-opacity); }
  .link-backdrop { position: fixed; inset: 0; background: var(--component-manga-preview-link-backdrop-bg); z-index: var(--component-manga-preview-link-backdrop-z-index); display: flex; align-items: center; justify-content: center; backdrop-filter: var(--component-manga-preview-link-backdrop-blur); -webkit-backdrop-filter: var(--component-manga-preview-link-backdrop-blur); animation: fadeIn var(--component-manga-preview-link-backdrop-animation) both; }
  .link-modal { width: var(--component-manga-preview-link-modal-width); max-height: var(--component-manga-preview-link-modal-max-height); display: flex; flex-direction: column; background: var(--component-manga-preview-modal-bg); border: 1px solid var(--component-manga-preview-modal-border); border-radius: var(--component-manga-preview-modal-radius); overflow: hidden; box-shadow: var(--component-manga-preview-link-modal-shadow); animation: scaleIn var(--component-manga-preview-link-modal-animation) both; }
  .link-header { display: flex; align-items: center; justify-content: space-between; padding: var(--component-manga-preview-link-header-padding); border-bottom: 1px solid var(--component-manga-preview-divider); flex-shrink: 0; }
  .link-title { font-size: var(--component-manga-preview-body-font-size); font-weight: var(--component-manga-preview-title-font-weight); color: var(--component-manga-preview-body-fg); }
  .link-hint { font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-action-font-size); color: var(--component-manga-preview-muted-fg); letter-spacing: var(--component-manga-preview-action-letter-spacing); line-height: var(--component-manga-preview-body-line-height); padding: var(--component-manga-preview-link-hint-padding); flex-shrink: 0; }
  .link-search-wrap { padding: var(--component-manga-preview-link-search-wrap-padding); border-bottom: 1px solid var(--component-manga-preview-divider); flex-shrink: 0; }
  .link-search { width: 100%; background: var(--component-manga-preview-link-search-bg); border: 1px solid var(--component-manga-preview-link-search-border); border-radius: var(--component-manga-preview-link-search-radius); padding: var(--component-manga-preview-link-search-padding); color: var(--component-manga-preview-title-fg); font-size: var(--component-manga-preview-body-font-size); outline: none; transition: border-color var(--component-manga-preview-transition-normal); }
  .link-search:focus { border-color: var(--component-manga-preview-link-search-focus-border); }
  .link-list { flex: 1; overflow-y: auto; padding: var(--component-manga-preview-link-list-padding); scrollbar-width: none; }
  .link-list::-webkit-scrollbar { display: none; }
  .link-row { display: flex; align-items: center; gap: var(--component-manga-preview-link-row-gap); width: 100%; padding: var(--component-manga-preview-link-row-padding); border-radius: var(--component-manga-preview-link-row-radius); border: none; background: transparent; text-align: left; cursor: pointer; transition: background var(--component-manga-preview-transition-fast); }
  .link-row:hover { background: var(--component-manga-preview-link-row-hover-bg); }
  .link-row-linked { background: var(--component-manga-preview-accent-bg) !important; }
  .link-thumb { width: var(--component-manga-preview-link-thumb-width); height: var(--component-manga-preview-link-thumb-height); border-radius: var(--component-manga-preview-link-thumb-radius); object-fit: cover; flex-shrink: 0; border: 1px solid var(--component-manga-preview-link-thumb-border); }
  .link-info { flex: 1; display: flex; flex-direction: column; gap: var(--component-manga-preview-link-info-gap); overflow: hidden; min-width: 0; }
  .link-manga-title { font-size: var(--component-manga-preview-body-font-size); color: var(--component-manga-preview-body-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .link-source { font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-badge-font-size); color: var(--component-manga-preview-muted-fg); letter-spacing: var(--component-manga-preview-action-letter-spacing); }
  .link-status { font-family: var(--component-manga-preview-font-ui); font-size: var(--component-manga-preview-badge-font-size); letter-spacing: var(--component-manga-preview-action-letter-spacing); color: var(--component-manga-preview-muted-fg); flex-shrink: 0; padding: var(--component-manga-preview-link-status-padding); border-radius: var(--component-manga-preview-link-status-radius); border: 1px solid var(--component-manga-preview-link-status-border); }
  .link-row-linked .link-status { color: var(--component-manga-preview-accent-fg); border-color: var(--component-manga-preview-accent-border); background: var(--component-manga-preview-accent-bg); }
  @keyframes pulse { 0%,100% { opacity: var(--component-manga-preview-skeleton-opacity-low) } 50% { opacity: var(--component-manga-preview-skeleton-opacity-high) } }
  @keyframes fadeIn  { from { opacity: var(--component-manga-preview-hidden-opacity) } to { opacity: var(--component-manga-preview-visible-opacity) } }
  @keyframes scaleIn { from { opacity: var(--component-manga-preview-hidden-opacity); transform: scale(var(--component-manga-preview-scale-from)) } to { opacity: var(--component-manga-preview-visible-opacity); transform: scale(var(--component-manga-preview-scale-to)) } }
</style>
