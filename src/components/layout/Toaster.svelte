<script lang="ts">
  import { onDestroy } from "svelte";
  import { store, dismissToast, setLibraryUpdateProgress } from "../../store/state.svelte";
  import type { LibraryUpdateProgress, Toast } from "../../store/state.svelte";

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
        <button class="toast-close" aria-label="Dismiss library update progress" onclick={() => setLibraryUpdateProgress(null)}>
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
        <button class="toast-close" aria-label="Dismiss notification" onclick={() => dismissToast(t.id)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toaster {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
    width: min(360px, calc(100vw - 32px));
  }

  .toast {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 12px 12px 0;
    border-radius: 12px;
    background:
      radial-gradient(circle at 0% 0%, rgba(201, 181, 255, 0.08), transparent 46%),
      rgba(21, 20, 25, 0.96);
    border: 1px solid rgba(92, 88, 103, 0.42);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.035), 0 16px 44px rgba(0,0,0,0.48);
    backdrop-filter: blur(18px) saturate(118%);
    -webkit-backdrop-filter: blur(18px) saturate(118%);
    pointer-events: all;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    animation: slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) both;
    transition: border-color 140ms ease, background 140ms ease, opacity 140ms ease, transform 140ms ease;
  }

  .toast:hover  { border-color: rgba(201, 181, 255, 0.24); background-color: rgba(25, 24, 29, 0.98); transform: translateX(-2px); }
  .toast:active { transform: translateX(0) scale(0.98); }
  .toast:focus-visible { outline: 2px solid rgba(201, 181, 255, 0.45); outline-offset: 2px; }

  .toast::after {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 2px;
    content: "";
    background: linear-gradient(90deg, rgba(201, 181, 255, 0.75), rgba(143, 126, 224, 0.7));
    transform-origin: left;
    animation: toastLife var(--toast-duration) linear forwards;
  }

  .toast-persistent::after {
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

  .toast-success  .accent-bar { background: #c9f0cf; }
  .toast-error    .accent-bar { background: #f08f9b; }
  .toast-info     .accent-bar { background: rgba(202, 196, 208, 0.52); }
  .toast-download .accent-bar { background: #c9b5ff; }

  .icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .toast-success  .icon { color: #c9f0cf; }
  .toast-error    .icon { color: #f08f9b; }
  .toast-info     .icon { color: rgba(202, 196, 208, 0.72); }
  .toast-download .icon { color: #d8cbff; }

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
    font-family: "Manrope", "Inter", system-ui, sans-serif;
    color: #e8e4eb;
    font-weight: 800;
    letter-spacing: 0.02em;
    line-height: 1.3;
  }

  .sub {
    margin: 0;
    font-family: "Manrope", "Inter", system-ui, sans-serif;
    font-size: 10px;
    color: rgba(202, 196, 208, 0.5);
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
    background: rgba(201, 181, 255, 0.12);
    box-shadow: inset 0 0 0 1px rgba(201, 181, 255, 0.04);
  }

  .library-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, rgba(201, 181, 255, 0.92), rgba(164, 134, 255, 0.8));
    box-shadow: 0 0 14px rgba(201, 181, 255, 0.28);
    transition: width 220ms ease;
  }

  .toast-action {
    flex-shrink: 0;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    color: #d8cbff;
    background: rgba(201, 181, 255, 0.12);
    border: 1px solid rgba(201, 181, 255, 0.28);
    border-radius: 9px;
    padding: 5px 8px;
    cursor: pointer;
  }

  .toast-action:hover {
    background: rgba(201, 181, 255, 0.18);
  }

  .toast-close {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 1px solid rgba(92, 88, 103, 0.34);
    border-radius: 8px;
    color: rgba(202, 196, 208, 0.54);
    background: rgba(255, 255, 255, 0.018);
    cursor: pointer;
    transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 140ms ease;
  }

  .toast-close:hover {
    color: #e8e4eb;
    border-color: rgba(201, 181, 255, 0.24);
    background: rgba(201, 181, 255, 0.08);
  }

  .toast-close:active {
    transform: scale(0.94);
  }
</style>
