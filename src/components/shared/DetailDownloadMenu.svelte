<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { CaretLeft, CaretRight } from "phosphor-svelte";
  import { onMount, tick } from "svelte";

  interface NextOption {
    amount: number;
    available: number;
  }

  interface ExtraAction {
    label: string;
    count: number;
    disabled: boolean;
    onSelect: () => void;
  }

  interface Props {
    downloaded: number;
    total: number;
    /** Live state (queued or saving) shown in place of the downloaded count while it lasts. */
    status?: string | null;
    /** Chapter label the "next" shortcuts start from; the shortcuts are hidden without one. */
    nextFrom?: string | number | null;
    nextOptions?: readonly NextOption[];
    unreadCount: number;
    notDownloadedCount: number;
    busy?: boolean;
    deleting?: boolean;
    extraActions?: readonly ExtraAction[];
    onNext: (amount: number) => void;
    onRange: (from: string, to: string) => void;
    onUnread: () => void;
    onAll: () => void;
    onDeleteAll: () => void;
    onClose: () => void;
  }

  let {
    downloaded,
    total,
    status = null,
    nextFrom = null,
    nextOptions = [],
    unreadCount,
    notDownloadedCount,
    busy = false,
    deleting = false,
    extraActions = [],
    onNext,
    onRange,
    onUnread,
    onAll,
    onDeleteAll,
    onClose,
  }: Props = $props();

  let panelEl = $state<HTMLDivElement | null>(null);
  let fromInputEl = $state<HTMLInputElement | null>(null);
  let showRange = $state(false);
  let rangeFrom = $state("");
  let rangeTo = $state("");
  let placement = $state<"below" | "above">("below");
  let maxHeight = $state<number | null>(null);
  // Downloads are user data: deleting all of them takes a second press, like clearing Activity.
  let confirmingDelete = $state(false);
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  const rangeReady = $derived(rangeFrom.trim().length > 0 && rangeTo.trim().length > 0 && !busy);

  function run(action: () => void) {
    action();
    onClose();
  }

  function stopConfirmingDelete() {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    confirmingDelete = false;
  }

  function deleteAll() {
    if (!confirmingDelete) {
      confirmingDelete = true;
      confirmTimer = setTimeout(stopConfirmingDelete, 4000);
      return;
    }
    stopConfirmingDelete();
    run(onDeleteAll);
  }

  function submitRange() {
    if (!rangeReady) return;
    const from = rangeFrom;
    const to = rangeTo;
    rangeFrom = "";
    rangeTo = "";
    showRange = false;
    run(() => onRange(from, to));
  }

  async function openRange() {
    showRange = true;
    await tick();
    fromInputEl?.focus();
  }

  function trigger(): HTMLElement | null {
    return panelEl?.parentElement?.querySelector<HTMLElement>("button") ?? null;
  }

  // The menu hangs from its button: below when it fits, above when there is more room there, and it
  // scrolls inside whichever side it takes instead of running past the window edge.
  function fit() {
    const anchor = panelEl?.parentElement;
    if (!panelEl || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const room = 20;
    const below = window.innerHeight - rect.bottom - room;
    const above = rect.top - room;
    const needed = panelEl.scrollHeight;
    placement = needed > below && above > below ? "above" : "below";
    maxHeight = Math.max(160, Math.floor(placement === "below" ? below : above));
  }

  $effect(() => {
    void showRange;
    void extraActions.length;
    void nextOptions.length;
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (showRange) {
      showRange = false;
      return;
    }
    if (confirmingDelete) {
      stopConfirmingDelete();
      return;
    }
    onClose();
    trigger()?.focus({ preventScroll: true });
  }

  function onPointerDown(event: MouseEvent) {
    const anchor = panelEl?.parentElement;
    if (anchor && !anchor.contains(event.target as Node)) onClose();
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", fit);
      if (confirmTimer) clearTimeout(confirmTimer);
    };
  });
</script>

<div
  bind:this={panelEl}
  class="ddm"
  class:ddm-above={placement === "above"}
  style:max-height={maxHeight === null ? null : `${maxHeight}px`}
  role="dialog"
  aria-label={$_("downloads_eyebrow")}
  data-detail-download-menu
>
  <header class="ddm-head">
    <strong>{$_("downloads_eyebrow")}</strong>
    <span class:ddm-live={Boolean(status)}>{status ?? $_("detail_download_summary", { done: downloaded, total })}</span>
  </header>

  {#if nextFrom !== null && nextOptions.length > 0}
    <div class="ddm-next">
      <span class="ddm-label">{$_("detail_download_nextFrom", { chapter: String(nextFrom) })}</span>
      <div class="ddm-chips">
        {#each nextOptions as option (option.amount)}
          <button
            type="button"
            class="ddm-chip"
            disabled={option.available === 0 || busy}
            title={$_("detail_download_newCount", { count: option.available })}
            aria-label={$_("detail_download_nextAmount", { count: option.amount })}
            onclick={() => run(() => onNext(option.amount))}
          >{option.amount}</button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="ddm-list">
    <button type="button" class="ddm-row" disabled={unreadCount === 0 || busy} onclick={() => run(onUnread)}>
      <span>{$_("library_sort_unreadChapters")}</span>
      <span class="ddm-count">{unreadCount}</span>
    </button>
    <button type="button" class="ddm-row ddm-row-primary" disabled={notDownloadedCount === 0 || busy} onclick={() => run(onAll)}>
      <span>{$_("ui_downloadAll")}</span>
      <span class="ddm-count">{notDownloadedCount}</span>
    </button>
    {#if showRange}
      <div class="ddm-range">
        <button type="button" class="ddm-range-back" aria-label={$_("ui_closeCustomRange")} onclick={() => showRange = false}><CaretLeft size={12} weight="bold" /></button>
        <input bind:this={fromInputEl} class="ddm-range-input" inputmode="decimal" placeholder={$_("ui_from")} aria-label={$_("ui_from")} bind:value={rangeFrom} onkeydown={(event) => event.key === "Enter" && submitRange()} />
        <span class="ddm-range-sep" aria-hidden="true">–</span>
        <input class="ddm-range-input" inputmode="decimal" placeholder={$_("ui_to")} aria-label={$_("ui_to")} bind:value={rangeTo} onkeydown={(event) => event.key === "Enter" && submitRange()} />
        <button type="button" class="ddm-range-go" disabled={!rangeReady} onclick={submitRange}>{$_("ui_go")}</button>
      </div>
    {:else}
      <button type="button" class="ddm-row" disabled={busy} onclick={openRange}>
        <span>{$_("ui_customRange")}</span>
        <span class="ddm-count" aria-hidden="true"><CaretRight size={12} weight="bold" /></span>
      </button>
    {/if}
    {#each extraActions as action (action.label)}
      <button type="button" class="ddm-row" disabled={action.disabled} onclick={() => run(action.onSelect)}>
        <span>{action.label}</span>
        <span class="ddm-count">{action.count}</span>
      </button>
    {/each}
  </div>

  {#if downloaded > 0 || deleting}
    <div class="ddm-list ddm-danger-zone">
      <button type="button" class="ddm-row ddm-row-danger" class:ddm-row-confirm={confirmingDelete} disabled={deleting || busy} onclick={deleteAll}>
        <span aria-live="polite">{deleting ? $_("detail_download_deleting") : confirmingDelete ? $_("detail_download_deleteAllConfirm") : $_("ui_deleteAllDownloads")}</span>
        <span class="ddm-count">{downloaded}</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .ddm {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: var(--component-detail-series-v3-root-dl-dropdown-z-index);
    width: min(300px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: var(--component-detail-series-v3-root-dl-dropdown-border);
    border-radius: var(--component-detail-series-v3-root-dl-dropdown-border-radius);
    color: var(--component-detail-dl-dropdown-color);
    background: var(--component-detail-series-v3-root-dl-dropdown-background);
    box-shadow: var(--component-detail-series-v3-root-dl-dropdown-box-shadow);
    backdrop-filter: var(--component-detail-popover-blur);
    font-family: var(--font-ui);
    text-align: left;
    transform-origin: top right;
    animation: ddm-in 160ms ease both;
  }
  .ddm-above {
    top: auto;
    bottom: calc(100% + 8px);
    transform-origin: bottom right;
  }

  .ddm-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 6px 10px;
    border-bottom: var(--component-detail-dl-pop-head-border-bottom);
  }
  .ddm-head strong {
    color: var(--component-detail-dl-pop-head-strong-color);
    font: var(--component-detail-dl-pop-head-strong-font);
  }
  .ddm-head span {
    min-width: 0;
    overflow: hidden;
    color: var(--component-detail-dl-item-sub-color);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ddm-head span.ddm-live { color: var(--component-detail-dl-item-primary-color); }

  .ddm-next {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 6px;
  }
  .ddm-label {
    min-width: 0;
    overflow: hidden;
    color: var(--component-detail-dl-next-sub-color);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ddm-chips { flex: none; display: flex; gap: 4px; }
  .ddm-chip {
    min-width: 34px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--component-detail-dl-next-btn-border-radius);
    color: var(--component-detail-dl-next-btn-color);
    background: var(--component-detail-dl-next-btn-background-2);
    font: var(--component-detail-dl-next-btn-font);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease, transform 140ms ease;
  }
  .ddm-chip:hover:not(:disabled) {
    color: var(--component-detail-dl-next-btn-color-2);
    background: var(--component-detail-dl-next-btn-background);
  }
  .ddm-chip:active:not(:disabled) { transform: scale(0.94); }
  .ddm-chip:disabled { opacity: var(--component-detail-dl-next-btn-opacity); cursor: default; }

  /* minmax(0, 1fr): the range inputs must shrink to the panel instead of widening the column. */
  .ddm-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .ddm-danger-zone {
    padding-top: 6px;
    border-top: var(--component-detail-dl-danger-zone-border-top);
  }
  .ddm-row {
    width: 100%;
    min-height: 34px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--component-detail-dl-next-btn-border-radius);
    color: var(--component-detail-dl-next-btn-color);
    background: transparent;
    font: var(--component-detail-dl-next-btn-font);
    letter-spacing: 0.03em;
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease;
  }
  .ddm-row:hover:not(:disabled) {
    color: var(--component-detail-dl-next-btn-color-2);
    background: var(--component-detail-dl-next-btn-background);
  }
  .ddm-row:disabled { opacity: var(--component-detail-dl-next-btn-opacity); cursor: default; }
  .ddm-count {
    flex: none;
    display: inline-flex;
    align-items: center;
    color: var(--component-detail-dl-item-sub-color);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .ddm-row-primary { color: var(--component-detail-dl-item-primary-color); }
  .ddm-row-primary .ddm-count { color: var(--component-detail-dl-item-primary-dl-item-sub-color); }
  .ddm-row-danger { color: var(--component-detail-sel-action-danger-color); }
  .ddm-row-danger.ddm-row-confirm {
    color: var(--component-detail-dl-item-danger-color-2);
    background: var(--component-detail-dl-item-danger-background);
  }
  .ddm-row-danger:hover:not(:disabled) {
    color: var(--component-detail-dl-item-danger-color-2);
    background: var(--component-detail-dl-item-danger-background);
  }

  .ddm-range {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px;
    border-radius: var(--component-detail-dl-range-row-border-radius);
    background: var(--component-detail-dl-range-row-background);
  }
  .ddm-range-input {
    flex: 1;
    min-width: 0;
    height: 30px;
    padding: 0 10px;
    border: var(--component-detail-dl-range-input-border);
    border-radius: var(--component-detail-dl-range-input-border-radius);
    color: var(--component-detail-dl-range-input-color);
    background: var(--component-detail-dl-range-input-background);
    font: inherit;
    font-size: var(--text-xs);
    outline: none;
  }
  .ddm-range-input:focus {
    border-color: var(--component-detail-dl-range-input-border-color);
    box-shadow: var(--component-detail-dl-range-input-box-shadow);
  }
  .ddm-range-sep { color: var(--component-detail-dl-range-sep-color); font-size: var(--text-xs); }
  .ddm-range-back,
  .ddm-range-go {
    flex: none;
    min-height: 30px;
    display: grid;
    place-items: center;
    padding: 0 10px;
    border: var(--component-detail-dl-range-go-border);
    border-radius: var(--component-detail-dl-range-go-border-radius);
    color: var(--component-detail-dl-range-go-color);
    background: var(--component-detail-dl-range-go-background);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 700;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease, transform 140ms ease;
  }
  .ddm-range-back { padding: 0 8px; }
  .ddm-range-back:hover,
  .ddm-range-go:hover:not(:disabled) {
    color: var(--component-detail-dl-range-go-color-2);
    background: var(--component-detail-dl-range-go-background-2);
  }
  .ddm-range-back:active,
  .ddm-range-go:active:not(:disabled) { transform: scale(0.97); }
  .ddm-range-go:disabled { opacity: var(--component-detail-dl-range-go-opacity); cursor: default; }

  .ddm-chip:focus-visible,
  .ddm-row:focus-visible,
  .ddm-range-back:focus-visible,
  .ddm-range-go:focus-visible {
    outline: 2px solid var(--component-detail-dl-range-input-border-color);
    outline-offset: 2px;
  }

  @keyframes ddm-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }
  .ddm-above { animation-name: ddm-in-above; }
  @keyframes ddm-in-above {
    from { opacity: 0; transform: translateY(4px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }

  /* Reduced motion follows the app setting, then the system (motion.ts). */
    :global(html[data-epigraph-reduced-motion="true"]) .ddm,
    :global(html[data-epigraph-reduced-motion="true"]) .ddm-above { animation: none; }

</style>
