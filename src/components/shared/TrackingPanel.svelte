<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { CircleNotch, X, MagnifyingGlass, ArrowSquareOut, Lock, LockOpen, ArrowsClockwise } from "phosphor-svelte";
  import { gql } from "../../lib/client";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { cache, CACHE_GROUPS } from "../../lib/cache";
  import {
    GET_TRACKERS,
    GET_MANGA_TRACK_RECORDS,
    SEARCH_TRACKER,
    BIND_TRACK,
    UPDATE_TRACK,
    UNBIND_TRACK,
    FETCH_TRACK,
  } from "../../lib/queries";
  import { addToast } from "../../store/state.svelte";
  import NocturneState from "./NocturneState.svelte";
  import type { Tracker, TrackRecord, TrackSearch } from "../../lib/types";

  let { mangaId, mangaTitle, onClose }: {
    mangaId:    number;
    mangaTitle: string;
    onClose:    () => void;
  } = $props();

  // ── State ──────────────────────────────────────────────────────────────────

  type TabId = "records" | number;

  let trackers:    Tracker[]     = $state([]);
  let records:     TrackRecord[] = $state([]);
  let loading:     boolean       = $state(true);
  let activeTab:   TabId         = $state("records");

  let searchQuery:   string        = $state("");
  let searchResults: TrackSearch[] = $state([]);
  let searching:     boolean       = $state(false);
  let searchInited:  Set<number>   = $state(new Set());

  let binding:        boolean       = $state(false);
  let updatingRecord: number | null = $state(null);
  let syncing:        number | null = $state(null);
  let editingChapter: number | null = $state(null);
  let chapterDraft:   number        = $state(0);

  // ── Load ───────────────────────────────────────────────────────────────────

  async function load() {
    loading = true;
    try {
      const [tRes, rRes] = await Promise.all([
        gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS),
        gql<{ manga: { trackRecords: { nodes: TrackRecord[] } } }>(
          GET_MANGA_TRACK_RECORDS, { mangaId }
        ),
      ]);
      trackers = tRes.trackers.nodes;
      records  = rRes.manga.trackRecords.nodes;
    } catch (e: any) {
      addToast({ kind: "error", title: translate("ui_failedToLoadTracking"), body: e?.message });
    } finally {
      loading = false;
    }
  }

  $effect(() => { load(); });

  // Auto-search with manga title when switching to a tracker tab
  $effect(() => {
    const tab = activeTab;
    if (typeof tab !== "number") return;
    if (searchInited.has(tab)) return;
    searchQuery = mangaTitle;
    searchInited = new Set([...searchInited, tab]);
    doSearch(tab, mangaTitle);
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function trackerFor(id: number)      { return trackers.find(t => t.id === id); }
  function recordFor(trackerId: number){ return records.find(r => r.trackerId === trackerId); }
  const loggedInTrackers = $derived(trackers.filter(t => t.isLoggedIn));

  // ── Search ─────────────────────────────────────────────────────────────────

  let searchTimer: ReturnType<typeof setTimeout>;

  function onSearchInput() {
    clearTimeout(searchTimer);
    if (typeof activeTab !== "number") return;
    const tid = activeTab;
    if (!searchQuery.trim()) { searchResults = []; return; }
    searchTimer = setTimeout(() => doSearch(tid, searchQuery), 400);
  }

  async function doSearch(trackerId: number, query: string) {
    if (!query.trim()) return;
    searching = true;
    searchResults = [];
    try {
      const res = await gql<{ searchTracker: { trackSearches: TrackSearch[] } }>(
        SEARCH_TRACKER, { trackerId, query: query.trim() }
      );
      searchResults = res.searchTracker.trackSearches;
    } catch (e: any) {
      addToast({ kind: "error", title: translate("ui_searchFailed"), body: e?.message });
    } finally {
      searching = false;
    }
  }

  // ── Bind / Unbind ──────────────────────────────────────────────────────────

  async function bind(result: TrackSearch) {
    if (typeof activeTab !== "number") return;
    binding = true;
    try {
      const res = await gql<{ bindTrack: { trackRecord: TrackRecord } }>(
        BIND_TRACK, { mangaId, trackerId: activeTab, remoteId: result.remoteId }
      );
      records = [...records.filter(r => r.trackerId !== activeTab), res.bindTrack.trackRecord];
      cache.clearGroup(CACHE_GROUPS.LIBRARY);
      addToast({ kind: "success", title: translate("ui_nowTracking"), body: result.title });
      activeTab = "records";
    } catch (e: any) {
      addToast({ kind: "error", title: translate("ui_failedToBind"), body: e?.message });
    } finally {
      binding = false;
    }
  }

  async function unbind(record: TrackRecord) {
    updatingRecord = record.id;
    try {
      await gql(UNBIND_TRACK, { recordId: record.id });
      records = records.filter(r => r.id !== record.id);
      cache.clearGroup(CACHE_GROUPS.LIBRARY);
      addToast({ kind: "info", title: translate("ui_unlinkedFrom") + trackerFor(record.trackerId)?.name });
    } catch (e: any) {
      addToast({ kind: "error", title: translate("ui_failedToUnlink"), body: e?.message });
    } finally {
      updatingRecord = null;
    }
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  async function updateStatus(record: TrackRecord, status: number) {
    updatingRecord = record.id;
    try {
      const res = await gql<{ updateTrack: { trackRecord: TrackRecord } }>(
        UPDATE_TRACK, { recordId: record.id, status }
      );
      patchRecord(res.updateTrack.trackRecord);
    } catch (e: any) {
      addToast({ kind: "error", title: translate("ui_updateFailed"), body: e?.message });
    } finally {
      updatingRecord = null;
    }
  }

  async function updateScore(record: TrackRecord, scoreString: string) {
    updatingRecord = record.id;
    try {
      const res = await gql<{ updateTrack: { trackRecord: TrackRecord } }>(
        UPDATE_TRACK, { recordId: record.id, scoreString }
      );
      patchRecord(res.updateTrack.trackRecord);
    } catch (e: any) {
      addToast({ kind: "error", title: translate("ui_updateFailed"), body: e?.message });
    } finally {
      updatingRecord = null;
    }
  }

  async function togglePrivate(record: TrackRecord) {
    updatingRecord = record.id;
    try {
      const res = await gql<{ updateTrack: { trackRecord: TrackRecord } }>(
        UPDATE_TRACK, { recordId: record.id, private: !record.private }
      );
      patchRecord(res.updateTrack.trackRecord);
    } catch (e: any) {
      addToast({ kind: "error", title: translate("ui_updateFailed"), body: e?.message });
    } finally {
      updatingRecord = null;
    }
  }

  async function syncRecord(record: TrackRecord) {
    syncing = record.id;
    try {
      const res = await gql<{ fetchTrack: { trackRecord: TrackRecord } }>(
        FETCH_TRACK, { recordId: record.id }
      );
      patchRecord(res.fetchTrack.trackRecord);
      cache.clearGroup(CACHE_GROUPS.LIBRARY);
      addToast({ kind: "success", title: translate("ui_syncedFromTracker") });
    } catch (e: any) {
      addToast({ kind: "error", title: translate("ui_syncFailed"), body: e?.message });
    } finally {
      syncing = null;
    }
  }

  function patchRecord(updated: Partial<TrackRecord> & { id: number }) {
    records = records.map(r => r.id === updated.id ? { ...r, ...updated } : r);
    cache.clearGroup(CACHE_GROUPS.LIBRARY);
  }

  function openChapterEditor(record: TrackRecord) {
    editingChapter = record.id;
    chapterDraft   = record.lastChapterRead;
  }

  function cancelChapterEditor() { editingChapter = null; }

  async function submitChapter(record: TrackRecord) {
    const val = Math.max(0, chapterDraft);
    editingChapter = null;
    if (val === record.lastChapterRead) return;
    updatingRecord = record.id;
    try {
      const res = await gql<{ updateTrack: { trackRecord: TrackRecord } }>(
        UPDATE_TRACK, { recordId: record.id, lastChapterRead: val }
      );
      patchRecord(res.updateTrack.trackRecord);
    } catch (e: any) {
      addToast({ kind: "error", title: translate("ui_updateFailed"), body: e?.message });
    } finally {
      updatingRecord = null;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onClose()} />

<div
  class="backdrop"
  role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="modal" role="dialog" aria-label={$_("home_sections_tracking")}>

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="modal-header">
      <div class="header-left">
        <span class="modal-title">{$_("home_sections_tracking")}</span>
        <span class="modal-subtitle">{mangaTitle}</span>
      </div>
      <button class="close-btn" onclick={onClose}><X size={15} weight="light" /></button>
    </div>

    {#if loading}
      <NocturneState layout="compact" tone="info" icon="retry" eyebrow={$_("detail.actions.tracking")} title={$_("ui_loadingTrackers")} />

    {:else if loggedInTrackers.length === 0}
      <NocturneState layout="compact" tone="info" icon="info" eyebrow={$_("detail.actions.tracking")} title={$_("ui_noTrackersConnected")} body={$_("ui_trackingGoToSettings")} />

    {:else}
      <!-- ── Tabs ──────────────────────────────────────────────────────────── -->
      <div class="tabs">
        <button
          class="tab"
          class:tab-active={activeTab === "records"}
          onclick={() => activeTab = "records"}
        >
          {$_("ui_myList")}
          {#if records.length > 0}
            <span class="tab-badge">{records.length}</span>
          {/if}
        </button>
        {#each loggedInTrackers as t}
          {@const rec = recordFor(t.id)}
          <button
            class="tab"
            class:tab-active={activeTab === t.id}
            onclick={() => { activeTab = t.id; searchResults = []; }}
          >
            <img src={resolveServiceIconUrl(t, { kind: "tracker" })} alt={t.name} class="tab-icon" onerror={(e) => applyServiceIconFallback(e, "tracker")} />
            {t.name}
            {#if rec}<span class="tab-dot"></span>{/if}
          </button>
        {/each}
      </div>

      <!-- ── My List tab ───────────────────────────────────────────────────── -->
      {#if activeTab === "records"}
        <div class="tab-body">
          {#if records.length === 0}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow={$_("detail.actions.tracking")} title={$_("ui_notTrackingThisMangaYet")} body={$_("ui_trackingNotTrackingMangaBody")} />
          {:else}
            {#each records as record (record.id)}
              {@const tracker = trackerFor(record.trackerId)}
              {@const isBusy  = updatingRecord === record.id}
              <div class="record-row" class:record-busy={isBusy}>

                <div class="record-identity">
                  {#if tracker}
                    <img src={resolveServiceIconUrl(tracker, { kind: "tracker" })} alt={tracker.name} class="record-tracker-icon" onerror={(e) => applyServiceIconFallback(e, "tracker")} />
                  {/if}
                  {#if record.remoteUrl}
                    <a href={record.remoteUrl} target="_blank" rel="noreferrer" class="record-title">
                      {record.title}
                      <ArrowSquareOut size={10} weight="light" />
                    </a>
                  {:else}
                    <span class="record-title-plain">{record.title}</span>
                  {/if}
                </div>

                <div class="record-controls">
                  <select
                    class="record-select"
                    value={record.status}
                    disabled={isBusy}
                    onchange={(e) => updateStatus(record, parseInt((e.target as HTMLSelectElement).value))}
                  >
                    {#each (tracker?.statuses ?? []) as s}
                      <option value={s.value}>{s.name}</option>
                    {/each}
                  </select>

                  <select
                    class="record-select record-select-score"
                    value={record.displayScore}
                    disabled={isBusy}
                    onchange={(e) => updateScore(record, (e.target as HTMLSelectElement).value)}
                  >
                    {#each (tracker?.scores ?? []) as s}
                      <option value={s}>★ {s}</option>
                    {/each}
                  </select>

                  {#if tracker?.supportsPrivateTracking}
                    <button
                      class="record-icon-btn"
                      class:icon-active={record.private}
                      title={record.private ? "Private — click to make public" : "Public — click to make private"}
                      disabled={isBusy}
                      onclick={() => togglePrivate(record)}
                    >
                      {#if record.private}
                        <Lock size={12} weight="fill" />
                      {:else}
                        <LockOpen size={12} weight="light" />
                      {/if}
                    </button>
                  {/if}

                  <button
                    class="record-icon-btn"
                    title={$_("ui_syncFromTracker")}
                    disabled={syncing === record.id}
                    onclick={() => syncRecord(record)}
                  >
                    <ArrowsClockwise size={12} weight="light" class={syncing === record.id ? "anim-spin" : ""} />
                  </button>

                  <button
                    class="record-icon-btn icon-danger"
                    title={$_("ui_unlink")}
                    disabled={isBusy}
                    onclick={() => unbind(record)}
                  >
                    <X size={12} weight="bold" />
                  </button>
                </div>

                {#if editingChapter === record.id}
                  <div class="chapter-editor">
                    <div class="chapter-editor-top">
                      <span class="chapter-editor-label">{$_("ui_chapterRead")}</span>
                      <div class="chapter-input-wrap">
                        <input
                          type="number"
                          class="chapter-input"
                          min="0"
                          max={record.totalChapters > 0 ? record.totalChapters : undefined}
                          step="0.5"
                          bind:value={chapterDraft}
                          onkeydown={(e) => {
                            if (e.key === "Enter") submitChapter(record);
                            if (e.key === "Escape") cancelChapterEditor();
                          }}
                          use:autoFocus
                        />
                        {#if record.totalChapters > 0}
                          <span class="chapter-total">/ {record.totalChapters}</span>
                        {/if}
                      </div>
                    </div>
                    {#if record.totalChapters > 0}
                      <input
                        type="range"
                        class="chapter-slider"
                        min="0"
                        max={record.totalChapters}
                        step="1"
                        bind:value={chapterDraft}
                      />
                    {/if}
                    <div class="chapter-editor-actions">
                      <button class="chapter-save-btn" onclick={() => submitChapter(record)}>{$_("ui_save")}</button>
                      <button class="chapter-cancel-btn" onclick={cancelChapterEditor}>{$_("ui_cancel")}</button>
                    </div>
                  </div>
                {:else if record.totalChapters > 0}
                  <div class="record-progress clickable" role="button" tabindex="0"
                    onclick={() => openChapterEditor(record)}
                    onkeydown={(e) => e.key === "Enter" && openChapterEditor(record)}
                    title={$_("ui_clickToEdit")}
                  >
                    <span class="record-progress-label">{$_("ui_ch")} {record.lastChapterRead} / {record.totalChapters} <span class="edit-hint">✎</span></span>
                    <div class="record-progress-track">
                      <div class="record-progress-fill" style="width:{Math.min(100,(record.lastChapterRead/record.totalChapters)*100)}%"></div>
                    </div>
                  </div>
                {:else}
                  <div class="record-progress clickable" role="button" tabindex="0"
                    onclick={() => openChapterEditor(record)}
                    onkeydown={(e) => e.key === "Enter" && openChapterEditor(record)}
                    title={$_("ui_clickToSetChapter")}
                  >
                    <span class="record-progress-label">
                      {record.lastChapterRead > 0 ? `Ch. ${record.lastChapterRead} read` : $_("ui_setChapter")} <span class="edit-hint">✎</span>
                    </span>
                  </div>
                {/if}

              </div>
            {/each}
          {/if}
        </div>

      <!-- ── Tracker search tab ─────────────────────────────────────────────── -->
      {:else}
        {@const tracker    = trackerFor(activeTab as number)}
        {@const boundRecord = recordFor(activeTab as number)}
        <div class="search-bar">
          <MagnifyingGlass size={13} weight="light" class="search-icon" />
          <input
            class="search-input"
            placeholder="Search {tracker?.name}…"
            bind:value={searchQuery}
            oninput={onSearchInput}
            onkeydown={(e) => e.key === "Enter" && doSearch(activeTab as number, searchQuery)}
            use:autoFocus
          />
          {#if searching}
            <CircleNotch size={13} weight="light" class="anim-spin search-icon" />
          {/if}
        </div>

        <div class="search-results">
          {#if searching && searchResults.length === 0}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow={$_("detail.actions.tracking")} title={$_("ui_searching")} />
          {:else if !searching && searchQuery.trim() && searchResults.length === 0}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow={$_("detail.actions.tracking")} title={$_("ui_noTrackerResults")} body={$_("browse.source.noResultsFor", { query: searchQuery })} />
          {:else if !searchQuery.trim()}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow={$_("detail.actions.tracking")} title={$_("ui_typeATitleToSearch")} />
          {:else}
            {#each searchResults as result (result.trackerId + ":" + result.remoteId)}
              {@const isBound = boundRecord?.remoteId === result.remoteId}
              <button
                class="result-row"
                class:result-bound={isBound}
                onclick={() => isBound ? unbind(boundRecord!) : bind(result)}
                disabled={binding}
              >
                {#if result.coverUrl}
                  <img
                    src={result.coverUrl}
                    alt={result.title}
                    class="result-cover"
                    loading="lazy"
                    onerror={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                {:else}
                  <div class="result-cover result-cover-empty"></div>
                {/if}
                <div class="result-info">
                  <span class="result-title">{result.title}</span>
                  <div class="result-meta">
                    {#if result.publishingType}<span class="result-tag">{result.publishingType}</span>{/if}
                    {#if result.publishingStatus}<span class="result-tag">{result.publishingStatus}</span>{/if}
                    {#if result.totalChapters > 0}<span class="result-tag">{result.totalChapters} {$_("ui_ch_482bd64c")}</span>{/if}
                  </div>
                  {#if result.summary}
                    <p class="result-summary">{result.summary.slice(0,140)}{result.summary.length > 140 ? "…" : ""}</p>
                  {/if}
                </div>
                <span class="result-action" class:result-action-on={isBound}>
                  {isBound ? $_("ui_tracking") : $_("ui_track")}
                </span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    {/if}

  </div>
</div>

<script module lang="ts">
  function autoFocus(node: HTMLElement) { setTimeout(() => node.focus(), 50); }
</script>

<style>
  .backdrop {
    position: fixed; inset: 0; background: var(--component-tracking-backdrop-background);
    z-index: var(--z-settings);
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: var(--component-tracking-backdrop-blur); -webkit-backdrop-filter: var(--component-tracking-backdrop-blur);
    animation: fadeIn 0.12s ease both;
  }
  .modal {
    width: min(580px, calc(100vw - 48px));
    max-height: min(680px, calc(100vh - 80px));
    display: flex; flex-direction: column;
    gap: 14px;
    padding: 16px;
    background: var(--component-tracking-modal-background);
    border: var(--component-tracking-modal-border);
    border-radius: var(--component-tracking-modal-border-radius); overflow: hidden;
    box-shadow: var(--component-tracking-modal-box-shadow);
    animation: scaleIn 0.16s ease both;
  }

  /* Header */
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0; border-bottom: 0; flex-shrink: 0;
  }
  .header-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .modal-title { font-size: 13px; font-weight: 800; color: var(--component-tracking-modal-title-color); letter-spacing: 0.02em; }
  .modal-subtitle { font-family: var(--component-tracking-modal-subtitle-font-family); font-size: 11px; color: var(--component-tracking-modal-subtitle-color); letter-spacing: 0.08em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: uppercase; }
  .close-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--component-tracking-close-btn-border-radius); color: var(--component-tracking-close-btn-color); background: var(--component-tracking-close-btn-background); border: var(--component-tracking-close-btn-border); cursor: pointer; transition: color 140ms ease, background 140ms ease, transform 140ms ease; flex-shrink: 0; }
  .close-btn:hover { color: var(--component-tracking-close-btn-color-2); background: var(--component-tracking-close-btn-background-2); }
  .close-btn:active { transform: scale(0.96); }

  /* Tabs */
  .tabs { display: flex; align-items: center; gap: 6px; padding: 0; border-bottom: 0; flex-shrink: 0; overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { display: flex; align-items: center; gap: var(--sp-2); position: relative; font-family: var(--component-tracking-tab-font-family); font-size: 11px; font-weight: 800; letter-spacing: 0.04em; padding: 8px 11px; border-radius: var(--component-tracking-tab-border-radius); color: var(--component-tracking-tab-color); background: var(--component-tracking-tab-background); border: 1px solid transparent; cursor: pointer; white-space: nowrap; transition: color 140ms ease, background 140ms ease, border-color 140ms ease, transform 140ms ease; }
  .tab:hover { color: var(--component-tracking-tab-color-2); background: var(--component-tracking-tab-background-2); }
  .tab-active { color: var(--component-tracking-tab-active-color); background: var(--component-tracking-tab-active-background); border-color: var(--component-tracking-tab-active-border-color); }
  .tab:active { transform: scale(0.97); }
  .tab-icon { width: 14px; height: 14px; border-radius: var(--component-tracking-tab-icon-border-radius); object-fit: contain; }
  .tab-badge { font-size: 10px; padding: 0 5px; border-radius: var(--radius-full); background: var(--component-tracking-tab-badge-background); color: var(--component-tracking-tab-badge-color); min-width: 16px; text-align: center; }
  .tab-dot { position: absolute; top: 4px; right: 4px; width: 5px; height: 5px; border-radius: var(--component-tracking-tab-dot-border-radius); background: var(--component-tracking-tab-dot-background); box-shadow: var(--component-tracking-tab-dot-box-shadow); }

  /* Records */
  .tab-body { flex: 1; overflow-y: auto; padding: 0; scrollbar-width: none; display: flex; flex-direction: column; gap: 8px; }
  .tab-body::-webkit-scrollbar { display: none; }
  .record-row { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 0; border-radius: var(--component-tracking-record-row-border-radius); border: 0; background: transparent; transition: opacity 140ms ease; }
  .record-row:hover { background: transparent; }
  .record-busy { opacity: var(--component-tracking-record-busy-opacity); pointer-events: none; }
  .record-identity { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
  .record-tracker-icon { width: 16px; height: 16px; border-radius: var(--component-tracking-record-tracker-icon-border-radius); flex-shrink: 0; object-fit: contain; }
  .record-title { display: inline-flex; align-items: center; gap: 3px; font-size: var(--text-sm); color: var(--component-tracking-record-title-color); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; transition: color 140ms ease, opacity var(--t-base); }
  .record-title:hover { color: var(--component-tracking-record-title-color-2); opacity: var(--component-tracking-record-title-opacity); }
  .record-title-plain { font-size: var(--text-sm); color: var(--component-tracking-record-title-plain-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .record-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .record-select {
    font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide);
    min-height: 34px;
    padding: 0 32px 0 11px; border-radius: var(--component-tracking-record-select-border-radius);
    border: var(--component-tracking-record-select-border); background-color: var(--component-tracking-record-select-background-color);
    color: var(--text-secondary); outline: none; cursor: pointer;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 8px center;
    transition: border-color var(--t-base);
  }
  .record-select:hover:not(:disabled) { border-color: var(--component-tracking-record-select-border-color); background-color: var(--component-tracking-record-select-background-color-2); }
  .record-select:focus { border-color: var(--component-tracking-record-select-border-color-2); outline: none; box-shadow: var(--component-tracking-record-select-box-shadow); }
  .record-select:disabled { opacity: var(--component-tracking-record-select-opacity); cursor: default; }
  .record-select option { background: var(--component-tracking-record-select-option-background); color: var(--component-tracking-record-select-option-color); }
  .record-select-score { max-width: 100px; }
  .record-icon-btn { display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: var(--component-tracking-record-icon-btn-border-radius); border: var(--component-tracking-record-icon-btn-border); background: var(--component-tracking-record-icon-btn-background); color: var(--text-faint); cursor: pointer; transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease; flex-shrink: 0; }
  .record-icon-btn:hover:not(:disabled) { color: var(--component-tracking-record-icon-btn-color); border-color: var(--component-tracking-record-icon-btn-border-color); background: var(--component-tracking-record-icon-btn-background-2); }
  .record-icon-btn:active:not(:disabled) { transform: scale(0.96); }
  .record-icon-btn.icon-active { color: var(--component-tracking-record-icon-btn-icon-active-color); border-color: var(--component-tracking-record-icon-btn-icon-active-border-color); background: var(--component-tracking-record-icon-btn-icon-active-background); }
  .record-icon-btn.icon-danger:hover:not(:disabled) { color: var(--component-tracking-record-icon-btn-icon-danger-color); border-color: var(--component-tracking-record-icon-btn-icon-danger-border-color); background: var(--component-tracking-record-icon-btn-icon-danger-background); }
  .record-icon-btn:disabled { opacity: var(--component-tracking-record-icon-btn-opacity); cursor: default; }
  .record-progress { display: flex; flex-direction: column; gap: 4px; }
  .record-progress.clickable { cursor: pointer; border-radius: var(--radius-sm); padding: 3px 4px; margin: -3px -4px; transition: background var(--t-fast); }
  .record-progress.clickable:hover { background: var(--component-tracking-record-progress-clickable-background); }
  .record-progress-label { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); }
  .edit-hint { opacity: var(--component-tracking-edit-hint-opacity); font-size: 10px; transition: opacity var(--t-fast); }
  .record-progress.clickable:hover .edit-hint { opacity: var(--component-tracking-record-progress-clickable-edit-hint-opacity); }
  .record-progress-track { height: 2px; background: var(--component-tracking-record-progress-track-background); border-radius: var(--radius-full); overflow: hidden; }
  .record-progress-fill { height: 100%; background: var(--component-tracking-record-progress-fill-background); border-radius: var(--radius-full); transition: width 0.3s ease; }
  /* Chapter editor */
  .chapter-editor { display: flex; flex-direction: column; gap: var(--sp-2); padding: 10px 0 0; border-radius: var(--component-tracking-chapter-editor-chapter-editor-border-radius); border: 0; background: transparent; }
  .chapter-editor-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  .chapter-editor-label { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); }
  .chapter-input-wrap { display: flex; align-items: center; gap: var(--sp-2); }
  .chapter-input { width: 68px; background: var(--component-tracking-chapter-input-background); border: var(--component-tracking-chapter-input-border); border-radius: var(--component-tracking-chapter-input-border-radius); padding: 3px 6px; font-family: var(--font-ui); font-size: var(--text-sm); color: var(--text-primary); outline: none; text-align: center; }
  .chapter-input:focus { border-color: var(--component-tracking-chapter-input-border-color); box-shadow: var(--component-tracking-chapter-input-box-shadow); }
  .chapter-total { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-faint); }
  .chapter-slider { width: 100%; accent-color: var(--component-tracking-chapter-slider-accent-color); cursor: pointer; height: 4px; }
  .chapter-editor-actions { display: flex; gap: var(--sp-2); justify-content: flex-end; }
  .chapter-save-btn { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 5px 13px; border-radius: var(--component-tracking-chapter-save-btn-border-radius); border: var(--component-tracking-chapter-save-btn-border); background: var(--component-tracking-chapter-save-btn-background); color: var(--component-tracking-chapter-save-btn-color); cursor: pointer; transition: background 140ms ease, border-color 140ms ease, transform 140ms ease; }
  .chapter-save-btn:hover { background: var(--component-tracking-chapter-save-btn-background-2); border-color: var(--component-tracking-chapter-save-btn-border-color); }
  .chapter-save-btn:active { transform: scale(0.97); }
  .chapter-cancel-btn { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 5px 10px; border-radius: var(--component-tracking-chapter-cancel-btn-border-radius); border: var(--component-tracking-chapter-cancel-btn-border); background: var(--component-tracking-chapter-cancel-btn-background); color: var(--text-faint); cursor: pointer; transition: color 140ms ease, border-color 140ms ease, background 140ms ease; }
  .chapter-cancel-btn:hover { color: var(--component-tracking-chapter-cancel-btn-color); border-color: var(--component-tracking-chapter-cancel-btn-border-color); background: var(--component-tracking-chapter-cancel-btn-background-2); }

  /* Search */
  .search-bar { display: flex; align-items: center; gap: var(--sp-2); padding: 0; border-bottom: 0; flex-shrink: 0; }
  :global(.search-icon) { color: var(--text-faint); flex-shrink: 0; }
  .search-input { flex: 1; background: none; border: none; outline: none; font-size: var(--text-sm); color: var(--text-primary); }
  .search-input::placeholder { color: var(--text-faint); }
  .search-results { flex: 1; overflow-y: auto; padding: 0; scrollbar-width: none; }
  .search-results::-webkit-scrollbar { display: none; }

  /* Results */
  .result-row { display: flex; align-items: flex-start; gap: var(--sp-3); width: 100%; padding: 10px 2px; border-radius: var(--component-tracking-results-result-row-border-radius); border: 1px solid transparent; background: none; text-align: left; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
  .result-row:hover:not(:disabled) { background: var(--component-tracking-result-row-background); border-color: var(--component-tracking-result-row-border-color); }
  .result-row:disabled { opacity: var(--component-tracking-result-row-opacity); cursor: default; }
  .result-bound { background: var(--component-tracking-result-bound-background) !important; border-color: var(--component-tracking-result-bound-border-color) !important; }
  .result-cover { width: 46px; height: 66px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); flex-shrink: 0; }
  .result-cover-empty { background: var(--component-tracking-result-cover-empty-background); }
  .result-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); padding-top: 2px; }
  .result-title { font-size: var(--text-sm); color: var(--text-secondary); line-height: var(--leading-snug); text-align: left; }
  .result-meta { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .result-tag { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); padding: 1px 6px; border-radius: var(--component-tracking-result-tag-border-radius); border: var(--component-tracking-result-tag-border); background: var(--component-tracking-result-tag-background); color: var(--component-tracking-result-tag-color); }
  .result-summary { font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading-snug); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-align: left; }
  .result-action { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 6px 12px; border-radius: var(--component-tracking-result-action-border-radius); border: var(--component-tracking-result-action-border); background: var(--component-tracking-result-action-background); color: var(--component-tracking-result-action-color); flex-shrink: 0; align-self: center; transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease; }
  .result-row:hover:not(:disabled) .result-action { color: var(--component-tracking-result-row-result-action-color); border-color: var(--component-tracking-result-row-result-action-border-color); background: var(--component-tracking-result-row-result-action-background); }
  .result-action-on { color: var(--component-tracking-result-action-on-color) !important; border-color: var(--component-tracking-result-action-on-border-color) !important; background: var(--component-tracking-result-action-on-background) !important; }

  @keyframes fadeIn  { from { opacity: 0 }                         to { opacity: 1 } }
  @keyframes scaleIn { from { opacity: var(--component-tracking-keyframes-scalein-from-opacity); transform: scale(0.97) } to { opacity: var(--component-tracking-to-opacity); transform: scale(1) } }
</style>
