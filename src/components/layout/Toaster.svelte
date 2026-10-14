<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { onDestroy } from "svelte";
  import { flip } from "svelte/animate";
  import { cubicIn, cubicInOut, cubicOut } from "svelte/easing";
  import { store, dismissToast } from "../../store/state.svelte";
  import type { Toast, ToastAction } from "../../store/state.svelte";
  import { prefersReducedMotion } from "../../lib/motion/motion";

  // The rules every toast follows are written on `Toast` in the store.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const timerVersions = new Map<string, number>();
  const visibleToasts = $derived(store.toasts.filter((toast) => !toast.hidden));

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

  $effect(() => {
    store.toasts.forEach(schedule);
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
  });

  // An action closes its toast, except on a running task: the task keeps reporting into it.
  function runAction(t: Toast, action: ToastAction | undefined, event: MouseEvent) {
    event.stopPropagation();
    action?.run();
    if (!t.progress?.active) dismissToast(t.id);
  }

  function progressWidth(percent: number) {
    return `${Math.max(0, Math.min(100, percent))}%`;
  }

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

  // Motion is skipped when animations are off (app setting, then system) or Web Animations are unavailable.
  const skipMotion = prefersReducedMotion;

  // A dismissed toast drifts back out to the right and softens, then folds its space away so the
  // toasts above it settle down smoothly instead of jumping when it is removed.
  function toastLeave(node: Element) {
    if (skipMotion()) return { duration: 0 };
    const style = getComputedStyle(node);
    const height = (node as HTMLElement).offsetHeight;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const gap = node.parentElement ? parseFloat(getComputedStyle(node.parentElement).rowGap) || 0 : 0;
    return {
      duration: 600,
      css: (_t: number, u: number) => {
        const fade = cubicIn(Math.min(1, u / 0.55));
        const fold = cubicInOut(Math.max(0, (u - 0.45) / 0.55));
        const drift = `opacity: ${1 - fade}; transform: translate3d(${fade * 36}px, 0, 0) scale(${1 - fade * 0.03}); filter: blur(${fade * 4}px);`;
        if (fold === 0) return drift;
        return `${drift} box-sizing: border-box; min-height: 0; height: ${height * (1 - fold)}px; padding-top: ${padTop * (1 - fold)}px; padding-bottom: ${padBottom * (1 - fold)}px; margin-top: ${-gap * fold}px;`;
      },
    };
  }

  // The rest of the stack glides into the freed space.
  const stackFlip = { duration: () => (skipMotion() ? 0 : 520), easing: cubicOut };
</script>

{#if visibleToasts.length}
  <div class="toaster" aria-live="polite" aria-atomic="false">
    {#each visibleToasts as t (t.id)}
      <div
        class="toast toast-{t.kind}"
        class:toast-persistent={t.duration === 0}
        class:toast-with-progress={Boolean(t.progress)}
        class:toast-with-actions={Boolean(t.action || t.actions?.length)}
        role={roleForKind(t.kind)}
        aria-atomic="true"
        style={`--toast-duration: ${t.duration ?? 3500}ms`}
        animate:flip={stackFlip}
        out:toastLeave|global
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
            {#if t.progress && typeof t.progress.percent === "number"}
              <div class="toast-progress-track" aria-hidden="true">
                <div class="toast-progress-fill" style={`width: ${progressWidth(t.progress.percent)}`}></div>
              </div>
            {:else if t.progress?.active}
              <div class="toast-progress-track toast-progress-indeterminate" aria-hidden="true">
                <div class="toast-progress-fill"></div>
              </div>
            {/if}
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
              <button class="toast-action" type="button" onclick={(event) => runAction(t, t.action, event)}>
                {t.action.label}
              </button>
            {/if}
            {#each t.actions ?? [] as action}
              <button class="toast-action" type="button" onclick={(event) => runAction(t, action, event)}>
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

  /* A floating card: a hairline rim (where the slow state glow shows through), an opaque
     surface inset by one hairline, a soft wash of the state colour from the left edge and
     the content on top. */
  .toast {
    --toast-glow-z-index: calc(var(--z-toast) - 4);
    --toast-mask-z-index: calc(var(--z-toast) - 3);
    --toast-wash-z-index: calc(var(--z-toast) - 2);
    --toast-content-z-index: calc(var(--z-toast) - 1);
    --toast-life-z-index: var(--z-toast);
    --toast-accent: var(--component-toast-info-fg);
    --toast-surface: var(--component-toast-mask-bg);
    --toast-glow: var(--component-toast-info-glow);
    --toast-frame-radius: var(--radius-xl);
    --toast-badge-size: 32px;
    position: relative;
    display: grid;
    grid-template-columns: var(--toast-badge-size) minmax(0, 1fr) auto;
    grid-template-areas: "icon body close";
    align-items: center;
    column-gap: var(--sp-3);
    width: 100%;
    height: var(--component-toast-height);
    overflow: hidden;
    isolation: isolate;
    box-sizing: border-box;
    font-family: var(--component-toast-font);
    padding: var(--component-nocturne-state-compact-padding);
    border: 0;
    border-radius: var(--toast-frame-radius);
    background: var(--component-toast-border);
    color: var(--component-nocturne-state-title-fg);
    /* Toasts float above everything, so they keep their own elevation (state panels are flat). */
    box-shadow: var(--component-toast-shadow);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    pointer-events: all;
    min-width: 0;
    animation: toast-enter 760ms var(--ui-out) both;
    transition: opacity var(--t-base), transform 420ms var(--ui-out);
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
    inset: var(--component-toast-border-width);
    z-index: var(--toast-mask-z-index);
    border-radius: calc(var(--toast-frame-radius) - var(--component-toast-border-width));
    background: var(--toast-surface);
    pointer-events: none;
    transition: background var(--t-base);
  }

  .toast:hover {
    --toast-surface: var(--component-toast-mask-bg-hover);
  }

  .toast:active { transform: scale(0.992); }

  /* The main row's children join the card's grid, so a single action can sit beside the text. */
  .toast-main {
    display: contents;
  }

  .toast-with-actions {
    grid-template-columns: var(--toast-badge-size) minmax(0, 1fr) auto auto;
    grid-template-areas: "icon body actions close";
  }

  /* Two or more actions get their own row under the text; the card grows to fit them. */
  .toast-with-actions:has(.toast-action + .toast-action) {
    grid-template-columns: var(--toast-badge-size) minmax(0, 1fr) auto;
    grid-template-areas:
      "icon body close"
      ". actions actions";
    row-gap: var(--sp-3);
    height: auto;
    min-height: var(--component-toast-height);
  }

  .icon,
  .body,
  .toast-close,
  .toast-actions {
    position: relative;
    z-index: var(--toast-content-z-index);
  }

  /* The kind of toast reads from a soft wash of its colour rising from the left edge. */
  .state-border {
    position: absolute;
    inset: var(--component-toast-border-width);
    z-index: var(--toast-wash-z-index);
    border-radius: var(--component-toast-accent-radius);
    background: radial-gradient(120% 150% at 0% 50%, var(--toast-accent), transparent 62%);
    opacity: 0.085;
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

  /* The glyph sits in a round, tinted badge; hovering the card lights the badge's halo. */
  .icon {
    grid-area: icon;
    align-self: center;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--toast-badge-size);
    height: var(--toast-badge-size);
    color: var(--toast-accent);
    border-radius: var(--radius-full);
    font-size: calc(var(--component-nocturne-state-compact-icon-font-size) + 2px);
    transition: box-shadow 520ms var(--ui-out);
  }

  .icon::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: currentColor;
    opacity: 0.13;
  }

  .toast:hover .icon {
    box-shadow: var(--component-toast-state-shadow);
  }

  .toast-icon,
  .toast-close-icon {
    position: relative;
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
    grid-area: body;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--component-nocturne-state-content-gap);
  }

  .title {
    margin: 0;
    font-family: var(--component-nocturne-state-font-ui);
    color: var(--text-primary);
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

  /* A task's toast keeps one line of detail so the bar fits the card. */
  .toast-with-progress .sub {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .toast-progress-track {
    width: 100%;
    height: var(--component-toast-progress-height);
    margin-top: calc(var(--component-nocturne-state-content-gap) / 2);
    border-radius: var(--component-toast-progress-radius);
    overflow: hidden;
    background: var(--component-toast-progress-track);
  }

  .toast-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--component-toast-progress-fill);
    box-shadow: var(--component-toast-progress-shadow);
    transition: width var(--duration-slow) var(--easing-standard);
  }

  /* A running task that cannot tell how far it is sweeps a short segment across the track. */
  .toast-progress-indeterminate .toast-progress-fill {
    width: 35%;
    animation: toast-progress-sweep 1400ms var(--easing-standard) infinite;
  }

  .toast-actions {
    grid-area: actions;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--component-toast-gap);
    justify-content: flex-start;
    min-width: 0;
  }

  /* Actions are soft capsules: the first carries the state action surface, the rest stay quiet. */
  .toast-action {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 56px;
    min-height: 28px;
    padding: 0 var(--space-sm);
    border: 0;
    border-radius: var(--component-nocturne-state-action-radius, var(--component-toast-action-radius));
    background: transparent;
    color: var(--component-toast-action-fg);
    box-shadow: inset 0 0 0 var(--component-toast-border-width) var(--component-toast-action-border);
    font-family: var(--component-nocturne-state-font-ui);
    font-size: var(--component-toast-action-font-size);
    font-weight: var(--component-toast-action-font-weight);
    letter-spacing: var(--component-toast-action-letter-spacing);
    line-height: 1;
    white-space: nowrap;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
    cursor: pointer;
    transition: background var(--t-base), color var(--t-base), box-shadow var(--t-base), transform 450ms var(--ui-spring);
  }

  .toast-action:first-child {
    background: var(--component-nocturne-state-action-bg, var(--component-toast-action-bg));
    box-shadow: inset 0 0 0 var(--component-toast-border-width) var(--component-toast-border);
  }

  .toast-action:hover {
    background: var(--component-toast-action-bg-hover);
  }

  .toast-action:active {
    transform: scale(0.95);
  }

  .toast-close {
    grid-area: close;
    align-self: start;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--component-toast-close-size);
    height: var(--component-toast-close-size);
    margin-top: calc((var(--toast-badge-size) - var(--component-toast-close-size)) / 2);
    padding: 0;
    border: 0;
    border-radius: var(--component-toast-close-radius);
    color: var(--component-toast-close-fg);
    background: transparent;
    font-size: calc(var(--component-toast-close-size) / 2);
    opacity: 0.6;
    cursor: pointer;
    transition: color var(--t-base), background var(--t-base), opacity var(--t-base), transform var(--t-base);
  }

  .toast:hover .toast-close,
  .toast:focus-within .toast-close {
    opacity: 1;
  }

  .toast-close:hover {
    color: var(--component-toast-close-fg-hover);
    background: var(--component-toast-close-bg-hover);
  }

  .toast-close:active {
    transform: scale(0.92);
  }

  .toast-action:focus-visible,
  .toast-close:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--component-toast-focus-ring);
  }

  /* The lifetime is a hairline that drains along the bottom edge, inset from the corners. */
  .toast-life {
    position: absolute;
    right: var(--toast-frame-radius);
    bottom: var(--component-toast-border-width);
    left: var(--toast-frame-radius);
    z-index: var(--toast-life-z-index);
    height: var(--component-toast-progress-height);
    border-radius: var(--component-toast-progress-radius);
    background: var(--component-toast-life-bg);
    opacity: 0.7;
    transform-origin: left;
    pointer-events: none;
    animation: toastLife var(--toast-duration) linear forwards;
  }

  .toast-persistent .toast-life {
    display: none;
  }

  @keyframes toast-enter {
    from { opacity: 0; transform: translate3d(32px, 6px, 0) scale(0.965); filter: blur(6px); }
    45%  { opacity: 1; filter: blur(0); }
    to   { opacity: 1; transform: translate3d(0, 0, 0) scale(1); filter: none; }
  }

  @keyframes toast-progress-sweep {
    from { transform: translateX(-100%); }
    to { transform: translateX(290%); }
  }

  @keyframes toastLife {
    from { transform: scaleX(1); }
    to { transform: scaleX(0); }
  }

  @keyframes toast-glow-pulse {
    from { opacity: var(--component-toast-glow-min-opacity); }
    to { opacity: calc(var(--component-toast-glow-min-opacity) * 1.28); }
  }

  @media (max-width: 480px) {
    .toaster {
      right: var(--space-sm);
      bottom: var(--space-sm);
      left: var(--space-sm);
      width: auto;
    }
  }

  /* Reduced motion follows the app setting, then the system (motion.ts). */
  :global(html[data-epigraph-reduced-motion="true"]) .toast {
    animation: none;
    transition: none;
  }

  :global(html[data-epigraph-reduced-motion="true"]) .toast::before {
    animation: none;
  }

  :global(html[data-epigraph-reduced-motion="true"]) .icon,
  :global(html[data-epigraph-reduced-motion="true"]) .toast-progress-fill {
    transition: none;
  }

  :global(html[data-epigraph-reduced-motion="true"]) .toast-progress-indeterminate .toast-progress-fill {
    width: 100%;
    opacity: 0.45;
    animation: none;
  }
</style>
