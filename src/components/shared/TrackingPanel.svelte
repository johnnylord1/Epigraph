<script lang="ts">
  import { CircleNotch, X, MagnifyingGlass, ArrowSquareOut, Lock, LockOpen, ArrowsClockwise } from "phosphor-svelte";
  import { gql, thumbUrl } from "../../lib/client";
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
      addToast({ kind: "error", title: "Failed to load tracking", body: e?.message });
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
      addToast({ kind: "error", title: "Search failed", body: e?.message });
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
      addToast({ kind: "success", title: "Now tracking", body: result.title });
      activeTab = "records";
    } catch (e: any) {
      addToast({ kind: "error", title: "Failed to bind", body: e?.message });
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
      addToast({ kind: "info", title: "Unlinked from " + trackerFor(record.trackerId)?.name });
    } catch (e: any) {
      addToast({ kind: "error", title: "Failed to unlink", body: e?.message });
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
      addToast({ kind: "error", title: "Update failed", body: e?.message });
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
      addToast({ kind: "error", title: "Update failed", body: e?.message });
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
      addToast({ kind: "error", title: "Update failed", body: e?.message });
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
      addToast({ kind: "success", title: "Synced from tracker" });
    } catch (e: any) {
      addToast({ kind: "error", title: "Sync failed", body: e?.message });
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
      addToast({ kind: "error", title: "Update failed", body: e?.message });
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
  <div class="modal" role="dialog" aria-label="Tracking">

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="modal-header">
      <div class="header-left">
        <span class="modal-title">Tracking</span>
        <span class="modal-subtitle">{mangaTitle}</span>
      </div>
      <button class="close-btn" onclick={onClose}><X size={15} weight="light" /></button>
    </div>

    {#if loading}
      <NocturneState layout="compact" tone="info" icon="retry" eyebrow="Tracking" title="Loading trackers" />

    {:else if loggedInTrackers.length === 0}
      <NocturneState layout="compact" tone="info" icon="info" eyebrow="Tracking" title="No trackers connected" body="Go to Settings > Tracking to log in." />

    {:else}
      <!-- ── Tabs ──────────────────────────────────────────────────────────── -->
      <div class="tabs">
        <button
          class="tab"
          class:tab-active={activeTab === "records"}
          onclick={() => activeTab = "records"}
        >
          My List
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
            <img src={thumbUrl(t.icon)} alt={t.name} class="tab-icon" />
            {t.name}
            {#if rec}<span class="tab-dot"></span>{/if}
          </button>
        {/each}
      </div>

      <!-- ── My List tab ───────────────────────────────────────────────────── -->
      {#if activeTab === "records"}
        <div class="tab-body">
          {#if records.length === 0}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow="Tracking" title="Not tracking this manga yet" body="Click a tracker tab above to search and add it." />
          {:else}
            {#each records as record (record.id)}
              {@const tracker = trackerFor(record.trackerId)}
              {@const isBusy  = updatingRecord === record.id}
              <div class="record-row" class:record-busy={isBusy}>

                <div class="record-identity">
                  {#if tracker}
                    <img src={thumbUrl(tracker.icon)} alt={tracker.name} class="record-tracker-icon" />
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
                    title="Sync from tracker"
                    disabled={syncing === record.id}
                    onclick={() => syncRecord(record)}
                  >
                    <ArrowsClockwise size={12} weight="light" class={syncing === record.id ? "anim-spin" : ""} />
                  </button>

                  <button
                    class="record-icon-btn icon-danger"
                    title="Unlink"
                    disabled={isBusy}
                    onclick={() => unbind(record)}
                  >
                    <X size={12} weight="bold" />
                  </button>
                </div>

                {#if editingChapter === record.id}
                  <div class="chapter-editor">
                    <div class="chapter-editor-top">
                      <span class="chapter-editor-label">Chapter read</span>
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
                      <button class="chapter-save-btn" onclick={() => submitChapter(record)}>Save</button>
                      <button class="chapter-cancel-btn" onclick={cancelChapterEditor}>Cancel</button>
                    </div>
                  </div>
                {:else if record.totalChapters > 0}
                  <div class="record-progress clickable" role="button" tabindex="0"
                    onclick={() => openChapterEditor(record)}
                    onkeydown={(e) => e.key === "Enter" && openChapterEditor(record)}
                    title="Click to edit"
                  >
                    <span class="record-progress-label">Ch. {record.lastChapterRead} / {record.totalChapters} <span class="edit-hint">✎</span></span>
                    <div class="record-progress-track">
                      <div class="record-progress-fill" style="width:{Math.min(100,(record.lastChapterRead/record.totalChapters)*100)}%"></div>
                    </div>
                  </div>
                {:else}
                  <div class="record-progress clickable" role="button" tabindex="0"
                    onclick={() => openChapterEditor(record)}
                    onkeydown={(e) => e.key === "Enter" && openChapterEditor(record)}
                    title="Click to set chapter"
                  >
                    <span class="record-progress-label">
                      {record.lastChapterRead > 0 ? `Ch. ${record.lastChapterRead} read` : "Set chapter…"} <span class="edit-hint">✎</span>
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
            <NocturneState layout="compact" tone="info" icon="search" eyebrow="Tracking" title="Searching" />
          {:else if !searching && searchQuery.trim() && searchResults.length === 0}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow="Tracking" title="No tracker results" body={`No results for "${searchQuery}".`} />
          {:else if !searchQuery.trim()}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow="Tracking" title="Type a title to search" />
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
                    {#if result.totalChapters > 0}<span class="result-tag">{result.totalChapters} ch</span>{/if}
                  </div>
                  {#if result.summary}
                    <p class="result-summary">{result.summary.slice(0,140)}{result.summary.length > 140 ? "…" : ""}</p>
                  {/if}
                </div>
                <span class="result-action" class:result-action-on={isBound}>
                  {isBound ? "✓ Tracking" : "Track"}
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
    position: fixed; inset: 0; background: rgba(0,0,0,0.68);
    z-index: var(--z-settings);
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(14px) saturate(118%); -webkit-backdrop-filter: blur(14px) saturate(118%);
    animation: fadeIn 0.12s ease both;
  }
  .modal {
    width: min(580px, calc(100vw - 48px));
    max-height: min(680px, calc(100vh - 80px));
    display: flex; flex-direction: column;
    gap: 14px;
    padding: 16px;
    background: rgba(21, 20, 25, 0.98);
    border: 1px solid rgba(92, 88, 103, 0.42);
    border-radius: 18px; overflow: hidden;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.025), 0 28px 80px rgba(0,0,0,0.54);
    animation: scaleIn 0.16s ease both;
  }

  /* Header */
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0; border-bottom: 0; flex-shrink: 0;
  }
  .header-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .modal-title { font-size: 13px; font-weight: 800; color: #e8e4eb; letter-spacing: 0.02em; }
  .modal-subtitle { font-family: "Manrope", "Inter", system-ui, sans-serif; font-size: 11px; color: rgba(202, 196, 208, 0.48); letter-spacing: 0.08em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: uppercase; }
  .close-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 10px; color: rgba(202, 196, 208, 0.74); background: rgba(255,255,255,0.018); border: 1px solid rgba(92, 88, 103, 0.42); cursor: pointer; transition: color 140ms ease, background 140ms ease, transform 140ms ease; flex-shrink: 0; }
  .close-btn:hover { color: #e8e4eb; background: rgba(201, 181, 255, 0.1); }
  .close-btn:active { transform: scale(0.96); }

  /* Tabs */
  .tabs { display: flex; align-items: center; gap: 6px; padding: 0; border-bottom: 0; flex-shrink: 0; overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { display: flex; align-items: center; gap: var(--sp-2); position: relative; font-family: "Manrope", "Inter", system-ui, sans-serif; font-size: 11px; font-weight: 800; letter-spacing: 0.04em; padding: 8px 11px; border-radius: 999px; color: rgba(202, 196, 208, 0.58); background: rgba(255,255,255,0.018); border: 1px solid transparent; cursor: pointer; white-space: nowrap; transition: color 140ms ease, background 140ms ease, border-color 140ms ease, transform 140ms ease; }
  .tab:hover { color: #e8e4eb; background: rgba(201, 181, 255, 0.08); }
  .tab-active { color: #d3c4ff; background: rgba(201, 181, 255, 0.13); border-color: rgba(201, 181, 255, 0.22); }
  .tab:active { transform: scale(0.97); }
  .tab-icon { width: 14px; height: 14px; border-radius: 2px; object-fit: contain; }
  .tab-badge { font-size: 10px; padding: 0 5px; border-radius: var(--radius-full); background: rgba(201, 181, 255, 0.16); color: #d8cbff; min-width: 16px; text-align: center; }
  .tab-dot { position: absolute; top: 4px; right: 4px; width: 5px; height: 5px; border-radius: 50%; background: #c9b5ff; box-shadow: 0 0 10px rgba(201, 181, 255, 0.34); }

  /* Records */
  .tab-body { flex: 1; overflow-y: auto; padding: 0; scrollbar-width: none; display: flex; flex-direction: column; gap: 8px; }
  .tab-body::-webkit-scrollbar { display: none; }
  .record-row { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 0; border-radius: 0; border: 0; background: transparent; transition: opacity 140ms ease; }
  .record-row:hover { background: transparent; }
  .record-busy { opacity: 0.5; pointer-events: none; }
  .record-identity { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
  .record-tracker-icon { width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; object-fit: contain; }
  .record-title { display: inline-flex; align-items: center; gap: 3px; font-size: var(--text-sm); color: #ddd6e8; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; transition: color 140ms ease, opacity var(--t-base); }
  .record-title:hover { color: #f0ecf7; opacity: 0.9; }
  .record-title-plain { font-size: var(--text-sm); color: #ddd6e8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .record-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .record-select {
    font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide);
    min-height: 34px;
    padding: 0 32px 0 11px; border-radius: 10px;
    border: 1px solid rgba(92, 88, 103, 0.36); background-color: rgba(255, 255, 255, 0.035);
    color: var(--text-secondary); outline: none; cursor: pointer;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 8px center;
    transition: border-color var(--t-base);
  }
  .record-select:hover:not(:disabled) { border-color: rgba(201, 181, 255, 0.26); background-color: rgba(201, 181, 255, 0.07); }
  .record-select:focus { border-color: rgba(201, 181, 255, 0.42); outline: none; box-shadow: 0 0 0 3px rgba(201, 181, 255, 0.08); }
  .record-select:disabled { opacity: 0.4; cursor: default; }
  .record-select option { background: #151419; color: #e8e4eb; }
  .record-select-score { max-width: 100px; }
  .record-icon-btn { display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; border: 1px solid rgba(92, 88, 103, 0.36); background: rgba(255, 255, 255, 0.025); color: var(--text-faint); cursor: pointer; transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease; flex-shrink: 0; }
  .record-icon-btn:hover:not(:disabled) { color: #e8e4eb; border-color: rgba(201, 181, 255, 0.24); background: rgba(201, 181, 255, 0.08); }
  .record-icon-btn:active:not(:disabled) { transform: scale(0.96); }
  .record-icon-btn.icon-active { color: #d8cbff; border-color: rgba(201, 181, 255, 0.28); background: rgba(201, 181, 255, 0.12); }
  .record-icon-btn.icon-danger:hover:not(:disabled) { color: #f08f9b; border-color: rgba(240, 143, 155, 0.42); background: rgba(240, 143, 155, 0.08); }
  .record-icon-btn:disabled { opacity: 0.3; cursor: default; }
  .record-progress { display: flex; flex-direction: column; gap: 4px; }
  .record-progress.clickable { cursor: pointer; border-radius: var(--radius-sm); padding: 3px 4px; margin: -3px -4px; transition: background var(--t-fast); }
  .record-progress.clickable:hover { background: rgba(201, 181, 255, 0.06); }
  .record-progress-label { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); }
  .edit-hint { opacity: 0; font-size: 10px; transition: opacity var(--t-fast); }
  .record-progress.clickable:hover .edit-hint { opacity: 1; }
  .record-progress-track { height: 2px; background: rgba(92, 88, 103, 0.32); border-radius: var(--radius-full); overflow: hidden; }
  .record-progress-fill { height: 100%; background: #c9b5ff; border-radius: var(--radius-full); transition: width 0.3s ease; }
  /* Chapter editor */
  .chapter-editor { display: flex; flex-direction: column; gap: var(--sp-2); padding: 10px 0 0; border-radius: 0; border: 0; background: transparent; }
  .chapter-editor-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  .chapter-editor-label { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); }
  .chapter-input-wrap { display: flex; align-items: center; gap: var(--sp-2); }
  .chapter-input { width: 68px; background: rgba(255,255,255,0.035); border: 1px solid rgba(92, 88, 103, 0.36); border-radius: 10px; padding: 3px 6px; font-family: var(--font-ui); font-size: var(--text-sm); color: var(--text-primary); outline: none; text-align: center; }
  .chapter-input:focus { border-color: rgba(201, 181, 255, 0.42); box-shadow: 0 0 0 3px rgba(201, 181, 255, 0.08); }
  .chapter-total { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-faint); }
  .chapter-slider { width: 100%; accent-color: #c9b5ff; cursor: pointer; height: 4px; }
  .chapter-editor-actions { display: flex; gap: var(--sp-2); justify-content: flex-end; }
  .chapter-save-btn { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 5px 13px; border-radius: 10px; border: 1px solid rgba(201, 181, 255, 0.32); background: rgba(201, 181, 255, 0.13); color: #d8cbff; cursor: pointer; transition: background 140ms ease, border-color 140ms ease, transform 140ms ease; }
  .chapter-save-btn:hover { background: rgba(201, 181, 255, 0.18); border-color: rgba(201, 181, 255, 0.44); }
  .chapter-save-btn:active { transform: scale(0.97); }
  .chapter-cancel-btn { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 5px 10px; border-radius: 10px; border: 1px solid rgba(92, 88, 103, 0.36); background: rgba(255,255,255,0.02); color: var(--text-faint); cursor: pointer; transition: color 140ms ease, border-color 140ms ease, background 140ms ease; }
  .chapter-cancel-btn:hover { color: #e8e4eb; border-color: rgba(201, 181, 255, 0.24); background: rgba(201, 181, 255, 0.07); }

  /* Search */
  .search-bar { display: flex; align-items: center; gap: var(--sp-2); padding: 0; border-bottom: 0; flex-shrink: 0; }
  :global(.search-icon) { color: var(--text-faint); flex-shrink: 0; }
  .search-input { flex: 1; background: none; border: none; outline: none; font-size: var(--text-sm); color: var(--text-primary); }
  .search-input::placeholder { color: var(--text-faint); }
  .search-results { flex: 1; overflow-y: auto; padding: 0; scrollbar-width: none; }
  .search-results::-webkit-scrollbar { display: none; }

  /* Results */
  .result-row { display: flex; align-items: flex-start; gap: var(--sp-3); width: 100%; padding: 10px 2px; border-radius: 12px; border: 1px solid transparent; background: none; text-align: left; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
  .result-row:hover:not(:disabled) { background: rgba(201, 181, 255, 0.07); border-color: rgba(201, 181, 255, 0.12); }
  .result-row:disabled { opacity: 0.5; cursor: default; }
  .result-bound { background: rgba(201, 181, 255, 0.1) !important; border-color: rgba(201, 181, 255, 0.18) !important; }
  .result-cover { width: 46px; height: 66px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); flex-shrink: 0; }
  .result-cover-empty { background: rgba(255,255,255,0.035); }
  .result-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); padding-top: 2px; }
  .result-title { font-size: var(--text-sm); color: var(--text-secondary); line-height: var(--leading-snug); text-align: left; }
  .result-meta { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .result-tag { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); padding: 1px 6px; border-radius: 8px; border: 1px solid rgba(92, 88, 103, 0.34); background: rgba(255,255,255,0.026); color: rgba(202, 196, 208, 0.58); }
  .result-summary { font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading-snug); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-align: left; }
  .result-action { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 6px 12px; border-radius: 10px; border: 1px solid rgba(92, 88, 103, 0.36); background: rgba(255,255,255,0.02); color: rgba(202, 196, 208, 0.62); flex-shrink: 0; align-self: center; transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease; }
  .result-row:hover:not(:disabled) .result-action { color: #d8cbff; border-color: rgba(201, 181, 255, 0.28); background: rgba(201, 181, 255, 0.12); }
  .result-action-on { color: #d8cbff !important; border-color: rgba(201, 181, 255, 0.28) !important; background: rgba(201, 181, 255, 0.12) !important; }

  @keyframes fadeIn  { from { opacity: 0 }                         to { opacity: 1 } }
  @keyframes scaleIn { from { opacity: 0; transform: scale(0.97) } to { opacity: 1; transform: scale(1) } }
</style>
