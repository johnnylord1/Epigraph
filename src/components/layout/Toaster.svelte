<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { onDestroy } from "svelte";
  import { store, dismissToast, setLibraryUpdateProgress } from "../../store/state.svelte";
  import type { LibraryUpdateProgress, Toast } from "../../store/state.svelte";
  import { stopSharedLibraryUpdate } from "../../lib/library/updateRuntime";

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const timerVersions = new Map<string, number>();
  let libraryUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let libraryUpdateTimerVersion = 0;

  function schedule(t: Toast) {
    const version = t.updatedAt ?? 0;
    if (timers.has(t.id) && timerVersions.get(t.id) === version) return;
    const existing = timers.get(t.id);
    if (existing) clearTimeout(existing);
    const dur = t.duration ?? 3500;
    if (dur === 0) return;
    timerVersions.set(t.id, version);
    timers.set(t.id, setTimeout(() => dismissToast(t.id), dur));
  }

  function scheduleLibraryUpdate(progress: LibraryUpdateProgress) {
    const version = progress.updatedAt ?? 0;
    if (libraryUpdateTimer && libraryUpdateTimerVersion === version) return;
    if (libraryUpdateTimer) clearTimeout(libraryUpdateTimer);
    const dur = progress.duration ?? (progress.active ? 0 : 2500);
    if (dur === 0) {
      libraryUpdateTimer = null;
      libraryUpdateTimerVersion = version;
      return;
    }
    libraryUpdateTimerVersion = version;
    libraryUpdateTimer = setTimeout(() => {
      setLibraryUpdateProgress(null);
      libraryUpdateTimer = null;
    }, dur);
  }

  $effect(() => {
    store.toasts.forEach(schedule);
    if (store.libraryUpdateProgress) {
      scheduleLibraryUpdate(store.libraryUpdateProgress);
    } else if (libraryUpdateTimer) {
      clearTimeout(libraryUpdateTimer);
      libraryUpdateTimer = null;
      libraryUpdateTimerVersion = 0;
    }
    for (const id of timers.keys()) {
      if (!store.toasts.some(t => t.id === id)) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        timerVersions.delete(id);
      }
    }
  });

  onDestroy(() => {
    timers.forEach(clearTimeout);
    timers.clear();
    timerVersions.clear();
    if (libraryUpdateTimer) clearTimeout(libraryUpdateTimer);
    libraryUpdateTimer = null;
  });

  const icons: Record<Toast["kind"], string> = {
    success:  "M20 6L9 17l-5-5",
    error:    "M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
    info:     "M12 16v-4M12 8h.01M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z",
    download: "M12 3v13M7 11l5 5 5-5M5 21h14",
  };
</script>

{#if store.toasts.length || store.libraryUpdateProgress}
  <div class="toaster" aria-live="polite">
    {#if store.libraryUpdateProgress}
      {@const p = store.libraryUpdateProgress}
      <div
        class="toast toast-{p.kind} toast-persistent library-update-toast"
        role="status"
        style="--toast-duration: 0ms"
      >
        <div class="accent-bar"></div>
        <span class="icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d={icons[p.kind]} />
          </svg>
        </span>
        <div class="body">
          <p class="title">{p.title}</p>
          <p class="sub">{p.body}</p>
          {#if typeof p.percent === "number"}
            <div class="library-progress-track" aria-hidden="true">
              <div class="library-progress-fill" style={`width: ${Math.max(0, Math.min(100, p.percent))}%`}></div>
            </div>
          {/if}
        </div>
        {#if p.active && store.libraryUpdateInFlight}
          <button
            class="toast-action"
            type="button"
            onclick={(event) => {
              event.stopPropagation();
              void stopSharedLibraryUpdate();
            }}
          >
            {$_("ui_stop")}
          </button>
        {/if}
        <button class="toast-close" aria-label={$_("ui_dismissLibraryUpdateProgress")} onclick={() => setLibraryUpdateProgress(null)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    {/if}
    {#each store.toasts as t (t.id)}
      <div
        class="toast toast-{t.kind}"
        class:toast-persistent={t.duration === 0}
        class:toast-has-actions={Boolean(t.actions?.length)}
        role="alert"
        style={`--toast-duration: ${t.duration ?? 3500}ms`}
      >
        <div class="accent-bar"></div>
        <span class="icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d={icons[t.kind]} />
          </svg>
        </span>
        <div class="body">
          <p class="title">{t.title}</p>
          {#if t.body}<p class="sub">{t.body}</p>{/if}
        </div>
        {#if t.action}
          <button
            class="toast-action"
            onclick={(event) => {
              event.stopPropagation();
              t.action?.run();
              dismissToast(t.id);
            }}
          >
            {t.action.label}
          </button>
        {/if}
        {#if t.actions?.length}
          <div class="toast-actions">
            {#each t.actions as action}
              <button
                class="toast-action"
                type="button"
                onclick={(event) => {
                  event.stopPropagation();
                  action.run();
                  dismissToast(t.id);
                }}
              >
                {action.label}
              </button>
            {/each}
          </div>
        {/if}
        <button class="toast-close" aria-label={$_("ui_dismissNotification")} onclick={() => dismissToast(t.id)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
        {#key t.updatedAt}
          <div class="toast-life" aria-hidden="true"></div>
        {/key}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toaster {
    position: fixed;
    bottom: var(--component-toast-offset);
    right: var(--component-toast-offset);
    z-index: var(--z-toast);
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    pointer-events: none;
    width: min(420px, calc(100vw - (var(--space-md) * 2)));
  }

  .toast {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 12px 12px 0;
    border-radius: var(--component-toast-radius);
    background: var(--component-toast-bg);
    border: 1px solid var(--component-toast-border);
    box-shadow: var(--component-toast-shadow);
    backdrop-filter: var(--component-toast-blur);
    -webkit-backdrop-filter: var(--component-toast-blur);
    pointer-events: all;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    animation: slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) both;
    transition: border-color 140ms ease, background 140ms ease, opacity 140ms ease, transform 140ms ease;
  }

  .toast:hover  { border-color: var(--component-toast-border-hover); background: var(--component-toast-bg-hover); transform: translateX(-2px); }
  .toast:active { transform: translateX(0) scale(0.98); }
  .toast:focus-visible { outline: 2px solid var(--component-toast-focus-ring); outline-offset: 2px; }

  .toast-life {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 2px;
    background: var(--component-toast-life-bg);
    transform-origin: left;
    animation: toastLife var(--toast-duration) linear forwards;
  }

  .toast-persistent .toast-life {
    display: none;
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateX(16px) scale(0.98); }
    to   { opacity: 1; transform: translateX(0)    scale(1); }
  }

  @keyframes toastLife {
    from { transform: scaleX(1); }
    to { transform: scaleX(0); }
  }

  .accent-bar {
    width: 3px;
    align-self: stretch;
    flex-shrink: 0;
    border-radius: 0 2px 2px 0;
    margin-right: 2px;
  }

  .toast-success  .accent-bar { background: var(--component-toast-success-fg); }
  .toast-error    .accent-bar { background: var(--component-toast-error-fg); }
  .toast-info     .accent-bar { background: var(--component-toast-info-fg); }
  .toast-download .accent-bar { background: var(--component-toast-download-fg); }

  .icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .toast-success  .icon { color: var(--component-toast-success-fg); }
  .toast-error    .icon { color: var(--component-toast-error-fg); }
  .toast-info     .icon { color: var(--component-toast-info-fg); }
  .toast-download .icon { color: var(--component-toast-download-fg); }

  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .title {
    margin: 0;
    font-size: 12px;
    font-family: "Manrope", var(--font-sans);
    color: var(--component-toast-title-fg);
    font-weight: var(--weight-extrabold);
    letter-spacing: 0.02em;
    line-height: 1.3;
  }

  .sub {
    margin: 0;
    font-family: "Manrope", var(--font-sans);
    font-size: 10px;
    color: var(--component-toast-body-fg);
    letter-spacing: 0.08em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .library-update-toast .body {
    gap: 5px;
  }

  .library-progress-track {
    width: 100%;
    height: 3px;
    border-radius: 999px;
    overflow: hidden;
    background: var(--component-toast-progress-track);
    box-shadow: inset 0 0 0 1px var(--component-toast-border);
  }

  .library-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--component-toast-progress-fill);
    box-shadow: var(--component-toast-progress-shadow);
    transition: width 220ms ease;
  }

  .toast-action {
    flex-shrink: 0;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    color: var(--component-toast-action-fg);
    background: var(--component-toast-action-bg);
    border: 1px solid var(--component-toast-action-border);
    border-radius: 9px;
    padding: 5px 8px;
    cursor: pointer;
  }

  .toast-action:hover {
    background: var(--component-toast-action-bg-hover);
  }

  .toast-actions {
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-start;
  }

  .toast-has-actions {
    display: grid;
    grid-template-columns: 3px 18px minmax(0, 1fr) 24px;
    grid-template-areas:
      "accent icon body close"
      "accent icon actions close";
    align-items: start;
    column-gap: 10px;
    row-gap: 8px;
    padding: 12px 12px 12px 0;
  }

  .toast-has-actions .accent-bar {
    grid-area: accent;
    margin-right: 0;
  }

  .toast-has-actions .icon {
    grid-area: icon;
    margin-top: 2px;
  }

  .toast-has-actions .body {
    grid-area: body;
    gap: 4px;
  }

  .toast-has-actions .toast-actions {
    grid-area: actions;
  }

  .toast-has-actions .toast-close {
    grid-area: close;
  }

  .toast-has-actions .sub {
    white-space: pre-line;
    overflow: visible;
    text-overflow: initial;
    line-height: 1.45;
    letter-spacing: 0.04em;
  }

  .toast-close {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--component-toast-close-border);
    border-radius: 8px;
    color: var(--component-toast-close-fg);
    background: var(--component-toast-close-bg);
    cursor: pointer;
    transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease;
  }

  .toast-close:hover {
    color: var(--component-toast-close-fg-hover);
    border-color: var(--component-toast-close-border-hover);
    background: var(--component-toast-close-bg-hover);
  }

  .toast-close:active {
    transform: scale(0.94);
  }
</style>
