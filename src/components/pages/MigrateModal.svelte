<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { X, MagnifyingGlass, CircleNotch, ArrowRight, Check, Warning, Sparkle, StackSimple } from "phosphor-svelte";
  import { untrack } from "svelte";
  import { gql } from "../../lib/client";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { GET_SOURCES, FETCH_CHAPTERS, GET_LIBRARY } from "../../lib/queries";
  import { fetchSourceMangaSearchWithFallback } from "../../lib/manga/sourceSearch";
  import { addToast, store } from "../../store/state.svelte";
  import type { Manga, Source, Chapter } from "../../lib/types";
  import {
    applyMangaMigrationWithJournal,
    applyMassMangaMigrationWithJournal,
    previewMassMangaMigration,
    type MassMangaMigrationPreview,
    undoMangaMigration,
  } from "../../lib/migration/manga";

  interface Props {
    manga:           Manga;
    currentChapters: Chapter[];
    onClose:         () => void;
    onMigrated:      (newManga: Manga) => void;
  }
  let { manga, currentChapters, onClose, onMigrated }: Props = $props();

  type MigrationMode = "single" | "mass";
  type Step = "source" | "search" | "confirm" | "mass-preview";

  interface Match {
    manga: Manga;
    chapters: Chapter[];
    readCount: number;
    similarity: number;
  }

  function titleSimilarity(a: string, b: string): number {
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const wordsA = new Set(norm(a));
    const wordsB = new Set(norm(b));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return intersection / union;
  }

  let step: Step            = $state("source");
  let mode: MigrationMode   = $state("single");
  let sources: Source[]     = $state([]);
  let loadingSources        = $state(true);
  let selectedSource: Source | null = $state(null);

  // Lang filter: "en" first, then alphabetical
  let selectedLang: string       = $state("all");
  let langStripEl: HTMLDivElement | undefined = $state();
  const availableLangs           = $derived.by(() => {
    const langs = Array.from(new Set<string>(sources.map(s => s.lang))).sort();
    const en = langs.indexOf("en");
    if (en > 0) { langs.splice(en, 1); langs.unshift("en"); }
    return langs;
  });
  const hasMultipleLangs         = $derived(availableLangs.length > 1);

  function scrollLangStrip(dir: -1 | 1) {
    if (!langStripEl) return;
    const strip = langStripEl;
    const chips = Array.from(strip.children) as HTMLElement[];
    const scrollLeft = strip.scrollLeft;
    const viewEnd = scrollLeft + strip.clientWidth;

    if (dir === 1) {
      // Find first chip that is cut off or fully outside the right edge, scroll it flush left
      const next = chips.find(c => c.offsetLeft + c.offsetWidth > viewEnd + 2);
      if (next) strip.scrollTo({ left: next.offsetLeft, behavior: "smooth" });
    } else {
      // Find last chip that is cut off or fully outside the left edge, scroll it flush right
      const prev = [...chips].reverse().find(c => c.offsetLeft < scrollLeft - 2);
      if (prev) strip.scrollTo({ left: prev.offsetLeft + prev.offsetWidth - strip.clientWidth, behavior: "smooth" });
    }
  }
  const visibleSources           = $derived.by(() => {
    if (selectedLang !== "all") return sources.filter(s => s.lang === selectedLang);
    const map = new Map<string, Source>();
    for (const s of sources) {
      const existing = map.get(s.name);
      if (!existing) { map.set(s.name, s); continue; }
      if (s.lang < existing.lang) map.set(s.name, s);
    }
    return Array.from(map.values());
  });

  let query                         = $state(untrack(() => manga.title));
  let results: { manga: Manga; similarity: number }[] = $state([]);
  let searching             = $state(false);
  let selectedMatch: Match | null = $state(null);
  let loadingMatchId: number | null = $state(null);
  let migrating             = $state(false);
  let massPreviewLoading    = $state(false);
  let massPreview           = $state<MassMangaMigrationPreview | null>(null);
  let massSelectedIds       = $state<Set<number>>(new Set());
  let error: string | null  = $state(null);
  const readCount   = $derived(currentChapters.filter((c) => c.isRead).length);
  const totalCount  = $derived(currentChapters.length);
  const chapterDiff = $derived(selectedMatch ? selectedMatch.chapters.length - totalCount : 0);
  const SINGLE_STEPS = ["source", "search", "confirm"] as const satisfies Step[];
  const MASS_STEPS = ["source", "mass-preview"] as const satisfies Step[];
  const currentSteps = $derived(mode === "mass" ? MASS_STEPS : SINGLE_STEPS);
  const stepIdx = $derived(currentSteps.indexOf(step));

  $effect(() => {
    gql<{ sources: { nodes: Source[] } }>(GET_SOURCES)
      .then((d) => {
        const filtered = d.sources.nodes.filter((s) => s.id !== "0" && s.id !== manga.source?.id);
        sources = filtered;
        // Pre-select preferred lang if available and there are multiple
        const prefLang = store?.settings?.preferredExtensionLang ?? "";
        const langs = new Set(filtered.map(s => s.lang));
        if (prefLang && langs.has(prefLang) && langs.size > 1) selectedLang = prefLang;
      })
      .catch(console.error)
      .finally(() => { loadingSources = false; });

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }

  function setMode(nextMode: MigrationMode) {
    mode = nextMode;
    step = "source";
    error = null;
    results = [];
    selectedMatch = null;
    massPreview = null;
    massSelectedIds = new Set();
  }

  async function searchSource(src: Source, q: string) {
    if (!src || !q.trim()) return;
    searching = true; results = []; error = null;
    try {
      const mangas = await fetchSourceMangaSearchWithFallback({
        sourceId: src.id,
        query: q.trim(),
      });
      const scored = mangas.map((m) => ({
        manga: m,
        similarity: titleSimilarity(manga.title, m.title),
      }));
      scored.sort((a, b) => b.similarity - a.similarity);
      results = scored;
    } catch (e: any) {
      error = e.message;
    } finally {
      searching = false;
    }
  }

  function pickSource(src: Source) {
    selectedSource = src;
    error = null;
    if (mode === "mass") {
      step = "source";
      return;
    }
    step = "search";
    searchSource(src, query);
  }

  async function loadMassMigrationItems() {
    if (!manga.source?.id) {
      throw new Error("This manga does not have a source id for mass migration.");
    }

    const library = await gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY);
    const sourceManga = (library.mangas.nodes ?? []).filter((entry) => (
      entry.inLibrary
      && entry.source?.id === manga.source?.id
    ));

    const chapterPairs = await Promise.all(sourceManga.map(async (entry) => {
      const chaptersResult = await gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, {
        mangaId: entry.id,
      });
      return {
        manga: entry,
        chapters: chaptersResult.chapters.nodes ?? [],
      };
    }));

    return chapterPairs;
  }

  async function buildMassPreview() {
    if (!selectedSource || !manga.source?.id) return;
    massPreviewLoading = true;
    error = null;
    massPreview = null;
    massSelectedIds = new Set();
    try {
      const items = await loadMassMigrationItems();
      const nextPreview = await previewMassMangaMigration({
        sourceFrom: manga.source.id,
        sourceTo: selectedSource.id,
        items,
      });
      massPreview = nextPreview;
      massSelectedIds = new Set(
        nextPreview.items
          .filter((item) => item.status === "ready")
          .map((item) => item.currentManga.id),
      );
      step = "mass-preview";
    } catch (previewError: any) {
      error = previewError.message;
    } finally {
      massPreviewLoading = false;
    }
  }

  function toggleMassSelection(mangaId: number) {
    const next = new Set(massSelectedIds);
    if (next.has(mangaId)) next.delete(mangaId);
    else next.add(mangaId);
    massSelectedIds = next;
  }

  async function selectMatch(m: Manga, similarity: number) {
    loadingMatchId = m.id; error = null;
    try {
      const d = await gql<{ fetchChapters: { chapters: Chapter[] } }>(FETCH_CHAPTERS, { mangaId: m.id });
      const chapters = d.fetchChapters.chapters;
      const matchReadCount = chapters.filter((c) => {
        const old = currentChapters.find((o) => Math.abs(o.chapterNumber - c.chapterNumber) < 0.01);
        return old?.isRead;
      }).length;
      selectedMatch = { manga: m, chapters, readCount: matchReadCount, similarity };
      step = "confirm";
    } catch (e: any) {
      error = e.message;
    } finally {
      loadingMatchId = null;
    }
  }

  async function migrate() {
    if (!selectedMatch) return;
    migrating = true; error = null;
    try {
      const result = await applyMangaMigrationWithJournal({
        currentManga: manga,
        currentChapters,
        targetSourceId: selectedSource?.id ?? selectedMatch.manga.source?.id ?? "unknown",
        match: selectedMatch,
      });

      addToast({
        kind: "success",
        title: translate("ui_sourceMigrated"),
        body: `${manga.title} moved to ${selectedMatch.manga.source?.displayName ?? selectedSource?.displayName ?? translate("ui_theNewSource")}.`,
        duration: 7000,
        action: {
          label: translate("ui_undo"),
          run: () => {
            void undoMangaMigration(result.journalEntryId).then(() => {
              addToast({
                kind: "info",
                title: translate("ui_migrationUndone"),
                body: manga.title,
              });
              onMigrated({ ...manga, inLibrary: true });
            }).catch((undoError) => {
              addToast({
                kind: "error",
                title: translate("ui_couldNotUndoMigration"),
                body: undoError instanceof Error ? undoError.message : String(undoError),
              });
            });
          },
        },
      });

      onMigrated(result.newManga);
    } catch (e: any) {
      error = e.message;
      migrating = false;
    }
  }

  async function applyMassMigration() {
    if (!massPreview) return;
    migrating = true;
    error = null;
    try {
      const result = await applyMassMangaMigrationWithJournal({
        preview: massPreview,
        selectedMangaIds: [...massSelectedIds],
      });

      addToast({
        kind: "success",
        title: translate("ui_massMigrationApplied"),
        body: `${result.migratedCount} title${result.migratedCount !== 1 ? "s" : ""} moved to ${selectedSource?.displayName ?? translate("ui_theNewSource")}.`,
        duration: 9000,
        action: {
          label: translate("ui_undo"),
          run: () => {
            void undoMangaMigration(result.journalEntryId).then(() => {
              addToast({
                kind: "info",
                title: translate("ui_massMigrationUndone"),
                body: `${result.migratedCount} title${result.migratedCount !== 1 ? "s" : ""}`,
              });
              onMigrated({ ...manga, inLibrary: true });
            }).catch((undoError) => {
              addToast({
                kind: "error",
                title: translate("ui_couldNotUndoMassMigration"),
                body: undoError instanceof Error ? undoError.message : String(undoError),
              });
            });
          },
        },
      });

      const currentItem = massPreview.items.find((item) => item.currentManga.id === manga.id && item.match);
      if (currentItem?.match) {
        onMigrated({ ...currentItem.match.manga, inLibrary: true });
      } else {
        onClose();
      }
    } catch (massError: any) {
      error = massError.message;
      migrating = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="modal">

    <!-- Header -->
    <div class="modal-header">
      <div class="modal-title">
        <span class="modal-title-label">{$_("ui_migrateSource")}</span>
        <span class="modal-title-manga">{manga.title}</span>
      </div>
      <button class="close-btn" onclick={onClose}><X size={14} weight="light" /></button>
    </div>

    <!-- Step indicators -->
    <div class="steps">
      {#each currentSteps as st, i}
        <div class="step" class:step-active={step === st} class:step-done={i < stepIdx}>
          <span class="step-dot">
            {#if i < stepIdx}<Check size={9} weight="bold" />{:else}{i + 1}{/if}
          </span>
          <span class="step-label">
            {st === "source"
              ? $_("ui_pickSource")
              : st === "search"
                ? (selectedSource ? selectedSource.displayName : "Search")
                : mode === "mass"
                  ? $_("ui_previewBatch")
                  : "Confirm"}
          </span>
        </div>
      {/each}
    </div>

    <!-- Body -->
    <div class="body">
      <div class="mode-tabs">
        <button class="mode-tab" class:mode-tab-active={mode === "single"} onclick={() => setMode("single")}>
          {$_("ui_single")}
        </button>
        <button class="mode-tab" class:mode-tab-active={mode === "mass"} onclick={() => setMode("mass")}>
          <StackSimple size={12} weight="bold" /> {$_("ui_mass")}
        </button>
      </div>

      <!-- Step 1: Pick source -->
      {#if step === "source"}
        {#if loadingSources}
          <div class="centered">
            <CircleNotch size={16} weight="light" class="anim-spin" style="color:var(--text-faint)" />
          </div>
        {:else if sources.length === 0}
          <div class="centered"><span class="hint">{$_("ui_noOtherSourcesInstalled")}</span></div>
        {:else}
          {#if hasMultipleLangs}
            <div class="src-lang-bar">
              <button class="src-lang-nav" onclick={() => scrollLangStrip(-1)}>‹</button>
              <div class="src-lang-chips" bind:this={langStripEl}>
                <button class="src-lang-chip" class:src-lang-chip-active={selectedLang === "all"} onclick={() => selectedLang = "all"}>{$_("downloads_filter_all")}</button>
                {#each availableLangs as lang}
                  <button class="src-lang-chip" class:src-lang-chip-active={selectedLang === lang} onclick={() => selectedLang = lang}>
                    {lang.toUpperCase()}
                  </button>
                {/each}
              </div>
              <button class="src-lang-nav" onclick={() => scrollLangStrip(1)}>›</button>
            </div>
          {/if}
          {#if mode === "mass"}
            <div class="notice inline">
              <StackSimple size={14} weight="light" />
              <span>{$_("ui_thisPreviewsAllLibraryMangaFrom")} {manga.source?.displayName ?? $_("ui_theCurrentSource")} {$_("ui_intoOneTargetSourceThenAppliesOnlyThe")}</span>
            </div>
          {/if}
          <div class="source-list">
            {#each visibleSources as src}
              <button
                class="source-row"
                class:source-row-active={selectedSource?.id === src.id}
                onclick={() => pickSource(src)}>
                <img src={resolveServiceIconUrl(src, { kind: "source" })} alt={src.name} class="source-icon"
                  onerror={(e) => applyServiceIconFallback(e, "source")} />
                <div class="source-info">
                  <span class="source-name">{src.displayName}</span>
                  <span class="source-meta">{src.lang.toUpperCase()}{src.isNsfw ? " · NSFW" : ""}</span>
                </div>
                <ArrowRight size={13} weight="light" class="source-arrow" />
              </button>
            {/each}
          </div>
          {#if mode === "mass" && selectedSource}
            <div class="confirm-actions" style="padding: var(--sp-2) var(--sp-3) 0;">
              <button class="migrate-btn" onclick={buildMassPreview} disabled={massPreviewLoading}>
                {#if massPreviewLoading}
                  <CircleNotch size={13} weight="light" class="anim-spin" />
                {:else}
                  <StackSimple size={13} weight="bold" />
                {/if}
                {$_("ui_previewMassMigration")}
              </button>
            </div>
          {/if}
        {/if}

      <!-- Step 2: Search & pick match -->
      {:else if step === "search"}
        <div class="search-step">

          <!-- Source context pill -->
          {#if selectedSource}
            <div class="search-context">
              <img src={resolveServiceIconUrl(selectedSource, { kind: "source" })} alt="" class="search-context-icon"
                onerror={(e) => applyServiceIconFallback(e, "source")} />
              <span class="search-context-name">{selectedSource.displayName}</span>
              <button class="search-context-change" onclick={() => { step = "source"; results = []; }}>{$_("ui_change")}</button>
            </div>
          {/if}

          <div class="search-row">
            <div class="search-bar">
              <MagnifyingGlass size={13} weight="light" class="search-icon" />
                <input class="search-input" bind:value={query}
                onkeydown={(e) => e.key === "Enter" && selectedSource && searchSource(selectedSource, query)}
                placeholder={$_("ui_searchTitle")} use:focusOnMount />
            </div>
            <button class="search-btn"
              onclick={() => selectedSource && searchSource(selectedSource, query)}
              disabled={searching || !selectedSource}>
              {#if searching}
                <CircleNotch size={13} weight="light" class="anim-spin" />
              {:else}
                <MagnifyingGlass size={12} weight="bold" /> {$_("novelSources_actions_search")}{/if}
            </button>
          </div>

          {#if error}<p class="error"><Warning size={13} weight="light" /> {error}</p>{/if}

          <div class="results">
            {#if searching}
              {#each Array(6) as _, i}
                <div class="sk-result">
                  <div class="skeleton sk-cover"></div>
                  <div class="sk-meta">
                    <div class="skeleton sk-title"></div>
                    <div class="skeleton sk-title" style="width:40%"></div>
                  </div>
                </div>
              {/each}
            {:else}
              {#each results as { manga: m, similarity }, idx}
                <button class="result-row"
                  onclick={() => selectMatch(m, similarity)}
                  disabled={loadingMatchId !== null}>
                  <div class="result-cover-wrap">
                    <img src={resolveMangaCoverUrl(m, { context: "migration", persistence: "memory" })} alt={m.title} class="result-cover" />
                  </div>
                  <div class="result-info">
                    <span class="result-title">{m.title}</span>
                    <div class="result-meta">
                      {#if idx === 0 && similarity > 0.5}
                        <span class="best-match-badge"><Sparkle size={9} weight="fill" /> {$_("ui_bestMatch")}</span>
                      {/if}
                      <span class="sim-bar"><span class="sim-fill" style="width:{Math.round(similarity * 100)}%"></span></span>
                      <span class="sim-label">{Math.round(similarity * 100)}{$_("ui_match")}</span>
                    </div>
                  </div>
                  {#if loadingMatchId === m.id}
                    <CircleNotch size={13} weight="light" class="anim-spin" style="color:var(--text-faint);flex-shrink:0" />
                  {:else}
                    <ArrowRight size={13} weight="light" style="color:var(--text-faint);flex-shrink:0;opacity:0.5" />
                  {/if}
                </button>
              {/each}
              {#if !searching && results.length === 0 && !error}
                <div class="centered">
                  <span class="hint">{query ? $_("ui_noResultsTryADifferentTitle") : $_("ui_enterATitleToSearch")}</span>
                </div>
              {/if}
            {/if}
          </div>
        </div>

      <!-- Step 3: Confirm -->
      {:else if step === "mass-preview" && massPreview}
        <div class="confirm-step">
          <div class="confirm-actions" style="justify-content: space-between;">
            <button class="back-btn" onclick={() => step = "source"} disabled={migrating}>{$_("ui_back")}</button>
            <span class="source-meta">
              {massPreview.readyCount} {$_("ui_ready_8a670e1b")} {massPreview.needsReviewCount} {$_("ui_needsReview")} {massPreview.blockedCount} {$_("ui_blocked")}
            </span>
          </div>

          <div class="confirm-stats">
            <div class="stat-row"><span class="stat-label">{$_("ui_sourceFrom")}</span><strong>{manga.source?.displayName ?? "Unknown"}</strong></div>
            <div class="stat-row"><span class="stat-label">{$_("ui_sourceTo")}</span><strong>{selectedSource?.displayName ?? "Unknown"}</strong></div>
            <div class="stat-row"><span class="stat-label">{$_("ui_selectedReadyItems")}</span><strong>{massSelectedIds.size}</strong></div>
          </div>

          <div class="results">
            {#each massPreview.items as item (item.currentManga.id)}
              <div class="result-row" class:result-row-ready={item.status === "ready"} class:result-row-blocked={item.status === "blocked"}>
                <button
                  class="mass-check"
                  type="button"
                  disabled={item.status !== "ready"}
                  onclick={() => toggleMassSelection(item.currentManga.id)}
                >
                  {#if massSelectedIds.has(item.currentManga.id)}
                    <Check size={12} weight="bold" />
                  {/if}
                </button>
                <div class="result-info">
                  <span class="result-title">{item.currentManga.title}</span>
                  <div class="result-meta">
                    <span class="sim-label">{item.status}</span>
                    <span class="sim-label">{item.reasonCode}</span>
                    {#if item.match}
                      <span class="sim-label">{Math.round(item.match.similarity * 100)}{$_("ui_match")}</span>
                    {/if}
                    <span class="sim-label">{item.matchedReadCount} {$_("ui_readMatched")}</span>
                  </div>
                  {#if item.match}
                    <span class="source-meta">{item.match.manga.title}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          <div class="notice">
            <Check size={14} weight="light" />
            <span>{$_("ui_theOriginalLibraryItemsStayProtectedByThe")}</span>
          </div>

          {#if error}<p class="error"><Warning size={13} weight="light" /> {error}</p>{/if}

          <div class="confirm-actions">
            <button class="back-btn" onclick={() => step = "source"} disabled={migrating}>{$_("ui_back")}</button>
            <button class="migrate-btn" onclick={applyMassMigration} disabled={migrating || massSelectedIds.size === 0}>
              {#if migrating}
                <CircleNotch size={13} weight="light" class="anim-spin" />
              {:else}
                <StackSimple size={13} weight="bold" />
              {/if}
              {$_("ui_applyReadyItems")}
            </button>
          </div>
        </div>

      {:else if step === "confirm" && selectedMatch}
        <div class="confirm-step">
          <div class="confirm-row">
            <div class="confirm-manga">
              <div class="confirm-cover-wrap">
                <img src={resolveMangaCoverUrl(manga, { context: "migration", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt={manga.title} class="confirm-cover" />
              </div>
              <p class="confirm-title">{manga.title}</p>
              <p class="confirm-source">{manga.source?.displayName ?? "Unknown"}</p>
              <span class="confirm-tag">{$_("bookDetail_filter_current")}</span>
            </div>

            <div class="confirm-divider">
              <ArrowRight size={16} weight="light" class="confirm-arrow" />
            </div>

            <div class="confirm-manga">
              <div class="confirm-cover-wrap">
                <img src={resolveMangaCoverUrl(selectedMatch.manga, { context: "migration", persistence: "memory" })} alt={selectedMatch.manga.title} class="confirm-cover" />
              </div>
              <p class="confirm-title">{selectedMatch.manga.title}</p>
              <p class="confirm-source">{selectedSource?.displayName ?? "Unknown"}</p>
              <span class="confirm-tag confirm-tag-new">{$_("ui_new")}</span>
            </div>
          </div>

          <div class="confirm-stats">
            <div class="stat-row">
              <span class="stat-label">{$_("ui_titleMatch")}</span>
              <span class="stat-val"
                class:stat-good={selectedMatch.similarity > 0.7}
                class:stat-warn={selectedMatch.similarity > 0.4 && selectedMatch.similarity <= 0.7}
                class:stat-bad={selectedMatch.similarity <= 0.4}>
                {Math.round(selectedMatch.similarity * 100)}%
              </span>
            </div>
            <div class="stat-row">
              <span class="stat-label">{$_("ui_chaptersOnNewSource")}</span>
              <span class="stat-val" class:stat-warn={chapterDiff < -5}>
                {selectedMatch.chapters.length}
                {#if chapterDiff !== 0}
                  <span class="chapter-diff">{chapterDiff > 0 ? `+${chapterDiff}` : chapterDiff} {$_("ui_vsCurrent")}</span>
                {/if}
              </span>
            </div>
            <div class="stat-row">
              <span class="stat-label">{$_("ui_readProgressToCarryOver")}</span>
              <span class="stat-val">{selectedMatch.readCount} / {readCount} {$_("ui_chapters")}</span>
            </div>
          </div>

          {#if chapterDiff < -5}
            <div class="warn-box">
              <Warning size={13} weight="light" />
              {$_("ui_newSourceHas")} {Math.abs(chapterDiff)} {$_("ui_fewerChaptersSomeContentMayBeMissing")}
            </div>
          {/if}

          <p class="confirm-note">{$_("ui_theCurrentEntryWillBeRemovedFromYour")}</p>

          {#if error}<p class="error"><Warning size={13} weight="light" /> {error}</p>{/if}

          <div class="confirm-actions">
            <button class="back-btn" onclick={() => step = "search"} disabled={migrating}>{$_("ui_back")}</button>
            <button class="migrate-btn" onclick={migrate} disabled={migrating}>
              {#if migrating}
                <CircleNotch size={13} weight="light" class="anim-spin" /> {$_("ui_migrating")}{:else}
                <Check size={13} weight="bold" /> {$_("detail_actions_migrate")}{/if}
            </button>
          </div>
        </div>
      {/if}

    </div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.68); display: flex; align-items: center; justify-content: center; z-index: 200; backdrop-filter: blur(14px) saturate(118%); animation: fadeIn 0.14s ease both; }
  .modal { background: rgba(21, 20, 25, 0.98); border: 1px solid rgba(92, 88, 103, 0.42); border-radius: 18px; width: 520px; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: inset 0 1px 0 rgba(255,255,255,0.025), 0 28px 80px rgba(0,0,0,0.54); animation: scaleIn 0.16s ease both; }
  .modal-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 15px 18px; border-bottom: 1px solid rgba(92, 88, 103, 0.34); flex-shrink: 0; }
  .modal-title { display: flex; flex-direction: column; gap: 2px; }
  .modal-title-label { font-family: "Manrope", "Inter", system-ui, sans-serif; font-size: 9px; color: rgba(202, 196, 208, 0.48); letter-spacing: 0.14em; text-transform: uppercase; }
  .modal-title-manga { font-size: 13px; font-weight: 800; color: #e8e4eb; letter-spacing: 0.02em; }
  .close-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 10px; color: rgba(202, 196, 208, 0.74); background: rgba(255,255,255,0.018); border: 1px solid rgba(92, 88, 103, 0.42); cursor: pointer; transition: color 140ms ease, background 140ms ease, transform 140ms ease; flex-shrink: 0; }
  .close-btn:hover { color: #e8e4eb; background: rgba(201, 181, 255, 0.1); }
  .close-btn:active { transform: scale(0.96); }

  /* Steps */
  .steps { display: flex; align-items: center; gap: var(--sp-1); padding: 10px 18px; border-bottom: 1px solid rgba(92, 88, 103, 0.34); flex-shrink: 0; }
  .step { display: flex; align-items: center; gap: var(--sp-2); opacity: 0.4; transition: opacity var(--t-base); }
  .step + .step::before { content: "›"; color: var(--text-faint); margin-right: var(--sp-1); font-size: var(--text-sm); }
  .step-active { opacity: 1; }
  .step-done   { opacity: 0.6; }
  .step-dot { width: 18px; height: 18px; border-radius: 50%; background: var(--bg-raised); border: 1px solid var(--border-base); display: flex; align-items: center; justify-content: center; font-family: var(--font-ui); font-size: 10px; color: var(--text-faint); flex-shrink: 0; }
  .step-active .step-dot { background: var(--accent-muted); border-color: var(--accent-dim); color: var(--accent-fg); }
  .step-label { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); color: var(--text-muted); }
  .step-active .step-label { color: var(--text-secondary); }

  /* Body */
  .body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .mode-tabs { display: flex; gap: 4px; padding: var(--sp-3) var(--sp-4) 0; }
  .mode-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 var(--sp-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    background: none;
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
  }
  .mode-tab-active { background: var(--accent-muted); border-color: var(--accent-dim); color: var(--accent-fg); }
  .centered { flex: 1; display: flex; align-items: center; justify-content: center; padding: var(--sp-8); }
  .hint { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); }

  /* Source list */
  .source-list { flex: 1; overflow-y: auto; padding: var(--sp-2); display: flex; flex-direction: column; gap: 1px; }
  .source-row { display: flex; align-items: center; gap: var(--sp-3); padding: 9px var(--sp-3); border-radius: var(--radius-md); border: 1px solid transparent; background: none; text-align: left; width: 100%; cursor: pointer; transition: background var(--t-fast), border-color var(--t-fast); }
  .source-row:hover { background: rgba(184, 167, 234, 0.08); border-color: rgba(184, 167, 234, 0.14); }
  .source-row-active { background: rgba(184, 167, 234, 0.12); border-color: rgba(184, 167, 234, 0.18); }
  .source-icon { width: 28px; height: 28px; border-radius: var(--radius-md); object-fit: cover; flex-shrink: 0; background: var(--bg-raised); }
  .source-info { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
  .source-name { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .source-meta { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); }
  :global(.source-arrow) { color: var(--text-faint); opacity: 0; transition: opacity var(--t-base); }
  .source-row:hover :global(.source-arrow) { opacity: 1; }

  /* Lang filter bar */
  .src-lang-bar { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-2); border-bottom: 1px solid var(--border-dim); flex-shrink: 0; }
  .src-lang-nav { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex-shrink: 0; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); background: none; color: var(--text-faint); font-size: 15px; line-height: 1; cursor: pointer; transition: color var(--t-base), border-color var(--t-base), background var(--t-base); }
  .src-lang-nav:hover { color: var(--text-muted); border-color: var(--border-strong); background: var(--bg-raised); }
  .src-lang-chips { display: flex; align-items: center; gap: var(--sp-1); flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; scroll-behavior: smooth; }
  .src-lang-chip:last-child { margin-right: var(--sp-1); }
  .src-lang-chips::-webkit-scrollbar { display: none; }
  .src-lang-chip { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); padding: 3px 8px; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); background: none; color: var(--text-faint); cursor: pointer; white-space: nowrap; flex-shrink: 0; transition: color var(--t-base), border-color var(--t-base), background var(--t-base); }
  .src-lang-chip:hover { color: var(--text-muted); border-color: var(--border-strong); background: var(--bg-raised); }
  .src-lang-chip-active { color: var(--accent-fg); border-color: var(--accent-dim); background: var(--accent-muted); }
  .src-lang-chip-active:hover { color: var(--accent-fg); border-color: var(--accent); }

  /* Search step */
  .search-step { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); }
  .search-context { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); background: var(--bg-raised); border: 1px solid var(--border-dim); border-radius: var(--radius-md); flex-shrink: 0; }
  .search-context-icon { width: 18px; height: 18px; border-radius: var(--radius-sm); object-fit: cover; flex-shrink: 0; }
  .search-context-name { flex: 1; font-size: var(--text-sm); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .search-context-change { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); color: var(--accent-fg); background: none; border: none; cursor: pointer; padding: 0; flex-shrink: 0; transition: opacity var(--t-base); }
  .search-context-change:hover { opacity: 0.75; }
  .search-row { display: flex; align-items: center; gap: var(--sp-2); flex-shrink: 0; }
  .search-bar { flex: 1; display: flex; align-items: center; gap: var(--sp-2); background: var(--bg-raised); border: 1px solid var(--border-dim); border-radius: var(--radius-md); padding: 0 var(--sp-3) 0 var(--sp-2); transition: border-color var(--t-base); }
  .search-bar:focus-within { border-color: var(--border-strong); }
  :global(.search-icon) { color: var(--text-faint); flex-shrink: 0; }
  .search-input { flex: 1; background: none; border: none; outline: none; color: var(--text-primary); font-size: var(--text-sm); padding: 7px 0; }
  .search-input::placeholder { color: var(--text-faint); }
  .search-btn { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 6px 12px; border-radius: var(--radius-md); background: var(--accent-muted); color: var(--accent-fg); border: 1px solid var(--accent-dim); cursor: pointer; flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); transition: filter var(--t-base); }
  .search-btn:hover:not(:disabled) { filter: brightness(1.1); }
  .search-btn:disabled { opacity: 0.4; cursor: default; }
  .results { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
  .result-row { display: flex; align-items: center; gap: var(--sp-3); padding: 7px var(--sp-2); border-radius: var(--radius-md); border: none; background: none; text-align: left; width: 100%; cursor: pointer; transition: background var(--t-fast); }
  .result-row:hover:not(:disabled) { background: var(--bg-raised); }
  .result-row:disabled { opacity: 0.5; cursor: default; }
  .result-row-ready { border: 1px solid color-mix(in srgb, var(--color-success) 18%, var(--border-dim)); }
  .result-row-blocked { border: 1px solid color-mix(in srgb, var(--color-error) 18%, var(--border-dim)); }
  .result-cover-wrap { width: 36px; height: 54px; border-radius: var(--radius-sm); overflow: hidden; background: var(--bg-raised); border: 1px solid var(--border-dim); flex-shrink: 0; }
  .result-cover { width: 100%; height: 100%; object-fit: cover; }
  .result-info { flex: 1; display: flex; flex-direction: column; gap: 4px; overflow: hidden; min-width: 0; }
  .result-title { font-size: var(--text-sm); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-meta { display: flex; align-items: center; gap: var(--sp-2); }
  .best-match-badge { display: inline-flex; align-items: center; gap: 3px; font-family: var(--font-ui); font-size: 9px; letter-spacing: var(--tracking-wide); text-transform: uppercase; color: var(--accent-fg); background: var(--accent-muted); border: 1px solid var(--accent-dim); padding: 1px 5px; border-radius: var(--radius-sm); flex-shrink: 0; }
  .sim-bar { width: 48px; height: 3px; background: var(--bg-overlay); border-radius: var(--radius-full); overflow: hidden; flex-shrink: 0; display: inline-block; }
  .sim-fill { display: block; height: 100%; background: var(--accent); border-radius: var(--radius-full); transition: width 0.2s ease; }
  .sim-label { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); white-space: nowrap; }
  .mass-check {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--accent-fg);
    flex-shrink: 0;
    cursor: pointer;
  }
  .mass-check:disabled { opacity: 0.35; cursor: default; }

  /* Skeletons */
  .sk-result { display: flex; align-items: center; gap: var(--sp-3); padding: 7px var(--sp-2); }
  .sk-cover { width: 36px; height: 54px; border-radius: var(--radius-sm); flex-shrink: 0; }
  .sk-meta { flex: 1; display: flex; flex-direction: column; gap: var(--sp-2); }
  .sk-title { height: 13px; width: 65%; border-radius: var(--radius-sm); }

  /* Confirm step */
  .confirm-step { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4) var(--sp-5); }
  .confirm-row { display: flex; align-items: center; justify-content: center; gap: var(--sp-4); }
  .confirm-manga { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); flex: 1; max-width: 160px; }
  .confirm-cover-wrap { width: 100%; aspect-ratio: 2/3; border-radius: var(--radius-md); overflow: hidden; background: var(--bg-raised); border: 1px solid var(--border-dim); }
  .confirm-cover { width: 100%; height: 100%; object-fit: cover; }
  .confirm-title { font-size: var(--text-xs); color: var(--text-secondary); text-align: center; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: var(--leading-snug); }
  .confirm-source { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); text-align: center; }
  .confirm-divider { display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  :global(.confirm-arrow) { color: var(--text-faint); }
  .confirm-tag { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); text-transform: uppercase; padding: 2px 7px; border-radius: var(--radius-full); background: var(--bg-raised); border: 1px solid var(--border-dim); color: var(--text-faint); }
  .confirm-tag-new { background: var(--accent-muted); border-color: var(--accent-dim); color: var(--accent-fg); }
  .confirm-stats { display: flex; flex-direction: column; gap: var(--sp-2); background: var(--bg-raised); border: 1px solid var(--border-dim); border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); }
  .stat-row { display: flex; justify-content: space-between; align-items: center; }
  .stat-label { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-muted); letter-spacing: var(--tracking-wide); }
  .stat-val { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-secondary); letter-spacing: var(--tracking-wide); }
  .stat-good { color: var(--color-success) !important; }
  .stat-warn { color: #d97706 !important; }
  .stat-bad  { color: var(--color-error) !important; }
  .chapter-diff { font-family: var(--font-ui); font-size: var(--text-2xs); color: #d97706; letter-spacing: var(--tracking-wide); margin-left: var(--sp-2); }
  .warn-box { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); background: rgba(217,119,6,0.08); border: 1px solid rgba(217,119,6,0.25); border-radius: var(--radius-md); font-size: var(--text-xs); color: #d97706; line-height: var(--leading-snug); }
  .confirm-note { font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading-base); }
  .confirm-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); flex-shrink: 0; }
  .back-btn { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 6px 10px; border-radius: var(--radius-md); background: none; color: var(--text-muted); border: 1px solid var(--border-dim); cursor: pointer; flex-shrink: 0; transition: color var(--t-base), border-color var(--t-base), background var(--t-base); }
  .back-btn:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--border-strong); background: var(--bg-raised); }
  .back-btn:disabled { opacity: 0.4; cursor: default; }
  .migrate-btn { display: flex; align-items: center; gap: var(--sp-2); font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 7px 16px; border-radius: var(--radius-md); background: var(--accent-dim); border: 1px solid var(--accent); color: var(--accent-fg); cursor: pointer; transition: background var(--t-base), border-color var(--t-base); }
  .migrate-btn:hover:not(:disabled) { background: var(--accent-muted); border-color: var(--accent-bright); }
  .migrate-btn:disabled { opacity: 0.5; cursor: default; }

  /* Error */
  .notice.inline { margin: 0 var(--sp-2); border-radius: var(--radius-md); border: 1px solid var(--border-dim); }
  .error { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--text-xs); color: var(--color-error); padding: var(--sp-2) var(--sp-3); background: rgba(180,60,60,0.08); border-radius: var(--radius-md); border: 1px solid rgba(180,60,60,0.2); }

  @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
</style>

<script module lang="ts">
  function focusOnMount(node: HTMLElement) { node.focus(); }
</script>
