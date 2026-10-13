<script lang="ts">
  import { onDestroy } from "svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { operationError, restoreNote } from "../../lib/i18n/operationPresentation";
  import { createProductionMangaDependencySession, type MangaDependencyPlan, type MangaRestoreChoices } from "../../lib/backup/mangaRestoreDependencies";
  import { extensionStoreKey } from "../../lib/manga/runtime";
  let { file, format, disabled = false, choices = {}, onChoices = () => {}, onBusy = () => {}, onChanged = () => {} }: {
    file: File; format: "native" | "epigraph"; disabled?: boolean; choices?: MangaRestoreChoices;
    onChoices?: (choices: MangaRestoreChoices) => void; onBusy?: (busy: boolean) => void;
    onChanged?: () => void | Promise<void>;
  } = $props();
  let session: Awaited<ReturnType<typeof createProductionMangaDependencySession>> | null = null;
  let plan = $state<MangaDependencyPlan | null>(null), busy = $state(false), error = $state<unknown>(null);
  let progress = $state<string | null>(null);
  let failedRepos = $state<string[]>([]);
  let detached = false;
  onDestroy(() => { detached = true; onBusy(false); });
  // Inspect once on open. Panels share one busy flag, so a panel opened while another is still
  // inspecting waits for it instead of giving up.
  let opened = false;
  $effect(() => {
    if (opened || disabled || busy) return;
    opened = true;
    void run();
  });
  export async function review() { await run(); }
  async function run(action?: (activeSession: NonNullable<typeof session>) => Promise<MangaDependencyPlan>, notify = true) {
    if (disabled || busy) return;
    busy = true; onBusy(true); error = null;
    try {
      session ??= await createProductionMangaDependencySession(file, format);
      const result = action ? await action(session) : await session.inspect();
      if (!detached) { plan = result; if (action && notify) await onChanged(); }
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
  // A repository that could not be added (offline, or no longer published) is reported once below
  // instead of being offered again; the restore goes on without it, as in Mihon.
  const missingRepos = $derived(plan ? plan.requiredRepositories.filter(url => !failedRepos.includes(url)
    && !plan!.repositories.some(repo => extensionStoreKey(repo.indexUrl) === extensionStoreKey(url))) : []);
  const installable = $derived(plan ? plan.extensions.filter(e => !e.isInstalled && e.storeId) : []);
  const choosable = $derived(plan ? plan.sources.filter(s => s.candidates.some(c => c.sourceId !== s.orphanSourceId)) : []);
  const unmatched = $derived(plan ? plan.sources.filter(s => s.candidates.length === 0) : []);
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
  function addAll() {
    void run(async s => { const r = await s.addRepositories(missingRepos); failedRepos = r.failed; return r.plan; });
  }
  async function installAll() {
    progress = $_("restoreDeps.installing", { count: installable.length });
    try {
      await run(s => s.installMany(installable.map(e => ({ packageName: e.packageName, storeId: e.storeId! }))));
    } finally { progress = null; }
  }
</script>

<section class="restore-dependencies" aria-label={$_("restoreDeps.mangaReview")}>
  {#if plan}
    <div class="dep-list">
      {#if missingRepos.length}
        <div class="dep-row">
          <span class="dep-copy"><strong>{$_("restoreDeps.missingRepositories", { count: missingRepos.length })}</strong>
            <small>{missingRepos.map(shortRepo).join(", ")}</small></span>
          <button type="button" disabled={disabled || busy} onclick={addAll}>{$_("restoreDeps.addAll")}</button>
        </div>
      {/if}
      {#if failedRepos.length}<p class="dep-warn" role="status">{$_("restoreDeps.addFailed", { names: failedRepos.map(shortRepo).join(", ") })}</p>{/if}
      {#if installable.length}
        <div class="dep-row">
          <span class="dep-copy"><strong>{$_("restoreDeps.extensionsToInstall", { count: installable.length })}</strong>
            <small>{installable.slice(0, 6).map(e => e.name ?? e.packageName).join(", ")}{installable.length > 6 ? ` +${installable.length - 6}` : ""}</small></span>
          <button type="button" disabled={disabled || busy} onclick={installAll}>{progress ?? $_("restoreDeps.installAll")}</button>
        </div>
      {/if}
      {#if !missingRepos.length && !installable.length}<p class="dep-ok">{$_("restoreDeps.nothingToInstall")}</p>{/if}
    </div>
    {#if choosable.length}
      <p class="dep-label">{$_("restoreDeps.replacements")}</p>
      <div class="dep-list">
        {#each choosable as source (source.orphanSourceId)}
          <label class="dep-row">
            <span class="dep-copy"><strong>{source.sourceName}</strong></span>
            <select disabled={disabled || busy} value={choices[source.orphanSourceId]?.mode === "map" ? `map:${(choices[source.orphanSourceId] as { sourceId: string }).sourceId}` : choices[source.orphanSourceId]?.mode ?? "preserve"}
              onchange={event => choose(source.orphanSourceId, event.currentTarget.value)}>
              <option value="preserve">{$_("restoreDeps.preserve")}</option>
              <option value="skip">{$_("ui_exclude")}</option>
              {#each source.candidates as candidate}<option value={`map:${candidate.sourceId}`}>{candidate.displayName} ({candidate.sourceId})</option>{/each}
            </select>
          </label>
        {/each}
      </div>
    {/if}
    {#if unmatched.length}
      <details class="dep-more"><summary>{$_("restoreDeps.unmatched", { count: unmatched.length })}</summary>
        <p>{unmatched.map(s => s.sourceName).join(", ")}</p></details>
    {/if}
    {#if plan.warnings.length}
      <details class="dep-more"><summary>{$_("restoreDeps.warnings", { count: plan.warnings.length })}</summary>
        {#each plan.warnings as warning}<p>{restoreNote(warning, $_)}</p>{/each}</details>
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
  .dep-ok, .dep-warn { margin: 10px 0 0; }
  .dep-warn { color: var(--color-warning); }
  .dep-more summary { cursor: pointer; color: var(--text-tertiary); }
  .dep-more p { margin: 6px 0 0; overflow-wrap: anywhere; }
  button, select { flex-shrink: 0; min-height: 32px; max-width: 45%; padding: 6px 12px; border: 0; border-radius: var(--radius-sm); background: var(--bg-overlay); color: var(--text-primary); font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  p { margin: 0; }
</style>
