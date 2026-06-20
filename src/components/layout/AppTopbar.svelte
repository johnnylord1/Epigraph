<script lang="ts">
  import type { Snippet } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";

  type Props = {
    className?: string;
    left?: Snippet;
    center?: Snippet;
    right?: Snippet;
  };

  let {
    className = "",
    left,
    center,
    right,
  }: Props = $props();

  const interactiveSelector = [
    "button",
    "a",
    "input",
    "select",
    "textarea",
    "label",
    "[role='button']",
    "[role='menuitem']",
    "[role='menuitemradio']",
    "[contenteditable='true']",
    ".n-search",
    ".n-icon-btn",
    ".n-segmented",
    ".n-popover-surface",
    ".window-controls-inline",
    "[data-no-window-drag]",
  ].join(",");

  function handleTopbarPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(interactiveSelector)) return;

    getCurrentWindow().startDragging().catch(() => {});
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions: desktop window drag must start from empty topbar regions. -->
<header class={`n-topbar ${className}`.trim()} data-tauri-drag-region onpointerdown={handleTopbarPointerDown}>
  <div class="n-topbar__left">
    {@render left?.()}
  </div>
  <div class="n-topbar__center">
    {@render center?.()}
  </div>
  <div class="n-topbar__right">
    {@render right?.()}
  </div>
</header>
