<script lang="ts">
  import {
    ArrowSquareOut,
    CircleNotch,
    LinkSimpleHorizontalBreak,
    MagnifyingGlass,
    X,
  } from "phosphor-svelte";
  import { addToast, store } from "../../store/state.svelte";
  import {
    findHardcoverRecordForNovel,
    loadHardcoverState,
    searchHardcoverBooks,
    unlinkHardcoverRecord,
    upsertHardcoverUserBook,
    type HardcoverBookSearchResult,
    type HardcoverNovelTrackRecord,
    type HardcoverTrackingState,
  } from "../../lib/novels/hardcover";
  import NocturneState from "./NocturneState.svelte";

  type TabId = "records" | "hardcover";

  let {
    title,
    sourceNovelId,
    contentLabel = "Novel",
    onClose,
  }: {
    title: string;
    sourceNovelId: string;
    contentLabel?: string;
    onClose: () => void;
  } = $props();

  const scopeInput = $derived({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  });
  let activeTab: TabId = $state("records");
  let state: HardcoverTrackingState = $state(loadHardcoverState());
  let searchQuery = $state("");
  let searchResults: HardcoverBookSearchResult[] = $state([]);
  let brokenCoverIds: Set<number> = $state(new Set());
  let searching = $state(false);
  let loadingMore = $state(false);
  let searchPage = $state(1);
  let hasMoreResults = $state(false);
  let binding = $state(false);
  let updating = $state(false);
  let error: string | null = $state(null);
  let searchInited = $state(false);

  const record = $derived(findHardcoverRecordForNovel(state.records, {
    novelId: sourceNovelId,
    title,
  }));
  const loggedIn = $derived(state.auth.connected && Boolean(state.auth.token));
  const scoreOptions = ["", "0.5", "1.0", "1.5", "2.0", "2.5", "3.0", "3.5", "4.0", "4.5", "5.0"];
  const statusOptions = ["Want to Read", "Currently Reading", "Read", "Did Not Finish"];

  $effect(() => {
    sourceNovelId;
    title;
    state = loadHardcoverState(scopeInput);
    searchQuery = title;
    searchResults = [];
    brokenCoverIds = new Set();
    searchPage = 1;
    hasMoreResults = false;
    error = null;
    searchInited = false;
    activeTab = "records";
  });

  $effect(() => {
    if (activeTab !== "hardcover" || searchInited || !loggedIn) return;
    searchInited = true;
    void doSearch(title);
  });

  async function doSearch(query = searchQuery, page = 1, append = false) {
    if (!query.trim() || !loggedIn) return;
    if (searching || loadingMore) return;
    const pageSize = 8;
    searching = !append;
    loadingMore = append;
    error = null;
    try {
      const results = await searchHardcoverBooks(scopeInput, query.trim(), pageSize, page);
      searchPage = page;
      hasMoreResults = results.length >= pageSize;
      if (append) {
        const seen = new Set(searchResults.map((result) => result.id));
        searchResults = [
          ...searchResults,
          ...results.filter((result) => !seen.has(result.id)),
        ];
      } else {
        searchResults = results;
        brokenCoverIds = new Set();
      }
      if (searchResults.length === 0) error = `No results for "${query.trim()}".`;
    } catch (err: any) {
      if (!append) error = err?.message ?? "Hardcover search failed";
      if (!append) searchResults = [];
    } finally {
      searching = false;
      loadingMore = false;
    }
  }

  function handleSearchScroll(event: Event) {
    const el = event.currentTarget as HTMLElement;
    if (!hasMoreResults || searching || loadingMore || !searchQuery.trim()) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 64) {
      void doSearch(searchQuery, searchPage + 1, true);
    }
  }

  async function bind(book: HardcoverBookSearchResult) {
    binding = true;
    error = null;
    try {
      await upsertHardcoverUserBook(scopeInput, {
        book,
        sourceNovelId,
      });
      state = loadHardcoverState(scopeInput);
      searchResults = [];
      activeTab = "records";
      addToast({ kind: "success", title: "Now tracking", body: book.title });
    } catch (err: any) {
      error = err?.message ?? "Hardcover link failed";
    } finally {
      binding = false;
    }
  }

  async function updateRecord(patch: { status?: string | null; rating?: number | null }) {
    if (!record) return;
    updating = true;
    error = null;
    try {
      await upsertHardcoverUserBook(scopeInput, {
        book: recordToBook(record),
        sourceNovelId,
        status: patch.status ?? record.status,
        rating: patch.rating ?? record.rating,
        progress: record.progress,
      });
      state = loadHardcoverState(scopeInput);
    } catch (err: any) {
      error = err?.message ?? "Hardcover update failed";
    } finally {
      updating = false;
    }
  }

  function unbind(record: HardcoverNovelTrackRecord) {
    state = unlinkHardcoverRecord(scopeInput, sourceNovelId, record.bookId);
    searchResults = [];
    error = null;
    addToast({ kind: "info", title: "Unlinked from Hardcover" });
  }

  function recordToBook(record: HardcoverNovelTrackRecord): HardcoverBookSearchResult {
    return {
      id: record.bookId,
      title: record.title,
      authors: record.authors,
      coverUrl: record.coverUrl,
      description: null,
      releaseYear: null,
      rating: record.rating,
      ratingsCount: null,
      slug: null,
      url: record.remoteUrl,
    };
  }

  function authorLine(authors: string[]): string {
    return authors.length > 0 ? authors.slice(0, 3).join(" / ") : "Hardcover book record";
  }

  function ratingLabel(rating: number | null | undefined): string {
    return rating ? `HC ${rating.toFixed(1)}` : "No rating";
  }

  function markBrokenCover(id: number) {
    brokenCoverIds = new Set([...brokenCoverIds, id]);
  }
</script>

<div
  class="backdrop"
  role="presentation"
  onclick={(event) => { if (event.target === event.currentTarget) onClose(); }}
>
  <div class="modal" role="dialog" aria-label={`${contentLabel} tracking`}>
    <div class="modal-header">
      <div class="header-left">
        <span class="modal-title">Tracking</span>
        <span class="modal-subtitle">{title}</span>
      </div>
      <button class="close-btn" type="button" onclick={onClose} aria-label="Close tracking">
        <X size={15} weight="light" />
      </button>
    </div>

    {#if !loggedIn}
      <NocturneState layout="compact" tone="info" icon="info" eyebrow="Tracking" title="No novel trackers connected" body="Go to Settings > Tracking and connect Hardcover." />
    {:else}
      <div class="tabs">
        <button
          class="tab"
          class:tab-active={activeTab === "records"}
          type="button"
          onclick={() => activeTab = "records"}
        >
          My List
          {#if record}
            <span class="tab-badge">1</span>
          {/if}
        </button>
        <button
          class="tab"
          class:tab-active={activeTab === "hardcover"}
          type="button"
          onclick={() => activeTab = "hardcover"}
        >
          <span class="tab-icon tab-icon-text">HC</span>
          Hardcover
          {#if record}
            <span class="tab-dot"></span>
          {/if}
        </button>
      </div>

      {#if activeTab === "records"}
        <div class="tab-body">
          {#if !record}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow="Tracking" title={`Not tracking this ${contentLabel.toLowerCase()} yet`} body="Click the Hardcover tab above to search and add it." />
          {:else}
            <div class="record-row" class:record-busy={updating}>
              <div class="record-main">
                {#if record.coverUrl}
                  <img
                    src={record.coverUrl}
                    alt={record.title}
                    class="record-cover"
                    loading="lazy"
                    onerror={(event) => { (event.target as HTMLImageElement).style.display = "none"; }}
                  />
                {:else}
                  <div class="record-cover record-cover-empty"><span>HC</span></div>
                {/if}
                <div class="record-content">
                  <div class="record-identity">
                    <span class="record-tracker-icon record-tracker-icon-text">HC</span>
                    {#if record.remoteUrl}
                      <a href={record.remoteUrl} target="_blank" rel="noreferrer" class="record-title">
                        {record.title}
                        <ArrowSquareOut size={10} weight="light" />
                      </a>
                    {:else}
                      <span class="record-title-plain">{record.title}</span>
                    {/if}
                  </div>
                  <p class="record-subtitle">{authorLine(record.authors)}</p>
                  <div class="record-meta">
                    <span class="result-tag">{ratingLabel(record.rating)}</span>
                    {#if record.status}<span class="result-tag">{record.status}</span>{/if}
                    <span class="result-tag">Hardcover ID {record.bookId}</span>
                    {#if record.progress}<span class="result-tag">Progress {record.progress}</span>{/if}
                  </div>
                  <div class="record-controls">
                <select
                  class="record-select"
                  value={record.status ?? "Want to Read"}
                  disabled={updating}
                  onchange={(event) => updateRecord({ status: (event.target as HTMLSelectElement).value })}
                >
                  {#each statusOptions as option}
                    <option value={option}>{option}</option>
                  {/each}
                </select>

                <select
                  class="record-select record-select-score"
                  value={record.rating ? record.rating.toFixed(1) : ""}
                  disabled={updating}
                  onchange={(event) => {
                    const value = (event.target as HTMLSelectElement).value;
                    updateRecord({ rating: value ? Number(value) : null });
                  }}
                >
                  {#each scoreOptions as option}
                    <option value={option}>{option ? `★ ${option}` : "No score"}</option>
                  {/each}
                </select>

                <button
                  class="record-icon-btn icon-danger"
                  type="button"
                  title="Unlink"
                  disabled={updating}
                  onclick={() => unbind(record)}
                >
                  <LinkSimpleHorizontalBreak size={12} weight="light" />
                </button>
                  </div>
                </div>
              </div>
            </div>
          {/if}
          {#if error}
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Tracking" title="Tracking update failed" body={error} />
          {/if}
        </div>
      {:else}
        <div class="search-bar">
          <MagnifyingGlass size={13} weight="light" class="search-icon" />
          <input
            class="search-input"
            placeholder="Search Hardcover..."
            bind:value={searchQuery}
            onkeydown={(event) => event.key === "Enter" && doSearch(searchQuery)}
          />
          {#if searching}
            <CircleNotch size={13} weight="light" class="anim-spin search-icon" />
          {/if}
        </div>

        <div class="search-results" onscroll={handleSearchScroll}>
          {#if searching && searchResults.length === 0}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow="Hardcover" title="Searching" />
          {:else if error}
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Hardcover" title="Search failed" body={error} />
          {:else if !searchQuery.trim()}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow="Hardcover" title="Type a title to search" />
          {:else}
            {#each searchResults as result (result.id)}
              {@const isBound = record?.bookId === result.id}
              <button
                class="result-row"
                class:result-bound={isBound}
                type="button"
                onclick={() => isBound && record ? unbind(record) : bind(result)}
                disabled={binding}
              >
                {#if result.coverUrl && !brokenCoverIds.has(result.id)}
                  <img
                    src={result.coverUrl}
                    alt={result.title}
                    class="result-cover"
                    loading="lazy"
                    onerror={() => markBrokenCover(result.id)}
                  />
                {:else}
                  <div class="result-cover result-cover-empty"><span>HC</span></div>
                {/if}
                <div class="result-info">
                  <span class="result-title">{result.title}</span>
                  <span class="result-subtitle">{authorLine(result.authors)}</span>
                  <div class="result-meta">
                    <span class="result-tag">{ratingLabel(result.rating)}</span>
                  </div>
                </div>
                <span class="result-action" class:result-action-on={isBound}>
                  {isBound ? "Tracking" : "Track"}
                </span>
              </button>
            {/each}
            {#if loadingMore}
              <div class="results-loading">
                <CircleNotch size={13} weight="light" class="anim-spin search-icon" />
                <span>Loading more...</span>
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.68);
    backdrop-filter: blur(14px) saturate(118%);
    -webkit-backdrop-filter: blur(14px) saturate(118%);
    animation: fadeIn 0.12s ease both;
  }
  .modal {
    width: min(580px, calc(100vw - 48px));
    max-height: min(680px, calc(100vh - 80px));
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    background: rgba(21, 20, 25, 0.98);
    border: 1px solid rgba(92, 88, 103, 0.42);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.025), 0 28px 80px rgba(0,0,0,0.54);
    animation: scaleIn 0.16s ease both;
  }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 0; border-bottom: 0; flex-shrink: 0; }
  .header-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .modal-title { font-size: 13px; font-weight: 800; color: #e8e4eb; letter-spacing: 0.02em; }
  .modal-subtitle { font-family: "Manrope", "Inter", system-ui, sans-serif; font-size: 11px; color: rgba(202, 196, 208, 0.48); letter-spacing: 0.08em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: uppercase; }
  .close-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 10px; color: rgba(202, 196, 208, 0.74); background: rgba(255,255,255,0.018); border: 1px solid rgba(92, 88, 103, 0.42); cursor: pointer; transition: color 140ms ease, background 140ms ease, transform 140ms ease; flex-shrink: 0; }
  .close-btn:hover { color: #e8e4eb; background: rgba(201, 181, 255, 0.1); }
  .close-btn:active { transform: scale(0.96); }
  .tabs { display: flex; align-items: center; gap: 6px; padding: 0; border-bottom: 0; flex-shrink: 0; overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { display: flex; align-items: center; gap: var(--sp-2); position: relative; font-family: "Manrope", "Inter", system-ui, sans-serif; font-size: 11px; font-weight: 800; letter-spacing: 0.04em; padding: 8px 11px; border-radius: 999px; color: rgba(202, 196, 208, 0.56); background: rgba(255,255,255,0.018); border: 1px solid transparent; cursor: pointer; white-space: nowrap; transition: color 140ms ease, background 140ms ease, border-color 140ms ease, transform 140ms ease; }
  .tab:hover { color: #e8e4eb; background: rgba(201, 181, 255, 0.08); }
  .tab-active { color: #d3c4ff; background: rgba(201, 181, 255, 0.13); border-color: rgba(201, 181, 255, 0.2); }
  .tab:active { transform: scale(0.97); }
  .tab-icon, .record-tracker-icon { width: 14px; height: 14px; border-radius: 2px; flex-shrink: 0; object-fit: contain; }
  .tab-icon-text, .record-tracker-icon-text { display: inline-flex; align-items: center; justify-content: center; background: rgba(201, 181, 255, 0.12); border: 1px solid rgba(201, 181, 255, 0.24); color: #d8cbff; font-size: 8px; font-weight: var(--weight-bold); }
  .record-tracker-icon { width: 16px; height: 16px; border-radius: 3px; }
  .tab-badge { font-size: 10px; padding: 0 5px; border-radius: var(--radius-full); background: rgba(201, 181, 255, 0.16); color: #d8cbff; min-width: 16px; text-align: center; }
  .tab-dot { position: absolute; top: 4px; right: 4px; width: 5px; height: 5px; border-radius: 50%; background: #c9b5ff; box-shadow: 0 0 10px rgba(201, 181, 255, 0.34); }
  .tab-body { flex: 1; overflow-y: auto; padding: 0; scrollbar-width: none; display: flex; flex-direction: column; gap: 8px; }
  .tab-body::-webkit-scrollbar { display: none; }
  .record-row { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 0; border-radius: 0; border: 0; background: transparent; transition: opacity 140ms ease; }
  .record-row:hover { background: transparent; }
  .record-busy { opacity: 0.5; pointer-events: none; }
  .record-main { display: flex; align-items: flex-start; gap: var(--sp-3); min-width: 0; }
  .record-cover { width: 56px; height: 80px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); flex: 0 0 auto; background: var(--bg-overlay); }
  .record-cover-empty,
  .result-cover-empty { display: flex; align-items: center; justify-content: center; color: #d8cbff; background: rgba(255,255,255,0.035); font-family: var(--font-ui); font-size: 9px; font-weight: var(--weight-bold); letter-spacing: var(--tracking-wide); }
  .record-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .record-identity { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
  .record-title { display: inline-flex; align-items: center; gap: 3px; font-size: var(--text-sm); color: #ddd6e8; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; transition: color 140ms ease, opacity var(--t-base); }
  .record-title:hover { color: #f0ecf7; opacity: 0.9; }
  .record-title-plain { font-size: var(--text-sm); color: #ddd6e8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .record-subtitle,
  .result-subtitle { margin: 0; font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .record-meta { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .record-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .record-select { min-height: 34px; font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 0 32px 0 11px; border-radius: 10px; border: 1px solid rgba(92, 88, 103, 0.36); background-color: rgba(255, 255, 255, 0.035); color: var(--text-secondary); outline: none; cursor: pointer; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease; }
  .record-select:hover:not(:disabled) { border-color: rgba(201, 181, 255, 0.26); background-color: rgba(201, 181, 255, 0.07); }
  .record-select:focus { border-color: rgba(201, 181, 255, 0.42); outline: none; box-shadow: 0 0 0 3px rgba(201, 181, 255, 0.08); }
  .record-select:disabled { opacity: 0.4; cursor: default; }
  .record-select option { background: #151419; color: #e8e4eb; }
  .record-select-score { max-width: 112px; }
  .record-icon-btn { display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; border: 1px solid rgba(92, 88, 103, 0.36); background: rgba(255, 255, 255, 0.025); color: var(--text-faint); cursor: pointer; transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease; flex-shrink: 0; }
  .record-icon-btn:hover:not(:disabled) { color: #e8e4eb; border-color: rgba(201, 181, 255, 0.24); background: rgba(201, 181, 255, 0.08); }
  .record-icon-btn:active:not(:disabled) { transform: scale(0.96); }
  .record-icon-btn.icon-danger:hover:not(:disabled) { color: #f08f9b; border-color: rgba(240, 143, 155, 0.42); background: rgba(240, 143, 155, 0.08); }
  .record-icon-btn:disabled { opacity: 0.3; cursor: default; }
  .search-bar { display: flex; align-items: center; gap: var(--sp-2); padding: 0; border-bottom: 0; flex-shrink: 0; }
  :global(.search-icon) { color: var(--text-faint); flex-shrink: 0; }
  .search-input { flex: 1; background: none; border: none; outline: none; font-size: var(--text-sm); color: var(--text-primary); }
  .search-input::placeholder { color: var(--text-faint); }
  .search-results { flex: 1; overflow-y: auto; padding: 0; scrollbar-width: none; }
  .search-results::-webkit-scrollbar { display: none; }
  .result-row { display: flex; align-items: center; gap: var(--sp-3); width: 100%; min-height: 76px; padding: 10px 2px; border-radius: 12px; border: 1px solid transparent; background: none; text-align: left; cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
  .result-row:hover:not(:disabled) { background: rgba(201, 181, 255, 0.07); border-color: rgba(201, 181, 255, 0.12); }
  .result-row:disabled { opacity: 0.5; cursor: default; }
  .result-bound { background: rgba(201, 181, 255, 0.1) !important; border-color: rgba(201, 181, 255, 0.18) !important; }
  .result-cover { width: 48px; height: 68px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); flex-shrink: 0; background: var(--bg-overlay); }
  .result-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); padding-top: 2px; }
  .result-title { font-size: var(--text-sm); color: var(--text-secondary); line-height: var(--leading-snug); text-align: left; font-weight: var(--weight-medium); }
  .result-meta { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .result-tag { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); padding: 1px 6px; border-radius: 8px; border: 1px solid rgba(92, 88, 103, 0.34); background: rgba(255,255,255,0.026); color: rgba(202, 196, 208, 0.58); }
  .result-action { font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 6px 12px; border-radius: 10px; border: 1px solid rgba(92, 88, 103, 0.36); background: rgba(255,255,255,0.02); color: rgba(202, 196, 208, 0.62); flex-shrink: 0; align-self: center; transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease; }
  .result-row:hover:not(:disabled) .result-action { color: #d8cbff; border-color: rgba(201, 181, 255, 0.28); background: rgba(201, 181, 255, 0.12); }
  .result-action-on { color: #d8cbff !important; border-color: rgba(201, 181, 255, 0.28) !important; background: rgba(201, 181, 255, 0.12) !important; }
  .results-loading { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-3); color: var(--text-faint); font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); }
  @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
  @keyframes scaleIn { from { opacity: 0; transform: scale(0.97) } to { opacity: 1; transform: scale(1) } }
</style>
