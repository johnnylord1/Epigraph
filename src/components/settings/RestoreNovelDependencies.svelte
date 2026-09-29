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
  let approved = $state<Record<string, boolean>>({});
  let busy = $state(false), error = $state<unknown>(null), warnings = $state<Array<{ code: string; message: string }>>([]);
  let detached = false;
  onDestroy(() => { detached = true; onBusy(false); });
  const selected = $derived((plan?.plugins ?? []).filter(plugin => plugin.status === "needs-selection" && approved[plugin.pluginId] && choices[plugin.pluginId]));
  function setBusy(value: boolean) { busy = value; if (!detached) onBusy(value); }
  async function inspect() {
    if (disabled || busy) return;
    setBusy(true); error = null;
    try {
      session ??= await createProductionNovelDependencySession(file, format);
      const next = await session.inspect();
      if (detached) return;
      plan = next; approved = {}; choices = Object.fromEntries(next.plugins.map(plugin => [plugin.pluginId, plugin.selectedRepositoryUrl ?? ""]));
    } catch (cause) { if (!detached) error = cause; }
    finally { setBusy(false); }
  }
  async function prepare() {
    if (!session || busy || disabled || !selected.length) return;
    const plugins = Object.fromEntries(selected.map(plugin => [plugin.pluginId, choices[plugin.pluginId]]));
    setBusy(true); error = null;
    try {
      const result = await session.apply({ repositoryUrls: [...new Set(Object.values(plugins))], plugins });
      if (detached) return;
      plan = result.plan; warnings = result.warnings; approved = {};
      await onChanged();
    } catch (cause) { if (!detached) error = cause; }
    finally { setBusy(false); }
  }
</script>

<section aria-label={$_("restoreDeps.novelReview")} class="restore-dependencies">
  <button type="button" disabled={disabled || busy} onclick={inspect}>{$_("restoreDeps.novelReview")}</button>
  {#if plan}
    {#if plan.plugins.length === 0}<p>{$_("restoreDeps.noPlugins")}</p>{/if}
    {#each plan.plugins as plugin (plugin.pluginId)}
      <div class="dependency">
        <strong>{plugin.pluginId}</strong>
        {#if plugin.status === "ready"}<span>{$_("restoreDeps.installed")}</span>
        {:else if plugin.status === "conflict"}<p role="status">{$_("restoreDeps.conflict")}</p>
        {:else if plugin.status === "missing"}<p role="status">{$_("restoreDeps.missing")}</p>
        {:else}
          <label>{$_("restoreDeps.repository")}
            <select disabled={disabled || busy} value={choices[plugin.pluginId] ?? ""} onchange={event => { choices[plugin.pluginId] = event.currentTarget.value; approved[plugin.pluginId] = false; }}>
              <option value="">{$_("restoreDeps.chooseRepository")}</option>
              {#each plugin.candidates as candidate}<option value={candidate.repositoryUrl}>{candidate.repositoryUrl}</option>{/each}
            </select>
          </label>
          <label class="consent"><input type="checkbox" disabled={disabled || busy || !choices[plugin.pluginId]} bind:checked={approved[plugin.pluginId]} />{$_("restoreDeps.consent")}</label>
        {/if}
      </div>
    {/each}
    <button type="button" disabled={disabled || busy || selected.length === 0} onclick={prepare}>{$_("restoreDeps.prepare")}</button>
  {/if}
  {#if busy}<p role="status">{$_("restoreDeps.checking")}</p>{/if}
  {#if error}<p role="alert">{operationError(error, "restoreDeps.failed", $_)}</p>{/if}
  {#if warnings.length}<ul>{#each warnings as warning}<li>{restoreNote(warning, $_)}</li>{/each}</ul>{/if}
</section>

<style>
  .restore-dependencies { display: grid; gap: 12px; margin-top: 16px; padding: 16px; border: 1px solid var(--border-dim); border-radius: var(--radius-md); color: var(--text-secondary); background: var(--bg-surface); }
  .dependency, label { display: grid; gap: 8px; min-width: 0; }
  .dependency { padding-block: 8px; overflow-wrap: anywhere; }
  .consent { display: flex; align-items: center; }
  button, select { min-height: 38px; max-width: 100%; padding: 8px 12px; border: 1px solid var(--border-dim); border-radius: var(--radius-sm); background: var(--bg-raised); color: var(--text-primary); font: inherit; }
  button:disabled { opacity: .5; }
  p { margin: 0; }
</style>
