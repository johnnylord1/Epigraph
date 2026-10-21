<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    ArrowLeft,
    ArrowRight,
    Books,
    Check,
    CloudArrowDown,
    Compass,
    Desktop,
    FolderOpen,
    Link,
    PaintBrush,
    Palette,
    PuzzlePiece,
    Stack,
  } from "phosphor-svelte";
  import { resolveAppLocale } from "../../lib/i18n/languages";
  import { _ } from "../../lib/i18n/runtime";
  import { BUILTIN_THEMES, BUILTIN_THEME_CONTRACTS } from "../../lib/theme/contract";
  import { builtinThemeLabel } from "../../lib/theme/themeLabels";
  import { loadNovelLibraryState } from "../../lib/novels/libraryState";
  import { countUp, depart, revealThemeChange, staggerIn } from "../../lib/motion/firstRunMotion";
  import {
    completeFirstRunState,
    canAdvanceFirstRun,
    createFirstRunState,
    FIRST_RUN_STORAGE_KEY,
    normalizeFirstRunState,
    updateFirstRunState,
    type FirstRunPath,
    type FirstRunBackupReadiness,
    type FirstRunReadiness,
    type FirstRunState,
    type FirstRunStep,
  } from "../../lib/firstRun";
  import {
    setLibrarySection,
    setNavPage,
    setSettingsOpen,
    store,
    updateSettings,
  } from "../../store/state.svelte";
  import FirstRunShell from "./FirstRunShell.svelte";
  import FirstRunTitle from "./FirstRunTitle.svelte";
  import FirstRunBackupStep from "./FirstRunBackupStep.svelte";
  import FirstRunSourcesStep from "./FirstRunSourcesStep.svelte";
  import FirstRunSyncStep from "./FirstRunSyncStep.svelte";
  import FirstRunTrackersStep from "./FirstRunTrackersStep.svelte";
  import FirstRunDiscoverStep from "./FirstRunDiscoverStep.svelte";
  import { createProductionFirstRunBackupWorkflow } from "../../lib/backup/firstRunBackupWorkflow";
  import { createProductionFirstRunSourcesWorkflow } from "../../lib/setup/firstRunSourcesWorkflow";
  import { createProductionFirstRunTrackerWorkflow } from "../../lib/tracking/firstRunTrackerWorkflow";

  interface Props {
    onComplete?: () => void;
    initialState?: FirstRunState;
    /** The launch check could not reach the server, so the app may already hold data. */
    serverUnavailable?: boolean;
    /** The app turned out to hold data while setup was open: it can be left. */
    skippable?: boolean;
  }
  let { onComplete = () => {}, initialState, serverUnavailable = false, skippable = false }: Props = $props();

  type ContentType = "manga" | "novels";

  const ENTRY_CHOICES: readonly { path: FirstRunPath; step: FirstRunStep; key: string; icon: typeof Desktop }[] = [
    { path: "sync", step: "sync", key: "sync", icon: Desktop },
    { path: "backup", step: "backup", key: "backup", icon: CloudArrowDown },
    { path: "fresh", step: "sources", key: "fresh", icon: Stack },
  ];

  const STEP_ORDER: readonly FirstRunStep[] = ["theme", "entry", "sync", "backup", "sources", "trackers", "discover", "complete"];

  let stepRoot = $state<HTMLDivElement>();
  let syncReady = $state(false);
  let backupReady = $state(false);
  let mangaSourcesReady = $state(false);
  let novelSourcesReady = $state(false);
  let novelLibraryCount = $state(0);
  let hasNovelLibraryContent = $derived(novelLibraryCount > 0);
  let novelLibraryCheck = $state<"loading" | "ready" | "error">("loading");
  let novelLibraryRetry = $state(0);
  let firstRun = $state(untrack(() => initialState ?? loadFirstRun()));
  let contentType = $state<ContentType>(untrack(() => firstRun.sourceContentType ?? "manga"));
  let backupWorkflow = $state<ReturnType<typeof createProductionFirstRunBackupWorkflow> | null>(null);
  let direction = $state(1);
  let summary = $state({ extensions: 0, trackers: [] as string[] });
  const sourcesWorkflow = createProductionFirstRunSourcesWorkflow();
  const trackersWorkflow = createProductionFirstRunTrackerWorkflow();
  let discoveryScopeKey = $derived(JSON.stringify([store.runtimeResolvedLocalProfileId, store.runtimeServerUrl]));

  $effect(() => {
    if (firstRun.step === "backup" && !firstRun.backupRestored && !backupWorkflow
      && store.runtimeResolvedLocalProfileId && store.runtimeServerUrl) {
      // Freeze the resolved target only when entering restore. Keep this operation
      // afterward so navigation cannot discard completed or uncertain work.
      backupWorkflow = untrack(() => createProductionFirstRunBackupWorkflow());
    }
  });

  const shouldUseInitialLightTheme = untrack(() => {
    if (initialState || typeof localStorage === "undefined") return false;
    try { return localStorage.getItem(FIRST_RUN_STORAGE_KEY) === null; } catch { return false; }
  });
  if (shouldUseInitialLightTheme) {
    updateSettings({ theme: "light" });
    persistFirstRun();
  }

  function loadFirstRun(): FirstRunState {
    try {
      const value = JSON.parse(localStorage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null");
      return value ? normalizeFirstRunState({ firstRun: value }) : createFirstRunState();
    } catch {
      return createFirstRunState();
    }
  }

  function persistFirstRun() {
    try { localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(firstRun)); } catch {}
  }

  function setFirstRunStep(step: FirstRunStep) {
    direction = STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(firstRun.step) ? 1 : -1;
    firstRun = updateFirstRunState(firstRun, { step });
    persistFirstRun();
  }

  function setFirstRunPath(path: FirstRunPath, step: FirstRunStep) {
    syncReady = false;
    backupReady = false;
    direction = 1;
    firstRun = updateFirstRunState(firstRun, { path, step, backupRestored: undefined, backupNeedsSources: undefined, backupSourceTypes: undefined });
    persistFirstRun();
  }

  const progress = [
    { label: "appearance", icon: PaintBrush, steps: ["theme"] },
    { label: "data", icon: FolderOpen, steps: ["entry"] },
    { label: "setup", icon: Stack, steps: ["sync", "backup", "sources"] },
    { label: "trackers", icon: Link, steps: ["trackers"] },
    { label: "library", icon: Compass, steps: ["discover", "complete"] },
  ] as const;

  let activeProgressIndex = $derived(progress.findIndex((item) => (item.steps as readonly string[]).includes(firstRun.step)));
  let libraryCount = $derived(store.libraryMangaSnapshot.length + store.books.length + novelLibraryCount);
  let hasLibraryContent = $derived(libraryCount > 0);
  $effect(() => {
    novelLibraryRetry;
    store.contentSetupVersion;
    firstRun.backupRestored;
    firstRun.step;
    const scope = {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    };
    let cancelled = false;
    novelLibraryCheck = "loading";
    void loadNovelLibraryState(scope).then((state) => {
      if (!cancelled) {
        novelLibraryCount = state.entries.length;
        novelLibraryCheck = "ready";
      }
    }).catch((error) => {
      if (!cancelled) {
        novelLibraryCount = 0;
        novelLibraryCheck = "error";
        console.warn("First-run library readiness could not be loaded.", error);
      }
    });
    return () => { cancelled = true; };
  });
  let readiness = $derived<FirstRunReadiness>({
    syncConnected: syncReady,
    backupRestored: backupReady,
    sourcesConfigured: firstRun.path === "backup"
      ? (firstRun.backupSourceTypes?.length ? firstRun.backupSourceTypes : [firstRun.sourceContentType ?? "manga"])
        .every((type) => type === "novels" ? novelSourcesReady : mangaSourcesReady)
      : mangaSourcesReady || novelSourcesReady,
    hasLibraryContent,
  });
  let canAdvance = $derived(canAdvanceFirstRun(firstRun, readiness)
    && (firstRun.step !== "complete" || novelLibraryCheck === "ready"));

  $effect(() => {
    const step = firstRun.step;
    backupWorkflow;
    void tick().then(() => {
      if (firstRun.step === step) stepRoot?.querySelector<HTMLHeadingElement>("h1")?.focus();
    });
  });

  /* The final page summarizes what this setup produced. Workflows the path skipped are loaded here. */
  $effect(() => {
    if (firstRun.step !== "complete") return;
    let cancelled = false;
    const countInstalled = () => sourcesWorkflow.repositories
      .reduce((total, repository) => total + repository.extensions.filter((extension) => extension.installed).length, 0);
    const connectedTrackers = () => trackersWorkflow.providers.filter((provider) => provider.connected).map((provider) => provider.name);
    summary = { extensions: countInstalled(), trackers: connectedTrackers() };
    void Promise.allSettled([
      sourcesWorkflow.repositories.length ? Promise.resolve() : sourcesWorkflow.hydrate(),
      trackersWorkflow.providers.length ? Promise.resolve() : trackersWorkflow.load(),
    ]).then(() => {
      if (!cancelled) summary = { extensions: countInstalled(), trackers: connectedTrackers() };
    });
    return () => { cancelled = true; };
  });

  function goBack() {
    const step = firstRun.step;
    if (step === "entry") return setFirstRunStep("theme");
    if (["sync", "backup"].includes(step)) return setFirstRunStep("entry");
    if (step === "sources") return setFirstRunStep(firstRun.path === "backup" ? "backup" : "entry");
    if (step === "trackers") {
      if (firstRun.path === "sync") return setFirstRunStep("sync");
      if (firstRun.path === "backup") return setFirstRunStep(firstRun.backupNeedsSources === false ? "backup" : "sources");
      return setFirstRunStep("sources");
    }
    if (step === "discover") return setFirstRunStep("trackers");
    if (step === "complete") return setFirstRunStep(hasLibraryContent ? "trackers" : "discover");
  }

  function finishTrackers() {
    setFirstRunStep(hasLibraryContent ? "complete" : "discover");
  }

  function updateBackupReadiness(next: FirstRunBackupReadiness) {
    backupReady = next.ready;
    if (next.ready) {
      contentType = next.contentType;
      firstRun = updateFirstRunState(firstRun, {
        backupRestored: true,
        backupNeedsSources: next.requiresSources !== false,
        backupSourceTypes: next.sourceTypes?.length ? next.sourceTypes : [next.contentType],
        sourceContentType: next.contentType,
      });
      persistFirstRun();
    } else if (next.hasSelection && firstRun.backupRestored) {
      firstRun = updateFirstRunState(firstRun, { backupRestored: undefined, backupNeedsSources: undefined, backupSourceTypes: undefined });
      persistFirstRun();
    }
  }

  async function handleBackupRestored(next: { hasLibrary: boolean; needsSourceKinds: ContentType[]; sourceTypes: ContentType[] }) {
    const sourceTypes: ContentType[] = next.sourceTypes.length > 0 ? next.sourceTypes : ["manga"];
    // The restore installs the backup's own repositories and extensions; the kinds it needed are
    // measured before that, so only the ones still without an installed extension are asked for.
    let missing = next.needsSourceKinds;
    if (missing.length > 0) {
      try {
        await sourcesWorkflow.hydrate();
        missing = missing.filter((kind) => !sourcesWorkflow.isReady(kind));
      } catch {}
    }
    updateBackupReadiness({
      ready: true,
      hasSelection: true,
      contentType: sourceTypes[0],
      requiresSources: missing.length > 0,
      sourceTypes,
    });
    setFirstRunStep(missing.length > 0 ? "sources" : "trackers");
  }

  /** Leaves a setup started from Settings: the app stays as it was and Settings opens again. */
  function cancelSetup() {
    firstRun = completeFirstRunState(firstRun);
    persistFirstRun();
    setSettingsOpen(true);
    onComplete();
  }

  /** Leaves setup when the server did not answer, or the app holds data: the app opens as it is. */
  function skipSetup() {
    firstRun = completeFirstRunState(firstRun);
    persistFirstRun();
    onComplete();
  }

  function advance(step: FirstRunStep) {
    if (!canAdvance) return;
    setFirstRunStep(step);
  }

  function chooseTheme(themeId: string, event: MouseEvent) {
    if (store.settings.theme === themeId) return;
    const origin = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined;
    revealThemeChange(async () => {
      updateSettings({ theme: themeId });
      await tick();
    }, origin);
  }

  function currentThemeLabel(): string {
    const builtin = BUILTIN_THEMES.find((theme) => theme.id === store.settings.theme);
    if (builtin) return builtinThemeLabel(builtin, $_);
    return (store.settings.customThemes ?? []).find((theme) => theme.id === store.settings.theme)?.name ?? "Nocturne";
  }

  function finish() {
    if (!canAdvance) return;
    firstRun = completeFirstRunState(firstRun);
    persistFirstRun();
    if (store.libraryMangaSnapshot.length === 0) {
      setLibrarySection("books");
    } else if (store.books.length === 0 && !hasNovelLibraryContent) {
      setLibrarySection("comics");
    }
    // Setup lands where every launch does: Home, or the library when the user asked to start there.
    setNavPage(store.settings.launchIntoLibrary ? "library" : "home");
    onComplete();
  }

</script>

<FirstRunShell
  progress={progress.map((item) => ({ label: $_(`firstRun.shell.${item.label}`), icon: item.icon }))}
  {activeProgressIndex}
  complete={firstRun.step === "complete"}
  subtitle={$_("firstRun.shell.initialSetup")}
  progressLabel={$_("firstRun.shell.setupProgress")}
  cancel={firstRun.cancellable
    ? { label: $_("firstRun.shell.cancel"), onCancel: cancelSetup }
    : serverUnavailable || skippable ? { label: $_("firstRun.shell.skip"), onCancel: skipSetup } : undefined}
  notice={serverUnavailable && !firstRun.cancellable ? $_("firstRun.shell.serverUnavailable") : undefined}
>
  {#key firstRun.step}
  <article class="first-run-page" data-page={firstRun.step} out:depart={{ direction }}>
    <div class="first-run-page-inner" bind:this={stepRoot} use:staggerIn={{ direction }} class:is-complete={firstRun.step === "complete"}>
      {#if firstRun.step === "theme"}
        <FirstRunTitle text={$_("firstRun.shell.themeTitle")} />
        <p class="fr-lede" data-enter>{$_("firstRun.shell.themeLede")}</p>
        <div class="theme-grid">
          {#each BUILTIN_THEMES as theme}
            {@const tokens = BUILTIN_THEME_CONTRACTS[theme.id].tokens}
            <button
              type="button"
              class="theme-option fr-card"
              data-enter
              data-tilt
              aria-pressed={store.settings.theme === theme.id}
              onclick={(event) => chooseTheme(theme.id, event)}
            >
              <span class="theme-ring" aria-hidden="true"></span>
              <span class="theme-swatches" aria-hidden="true">
                <i class="swatch-base" style:background={tokens["bg-base"]}></i>
                <i class="swatch-side" style:background={tokens["bg-raised"]}></i>
                <i class="swatch-accent" style:background={tokens.accent}></i>
                <i class="swatch-text" style:background={tokens["text-primary"]}></i>
                <i class="swatch-cover" style:background={tokens["bg-raised"]}></i>
                <i class="swatch-cover second" style:background={tokens["bg-raised"]}></i>
              </span>
              <span class="theme-name">{builtinThemeLabel(theme, $_)}<span class="theme-tick" aria-hidden="true"><Check size={15} weight="bold" /></span></span>
            </button>
          {/each}
        </div>
        <div class="fr-footer"><span class="fr-spacer"></span><button class="fr-btn fr-btn--primary" type="button" onclick={() => setFirstRunStep("entry")}>{$_("firstRun.shell.continue")}<ArrowRight class="fr-arrow-next" size={16} /></button></div>

      {:else if firstRun.step === "entry"}
        <FirstRunTitle text={$_("firstRun.shell.entryTitle")} />
        <p class="fr-lede" data-enter>{$_("firstRun.shell.entryLede")}</p>
        <div class="entry-list first-run-choice-list">
          {#each ENTRY_CHOICES as choice (choice.path)}
            <button type="button" class="entry-card fr-card" data-enter data-spotlight aria-labelledby={`first-run-entry-${choice.key}`} aria-describedby={`first-run-entry-${choice.key}-hint`} onclick={() => setFirstRunPath(choice.path, choice.step)}>
              <span class="entry-icon"><choice.icon size={22} /></span>
              <strong id={`first-run-entry-${choice.key}`}>{$_(`firstRun.shell.${choice.key}`)}<ArrowRight size={15} /></strong>
              <small id={`first-run-entry-${choice.key}-hint`}>{$_(`firstRun.shell.${choice.key}Hint`)}</small>
            </button>
          {/each}
        </div>
        <div class="fr-footer"><button class="fr-btn" type="button" onclick={goBack}><ArrowLeft class="fr-arrow-back" size={16} />{$_("firstRun.shell.back")}</button></div>

      {:else if firstRun.step === "sync"}
        <FirstRunSyncStep
          profileId={store.runtimeResolvedLocalProfileId ?? store.settings.defaultLocalProfileId}
          onReadyChange={(ready) => (syncReady = ready)}
          onBack={goBack}
          onContinue={() => advance("trackers")}
        />

      {:else if firstRun.path === "backup" && (firstRun.step === "backup" || firstRun.step === "sources")}
        {#if firstRun.step === "backup"}
          {#if firstRun.backupRestored}
            <FirstRunTitle text={$_("ui_backupRestored")} />
            <p class="setup-status" data-enter><Check size={16} />{$_("ui_backupRestored")}</p>
            <div class="fr-footer">
              <button class="fr-btn" type="button" onclick={goBack}><ArrowLeft class="fr-arrow-back" size={16} />{$_("firstRun.shell.back")}</button>
              <span class="fr-spacer"></span>
              <button class="fr-btn fr-btn--primary" type="button" onclick={() => setFirstRunStep(firstRun.backupNeedsSources === false ? "trackers" : "sources")}>{$_("firstRun.shell.continue")}<ArrowRight class="fr-arrow-next" size={16} /></button>
            </div>
          {:else if backupWorkflow}
            <FirstRunBackupStep
              workflow={backupWorkflow}
              onBack={goBack}
              onDefer={() => setFirstRunPath("fresh", "sources")}
              onRestored={handleBackupRestored}
            />
          {:else}
            <FirstRunTitle text={$_("firstRun.backup.selectTitle")} />
            <span class="loading-dot" role="status" aria-label={$_("ui_loading")}></span>
            <div class="fr-footer"><button class="fr-btn" type="button" onclick={goBack}><ArrowLeft class="fr-arrow-back" size={16} />{$_("firstRun.shell.back")}</button></div>
          {/if}
        {:else}
          <FirstRunSourcesStep
            workflow={sourcesWorkflow}
            requiredKinds={firstRun.backupSourceTypes?.length ? firstRun.backupSourceTypes : [contentType]}
            onBack={goBack}
            onContinue={() => setFirstRunStep("trackers")}
          />
        {/if}

      {:else if firstRun.step === "sources"}
        <FirstRunSourcesStep
          workflow={sourcesWorkflow}
          requiredKinds={[]}
          onBack={goBack}
          onContinue={() => setFirstRunStep("trackers")}
        />

      {:else if firstRun.step === "trackers"}
        <FirstRunTrackersStep workflow={trackersWorkflow} onBack={goBack} onContinue={finishTrackers} />

      {:else if firstRun.step === "discover"}
        {#key discoveryScopeKey}
        <FirstRunDiscoverStep
          initialHasLibrary={hasLibraryContent}
          onBack={goBack}
          onContinue={() => advance("complete")}
        />
        {/key}

      {:else}
        <div class="complete">
          <div class="complete-seal" data-enter aria-hidden="true">
            <span class="complete-halo"></span><span class="complete-halo second"></span>
            <svg viewBox="0 0 76 76"><circle class="complete-ring" cx="38" cy="38" r="34" /><path class="complete-check" d="M24 39l9.5 9.5L53 29" /></svg>
          </div>
          <FirstRunTitle text={$_("firstRun.shell.completeTitle")} />
          <p class="fr-lede complete-lede" data-enter>{$_("firstRun.shell.completeLede")}</p>
          <dl class="complete-summary">
            <div class="complete-item" data-enter>
              <span class="complete-icon"><Palette size={18} /></span>
              <dt>{$_("firstRun.complete.theme")}</dt><dd>{currentThemeLabel()}</dd>
            </div>
            <div class="complete-item" data-enter>
              <span class="complete-icon"><PuzzlePiece size={18} /></span>
              <dt>{$_("firstRun.complete.sources")}</dt>
              <dd>{summary.extensions === 1 ? $_("firstRun.complete.extensionOne") : $_("firstRun.complete.extensions", { count: summary.extensions })}</dd>
            </div>
            <div class="complete-item" data-enter>
              <span class="complete-icon"><Link size={18} /></span>
              <dt>{$_("firstRun.complete.trackers")}</dt>
              <dd>{summary.trackers.length ? summary.trackers.join(", ") : $_("firstRun.complete.trackersNone")}</dd>
            </div>
            <div class="complete-item" data-enter>
              <span class="complete-icon"><Books size={18} /></span>
              <dt>{$_("firstRun.complete.library")}</dt>
              <dd><span use:countUp={libraryCount}></span> {libraryCount === 1 ? $_("firstRun.complete.titleOne") : $_("firstRun.complete.titles")}</dd>
            </div>
          </dl>
          {#if novelLibraryCheck === "error"}
            <div class="fr-error" role="alert" data-enter>
              <span>{$_("shell.pageState.failedTitle")}</span>
              <button class="fr-link" type="button" onclick={() => { novelLibraryRetry += 1; }}>{$_("shell.pageState.retry")}</button>
            </div>
          {/if}
          <div class="complete-actions" data-enter>
            <button class="fr-btn" type="button" onclick={goBack}><ArrowLeft class="fr-arrow-back" size={16} />{$_("firstRun.shell.back")}</button>
            <button class="fr-btn fr-btn--primary fr-btn--large complete-action" type="button" disabled={!canAdvance} aria-busy={novelLibraryCheck === "loading"} onclick={finish}>{$_(store.settings.launchIntoLibrary ? "firstRun.shell.openLibrary" : "firstRun.shell.openHome")}<ArrowRight class="fr-arrow-next" size={16} /></button>
          </div>
        </div>
      {/if}
    </div>
  </article>
  {/key}
</FirstRunShell>

<style>
  .first-run-page {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 20px 0 24px var(--first-run-gutter);
  }
  .first-run-page-inner {
    /* Match the shell's grid, even when WebView2 reserves scrollbar width.
       The scrollbar consumes the outer gutter, not the content column. */
    width: calc(100cqw - 2 * var(--first-run-gutter));
    display: flex;
    flex-direction: column;
    min-height: 100%;
    margin: 0;
  }
  .first-run-page-inner :global(h1) { max-width: 680px; margin: 0; font-size: clamp(28px, 2.5vw, 34px); line-height: 1.1; letter-spacing: -0.035em; font-weight: 780; outline: none; text-wrap: balance; }

  .theme-grid { display: grid; grid-template-columns: repeat(4, minmax(112px, 1fr)); gap: 14px; perspective: 900px; }
  .theme-option {
    --fr-tilt-x: 0deg;
    --fr-tilt-y: 0deg;
    --fr-glare-x: 50%;
    --fr-glare-y: 50%;
    position: relative;
    width: 100%;
    min-width: 0;
    padding: 8px;
    border: 0;
    border-radius: 16px;
    display: grid;
    gap: 2px;
    color: var(--text-secondary);
    background: transparent;
    font: inherit;
    font-size: var(--text-md);
    font-weight: 650;
    text-align: left;
    cursor: pointer;
    transform: rotateX(var(--fr-tilt-x)) rotateY(var(--fr-tilt-y));
    transition: transform .6s var(--fr-spring), background .3s, color .3s;
  }
  .theme-option:hover { background: var(--fr-surface); }
  .theme-option[aria-pressed="true"] { color: var(--text-primary); }
  .theme-option:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .theme-ring { position: absolute; inset: 0; border-radius: 16px; box-shadow: inset 0 0 0 1.5px var(--accent); opacity: 0; transform: scale(.96); transition: opacity .35s, transform .6s var(--fr-spring); pointer-events: none; }
  .theme-option[aria-pressed="true"] .theme-ring { opacity: 1; transform: none; }
  /* A miniature of the app in the theme's own colors: canvas, sidebar, a title line and covers. */
  .theme-swatches { position: relative; height: clamp(58px, 11.5vh, 92px); overflow: hidden; border-radius: 11px; box-shadow: 0 12px 26px -14px var(--fr-shadow); transition: box-shadow .4s; }
  .theme-option:hover .theme-swatches { box-shadow: 0 22px 36px -16px var(--fr-shadow); }
  .theme-swatches::after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at var(--fr-glare-x) var(--fr-glare-y), color-mix(in srgb, var(--text-primary) 18%, transparent), transparent 55%); opacity: 0; mix-blend-mode: soft-light; transition: opacity .3s; }
  .theme-option:hover .theme-swatches::after { opacity: 1; }
  .theme-swatches i { position: absolute; display: block; }
  .swatch-base { inset: 0; }
  .swatch-side { left: 0; top: 0; bottom: 0; width: 16px; }
  .swatch-text { left: 26px; top: 12px; width: 44%; height: 6px; border-radius: 3px; opacity: .85; }
  .swatch-accent, .swatch-cover { top: 28px; bottom: 12px; width: calc((100% - 50px) / 3); border-radius: 5px; }
  .swatch-accent { left: 26px; }
  .swatch-cover { left: calc(26px + (100% - 50px) / 3 + 4px); }
  .swatch-cover.second { left: calc(26px + 2 * (100% - 50px) / 3 + 8px); }
  .theme-name { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 4px 2px; }
  .theme-tick { display: flex; color: var(--accent-fg); opacity: 0; transform: scale(.2) rotate(-40deg); transition: opacity .2s, transform .55s var(--fr-bounce); }
  .theme-option[aria-pressed="true"] .theme-tick { opacity: 1; transform: none; }

  .entry-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .entry-card {
    --fr-spot-x: 50%;
    --fr-spot-y: 50%;
    position: relative;
    isolation: isolate;
    overflow: hidden;
    padding: 20px;
    border: 0;
    border-radius: 18px;
    display: grid;
    align-content: start;
    gap: 6px;
    color: var(--text-primary);
    background: var(--fr-surface);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: transform .6s var(--fr-spring), background .3s;
  }
  .entry-card::before { content: ""; position: absolute; inset: 0; z-index: -1; background: radial-gradient(260px circle at var(--fr-spot-x) var(--fr-spot-y), color-mix(in srgb, var(--accent) 14%, transparent), transparent 65%); opacity: 0; transition: opacity .35s; }
  .entry-card:hover { transform: translateY(-5px); }
  .entry-card:hover::before { opacity: 1; }
  .entry-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .entry-icon { width: 44px; height: 44px; margin-bottom: 12px; display: grid; place-items: center; border-radius: 14px; color: var(--accent-fg); background: var(--accent-muted); transition: transform .7s var(--fr-bounce); }
  .entry-card:hover .entry-icon { transform: translateY(-3px) rotate(-6deg) scale(1.06); }
  .entry-card strong { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; }
  .entry-card strong :global(svg) { color: var(--text-muted); transition: transform .5s var(--fr-bounce), color .3s; }
  .entry-card:hover strong :global(svg) { transform: translateX(4px); color: var(--accent-fg); }
  .entry-card small { color: var(--text-muted); font-size: 12.5px; line-height: 1.55; }

  .loading-dot { position: absolute; inset: 50% auto auto 50%; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pulse 900ms ease-in-out infinite alternate; }
  .setup-status { display: flex; align-items: center; gap: 8px; margin: 12px 0 20px; color: var(--color-success); font-size: var(--text-base); }

  /* Final page: one centered composition instead of two floating columns. */
  .complete { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; padding: 12px 0; text-align: center; }
  .complete :global(h1) { max-width: none; }
  .complete-lede { margin: 10px auto 26px; }
  .complete-seal { position: relative; width: 76px; height: 76px; margin-bottom: 22px; }
  .complete-seal svg { position: relative; width: 76px; height: 76px; overflow: visible; }
  .complete-ring { fill: color-mix(in srgb, var(--color-success) 12%, transparent); stroke: var(--color-success); stroke-width: 2.5; stroke-dasharray: 214; stroke-dashoffset: 214; transform: rotate(-90deg); transform-origin: 38px 38px; animation: complete-draw .9s .25s cubic-bezier(.65, 0, .35, 1) forwards; }
  .complete-check { fill: none; stroke: var(--color-success); stroke-width: 3.6; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 44; stroke-dashoffset: 44; animation: complete-draw .52s 1s var(--fr-out) forwards; }
  .complete-halo { position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--color-success); opacity: 0; animation: complete-halo 1.4s 1.1s var(--fr-out) 2; }
  .complete-halo.second { animation-delay: 1.45s; }
  .complete-summary { width: min(560px, 100%); margin: 0 0 26px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .complete-item { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 12px; row-gap: 2px; align-items: center; padding: 14px 16px; border-radius: 16px; background: var(--fr-surface); text-align: left; }
  .complete-icon { grid-row: 1 / 3; width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; color: var(--accent-fg); background: var(--accent-muted); }
  .complete-item dt { color: var(--text-muted); font-size: 12px; font-weight: 600; }
  .complete-item dd { min-width: 0; margin: 0; overflow: hidden; color: var(--text-primary); font-size: 14px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .complete-actions { display: flex; align-items: center; justify-content: center; gap: 10px; }
  @keyframes complete-draw { to { stroke-dashoffset: 0; } }
  @keyframes complete-halo { from { transform: scale(1); opacity: .6; } to { transform: scale(2.4); opacity: 0; } }
  @keyframes pulse { to { opacity: .25; transform: scale(.7); } }

  @media (max-width: 700px) {
    .theme-grid { grid-template-columns: repeat(2, minmax(112px, 1fr)); }
    .entry-list { grid-template-columns: 1fr; }
  }
  @media (max-width: 520px) {
    .complete-summary { grid-template-columns: 1fr; }
  }
  /* Reduced motion follows the app setting, then the system (motion.ts). */
  :global(html[data-epigraph-reduced-motion="true"]) .loading-dot { animation: none; }
  :global(html[data-epigraph-reduced-motion="true"]) .complete-ring,
  :global(html[data-epigraph-reduced-motion="true"]) .complete-check { animation: none; stroke-dashoffset: 0; }
  :global(html[data-epigraph-reduced-motion="true"]) .complete-halo { animation: none; }
</style>
