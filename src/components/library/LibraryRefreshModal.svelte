<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { X, ArrowRight } from "phosphor-svelte";
  import { onMount } from "svelte";
  import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";
  import { enterOnMount, glideHeight } from "../../lib/motion/motion";
  import "../pages/migrationModal.css";

  interface Props {
    section: "comics" | "books";
    busy: boolean;
    onRun: (target: "active" | "all") => void;
    onClose: () => void;
  }

  let { section, busy, onRun, onClose }: Props = $props();

  let overlayEl = $state<HTMLDivElement | null>(null);
  let modalEl = $state<HTMLDivElement | null>(null);
  let closeButtonEl = $state<HTMLButtonElement | null>(null);

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && !busy) onClose();
  }

  $effect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  onMount(() => {
    if (!overlayEl || !modalEl) return;
    return createDialogFocusBoundary({
      dialog: modalEl,
      isolationRoot: overlayEl,
      initialFocus: closeButtonEl,
    });
  });
</script>

<div bind:this={overlayEl} class="mg-overlay" data-library-refresh>
  <button class="mg-backdrop" type="button" aria-label={$_("library.refresh.close")} disabled={busy} onclick={onClose}></button>
  <div
    bind:this={modalEl}
    class="mg-modal mg-modal--compact"
    role="dialog"
    aria-modal="true"
    aria-labelledby="library-refresh-title"
    tabindex="-1"
    use:glideHeight
  >
    <header class="mg-header">
      <div class="mg-heading">
        <h2 id="library-refresh-title" class="mg-title">{$_("library.refresh.eyebrow")}</h2>
      </div>
      <button bind:this={closeButtonEl} class="mg-close" type="button" onclick={onClose} disabled={busy} aria-label={$_("library.refresh.close")}><X size={16} weight="bold" /></button>
    </header>

    <div class="mg-body">
      <div class="mg-step" use:enterOnMount={{ y: 10, blur: 4, duration: 560 }}>
        <div class="mg-list">
          <button type="button" class="mg-row" disabled={busy} onclick={() => onRun("active")}>
            <span class="mg-row-copy">
              <strong>{section === "comics" ? $_("library.refresh.updateComics") : $_("library.refresh.updateBooks")}</strong>
              <small>{section === "comics" ? $_("library.refresh.updateComicsHint") : $_("library.refresh.updateBooksHint")}</small>
            </span>
            <span class="mg-row-end" aria-hidden="true"><ArrowRight size={16} weight="bold" /></span>
          </button>
          <button type="button" class="mg-row" disabled={busy} onclick={() => onRun("all")}>
            <span class="mg-row-copy">
              <strong>{$_("library.refresh.updateAll")}</strong>
              <small>{$_("library.refresh.updateAllHint")}</small>
            </span>
            <span class="mg-row-end" aria-hidden="true"><ArrowRight size={16} weight="bold" /></span>
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
