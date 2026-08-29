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
    success:  "M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,1,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z",
    error:    "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z",
    info:     "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z",
    download: "M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z",
  };

  const closeIcon = "M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,1,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z";

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
            <svg class="toast-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
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
            <svg class="toast-close-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d={closeIcon} />
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
            <svg class="toast-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d={icons[t.kind]} />
            </svg>
          </span>
          <div class="body">
            <p class="title">{t.title}</p>
            {#if t.body}<p class="sub">{t.body}</p>{/if}
          </div>
          <button class="toast-close" type="button" aria-label={$_("ui_dismissNotification")} onclick={() => dismissToast(t.id)}>
            <svg class="toast-close-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d={closeIcon} />
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
    --toast-glow-z-index: calc(var(--z-toast) - 3);
    --toast-mask-z-index: calc(var(--z-toast) - 2);
    --toast-content-z-index: calc(var(--z-toast) - 1);
    --toast-life-z-index: var(--z-toast);
    --toast-rail-z-index: calc(var(--z-toast) + 1);
    --toast-accent: var(--component-toast-info-fg);
    --toast-surface: var(--component-toast-mask-bg);
    --toast-glow: var(--component-toast-info-glow);
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: var(--component-toast-height);
    overflow: hidden;
    isolation: isolate;
    box-sizing: border-box;
    justify-content: center;
    gap: 0;
    font-family: var(--component-toast-font);
    padding: var(--component-nocturne-state-compact-padding);
    border: var(--component-toast-border-width) solid transparent;
    border-radius: var(--component-nocturne-state-compact-radius, var(--component-toast-accent-radius));
    background: transparent;
    color: var(--component-nocturne-state-title-fg);
    box-shadow: var(--component-nocturne-state-panel-shadow);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    pointer-events: all;
    min-width: 0;
    animation: toast-enter 360ms var(--easing-emphasized) both;
    transition: border-color var(--t-base), background var(--t-base), opacity var(--t-base), transform var(--t-base);
  }

  .toast::before {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: var(--toast-glow-z-index);
    width: 250%;
    height: 250%;
    background: var(--toast-glow);
    opacity: var(--component-toast-glow-min-opacity);
    transform: translate(-50%, -50%) rotate(0deg);
    transform-origin: center center;
    pointer-events: none;
    animation: epigraph-glow-rotate var(--component-toast-glow-rotate-duration) linear infinite, toast-glow-pulse var(--component-toast-glow-pulse-duration) ease-in-out infinite alternate;
  }

  .toast::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: var(--toast-mask-z-index);
    border-radius: var(--component-nocturne-state-compact-radius);
    background: var(--toast-surface);
    pointer-events: none;
  }

  .toast > :not(.state-border) {
    position: relative;
    z-index: var(--toast-content-z-index);
  }

  .toast:hover {
    --toast-surface: var(--component-toast-mask-bg-hover);
  }

  .toast:active { transform: scale(0.99); }

  .toast-main {
    display: grid;
    grid-template-columns: var(--component-nocturne-state-compact-icon-size) minmax(0, 1fr) var(--component-toast-close-size);
    align-items: center;
    column-gap: var(--component-nocturne-state-gap);
    min-width: 0;
  }

  .toast-life {
    position: absolute;
    right: var(--component-toast-border-width);
    bottom: var(--component-toast-border-width);
    left: var(--component-toast-border-width);
    z-index: var(--toast-life-z-index);
    height: var(--component-toast-progress-height);
    background: var(--component-toast-life-bg);
    transform-origin: left;
    animation: toastLife var(--toast-duration) linear forwards;
  }

  .toast-persistent .toast-life {
    display: none;
  }

  @keyframes toast-enter {
    from { opacity: 0; transform: translate3d(18px, 0, 0) scale(0.985); }
    to   { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
  }

  @keyframes toastLife {
    from { transform: scaleX(1); }
    to { transform: scaleX(0); }
  }

  @keyframes toast-glow-pulse {
    from { opacity: var(--component-toast-glow-min-opacity); }
    to { opacity: calc(var(--component-toast-glow-min-opacity) * 1.28); }
  }

  .state-border {
    position: absolute;
    inset: var(--component-nocturne-state-rail-inset);
    bottom: var(--component-toast-border-width);
    z-index: var(--toast-rail-z-index);
    width: var(--component-toast-border-width);
    border-radius: var(--component-nocturne-state-rail-radius);
    background: var(--toast-accent);
    opacity: var(--component-nocturne-state-rail-opacity);
    pointer-events: none;
  }

  .toast-success {
    --toast-accent: var(--component-toast-success-fg);
    --toast-glow: var(--component-toast-success-glow);
  }
  .toast-error {
    --toast-accent: var(--component-toast-error-fg);
    --toast-glow: var(--component-toast-error-glow);
  }
  .toast-info {
    --toast-accent: var(--component-toast-info-fg);
    --toast-glow: var(--component-toast-info-glow);
  }
  .toast-download {
    --toast-accent: var(--component-toast-download-fg);
    --toast-glow: var(--component-toast-download-glow);
  }

  .icon {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--component-nocturne-state-compact-icon-size);
    height: var(--component-nocturne-state-compact-icon-size);
    color: var(--toast-accent);
    background: transparent;
    border: 0;
    border-radius: var(--component-nocturne-state-compact-icon-radius);
    box-shadow: var(--component-nocturne-state-icon-shadow);
    font-size: var(--component-nocturne-state-compact-icon-font-size);
    align-self: flex-start;
    margin-top: calc(var(--sp-1) / 2);
  }

  .toast-icon,
  .toast-close-icon {
    display: block;
    width: 1em;
    height: 1em;
    overflow: visible;
  }

  .toast-success  .icon { color: var(--component-toast-success-fg); }
  .toast-error    .icon { color: var(--component-toast-error-fg); }
  .toast-info     .icon { color: var(--component-toast-info-fg); }
  .toast-download .icon { color: var(--component-toast-download-fg); }

  .body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--component-nocturne-state-content-gap);
  }

  .title {
    margin: 0;
    font-family: var(--component-nocturne-state-font-ui);
    color: var(--component-nocturne-state-title-fg);
    font-size: var(--component-nocturne-state-compact-title-font-size);
    font-weight: var(--component-nocturne-state-title-font-weight);
    line-height: var(--component-nocturne-state-title-line-height);
    letter-spacing: var(--component-nocturne-state-title-letter-spacing);
    font-synthesis: none;
    text-rendering: optimizeLegibility;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    margin: 0;
    max-width: 100%;
    font-family: var(--component-nocturne-state-font-ui);
    color: var(--component-nocturne-state-body-fg);
    font-size: var(--component-nocturne-state-body-font-size);
    line-height: var(--component-nocturne-state-body-line-height);
    letter-spacing: var(--tracking-normal);
    white-space: normal;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .toast-with-actions .sub,
  .library-update-toast .sub {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .library-update-toast .body {
    gap: var(--component-nocturne-state-content-gap);
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
    min-height: var(--component-nocturne-state-compact-icon-size);
    padding: 0 var(--space-sm);
    border: var(--component-nocturne-state-action-border, var(--component-toast-action-border));
    border-radius: var(--component-nocturne-state-action-radius, var(--component-toast-action-radius));
    background: var(--component-nocturne-state-action-bg, var(--component-toast-action-bg));
    color: var(--component-nocturne-state-action-fg, var(--component-toast-action-fg));
    font-family: var(--component-nocturne-state-font-ui);
    font-size: var(--text-2xs, var(--component-toast-action-font-size));
    font-weight: var(--component-nocturne-state-action-font-weight, var(--component-toast-action-font-weight));
    letter-spacing: var(--component-nocturne-state-action-letter-spacing, var(--component-toast-action-letter-spacing));
    line-height: 1;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
    cursor: pointer;
    transition: background var(--t-base), color var(--t-base), border-color var(--t-base);
  }

  .toast-action:hover {
    color: var(--component-nocturne-state-action-hover-fg, var(--component-toast-action-fg));
    background: var(--component-nocturne-state-action-hover-bg, var(--component-toast-action-bg-hover));
    border-color: var(--component-nocturne-state-action-hover-border, var(--component-toast-action-border));
  }

  .toast-action:first-child {
    background: var(--component-nocturne-state-action-bg, var(--component-toast-action-bg));
    border-color: var(--component-nocturne-state-action-border, var(--component-toast-action-border));
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
    margin-top: var(--component-nocturne-state-content-gap);
    margin-left: calc(var(--component-nocturne-state-compact-icon-size) + var(--component-nocturne-state-gap));
  }

  .toast-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--component-toast-close-size);
    height: var(--component-toast-close-size);
    border: 0;
    border-radius: var(--component-toast-close-radius);
    color: var(--component-toast-close-fg);
    background: transparent;
    cursor: pointer;
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base), transform var(--t-base);
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
    background: var(--component-toast-close-bg-hover);
  }

  @media (max-width: 480px) {
    .toaster {
      right: var(--space-sm);
      bottom: var(--space-sm);
      left: var(--space-sm);
      width: auto;
    }

    .toast-main { grid-template-columns: var(--component-nocturne-state-compact-icon-size) minmax(0, 1fr) var(--component-toast-close-size); }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
      transition: none;
    }

    .toast::before {
      animation: none;
    }

    .library-progress-fill {
      transition: none;
    }
  }
</style>
