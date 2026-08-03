<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { onDestroy } from "svelte";
  import { store, dismissToast, setLibraryUpdateProgress } from "../../store/state.svelte";
  import type { LibraryUpdateProgress, Toast } from "../../store/state.svelte";

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const timerVersions = new Map<string, number>();
  let libraryUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let libraryUpdateTimerVersion = 0;

  async function stopLibraryUpdate() {
    const { stopSharedLibraryUpdate } = await import("../../lib/library/updateRuntime");
    stopSharedLibraryUpdate();
  }

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

  function roleForKind(kind: Toast["kind"]): "alert" | "status" {
    return kind === "error" ? "alert" : "status";
  }
</script>

{#if store.toasts.length || store.libraryUpdateProgress}
  <div class="toaster" aria-live="polite" aria-atomic="false">
    {#if store.libraryUpdateProgress}
      {@const p = store.libraryUpdateProgress}
      <div
        class="toast toast-{p.kind} toast-persistent library-update-toast"
        class:toast-with-actions={p.active && store.libraryUpdateInFlight}
        role={roleForKind(p.kind)}
        aria-atomic="true"
        style="--toast-duration: 0ms"
      >
        <div class="state-border" aria-hidden="true"></div>
        <div class="toast-main">
          <span class="icon" aria-hidden="true">
            <svg class="toast-icon" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
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
          <button class="toast-close" type="button" aria-label={$_("ui_dismissLibraryUpdateProgress")} onclick={() => setLibraryUpdateProgress(null)}>
            <svg class="toast-close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {#if p.active && store.libraryUpdateInFlight}
          <div class="toast-actions">
            <button
              class="toast-action"
              type="button"
              onclick={(event) => {
                event.stopPropagation();
                void stopLibraryUpdate();
              }}
            >
              {$_("ui_stop")}
            </button>
          </div>
        {/if}
      </div>
    {/if}
    {#each store.toasts as t (t.id)}
      <div
        class="toast toast-{t.kind}"
        class:toast-persistent={t.duration === 0}
        class:toast-with-actions={Boolean(t.action || t.actions?.length)}
        role={roleForKind(t.kind)}
        aria-atomic="true"
        style={`--toast-duration: ${t.duration ?? 3500}ms`}
      >
        <div class="state-border" aria-hidden="true"></div>
        <div class="toast-main">
          <span class="icon" aria-hidden="true">
            <svg class="toast-icon" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d={icons[t.kind]} />
            </svg>
          </span>
          <div class="body">
            <p class="title">{t.title}</p>
            {#if t.body}<p class="sub">{t.body}</p>{/if}
          </div>
          <button class="toast-close" type="button" aria-label={$_("ui_dismissNotification")} onclick={() => dismissToast(t.id)}>
            <svg class="toast-close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {#if t.action || t.actions?.length}
          <div class="toast-actions">
            {#if t.action}
              <button
                class="toast-action"
                type="button"
                onclick={(event) => {
                  event.stopPropagation();
                  t.action?.run();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            {/if}
            {#each t.actions ?? [] as action}
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
    gap: var(--component-toast-stack-gap);
    pointer-events: none;
    width: var(--component-toast-width);
  }

  .toast {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0;
    font-family: var(--component-toast-font);
    padding: var(--component-toast-padding);
    border-radius: var(--component-toast-radius);
    background: transparent;
    border: var(--component-toast-border-width) solid transparent;
    box-shadow: var(--component-toast-shadow), var(--component-toast-state-shadow);
    backdrop-filter: var(--component-toast-blur);
    -webkit-backdrop-filter: var(--component-toast-blur);
    pointer-events: all;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    animation: slideIn var(--duration-normal) var(--easing-emphasized) both;
    transition: border-color var(--t-base), background var(--t-base), opacity var(--t-base), transform var(--t-base);
  }

  .toast:hover  { border-color: transparent; background: transparent; }
  .toast:active { transform: scale(0.99); }

  .toast-main {
    display: grid;
    grid-template-columns: var(--component-toast-icon-size) minmax(0, 1fr) var(--component-toast-close-size);
    align-items: center;
    column-gap: var(--component-toast-gap);
    min-width: 0;
  }

  .toast-life {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: var(--component-toast-progress-height);
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

  .state-border {
    position: absolute;
    inset: var(--component-toast-accent-inset);
    width: auto;
    border-radius: var(--component-toast-accent-radius);
    border: var(--component-toast-accent-width) solid currentColor;
    overflow: hidden;
    pointer-events: none;
  }

  .state-border::before {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    width: 250%;
    height: 250%;
    background: var(--component-toast-info-glow);
    transform: translate(-50%, -50%) rotate(0deg);
    transform-origin: center;
    opacity: var(--component-toast-glow-min-opacity);
    animation:
      toastGlowRotate var(--component-toast-glow-rotate-duration) linear infinite,
      toastGlowPulse var(--component-toast-glow-pulse-duration) ease-in-out infinite alternate;
  }

  .state-border::after {
    content: "";
    position: absolute;
    inset: var(--component-toast-accent-width);
    border-radius: var(--component-toast-accent-radius);
    background: var(--component-toast-texture), var(--component-toast-mask-bg);
    transition: background var(--t-base);
  }

  .toast-success { color: var(--component-toast-success-fg); }
  .toast-success  .state-border { color: var(--component-toast-success-fg); }
  .toast-success  .state-border::before { background: var(--component-toast-success-glow); }
  .toast-error { color: var(--component-toast-error-fg); }
  .toast-error    .state-border { color: var(--component-toast-error-fg); }
  .toast-error    .state-border::before { background: var(--component-toast-error-glow); }
  .toast-info { color: var(--component-toast-info-fg); }
  .toast-info     .state-border { color: var(--component-toast-info-fg); }
  .toast-download { color: var(--component-toast-download-fg); }
  .toast-download .state-border { color: var(--component-toast-download-fg); }
  .toast-download .state-border::before { background: var(--component-toast-download-glow); }

  .toast:hover .state-border::after {
    background: var(--component-toast-texture), var(--component-toast-mask-bg-hover);
  }

  .toast > :not(.state-border) {
    position: relative;
  }

  @keyframes toastGlowRotate {
    from { transform: translate(-50%, -50%) rotate(0deg); }
    to { transform: translate(-50%, -50%) rotate(360deg); }
  }

  @keyframes toastGlowPulse {
    from { opacity: var(--component-toast-glow-min-opacity); }
    to { opacity: var(--component-toast-glow-min-opacity); }
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--component-toast-icon-size);
    height: var(--component-toast-icon-size);
    color: var(--component-toast-body-fg);
    background: var(--component-toast-icon-bg);
    border: var(--component-toast-icon-border);
    border-radius: var(--radius-md);
  }

  .toast-icon {
    width: var(--text-sm);
    height: var(--text-sm);
    stroke-width: var(--component-toast-icon-stroke-width);
  }

  .toast-success  .icon { color: var(--component-toast-success-fg); }
  .toast-error    .icon { color: var(--component-toast-error-fg); }
  .toast-info     .icon { color: var(--component-toast-info-fg); }
  .toast-download .icon { color: var(--component-toast-download-fg); }

  .body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .title {
    margin: 0;
    font-size: var(--component-toast-title-font-size);
    font-family: inherit;
    color: var(--component-toast-title-fg);
    font-weight: var(--component-toast-title-font-weight);
    letter-spacing: var(--tracking-normal);
    line-height: var(--component-toast-title-line-height);
  }

  .sub {
    margin: 0;
    font-family: inherit;
    font-size: var(--component-toast-body-font-size);
    color: var(--component-toast-body-fg);
    letter-spacing: var(--tracking-normal);
    line-height: var(--component-toast-body-line-height);
    white-space: normal;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .library-update-toast .body {
    gap: var(--space-xs);
  }

  .library-progress-track {
    width: 100%;
    height: var(--component-toast-progress-height);
    border-radius: var(--component-toast-progress-radius);
    overflow: hidden;
    background: var(--component-toast-progress-track);
    box-shadow: inset 0 0 0 var(--component-toast-border-width) var(--component-toast-border);
  }

  .library-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--component-toast-progress-fill);
    box-shadow: var(--component-toast-progress-shadow);
    transition: width var(--duration-slow) var(--easing-standard);
  }

  .toast-action {
    flex-shrink: 0;
    font-family: inherit;
    font-size: var(--component-toast-action-font-size);
    font-weight: var(--component-toast-action-font-weight);
    letter-spacing: var(--component-toast-action-letter-spacing);
    color: var(--component-toast-action-fg);
    background: var(--component-toast-action-bg);
    border: var(--component-toast-border-width) solid var(--component-toast-action-border);
    border-radius: var(--component-toast-action-radius);
    padding: var(--component-toast-action-padding);
    cursor: pointer;
    transition: background var(--t-base), color var(--t-base), border-color var(--t-base);
  }

  .toast-action:hover {
    color: var(--component-toast-action-fg);
    background: var(--component-toast-action-bg-hover);
  }

  .toast-action:first-child {
    background: var(--component-toast-action-bg);
    border-color: var(--component-toast-action-border);
  }

  .toast-action:not(:first-child) {
    background: transparent;
    border-color: transparent;
  }

  .toast-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--component-toast-gap);
    justify-content: flex-start;
    margin-top: var(--space-xs);
    margin-left: calc(var(--component-toast-icon-size) + var(--component-toast-gap));
  }

  .toast-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--component-toast-close-size);
    height: var(--component-toast-close-size);
    border: var(--component-toast-border-width) solid var(--component-toast-close-border);
    border-radius: var(--component-toast-close-radius);
    color: var(--component-toast-close-fg);
    background: var(--component-toast-close-bg);
    cursor: pointer;
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base), transform var(--t-base);
  }

  .toast-close-icon {
    width: var(--text-xs);
    height: var(--text-xs);
    stroke-width: var(--component-toast-close-icon-stroke-width);
  }

  .toast-action:focus-visible,
  .toast-close:focus-visible {
    outline: none;
    box-shadow: var(--component-toast-focus-ring);
  }

  .toast-close:active {
    transform: scale(0.96);
  }

  .toast-close:hover {
    color: var(--component-toast-close-fg-hover);
    border-color: var(--component-toast-close-border-hover);
    background: var(--component-toast-close-bg-hover);
  }

  @media (max-width: 480px) {
    .toaster {
      right: var(--space-sm);
      bottom: var(--space-sm);
      left: var(--space-sm);
      width: auto;
    }

    .toast-main { grid-template-columns: var(--component-toast-icon-size) minmax(0, 1fr) var(--component-toast-close-size); }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
      transition: none;
    }

    .toast-life,
    .library-progress-fill,
    .state-border::before {
      animation: none;
      transition: none;
    }
  }
</style>
