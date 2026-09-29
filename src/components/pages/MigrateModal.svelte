<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { X, MagnifyingGlass, CircleNotch, ArrowRight, ArrowLeft, Check, Sparkle, Plugs, ArrowsLeftRight, Warning } from "phosphor-svelte";
  import { onMount, untrack } from "svelte";
  import { gql } from "../../lib/client";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { GET_SOURCES } from "../../lib/queries";
  import { fetchSourceMangaChapters } from "../../lib/manga/runtime";
  import { fetchSourceMangaSearchWithFallback } from "../../lib/manga/sourceSearch";
  import { ensureServerAwakeFor } from "../../lib/serverLifecycle";
  import { waitForSuwayomiGraphqlReady } from "../../lib/suwayomiReadiness";
  import { setMigrationPresence } from "../../lib/discord";
  import { addToast, store } from "../../store/state.svelte";
  import type { Manga, Source, Chapter } from "../../lib/types";
  import {
    applyMangaMigrationWithJournal,
    undoMangaMigration,
  } from "../../lib/migration/manga";
  import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";
  import { createStoreMigrationIdentityBridge } from "../../lib/migration/storeIdentity.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import { enterOnMount, glideHeight, listFlip } from "../../lib/motion/motion";
  import "./migrationModal.css";

  interface Props {
    manga:           Manga;
    currentChapters: Chapter[];
    onClose:         () => void;
    onMigrated:      (newManga: Manga) => void;
  }
  let { manga, currentChapters, onClose, onMigrated }: Props = $props();

  type Step = "source" | "search" | "confirm";

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
  let sources: Source[]     = $state([]);
  let loadingSources        = $state(true);
  let sourceLoadError: string | null = $state(null);
  let selectedSource = $state<Source | null>(null);
  let sourceFilter          = $state("");

  // Lang filter: "en" first, then alphabetical
  let selectedLang: string       = $state("all");
  const availableLangs           = $derived.by(() => {
    const langs = Array.from(new Set<string>(sources.map(s => s.lang))).sort();
    const en = langs.indexOf("en");
    if (en > 0) { langs.splice(en, 1); langs.unshift("en"); }
    return langs;
  });
  const hasMultipleLangs         = $derived(availableLangs.length > 1);

  // With every language shown, one row per source name: the current work's language wins, then the
  // preferred extension language, then English, then the first alphabetically.
  function langRank(lang: string): number {
    if (lang === manga.source?.lang) return 0;
    if (lang === store?.settings?.preferredExtensionLang) return 1;
    if (lang === "en") return 2;
    return 3;
  }
  const visibleSources           = $derived.by(() => {
    const needle = sourceFilter.trim().toLowerCase();
    const matches = (s: Source) => !needle || s.displayName.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle);
    if (selectedLang !== "all") return sources.filter(s => s.lang === selectedLang && matches(s));
    const map = new Map<string, Source>();
    for (const s of sources) {
      if (!matches(s)) continue;
      const existing = map.get(s.name);
      if (!existing) { map.set(s.name, s); continue; }
      const rank = langRank(s.lang) - langRank(existing.lang);
      if (rank < 0 || (rank === 0 && s.lang < existing.lang)) map.set(s.name, s);
    }
    return Array.from(map.values());
  });

  const languageNames = (() => {
    try { return new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "language" }); }
    catch { return null; }
  })();
  function languageLabel(lang: string): string {
    if (lang === "all") return $_("migrate.allLanguages");
    try { return languageNames?.of(lang) ?? lang.toUpperCase(); }
    catch { return lang.toUpperCase(); }
  }

  let query                         = $state(untrack(() => manga.title));
  let results: { manga: Manga; similarity: number }[] = $state([]);
  let searching             = $state(false);
  let selectedMatch: Match | null = $state(null);
  let loadingMatchId: number | null = $state(null);
  let migrating             = $state(false);
  let error: string | null  = $state(null);
  let overlayEl: HTMLDivElement | undefined = $state();
  let modalEl: HTMLDivElement | undefined = $state();
  let closeButtonEl: HTMLButtonElement | undefined = $state();
  const readCount   = $derived(currentChapters.filter((c) => c.isRead).length);
  const totalCount  = $derived(currentChapters.length);
  const chapterDiff = $derived(chapterDifference(selectedMatch, totalCount));
  const currentSteps = ["source", "search", "confirm"] as const satisfies Step[];
  const stepIdx = $derived(currentSteps.indexOf(step));
  const currentSourceName = $derived(manga.source?.displayName ?? $_("libraryUpdate.unknownSource"));
  const selectedSourceName = $derived(selectedSource?.displayName ?? $_("libraryUpdate.unknownSource"));

  function chapterDifference(match: Match | null, currentTotal: number): number {
    return match ? match.chapters.length - currentTotal : 0;
  }

  function stepLabel(st: Step): string {
    return st === "source" ? $_("ui_pickSource") : st === "search" ? $_("migrate.stepSearch") : $_("migrate.stepConfirm");
  }

  function percent(similarity: number): number {
    return Math.round(similarity * 100);
  }

  function markBrokenImage(event: Event) {
    (event.currentTarget as HTMLImageElement).dataset.broken = "true";
  }

  async function attemptWakeWithDeadline(timeoutMs = 3500) {
    const wake = ensureServerAwakeFor("series-detail", {
      serverUrl: store.runtimeServerUrl ?? store.settings.serverUrl,
      binary: store.settings.serverBinary,
      updateIntensity: store.settings.libraryUpdateIntensity,
      profileId: store.runtimeResolvedLocalProfileId,
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
    }).catch(() => false);
    const deadline = new Promise<boolean>((resolve) => {
      window.setTimeout(() => resolve(false), timeoutMs);
    });
    await Promise.race([wake, deadline]);
  }

  async function loadSources() {
    loadingSources = true;
    sourceLoadError = null;
    try {
      await attemptWakeWithDeadline();
      const ready = await waitForSuwayomiGraphqlReady("sources", { attempts: 8, delayMs: 800, timeoutMs: 5000 });
      if (!ready) throw new Error("Suwayomi is still starting. Try loading migration sources again in a moment.");
      const d = await gql<{ sources: { nodes: Source[] } }>(GET_SOURCES);
      const filtered = d.sources.nodes.filter((s) => s.id !== "0" && s.id !== manga.source?.id);
      sources = filtered;
      const prefLang = store?.settings?.preferredExtensionLang ?? "";
      const langs = new Set(filtered.map(s => s.lang));
      if (prefLang && langs.has(prefLang) && langs.size > 1) selectedLang = prefLang;
    } catch (loadError) {
      console.error(loadError);
      sourceLoadError = loadError instanceof Error ? loadError.message : String(loadError);
    } finally {
      loadingSources = false;
    }
  }

  $effect(() => {
    untrack(() => { void loadSources(); });

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onKey(e: KeyboardEvent) { if (e.key === "Escape" && !migrating) onClose(); }

  onMount(() => {
    if (!overlayEl || !modalEl) return;
    return createDialogFocusBoundary({
      dialog: modalEl,
      isolationRoot: overlayEl,
      initialFocus: closeButtonEl,
    });
  });

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
    step = "search";
    searchSource(src, query);
  }

  function backToSources() {
    step = "source";
    results = [];
    error = null;
  }

  async function selectMatch(m: Manga, similarity: number) {
    loadingMatchId = m.id; error = null;
    try {
      const d = await fetchSourceMangaChapters({ mangaId: m.id, sourceId: m.source?.id });
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
    void setMigrationPresence(true, store.settings, "library");
    try {
      const identityBridge = createStoreMigrationIdentityBridge(
        store.runtimeResolvedLocalProfileId ?? store.settings.defaultLocalProfileId,
      );
      const result = await applyMangaMigrationWithJournal({
        currentManga: manga,
        currentChapters,
        targetSourceId: selectedSource?.id ?? selectedMatch.manga.source?.id ?? "unknown",
        match: selectedMatch,
        profileId: store.runtimeResolvedLocalProfileId,
        identityBridge,
      });

      addToast({
        kind: "success",
        title: translate("ui_sourceMigrated"),
        body: translate("migrate.movedTo", { title: manga.title, source: selectedMatch.manga.source?.displayName ?? selectedSource?.displayName ?? translate("ui_theNewSource") }),
        duration: 7000,
        action: {
          label: translate("ui_undo"),
          run: () => {
            void undoMangaMigration(result.journalEntryId, identityBridge).then(() => {
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
    } finally {
      void setMigrationPresence(false, store.settings, "library");
    }
  }

</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={overlayEl} class="mg-overlay" onclick={(e) => { if (e.target === e.currentTarget && !migrating) onClose(); }}>
  <div
    bind:this={modalEl}
    class="mg-modal"
    role="dialog"
    aria-modal="true"
    aria-label={$_("ui_migrateSource")}
    tabindex="-1"
    use:glideHeight
  >
    <header class="mg-header">
      <span class="mg-header-cover">
        <img src={resolveMangaCoverUrl(manga, { context: "migration", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt="" onerror={markBrokenImage} />
      </span>
      <div class="mg-heading">
        <p class="mg-eyebrow">{$_("migrate.eyebrow")}</p>
        <h2 class="mg-title" title={manga.title}>{manga.title}</h2>
        <p class="mg-subtitle">{$_("migrate.fromSource", { source: currentSourceName, count: totalCount })}</p>
      </div>
      <button bind:this={closeButtonEl} class="mg-close" type="button" onclick={onClose} disabled={migrating} aria-label={$_("ui_closeMigrationModal")}><X size={16} weight="bold" /></button>
    </header>

    <nav class="mg-steps" aria-label={$_("ui_migrateSource")}>
      <ol>
        {#each currentSteps as st, i}
          <li class:is-complete={i < stepIdx} aria-current={step === st ? "step" : undefined}>
            <span class="mg-step-chip">
              <span class="mg-step-icon" aria-hidden="true">
                {#if i < stepIdx}<Check size={15} weight="bold" />{:else if st === "source"}<Plugs size={16} weight="duotone" />{:else if st === "search"}<MagnifyingGlass size={16} weight="duotone" />{:else}<ArrowsLeftRight size={16} weight="duotone" />{/if}
              </span>
              <span>{stepLabel(st)}</span>
            </span>
            {#if i < currentSteps.length - 1}<span class="mg-step-line" aria-hidden="true"><i></i></span>{/if}
          </li>
        {/each}
      </ol>
    </nav>

    <div class="mg-body">
      {#key step}<div class="mg-step" use:enterOnMount={{ y: 10, blur: 4, duration: 560 }}>
      {#if step === "source"}
        {#if loadingSources}
          <div class="mg-list" aria-busy="true">
            {#each Array(5) as _}<div class="mg-skeleton"></div>{/each}
          </div>
        {:else if sourceLoadError}
          <NocturneState
            layout="compact"
            tone="danger"
            icon="warning"
            eyebrow={$_("ui_migration")}
            title={$_("ui_migrationFailed")}
            body={sourceLoadError}
            actions={[{ label: $_("sources.actions.refresh"), kind: "primary", icon: "retry", onClick: loadSources }]}
          />
        {:else if sources.length === 0}
          <div class="mg-empty"><span class="mg-mark"><Plugs size={18} weight="duotone" /></span><span>{$_("ui_noOtherSourcesInstalled")}</span></div>
        {:else}
          <p class="mg-lede">{$_("migrate.sourceLede")}</p>
          <div class="mg-toolbar">
            <label class="mg-field">
              <MagnifyingGlass size={16} weight="bold" />
              <input bind:value={sourceFilter} placeholder={$_("migrate.filterSources")} aria-label={$_("migrate.filterSources")} />
            </label>
            {#if hasMultipleLangs}
              <label class="mg-field mg-field--select">
                <select bind:value={selectedLang} aria-label={$_("migrate.allLanguages")}>
                  <option value="all">{languageLabel("all")}</option>
                  {#each availableLangs as lang}<option value={lang}>{languageLabel(lang)}</option>{/each}
                </select>
              </label>
            {/if}
          </div>
          <p class="mg-section-label">{$_("migrate.sourceCount", { count: visibleSources.length })}</p>
          {#if visibleSources.length === 0}
            <div class="mg-empty">{$_("migrate.noSourceMatches")}</div>
          {:else}
            <div class="mg-list">
              {#each visibleSources as src, i (src.id)}
                <button
                  animate:listFlip
                  style:--mg-i={i}
                  class="mg-row"
                  class:is-selected={selectedSource?.id === src.id}
                  type="button"
                  data-migration-source
                  onclick={() => pickSource(src)}>
                  <span class="mg-mark">
                    <img src={resolveServiceIconUrl(src, { kind: "source" })} alt="" onerror={(e) => applyServiceIconFallback(e, "source")} />
                  </span>
                  <span class="mg-row-copy">
                    <strong>{src.displayName}</strong>
                    <small>{languageLabel(src.lang)}{src.isNsfw ? " · NSFW" : ""}</small>
                  </span>
                  <span class="mg-row-end"><ArrowRight size={16} weight="bold" /></span>
                </button>
              {/each}
            </div>
          {/if}
        {/if}

      {:else if step === "search"}
        {#if selectedSource}
          <div class="mg-context">
            <span class="mg-mark">
              <img src={resolveServiceIconUrl(selectedSource, { kind: "source" })} alt="" onerror={(e) => applyServiceIconFallback(e, "source")} />
            </span>
            <span class="mg-row-copy">
              <strong>{selectedSource.displayName}</strong>
              <small>{languageLabel(selectedSource.lang)}</small>
            </span>
            <button class="mg-btn mg-btn--small" type="button" onclick={backToSources}>{$_("ui_change")}</button>
          </div>
        {/if}
        <p class="mg-lede">{$_("migrate.searchLede", { source: selectedSourceName })}</p>
        <form class="mg-field" onsubmit={(e) => { e.preventDefault(); if (selectedSource) searchSource(selectedSource, query); }}>
          <MagnifyingGlass size={16} weight="bold" />
          <input bind:value={query} placeholder={$_("ui_searchTitle")} aria-label={$_("ui_searchTitle")} use:focusOnMount />
          <button class="mg-btn mg-btn--primary mg-btn--small" type="submit" disabled={searching || !selectedSource || !query.trim()}>
            {#if searching}<CircleNotch size={14} weight="bold" class="anim-spin" />{/if}
            {$_("novelSources_actions_search")}
          </button>
        </form>

        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={$_("ui_searchFailed")} body={error} />
        {/if}

        {#if searching}
          <div class="mg-list" aria-busy="true">
            {#each Array(5) as _}<div class="mg-skeleton"></div>{/each}
          </div>
        {:else if results.length > 0}
          <p class="mg-section-label">{$_("migrate.resultCount", { count: results.length })}</p>
          <div class="mg-list">
            {#each results as { manga: m, similarity }, idx (m.id)}
              {@const best = idx === 0 && similarity > 0.5}
              <button class="mg-row"
                animate:listFlip
                style:--mg-i={idx}
                class:is-best={best}
                type="button"
                data-migration-result
                onclick={() => selectMatch(m, similarity)}
                disabled={loadingMatchId !== null}>
                <span class="mg-cover">
                  <img src={resolveMangaCoverUrl(m, { context: "migration", persistence: "memory" })} alt="" onerror={markBrokenImage} />
                </span>
                <span class="mg-row-copy">
                  <strong title={m.title}>{m.title}</strong>
                  <small>
                    {#if best}<span class="mg-pill mg-pill--accent"><Sparkle size={11} weight="fill" /> {$_("ui_bestMatch")}</span>{/if}
                    <span class="mg-meter"><i style:width="{percent(similarity)}%"></i></span>
                    <span>{$_("migrate.matchPercent", { percent: percent(similarity) })}</span>
                  </small>
                </span>
                <span class="mg-row-end">
                  {#if loadingMatchId === m.id}<CircleNotch size={16} weight="bold" class="anim-spin" />{:else}<ArrowRight size={16} weight="bold" />{/if}
                </span>
              </button>
            {/each}
          </div>
        {:else if !error}
          <div class="mg-empty">
            <span class="mg-mark"><MagnifyingGlass size={18} weight="duotone" /></span>
            <span>{query ? $_("ui_noResultsTryADifferentTitle") : $_("ui_enterATitleToSearch")}</span>
          </div>
        {/if}

      {:else if step === "confirm" && selectedMatch}
        <p class="mg-lede">{$_("migrate.confirmLede")}</p>
        <div class="mg-compare">
          <div class="mg-compare-card">
            <span class="mg-cover">
              <img src={resolveMangaCoverUrl(manga, { context: "migration", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt="" onerror={markBrokenImage} />
            </span>
            <span class="mg-row-copy">
              <span class="mg-pill">{$_("bookDetail_filter_current")}</span>
              <strong title={manga.title}>{manga.title}</strong>
              <small>{currentSourceName}</small>
            </span>
          </div>
          <span class="mg-compare-arrow" aria-hidden="true"><ArrowRight size={16} weight="bold" /></span>
          <div class="mg-compare-card is-new">
            <span class="mg-cover">
              <img src={resolveMangaCoverUrl(selectedMatch.manga, { context: "migration", persistence: "memory" })} alt="" onerror={markBrokenImage} />
            </span>
            <span class="mg-row-copy">
              <span class="mg-pill mg-pill--accent">{$_("ui_new")}</span>
              <strong title={selectedMatch.manga.title}>{selectedMatch.manga.title}</strong>
              <small>{selectedSourceName}</small>
            </span>
          </div>
        </div>

        <div class="mg-metrics">
          <div class="mg-metric">
            <span>{$_("ui_titleMatch")}</span>
            <strong
              class:is-good={selectedMatch.similarity > 0.7}
              class:is-warn={selectedMatch.similarity > 0.4 && selectedMatch.similarity <= 0.7}
              class:is-bad={selectedMatch.similarity <= 0.4}>{percent(selectedMatch.similarity)}%</strong>
          </div>
          <div class="mg-metric">
            <span>{$_("ui_chaptersOnNewSource")}</span>
            <strong class:is-warn={chapterDiff < -5}>{selectedMatch.chapters.length}</strong>
            {#if chapterDiff !== 0}<small>{chapterDiff > 0 ? `+${chapterDiff}` : chapterDiff} {$_("ui_vsCurrent")}</small>{/if}
          </div>
          <div class="mg-metric">
            <span>{$_("ui_readProgressToCarryOver")}</span>
            <strong>{selectedMatch.readCount} / {readCount}</strong>
            <small>{$_("ui_chapters")}</small>
          </div>
        </div>

        {#if chapterDiff < -5}
          <NocturneState
            layout="compact"
            tone="warning"
            icon="warning"
            eyebrow={$_("ui_migration")}
            title={$_("ui_warning")}
            body={`${$_("ui_newSourceHas")} ${Math.abs(chapterDiff)} ${$_("ui_fewerChaptersSomeContentMayBeMissing")}`}
          />
        {/if}

        <p class="mg-note"><Warning size={12} weight="bold" /> {$_("ui_theCurrentEntryWillBeRemovedFromYour")}</p>

        {#if error}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={$_("ui_migrationFailed")} body={error} />
        {/if}
      {/if}
      </div>{/key}
    </div>

    <footer class="mg-footer">
      {#if step === "source"}
        <span class="mg-spacer"></span>
        <button class="mg-btn" type="button" onclick={onClose}>{$_("ui_cancel")}</button>
      {:else if step === "search"}
        <button class="mg-btn" type="button" onclick={backToSources} disabled={loadingMatchId !== null}><ArrowLeft size={15} weight="bold" class="mg-arrow-back" /> {$_("ui_back")}</button>
        <span class="mg-spacer"></span>
      {:else}
        <button class="mg-btn" type="button" onclick={() => step = "search"} disabled={migrating}><ArrowLeft size={15} weight="bold" class="mg-arrow-back" /> {$_("ui_back")}</button>
        <span class="mg-spacer"></span>
        <button class="mg-btn mg-btn--primary" type="button" onclick={migrate} disabled={migrating || !selectedMatch}>
          {#if migrating}
            <CircleNotch size={15} weight="bold" class="anim-spin" /> {$_("ui_migrating")}
          {:else}
            {$_("detail_actions_migrate")} <ArrowRight size={15} weight="bold" class="mg-arrow-next" />
          {/if}
        </button>
      {/if}
    </footer>
  </div>
</div>

<script module lang="ts">
  function focusOnMount(node: HTMLElement) { node.focus(); }
</script>
