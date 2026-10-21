<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import FirstRunDependencies from "./FirstRunDependencies.svelte";
  import type { MangaRestoreChoices } from "../../lib/backup/mangaRestoreDependencies";
  import {
    Archive,
    ArrowClockwise,
    ArrowLeft,
    ArrowRight,
    CheckCircle,
    FileArchive,
    Files,
    FolderOpen,
    GitMerge,
    Trash,
    WarningCircle,
  } from "phosphor-svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { operationError, restoreNote } from "../../lib/i18n/operationPresentation";
  import { arrive, countUp } from "../../lib/motion/firstRunMotion";
  import FirstRunTitle from "./FirstRunTitle.svelte";
  import type {
    BackupSourceKind,
    BackupWorkflow,
    BackupWorkflowFile,
  } from "../../lib/backup/backupWorkflow";

  type RestoredResult = {
    hasLibrary: boolean;
    needsSourceKinds: BackupSourceKind[];
    sourceTypes: BackupSourceKind[];
  };

  interface Props {
    workflow: BackupWorkflow & { warnings?(): Record<string, string[]>; setMangaChoices?(choices: MangaRestoreChoices, inputKey?: string): void };
    picker?: () => Promise<File[]>;
    onBack?: () => void;
    onDefer?: () => void;
    onRestored?: (result: RestoredResult) => void;
  }

  let {
    workflow,
    picker,
    onBack = () => {},
    onDefer = () => {},
    onRestored = () => {},
  }: Props = $props();

  let fileInput = $state<HTMLInputElement>();
  let files = $state<BackupWorkflowFile[]>([]);
  let view = $state<"select" | "review">("select");
  let working = $state(false);
  let installingDependencies = $state(false);
  let dependencies = $state<ReturnType<typeof FirstRunDependencies>>();
  let mangaChoices = $state<Record<string, MangaRestoreChoices>>({});
  let cancellationRequested = $state(false);
  let detached = false;
  onDestroy(() => {
    detached = true;
    workflow.detach();
  });

  function cancelRestore() {
    workflow.requestCancel();
    cancellationRequested = true;
  }
  let restoreError = $state<unknown>(null);
  let restoreWarnings = $state<string[]>([]);
  let completedResult = $state<RestoredResult | null>(null);
  let summary = $derived(workflow.summarize(files));
  // Per-file counts double up what several backups share; the dependency list is what gets installed.
  let dependencyCounts = $state<{ repositories: number; extensions: number } | null>(null);
  let repositoryTotal = $derived(dependencyCounts?.repositories ?? summary.repositoryCount);
  let extensionTotal = $derived(dependencyCounts?.extensions ?? summary.extensionCount);
  // The same note from many titles is shown once, with how many it affected.
  let warningNotes = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const warning of restoreWarnings) {
      const note = restoreNote(warning, $_);
      counts.set(note, (counts.get(note) ?? 0) + 1);
    }
    return [...counts].map(([note, count]) => ({ note, count }));
  });
  let readyFiles = $derived(files.filter((file) => file.status === "ready"));
  let restoreProgress = $derived(
    readyFiles.length === 0
      ? 0
      : readyFiles.reduce((sum, file) => sum + file.restoreProgress, 0) / readyFiles.length,
  );

  async function addFiles(selected: readonly File[]) {
    if (selected.length === 0) return;
    working = true;
    restoreError = null;
    try {
      files = await workflow.inspectFiles(selected, files);
    } finally {
      working = false;
    }
  }

  async function chooseFiles() {
    if (picker) {
      await addFiles(await picker());
      return;
    }
    fileInput?.click();
  }

  async function onInputChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    await addFiles(Array.from(input.files ?? []));
    input.value = "";
  }

  function removeFile(key: string) {
    files = files.filter((file) => file.key !== key);
  }

  function reviewImport() {
    if (working || readyFiles.length === 0) return;
    restoreError = null;
    view = "review";
  }

  async function restoreAll() {
    if (working || readyFiles.length === 0) return;
    working = true;
    restoreError = null;
    try {
      installingDependencies = true;
      await dependencies?.installAll();
      installingDependencies = false;
      if (detached) return;
      await workflow.restoreFiles(files);
      if (detached) return;
      files = [...files];
      completedResult = {
        hasLibrary: summary.workCount > 0,
        needsSourceKinds: summary.needsSourceKinds,
        sourceTypes: summary.libraryKinds.filter((kind): kind is BackupSourceKind => kind === "manga" || kind === "novels"),
      };
      restoreWarnings = Object.values(workflow.warnings?.() ?? {}).flat();
      if (restoreWarnings.length === 0) onRestored(completedResult);
      else revealRestoreNotes();
    } catch (error) {
      files = [...files];
      restoreError = error;
    } finally {
      installingDependencies = false;
      working = false;
    }
  }

  let restoreNotes = $state<HTMLElement | null>(null);

  /* The notes sit under the review, below the fold on a short window; the heading already says the
     import is done, and the notes come into view above the footer. */
  async function revealRestoreNotes() {
    await tick();
    restoreNotes?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }

  function kindLabel(file: BackupWorkflowFile): string {
    if (file.kind === "manga") return "Mihon / Tachiyomi";
    if (file.kind === "novels-lnreader") return "LNReader";
    if (file.kind === "epigraph") return "Epigraph";
    return $_("firstRun.backup.unsupported");
  }

  function libraryKindsLabel(): string {
    const labels = summary.libraryKinds
      .filter((kind) => kind !== "app")
      .map((kind) => kind === "manga" ? $_("firstRun.backup.comics") : kind === "books" ? $_("firstRun.backup.books") : $_("firstRun.backup.novels"));
    return labels.length > 0 ? labels.join(", ") : $_("firstRun.backup.none");
  }
</script>

{#if view === "select"}
  <FirstRunTitle text={$_("firstRun.backup.selectTitle")} />
  <p class="fr-lede" data-enter>{$_("firstRun.backup.selectLede")}</p>
  <div class="upload-zone" data-enter data-spotlight>
    <span class="upload-icon"><Files size={30} aria-hidden="true" /></span>
    <strong>{$_("firstRun.backup.supportedApps")}</strong>
    <small>{$_("firstRun.backup.supportedFormats")}</small>
    <button class="fr-btn fr-btn--primary" type="button" disabled={working} onclick={chooseFiles}>
      <FolderOpen size={16} /> {$_("firstRun.backup.select")}
    </button>
    <input bind:this={fileInput} class="native-file-input" type="file" multiple accept=".epigraphbk,.aethonbk,.tachibk,.proto,.gz,.zip" onchange={onInputChange} />
  </div>

  <div class="backup-list" aria-live="polite">
    {#if files.length === 0}
      <div class="fr-empty">{$_("firstRun.backup.noFiles")}</div>
    {:else}
      {#each files as file (file.key)}
        <div class="fr-row backup-row" class:is-invalid={file.status === "invalid"} in:arrive>
          <span class="fr-mark">{#if file.status === "invalid"}<WarningCircle size={19} />{:else}<FileArchive size={19} />{/if}</span>
          <span class="fr-row-copy">
            <strong>{file.name}</strong>
            <small>{#if file.status === "inspecting"}<span class="inspecting" aria-label={$_("firstRun.backup.inspecting")}></span>{:else}{kindLabel(file)}{/if}</small>
            {#if file.error}<small class="file-error" role="alert">{operationError(file.error, "outcomes.invalidBackup", $_)}</small>{/if}
          </span>
          {#if file.status === "ready"}<span class="tag" in:arrive>{$_("firstRun.backup.titleCount", { count: file.workCount })}</span>{/if}
          <button class="fr-link fr-link--quiet fr-link--danger" type="button" aria-label={$_("firstRun.backup.remove", { name: file.name })} onclick={() => removeFile(file.key)}><Trash size={16} /></button>
        </div>
      {/each}
    {/if}
  </div>

  <div class="fr-footer">
    <button class="fr-btn" type="button" onclick={onBack}><ArrowLeft class="fr-arrow-back" size={16} /> {$_("firstRun.backup.back")}</button>
    <span class="fr-spacer"></span>
    <button class="fr-btn" type="button" onclick={onDefer}>{$_("firstRun.backup.doLater")}</button>
    <button class="fr-btn fr-btn--primary" type="button" disabled={working || readyFiles.length === 0} onclick={reviewImport}>
      {$_("firstRun.backup.reviewImport")} <ArrowRight class="fr-arrow-next" size={16} />
    </button>
  </div>
{:else}
  <div class="review" in:arrive>
  {#if completedResult}
    <FirstRunTitle text={$_("firstRun.backup.doneTitle")} />
    <p class="fr-lede">{$_("firstRun.backup.doneLede")}</p>
  {:else}
    <FirstRunTitle text={$_("firstRun.backup.reviewTitle")} />
    <p class="fr-lede">{$_("firstRun.backup.reviewLede")}</p>
  {/if}
  <div class="summary-strip">
    <div><strong aria-label={String(summary.workCount)} use:countUp={summary.workCount}></strong><span>{$_("firstRun.backup.titles")}</span></div>
    <div><strong aria-label={String(repositoryTotal)} use:countUp={repositoryTotal}></strong><span>{$_("firstRun.backup.repositories")}</span></div>
    <div><strong aria-label={String(extensionTotal)} use:countUp={extensionTotal}></strong><span>{$_("firstRun.backup.extensions")}</span></div>
    <div><strong aria-label={String(summary.conflictCount)} use:countUp={summary.conflictCount}></strong><span>{$_("firstRun.backup.conflicts")}</span></div>
  </div>

  <ul class="review-list">
    <li><CheckCircle size={20} /><strong>{$_("firstRun.backup.library")}</strong><span>{libraryKindsLabel()}</span></li>
    <li><Archive size={20} /><strong>{$_("firstRun.backup.dependencies")}</strong><span>{$_("firstRun.backup.dependencyCount", { repositories: repositoryTotal, extensions: extensionTotal })}</span></li>
    <li><GitMerge size={20} /><strong>{$_("firstRun.backup.merge")}</strong><span>{$_("firstRun.backup.overlapCount", { count: summary.conflictCount })}</span></li>
  </ul>

  {#if summary.conflictCount > 0}
    <details class="merge-decisions">
      <summary>{$_("firstRun.backup.mergeDecisions")}</summary>
      <div class="backup-list">
        {#each readyFiles.filter((file) => file.conflictCount > 0) as file (file.key)}
          <div class="fr-row backup-row"><span class="fr-mark"><GitMerge size={19} /></span><span class="fr-row-copy"><strong>{file.name}</strong><small>{$_("firstRun.backup.mergeRule", { count: file.conflictCount })}</small></span><span class="tag">{$_("firstRun.backup.reviewed")}</span></div>
        {/each}
      </div>
    </details>
  {/if}

  {#if readyFiles.some(file => file.libraryKinds.includes("manga") || file.libraryKinds.includes("novels"))}
    <FirstRunDependencies bind:this={dependencies} entries={readyFiles} choices={mangaChoices}
      disabled={working || completedResult !== null}
      onCounts={(counts) => { dependencyCounts = counts; }}
      onChoices={(key, choices) => {
        if (!workflow.setMangaChoices) throw Error("RESTORE_CHOICES_UNAVAILABLE");
        workflow.setMangaChoices(choices, key); mangaChoices[key] = choices;
      }} />
  {/if}

  {#if working || restoreProgress > 0}
    <div class="restore-progress" in:arrive>
      <div class="progress-copy"><span>{installingDependencies ? $_("firstRun.backup.installingDependencies") : restoreProgress >= 1 ? $_("firstRun.backup.restoreComplete") : $_("firstRun.backup.restoring")}</span><strong>{Math.round(restoreProgress * 100)}%</strong></div>
      <div class="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(restoreProgress * 100)} aria-label={$_("firstRun.backup.restoreProgress")}>
        <i class:is-done={restoreProgress >= 1} style:width={`${Math.round(restoreProgress * 100)}%`}></i>
      </div>
    </div>
  {/if}
  {#if restoreError}<div class="fr-error restore-error" role="alert"><WarningCircle size={18} /><span>{operationError(restoreError, "firstRun.backup.restoreError", $_)}</span></div>{/if}
  {#if restoreWarnings.length > 0}
    <div class="restore-progress restore-notes" role="status" bind:this={restoreNotes}><ul>{#each warningNotes as { note, count } (note)}<li>{note}{#if count > 1} <b class="note-count">({count})</b>{/if}</li>{/each}</ul></div>
  {/if}

  <div class="fr-footer">
    <button class="fr-btn" type="button" disabled={working || completedResult !== null} onclick={() => view = "select"}><ArrowLeft class="fr-arrow-back" size={16} /> {$_("firstRun.backup.back")}</button>
    <span class="fr-spacer"></span>
    {#if working}
      <button class="fr-btn" type="button" disabled={cancellationRequested} onclick={cancelRestore}>{$_("ui_cancel")}</button>
    {/if}
    {#if completedResult && restoreWarnings.length > 0}
      <button class="fr-btn fr-btn--primary" type="button" onclick={() => { if (completedResult) onRestored(completedResult); }}>{$_("firstRun.sources.continue")} <ArrowRight class="fr-arrow-next" size={16} /></button>
    {:else}
      <button class="fr-btn fr-btn--primary" type="button" disabled={working || readyFiles.length === 0} onclick={restoreAll}><ArrowClockwise size={16} /> {$_("firstRun.backup.restoreAll")}</button>
    {/if}
  </div>
  </div>
{/if}

<style>
  .upload-zone {
    --fr-spot-x: 50%;
    --fr-spot-y: 50%;
    position: relative;
    isolation: isolate;
    overflow: hidden;
    min-height: 190px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 22px;
    border-radius: 20px;
    color: var(--text-secondary);
    background: var(--fr-surface);
    text-align: center;
  }
  .upload-zone::before { content: ""; position: absolute; inset: 0; z-index: -1; background: radial-gradient(300px circle at var(--fr-spot-x) var(--fr-spot-y), color-mix(in srgb, var(--accent) 12%, transparent), transparent 65%); opacity: 0; transition: opacity .35s; }
  .upload-zone:hover::before { opacity: 1; }
  .upload-icon { color: var(--accent-fg); animation: backup-bob 3.2s ease-in-out infinite; }
  .upload-zone strong { color: var(--text-primary); font-size: 14px; }
  .upload-zone small { margin-bottom: 8px; color: var(--text-muted); font-size: 12px; }
  .native-file-input { display: none; }
  .backup-list { display: grid; gap: 2px; margin-top: 12px; }
  .backup-row.is-invalid .fr-mark { color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
  .inspecting { display: inline-block; width: 110px; height: 10px; border-radius: 5px; vertical-align: middle; background: linear-gradient(90deg, var(--fr-surface-strong) 25%, color-mix(in srgb, var(--text-primary) 14%, transparent) 50%, var(--fr-surface-strong) 75%); background-size: 300% 100%; animation: fr-shimmer 1.2s linear infinite; }
  .file-error { color: var(--color-danger) !important; }
  .tag { padding: 4px 9px; border-radius: 8px; color: var(--text-secondary); background: var(--fr-surface-strong); font-size: var(--text-xs); font-weight: 700; }
  .review { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .summary-strip > div { display: grid; gap: 4px; padding: 16px; border-radius: 16px; background: var(--fr-surface); }
  .summary-strip strong { color: var(--text-primary); font-size: 26px; font-weight: 800; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
  .summary-strip span { color: var(--text-muted); font-size: 12px; }
  .review-list { list-style: none; display: grid; margin: 16px 0 0; padding: 0; }
  .review-list li { min-height: 44px; display: grid; grid-template-columns: 24px 150px 1fr; align-items: center; gap: 10px; padding: 0 8px; color: var(--color-success); }
  .review-list strong { color: var(--text-primary); font-size: var(--text-base); }
  .review-list span { color: var(--text-muted); font-size: var(--text-base); }
  .merge-decisions { margin-top: 12px; color: var(--text-secondary); font-size: var(--text-base); }
  .merge-decisions summary { padding: 4px 8px; color: var(--accent-fg); font-weight: 700; cursor: pointer; }
  .restore-progress { margin-top: 16px; padding: 14px; border-radius: 14px; background: var(--fr-surface); }
  .progress-copy { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 9px; color: var(--text-secondary); font-size: 12.5px; }
  .progress-copy strong { font-variant-numeric: tabular-nums; }
  .progress-track { height: 6px; overflow: hidden; border-radius: 999px; background: var(--fr-surface-strong); }
  .progress-track i { position: relative; display: block; height: 100%; overflow: hidden; border-radius: inherit; background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 60%, var(--color-success)), var(--color-success)); transition: width .5s var(--fr-out); }
  .progress-track i::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--text-primary) 40%, transparent), transparent); animation: backup-sheen 1.4s linear infinite; }
  .progress-track i.is-done::after { animation: none; opacity: 0; }
  .restore-error { margin: 14px 0 0; }
  /* Room for the sticky footer, so the last note is not hidden under it once scrolled into view. */
  .restore-notes { scroll-margin-bottom: 96px; }
  .restore-progress ul { margin: 0; padding-left: 18px; color: var(--text-secondary); font-size: 12.5px; }
  .note-count { color: var(--text-muted); font-weight: 600; font-variant-numeric: tabular-nums; }
  @keyframes backup-bob { 50% { transform: translateY(-5px); } }
  @keyframes backup-sheen { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  @media (max-width: 680px) {
    .summary-strip { grid-template-columns: repeat(2, 1fr); }
    .review-list li { grid-template-columns: 24px 100px 1fr; }
    .fr-footer { flex-wrap: wrap; }
  }
</style>
