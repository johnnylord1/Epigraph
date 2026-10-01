<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { X, CircleNotch, ArrowRight, ArrowLeft } from "phosphor-svelte";
  import { onMount, untrack } from "svelte";
  import { gql } from "../../lib/client";
  import { resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
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
  import MigrationSourcePicker from "./MigrationSourcePicker.svelte";
  import MigrationResultList from "./MigrationResultList.svelte";
  import MigrationConfirm from "./MigrationConfirm.svelte";
  import { enterOnMount, glideHeight } from "../../lib/motion/motion";
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
    if (selectedLang !== "all") return sources.filter(s => s.lang === selectedLang);
    const map = new Map<string, Source>();
    for (const s of sources) {
      const existing = map.get(s.name);
      if (!existing) { map.set(s.name, s); continue; }
      const rank = langRank(s.lang) - langRank(existing.lang);
      if (rank < 0 || (rank === 0 && s.lang < existing.lang)) map.set(s.name, s);
    }
    return Array.from(map.values());
  });
  const sourceOptions = $derived(visibleSources.map((s) => ({
    id: s.id,
    name: s.displayName,
    iconSrc: resolveServiceIconUrl(s, { kind: "source" }),
  })));

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
  const totalCount  = $derived(currentChapters.length);
  const chapterDiff = $derived(chapterDifference(selectedMatch, totalCount));
  const currentSourceName = $derived(manga.source?.displayName ?? $_("libraryUpdate.unknownSource"));
  const selectedSourceName = $derived(selectedSource?.displayName ?? $_("libraryUpdate.unknownSource"));
  const resultOptions = $derived(results.map(({ manga: m, similarity }, idx) => {
    const best = idx === 0 && similarity > 0.5;
    const match = $_("migrate.matchPercent", { percent: percent(similarity) });
    return {
      id: String(m.id),
      title: m.title,
      coverSrc: resolveMangaCoverUrl(m, { context: "migration", persistence: "memory" }),
      hint: best ? `${$_("ui_bestMatch")} · ${match}` : match,
      best,
    };
  }));
  const confirmWarning = $derived.by(() => {
    if (!selectedMatch) return null;
    if (chapterDiff < -5) return `${$_("ui_newSourceHas")} ${Math.abs(chapterDiff)} ${$_("ui_fewerChaptersSomeContentMayBeMissing")}`;
    if (selectedMatch.similarity < 0.5) return `${$_("ui_lowConfidenceMatch")}. ${$_("feedback.reviewMigration")}`;
    return null;
  });

  function chapterDifference(match: Match | null, currentTotal: number): number {
    return match ? match.chapters.length - currentTotal : 0;
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

  function pickSource(id: string) {
    const src = sources.find((s) => s.id === id);
    if (!src) return;
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

  function pickResult(id: string) {
    const picked = results.find((r) => String(r.manga.id) === id);
    if (picked) void selectMatch(picked.manga, picked.similarity);
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
        <h2 class="mg-title" title={manga.title}>{manga.title}</h2>
        <p class="mg-subtitle">{step === "source" ? $_("migrate.fromSource", { source: currentSourceName, count: totalCount }) : selectedSourceName}</p>
      </div>
      <button bind:this={closeButtonEl} class="mg-close" type="button" onclick={onClose} disabled={migrating} aria-label={$_("ui_closeMigrationModal")}><X size={16} weight="bold" /></button>
    </header>

    <div class="mg-body">
      {#key step}<div class="mg-step" use:enterOnMount={{ y: 10, blur: 4, duration: 560 }}>
      {#if step === "source"}
        {#if sourceLoadError}
          <NocturneState
            layout="compact"
            tone="danger"
            icon="warning"
            eyebrow={$_("ui_migration")}
            title={$_("ui_migrationFailed")}
            body={sourceLoadError}
            actions={[{ label: $_("sources.actions.refresh"), kind: "primary", icon: "retry", onClick: loadSources }]}
          />
        {:else}
          <MigrationSourcePicker
            sources={sourceOptions}
            loading={loadingSources}
            emptyLabel={$_("ui_noOtherSourcesInstalled")}
            onPick={pickSource}
          >
            {#snippet tools()}
              {#if hasMultipleLangs}
                <label class="mg-field mg-field--select">
                  <select bind:value={selectedLang} aria-label={$_("migrate.allLanguages")}>
                    <option value="all">{languageLabel("all")}</option>
                    {#each availableLangs as lang}<option value={lang}>{languageLabel(lang)}</option>{/each}
                  </select>
                </label>
              {/if}
            {/snippet}
          </MigrationSourcePicker>
        {/if}

      {:else if step === "search"}
        <MigrationResultList
          bind:query
          {searching}
          results={resultOptions}
          pendingId={loadingMatchId === null ? null : String(loadingMatchId)}
          {error}
          onSearch={() => { if (selectedSource) searchSource(selectedSource, query); }}
          onPick={pickResult}
        />

      {:else if step === "confirm" && selectedMatch}
        <MigrationConfirm
          from={{ title: manga.title, caption: currentSourceName, coverSrc: resolveMangaCoverUrl(manga, { context: "migration", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration }) }}
          to={{ title: selectedMatch.manga.title, caption: selectedSourceName, coverSrc: resolveMangaCoverUrl(selectedMatch.manga, { context: "migration", persistence: "memory" }) }}
          warning={confirmWarning}
          note={$_("ui_theCurrentEntryWillBeRemovedFromYour")}
          {error}
        >
          {#snippet summary()}{$_("migrate.confirmSummary", { chapters: selectedMatch?.chapters.length ?? 0, read: selectedMatch?.readCount ?? 0 })}{/snippet}
        </MigrationConfirm>
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
