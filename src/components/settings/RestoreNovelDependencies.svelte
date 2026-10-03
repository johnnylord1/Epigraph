<script lang="ts">
  import { onDestroy } from "svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { operationError, restoreNote } from "../../lib/i18n/operationPresentation";
  import { createProductionNovelDependencySession, type NovelDependencyPlan } from "../../lib/backup/restoreDependencies";
  let { file, format, disabled = false, onChanged = () => {}, onBusy = () => {} }: {
    file: File; format: "epigraph" | "lnreader"; disabled?: boolean;
    onChanged?: () => void | Promise<void>; onBusy?: (busy: boolean) => void;
  } = $props();
  let session: Awaited<ReturnType<typeof createProductionNovelDependencySession>> | null = null;
  let plan = $state<NovelDependencyPlan | null>(null);
  let choices = $state<Record<string, string>>({});
  let busy = $state(false), error = $state<unknown>(null);
  let progress = $state<string | null>(null);
  let warnings = $state<Array<{ code: string; message: string }>>([]);
  let detached = false;
  onDestroy(() => { detached = true; onBusy(false); });
  // Inspect once on open. Panels share one busy flag, so a panel opened while another is still
  // inspecting waits for it instead of giving up.
  let opened = false;
  $effect(() => {
    if (opened || disabled || busy) return;
    opened = true;
    void inspect();
  });
  function setBusy(value: boolean) { busy = value; if (!detached) onBusy(value); }
  async function inspect() {
    if (disabled || busy) return;
    setBusy(true); error = null;
    try {
      session ??= await createProductionNovelDependencySession(file, format);
      const next = await session.inspect();
      if (detached) return;
      plan = next;
      choices = Object.fromEntries(next.plugins.map(plugin => [plugin.pluginId, plugin.selectedRepositoryUrl ?? (plugin.candidates.length === 1 ? plugin.candidates[0].repositoryUrl : "")]));
    } catch (cause) { if (!detached) error = cause; }
    finally { setBusy(false); }
  }
  const installable = $derived((plan?.plugins ?? []).filter(p => p.status === "needs-selection" && choices[p.pluginId]));
  const choosable = $derived((plan?.plugins ?? []).filter(p => p.status === "needs-selection" && !choices[p.pluginId]));
  const attention = $derived((plan?.plugins ?? []).filter(p => p.status === "conflict" || p.status === "missing"));
  const ready = $derived((plan?.plugins ?? []).filter(p => p.status === "ready"));
  function shortRepo(url: string) {
    try {
      const u = new URL(url);
      if (u.hostname === "raw.githubusercontent.com" || u.hostname === "github.com") {
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      }
      return u.hostname;
    } catch { return url; }
  }
  async function installAll() {
    if (!session || busy || disabled || !installable.length) return;
    const plugins = Object.fromEntries(installable.map(p => [p.pluginId, choices[p.pluginId]]));
    progress = $_("restoreDeps.installing", { count: installable.length });
    setBusy(true); error = null;
    try {
      const result = await session.apply({ repositoryUrls: [...new Set(Object.values(plugins))], plugins });
      if (detached) return;
      plan = result.plan; warnings = result.warnings;
      await onChanged();
    } catch (cause) { if (!detached) error = cause; }
    finally { progress = null; setBusy(false); }
  }
</script>

<section class="restore-dependencies" aria-label={$_("restoreDeps.novelReview")}>
  {#if plan}
    <div class="dep-list">
      {#if installable.length}
        <div class="dep-row">
          <span class="dep-copy"><strong>{$_("restoreDeps.pluginsToInstall", { count: installable.length })}</strong>
            <small>{[...new Set(installable.map(p => shortRepo(choices[p.pluginId])))].join(", ")}</small></span>
          <button type="button" disabled={disabled || busy} onclick={installAll}>{progress ?? $_("restoreDeps.installAll")}</button>
        </div>
      {/if}
      {#if !installable.length && !choosable.length}
        <p class="dep-ok">{ready.length ? $_("restoreDeps.pluginsReady", { count: ready.length }) : $_("restoreDeps.noPlugins")}</p>
      {/if}
    </div>
    {#if choosable.length}
      <p class="dep-label">{$_("restoreDeps.chooseRepository")}</p>
      <div class="dep-list">
        {#each choosable as plugin (plugin.pluginId)}
          <label class="dep-row">
            <span class="dep-copy"><strong>{plugin.pluginId}</strong></span>
            <select disabled={disabled || busy} value={choices[plugin.pluginId] ?? ""}
              onchange={event => { choices[plugin.pluginId] = event.currentTarget.value; }}>
              <option value="">{$_("restoreDeps.chooseRepository")}</option>
              {#each plugin.candidates as candidate}<option value={candidate.repositoryUrl} title={candidate.repositoryUrl}>{shortRepo(candidate.repositoryUrl)}</option>{/each}
            </select>
          </label>
        {/each}
      </div>
    {/if}
    {#if attention.length}
      <details class="dep-more"><summary>{$_("restoreDeps.needsAttention", { count: attention.length })}</summary>
        {#each attention as plugin (plugin.pluginId)}
          <p><strong>{plugin.pluginId}</strong> {plugin.status === "conflict" ? $_("restoreDeps.conflict") : $_("restoreDeps.missing")}</p>
        {/each}
      </details>
    {/if}
    {#if warnings.length}
      <details class="dep-more"><summary>{$_("restoreDeps.warnings", { count: warnings.length })}</summary>
        {#each [...new Set(warnings.map(w => restoreNote(w, $_)))] as note}
          <p>{note}</p>
        {/each}
      </details>
    {/if}
  {:else if busy}
    <p role="status">{$_("restoreDeps.checking")}</p>
  {/if}
  {#if error}<p role="alert">{operationError(error, "restoreDeps.failed", $_)}</p>{/if}
</section>

<style>
  .restore-dependencies { display: grid; gap: 12px; color: var(--text-secondary); font-size: var(--text-sm); }
  .dep-list { display: grid; border-top: 1px solid var(--border-dim); }
  .dep-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-dim); min-width: 0; }
  .dep-copy { display: grid; gap: 2px; flex: 1; min-width: 0; }
  .dep-copy strong { color: var(--text-primary); font-weight: 600; }
  .dep-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-tertiary); }
  .dep-label { margin: 4px 0 0; color: var(--text-tertiary); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: .04em; }
  .dep-ok { margin: 10px 0 0; }
  .dep-more summary { cursor: pointer; color: var(--text-tertiary); }
  .dep-more p { margin: 6px 0 0; overflow-wrap: anywhere; }
  button, select { flex-shrink: 0; min-height: 32px; max-width: 45%; padding: 6px 12px; border: 0; border-radius: var(--radius-sm); background: var(--bg-overlay); color: var(--text-primary); font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  p { margin: 0; }
</style>
