<script lang="ts" module>
  export interface MigrationConfirmSide {
    title: string;
    caption: string;
    coverSrc: string | null;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { ArrowRight, BookOpen, Warning } from "phosphor-svelte";
  import { _ } from "../../lib/i18n/runtime";
  import NocturneState from "../shared/NocturneState.svelte";

  // The confirmation shared by every migration modal: the two covers, one line with what carries
  // over, at most one warning, and the short note about what happens to the current entry.
  interface Props {
    from: MigrationConfirmSide;
    to: MigrationConfirmSide;
    summary?: Snippet;
    warning?: string | null;
    note: string;
    error?: string | null;
    errorTitle?: string;
  }

  let { from, to, summary, warning = null, note, error = null, errorTitle }: Props = $props();

  function markBrokenImage(event: Event) {
    (event.currentTarget as HTMLImageElement).dataset.broken = "true";
  }
</script>

<div class="mg-compare">
  {#each [from, to] as side, i}
    {#if i === 1}<span class="mg-compare-arrow" aria-hidden="true"><ArrowRight size={16} weight="bold" /></span>{/if}
    <div class="mg-compare-card">
      <span class="mg-cover">
        {#if side.coverSrc}<img src={side.coverSrc} alt="" onerror={markBrokenImage} />{:else}<BookOpen size={18} weight="duotone" />{/if}
      </span>
      <span class="mg-row-copy">
        <strong title={side.title}>{side.title}</strong>
        <small>{side.caption}</small>
      </span>
    </div>
  {/each}
</div>

{#if summary}<p class="mg-summary">{@render summary()}</p>{/if}
{#if warning}<p class="mg-note is-warn"><Warning size={13} weight="bold" /> {warning}</p>{/if}
<p class="mg-note">{note}</p>

{#if error}
  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={errorTitle ?? $_("ui_migrationFailed")} body={error} />
{/if}
