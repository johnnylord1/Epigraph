<script lang="ts">
  import type { LibraryDisplaySettings } from "../../lib/library/contracts";
  import type { LibraryPreferredGridColumns, LibraryViewMode } from "../../lib/libraryDisplay";
  import { _ } from "../../lib/i18n/runtime";
  import LibraryDensityRail from "./LibraryDensityRail.svelte";

  type Props = {
    settings: LibraryDisplaySettings;
    panel?: "density" | "layout" | "all";
    onViewModeChange?: (mode: LibraryViewMode) => void;
    onPreferredColumnsChange?: (value: LibraryPreferredGridColumns) => void;
    onShowProgressChange?: (value: boolean) => void;
    onShowOutlineChange?: (value: boolean) => void;
  };

  const VIEW_OPTIONS: { id: LibraryViewMode; labelKey: string }[] = [
    { id: "grid", labelKey: "library.display.grid" },
    { id: "compact_grid", labelKey: "library.display.compact" },
    { id: "list", labelKey: "library.display.list" },
  ];
  const SWITCH_SYNC_HOLD_MS = 620;
  let viewModeSyncHoldUntil = 0;
  let progressSyncHoldUntil = 0;
  let outlineSyncHoldUntil = 0;

  let {
    settings,
    panel = "density",
    onViewModeChange = () => {},
    onPreferredColumnsChange = () => {},
    onShowProgressChange = () => {},
    onShowOutlineChange = () => {},
  }: Props = $props();

  const densityLabel = $derived(
    settings.preferredColumns === "auto" ? $_("library.display.auto") : String(settings.preferredColumns),
  );
  let visualViewMode = $state<LibraryViewMode>("grid");
  let visualShowProgress = $state(true);
  let visualShowOutline = $state(true);

  $effect(() => {
    if (Date.now() < viewModeSyncHoldUntil) return;
    visualViewMode = settings.viewMode;
  });

  $effect(() => {
    if (Date.now() < progressSyncHoldUntil) return;
    visualShowProgress = settings.showProgress;
  });

  $effect(() => {
    if (Date.now() < outlineSyncHoldUntil) return;
    visualShowOutline = settings.showOutline;
  });

  const viewModeLabel = $derived(
    visualViewMode === "compact_grid"
      ? $_("library.display.compact")
      : visualViewMode === "list"
        ? $_("library.display.list")
        : $_("library.display.grid"),
  );
  const viewModeIndex = $derived(Math.max(0, VIEW_OPTIONS.findIndex((option) => option.id === visualViewMode)));

  function holdViewModeSync() {
    viewModeSyncHoldUntil = Date.now() + SWITCH_SYNC_HOLD_MS;
  }

  function selectViewMode(event: MouseEvent, mode: LibraryViewMode) {
    event.currentTarget instanceof HTMLElement && event.currentTarget.blur();
    holdViewModeSync();
    visualViewMode = mode;
    requestAnimationFrame(() => onViewModeChange(mode));
  }

  function selectShowProgress(event: MouseEvent, value: boolean) {
    event.currentTarget instanceof HTMLElement && event.currentTarget.blur();
    progressSyncHoldUntil = Date.now() + 300;
    visualShowProgress = value;
    onShowProgressChange(value);
  }

  function selectShowOutline(event: MouseEvent, value: boolean) {
    event.currentTarget instanceof HTMLElement && event.currentTarget.blur();
    outlineSyncHoldUntil = Date.now() + 300;
    visualShowOutline = value;
    onShowOutlineChange(value);
  }
</script>

  <div class="display-panel" role="menu" aria-label={$_("library.display.viewSettings")}>
  {#if panel === "density"}
    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">{$_("library.display.itemsPerRow")}</p>
          <p class="n-popover-note">{$_("library.display.itemsPerRowHint")}</p>
        </div>
        <span class="n-popover-meta">{densityLabel}</span>
      </div>
      <LibraryDensityRail
        value={settings.preferredColumns}
        disabled={settings.viewMode === "list"}
        onSelect={onPreferredColumnsChange}
      />
    </section>
  {:else if panel === "layout"}
    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">{$_("library.display.layout")}</p>
          <p class="n-popover-note">{$_("library.display.layoutHint")}</p>
        </div>
        <span class="n-popover-meta">{viewModeLabel}</span>
      </div>

      <div
        class="n-mini-switch n-layout-switch"
        role="group"
        aria-label={$_("library.display.layoutMode")}
        data-index={viewModeIndex}
      >
        <span class="n-mini-switch-thumb" aria-hidden="true"></span>
        {#each VIEW_OPTIONS as option}
          <button
            type="button"
            class:is-selected={visualViewMode === option.id}
            onclick={(event) => selectViewMode(event, option.id)}
          >
            {$_(option.labelKey)}
          </button>
        {/each}
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">{$_("library.display.showProgress")}</span>
        <button
          type="button"
          class="n-compact-toggle"
          class:is-on={visualShowProgress}
          role="switch"
          aria-checked={visualShowProgress}
          aria-label={$_("library.display.showProgress")}
          onclick={(event) => selectShowProgress(event, !visualShowProgress)}
        ></button>
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">{$_("library.display.showOutlines")}</span>
        <button
          type="button"
          class="n-compact-toggle"
          class:is-on={visualShowOutline}
          role="switch"
          aria-checked={visualShowOutline}
          aria-label={$_("library.display.showOutlines")}
          onclick={(event) => selectShowOutline(event, !visualShowOutline)}
        ></button>
      </div>
    </section>
  {:else}
    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">{$_("library.display.itemsPerRow")}</p>
          <p class="n-popover-note">{$_("library.display.itemsPerRowHint")}</p>
        </div>
        <span class="n-popover-meta">{densityLabel}</span>
      </div>
      <LibraryDensityRail
        value={settings.preferredColumns}
        disabled={settings.viewMode === "list"}
        onSelect={onPreferredColumnsChange}
      />
    </section>

    <section class="n-popover-panel is-open">
      <div class="n-popover-head">
        <div>
          <p class="n-popover-title">{$_("library.display.layout")}</p>
          <p class="n-popover-note">{$_("library.display.layoutHint")}</p>
        </div>
        <span class="n-popover-meta">{viewModeLabel}</span>
      </div>

      <div
        class="n-mini-switch n-layout-switch"
        role="group"
        aria-label={$_("library.display.layoutMode")}
        data-index={viewModeIndex}
      >
        <span class="n-mini-switch-thumb" aria-hidden="true"></span>
        {#each VIEW_OPTIONS as option}
          <button
            type="button"
            class:is-selected={visualViewMode === option.id}
            onclick={(event) => selectViewMode(event, option.id)}
          >
            {$_(option.labelKey)}
          </button>
        {/each}
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">{$_("library.display.showProgress")}</span>
        <button
          type="button"
          class="n-compact-toggle"
          class:is-on={visualShowProgress}
          role="switch"
          aria-checked={visualShowProgress}
          aria-label={$_("library.display.showProgress")}
          onclick={(event) => selectShowProgress(event, !visualShowProgress)}
        ></button>
      </div>

      <div class="n-toggle-row">
        <span class="n-toggle-label">{$_("library.display.showOutlines")}</span>
        <button
          type="button"
          class="n-compact-toggle"
          class:is-on={visualShowOutline}
          role="switch"
          aria-checked={visualShowOutline}
          aria-label={$_("library.display.showOutlines")}
          onclick={(event) => selectShowOutline(event, !visualShowOutline)}
        ></button>
      </div>
    </section>
  {/if}
</div>

<style>
  .display-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(300px, calc(100vw - 40px));
    min-width: 0;
  }

  .n-popover-panel {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 0;
  }

  .n-popover-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .n-popover-head > div {
    min-width: 0;
    flex: 1 1 auto;
  }

  .n-popover-title {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 620;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--component-library-faint-fg);
  }

  .n-popover-note {
    margin: 2px 0 0;
    font-family: var(--font-sans);
    font-size: 11px;
    line-height: 1.45;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--component-library-muted-fg);
  }

  .n-popover-meta {
    flex: 0 0 auto;
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 620;
    letter-spacing: 0.055em;
    text-transform: uppercase;
    color: var(--component-library-accent-fg);
    white-space: nowrap;
  }

  .n-layout-switch {
    align-self: flex-start;
    width: 100%;
  }

  .n-layout-switch button {
    flex: 1 1 0;
  }

  .n-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .n-toggle-label {
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.045em;
    text-transform: uppercase;
    color: var(--component-library-muted-fg);
  }

  .n-compact-toggle {
    position: relative;
    flex: 0 0 auto;
    width: calc(40px * var(--component-library-scale, 1));
    height: calc(22px * var(--component-library-scale, 1));
    padding: 0;
    border: none;
    border-radius: var(--radius-full);
    background: var(--component-library-popover-toggle-bg);
    box-shadow: var(--component-library-popover-toggle-shadow);
    cursor: pointer;
    transition:
      background 180ms ease,
      box-shadow 180ms ease,
      transform 90ms ease;
  }

  .n-compact-toggle::after {
    content: "";
    position: absolute;
    top: calc(2px * var(--component-library-scale, 1));
    left: calc(2px * var(--component-library-scale, 1));
    width: calc(18px * var(--component-library-scale, 1));
    height: calc(18px * var(--component-library-scale, 1));
    border-radius: var(--radius-full);
    background: var(--component-library-popover-toggle-knob-bg);
    transition: transform 180ms ease, background 180ms ease;
  }

  .n-compact-toggle.is-on {
    background: var(--component-library-popover-toggle-on-bg);
  }

  .n-compact-toggle.is-on::after {
    transform: translateX(calc(18px * var(--component-library-scale, 1)));
    background: var(--component-library-popover-toggle-on-knob-bg);
  }

  .n-compact-toggle:hover {
    box-shadow: var(--component-library-popover-toggle-hover-shadow);
  }

  .n-compact-toggle:active {
    transform: scale(0.97);
  }

  .n-mini-switch {
    --switch-count: 2;
    position: relative;
    isolation: isolate;
    display: grid;
    grid-template-columns: repeat(var(--switch-count, 2), minmax(0, 1fr));
    gap: 4px;
    padding: 4px;
    border-radius: var(--radius-full);
    background: var(--component-library-popover-switch-bg);
    backdrop-filter: var(--component-library-popover-switch-blur);
    border: 1px solid var(--component-library-popover-switch-border);
    overflow: hidden;
  }

  .n-layout-switch {
    --switch-count: 3;
  }

  .n-mini-switch-thumb {
    position: absolute;
    z-index: var(--component-library-panel-hidden-z-index);
    top: 4px;
    bottom: 4px;
    left: 4px;
    width: calc((100% - 12px) / 2);
    border-radius: var(--radius-full);
    background: var(--component-library-popover-switch-thumb-bg);
    box-shadow: var(--component-library-popover-switch-thumb-shadow);
    transform: translateX(0);
    transition: transform 620ms cubic-bezier(0.22, 1, 0.36, 1);
    pointer-events: none;
    will-change: transform;
  }

  .n-mini-switch[data-index="1"] .n-mini-switch-thumb {
    transform: translateX(calc(100% + 4px));
  }

  .n-mini-switch[data-index="2"] .n-mini-switch-thumb {
    transform: translateX(calc(200% + 8px));
  }

  .n-layout-switch .n-mini-switch-thumb {
    width: calc((100% - 16px) / 3);
  }

  .n-mini-switch > button:not(.n-mini-switch-hit) {
    position: relative;
    z-index: var(--component-library-control-z-index);
    min-width: 28px;
    min-height: 22px;
    padding: 0 8px;
    border-radius: var(--radius-full);
    border: none;
    background: transparent;
    color: var(--component-library-muted-fg);
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    cursor: pointer;
    transition: all 250ms var(--easing-emphasized);
  }

  .n-mini-switch > button:not(.n-mini-switch-hit):hover:not(.is-selected) {
    color: var(--component-library-fg);
    background: var(--component-button-bg-hover);
  }

  .n-mini-switch > button:not(.n-mini-switch-hit).is-selected {
    color: var(--component-library-popover-switch-selected-fg);
  }

  @media (prefers-reduced-motion: reduce) {
    .n-mini-switch-thumb,
    .n-mini-switch button,
    .n-compact-toggle,
    .n-compact-toggle::after {
      transition-duration: 1ms;
    }
  }
</style>
