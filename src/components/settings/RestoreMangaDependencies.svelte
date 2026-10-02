<script lang="ts">
  import { onDestroy } from "svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { operationError, restoreNote } from "../../lib/i18n/operationPresentation";
  import { createProductionMangaDependencySession, type MangaDependencyPlan, type MangaRestoreChoices } from "../../lib/backup/mangaRestoreDependencies";
  let { file, format, disabled = false, choices = {}, onChoices = () => {}, onBusy = () => {}, onChanged = () => {} }: {
    file: File; format: "native" | "epigraph"; disabled?: boolean; choices?: MangaRestoreChoices;
    onChoices?: (choices: MangaRestoreChoices) => void; onBusy?: (busy: boolean) => void;
    onChanged?: () => void | Promise<void>;
  } = $props();
  let session: Awaited<ReturnType<typeof createProductionMangaDependencySession>> | null = null;
  let plan = $state<MangaDependencyPlan | null>(null), busy = $state(false), error = $state<unknown>(null);
  let detached = false;
  onDestroy(() => { detached = true; onBusy(false); });
  export async function review() { await run(); }
  async function run(action?: (activeSession: NonNullable<typeof session>) => Promise<MangaDependencyPlan>) {
    if (disabled || busy) return;
    busy = true; onBusy(true); error = null;
    try {
      session ??= await createProductionMangaDependencySession(file, format);
      const result = action ? await action(session) : await session.inspect();
      if (!detached) { plan = result; if (action) await onChanged(); }
    } catch (cause) { if (!detached) error = cause; }
    finally { busy = false; if (!detached) onBusy(false); }
  }
  function choose(sourceId: string, value: string) {
    if (disabled || busy) return;
    const candidate = plan?.sources.find(source => source.orphanSourceId === sourceId)?.candidates.find(candidate => `map:${candidate.sourceId}` === value);
    const next: MangaRestoreChoices = { ...choices, [sourceId]: candidate
      ? { mode: "map", sourceId: candidate.sourceId, name: candidate.sourceName, lang: candidate.sourceLang }
      : { mode: value === "skip" ? "skip" : "preserve" } };
    try { onChoices(next); } catch (cause) { error = cause; }
  }
</script>

<section class="restore-dependencies" aria-label={$_("restoreDeps.mangaReview")}>
  <button type="button" disabled={disabled || busy} onclick={() => run()}>{$_("restoreDeps.mangaReview")}</button>
  {#if plan}
    <p>{$_("restoreDeps.mangaPreserveHint")}</p>
    {#each plan.requiredRepositories.filter(url => !plan!.repositories.some(repo => repo.indexUrl === url)) as url}
      <div class="dependency"><span>{url}</span><button type="button" disabled={disabled || busy} onclick={() => run(session => session.addRepository(url))}>{$_("restoreDeps.approveRepository")}</button></div>
    {/each}
    {#each plan.sources as source (source.orphanSourceId)}
      <label>{source.sourceName}
        <select disabled={disabled || busy} value={choices[source.orphanSourceId]?.mode === "map" ? `map:${(choices[source.orphanSourceId] as { sourceId: string }).sourceId}` : choices[source.orphanSourceId]?.mode ?? "preserve"}
          onchange={event => choose(source.orphanSourceId, event.currentTarget.value)}>
          <option value="preserve">{$_("restoreDeps.preserve")}</option>
          <option value="skip">{$_("ui_exclude")}</option>
          {#each source.candidates as candidate}<option value={`map:${candidate.sourceId}`}>{candidate.displayName} ({candidate.sourceId})</option>{/each}
        </select>
      </label>
    {/each}
    {#each plan.extensions.filter(extension => !extension.isInstalled) as extension}
      <div class="dependency">
        <span>{extension.name ?? extension.packageName}<small>{extension.packageName} · {plan.repositories.find(repo => repo.id === extension.storeId)?.indexUrl ?? $_("restoreDeps.unknownOrigin")}</small></span>
        <button type="button" disabled={disabled || busy || !extension.storeId} onclick={() => run(session => session.install({ packageName: extension.packageName, storeId: extension.storeId! }))}>{$_("firstRun.sources.installNamed", { name: extension.name ?? extension.packageName })}</button>
      </div>
    {/each}
    {#each plan.warnings as warning}<p role="status">{restoreNote(warning, $_)}</p>{/each}
  {/if}
  {#if busy}<p role="status">{$_("restoreDeps.checking")}</p>{/if}
  {#if error}<p role="alert">{operationError(error, "restoreDeps.failed", $_)}</p>{/if}
</section>

<style>
  .restore-dependencies { display: grid; gap: 10px; color: var(--text-secondary); font-size: var(--text-sm); }
  .dependency, label { display: grid; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
  small { display: block; }
  button, select { min-height: 34px; max-width: 100%; padding: 6px 12px; border: 0; border-radius: var(--radius-sm); background: var(--bg-overlay); color: var(--text-primary); font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; }
  p { margin: 0; }
</style>
