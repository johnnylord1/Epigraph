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
    FileArchive,
    FolderOpen,
    Laptop,
    Link,
    PaintBrush,
    Palette,
    Plus,
    PuzzlePiece,
    Stack,
  } from "phosphor-svelte";
  import { resolveAppLocale } from "../../lib/i18n/languages";
  import { _ } from "../../lib/i18n/runtime";
  import { BUILTIN_THEMES, BUILTIN_THEME_CONTRACTS } from "../../lib/theme/contract";
  import { builtinThemeLabel } from "../../lib/theme/themeLabels";
  import { loadNovelLibraryState } from "../../lib/novels/libraryState";
  import { countComicLibrary } from "../../lib/setup/firstRunSyncReadiness";
  import { mirrorFirstRunMarker } from "../../lib/firstRunDurable";
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
  /* Read live from the server: a library that arrived through sync is not in the store snapshot yet. */
  let comicLibraryCount = $state<number | null>(null);
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
    void mirrorFirstRunMarker({ profileId: store.runtimeResolvedLocalProfileId, serverUrl: store.runtimeServerUrl });
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
  let comicCount = $derived(comicLibraryCount ?? store.libraryMangaSnapshot.length);
  let libraryCount = $derived(comicCount + store.books.length + novelLibraryCount);
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
    void countComicLibrary()
      .then((count) => { if (!cancelled && count !== null) comicLibraryCount = count; })
      .catch(() => {});
    return () => { cancelled = true; };
  });
  let readiness = $derived<FirstRunReadiness>({
    syncConnected: syncReady,
    backupRestored: backupReady,
    sourcesConfigured: firstRun.path === "backup"
      ? (firstRun.backupSourceTypes?.length ? firstRun.backupSourceTypes : [firstRun.sourceContentType ?? "manga"])
        .every((type) => type === "novels" ? novelSourcesReady : mangaSourcesReady)
      : mangaSourcesReady || novelSourcesReady,
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
    if (comicCount === 0) {
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
              <span
                class="theme-swatches"
                aria-hidden="true"
                style:--m-base={tokens["bg-base"]}
                style:--m-raised={tokens["bg-raised"]}
                style:--m-overlay={tokens["bg-overlay"]}
                style:--m-accent={tokens.accent}
                style:--m-text={tokens["text-primary"]}
                style:--m-muted={tokens["text-muted"]}
              >
                <i class="swatch-side"><b class="swatch-logo"></b><b class="swatch-nav is-on"></b><b class="swatch-nav"></b><b class="swatch-nav"></b></i>
                <span class="swatch-main">
                  <span class="swatch-bar"><i class="swatch-text"></i><b class="swatch-search"></b></span>
                  <span class="swatch-hero"><i class="swatch-accent"></i><span class="swatch-copy"><b></b><b></b><b class="swatch-progress"></b></span></span>
                  <span class="swatch-shelf"><b></b><b></b><b></b><b></b><b></b><b></b><b></b></span>
                </span>
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
            <button type="button" class="entry-card fr-card" data-enter data-spotlight aria-labelledby={`first-run-entry-${choice.key}`} aria-describedby={`first-run-entry-${choice.key}-hint first-run-entry-${choice.key}-points`} onclick={() => setFirstRunPath(choice.path, choice.step)}>
              <span class={`entry-art entry-art--${choice.key}`} aria-hidden="true"><span class="art-stage">
                {#if choice.key === "sync"}
                  <span class="art-device"><Desktop size={30} /></span>
                  <span class="art-link"><i></i></span>
                  <span class="art-device"><Laptop size={30} /></span>
                {:else if choice.key === "backup"}
                  <span class="art-file"><FileArchive size={22} /><b></b><b></b></span>
                  <span class="art-file"><FileArchive size={22} /><b></b><b></b></span>
                  <span class="art-file"><FileArchive size={22} /><b></b><b></b></span>
                {:else}
                  <span class="art-shelf"><i></i><i></i><i class="art-add"><Plus size={18} weight="bold" /></i><i></i><i></i><i></i></span>
                {/if}
              </span></span>
              <span class="entry-icon"><choice.icon size={22} /></span>
              <strong id={`first-run-entry-${choice.key}`}>{$_(`firstRun.shell.${choice.key}`)}<ArrowRight size={15} /></strong>
              <small id={`first-run-entry-${choice.key}-hint`}>{$_(`firstRun.shell.${choice.key}Hint`)}</small>
              <span class="entry-points" id={`first-run-entry-${choice.key}-points`}>
                {#each [1, 2, 3] as point}
                  <span><Check size={13} weight="bold" />{$_(`firstRun.shell.${choice.key}Point${point}`)}</span>
                {/each}
              </span>
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
          onSkip={() => setFirstRunPath("fresh", "sources")}
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
          onSkip={() => setFirstRunStep("trackers")}
        />

      {:else if firstRun.step === "trackers"}
        <FirstRunTrackersStep workflow={trackersWorkflow} onBack={goBack} onContinue={finishTrackers} />

      {:else if firstRun.step === "discover"}
        {#key discoveryScopeKey}
        <FirstRunDiscoverStep
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

  /* The choices grow into the page height, up to a size where the previews still read as miniatures. */
  .theme-grid { flex: 1 0 auto; max-height: 680px; display: grid; grid-template-columns: repeat(4, minmax(112px, 1fr)); grid-auto-rows: minmax(0, 1fr); gap: 14px; perspective: 900px; }
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
    grid-template-rows: minmax(0, 1fr) auto;
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
  /* A miniature of the app in the theme's own colors: icon rail, top bar, a "continue reading"
     card and a shelf of covers. Sizes follow the preview box, so it reads the same at any card size. */
  .theme-swatches {
    position: relative;
    container-type: size;
    min-height: clamp(58px, 11.5vh, 92px);
    display: grid;
    grid-template-columns: clamp(14px, 12%, 34px) minmax(0, 1fr);
    overflow: hidden;
    border-radius: 11px;
    background: var(--m-base);
    box-shadow: 0 12px 26px -14px var(--fr-shadow);
    transition: box-shadow .4s;
  }
  .theme-option:hover .theme-swatches { box-shadow: 0 22px 36px -16px var(--fr-shadow); }
  .theme-swatches::after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at var(--fr-glare-x) var(--fr-glare-y), color-mix(in srgb, var(--text-primary) 18%, transparent), transparent 55%); opacity: 0; mix-blend-mode: soft-light; transition: opacity .3s; }
  .theme-option:hover .theme-swatches::after { opacity: 1; }
  :where(.theme-swatches) :where(i, b) { display: block; }
  .swatch-side { display: flex; flex-direction: column; align-items: center; gap: 6cqh; padding-top: 8cqh; background: var(--m-raised); }
  .swatch-logo { width: 46%; aspect-ratio: 1; margin-bottom: 4cqh; border-radius: 30%; background: var(--m-accent); }
  .swatch-nav { width: 36%; aspect-ratio: 1; border-radius: 28%; background: var(--m-muted); opacity: .4; }
  .swatch-nav.is-on { background: var(--m-accent); opacity: 1; }
  .swatch-main { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); gap: 7cqh; padding: 8cqh 6cqw 0; }
  .swatch-bar { display: flex; align-items: center; justify-content: space-between; gap: 6cqw; height: max(6px, 7cqh); }
  .swatch-text { width: 40%; height: max(4px, 3cqh); border-radius: 99px; background: var(--m-text); opacity: .88; }
  .swatch-search { width: 28%; height: 100%; border-radius: 99px; background: var(--m-raised); }
  .swatch-hero { display: flex; gap: 5cqw; height: 30cqh; padding: 4cqh; border-radius: 6px; background: var(--m-raised); }
  .swatch-accent { flex: none; height: 100%; aspect-ratio: 2 / 3; border-radius: 3px; background: var(--m-accent); }
  .swatch-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 4cqh; }
  .swatch-copy b { width: 72%; height: max(3px, 2.6cqh); border-radius: 99px; background: var(--m-text); opacity: .82; }
  .swatch-copy b:nth-child(2) { width: 46%; background: var(--m-muted); opacity: .7; }
  .swatch-copy .swatch-progress { width: 100%; height: max(2px, 1.8cqh); margin-top: 2cqh; background: linear-gradient(90deg, var(--m-accent) 62%, color-mix(in srgb, var(--m-muted) 35%, transparent) 0); opacity: 1; }
  .swatch-shelf { display: flex; gap: 4cqw; min-height: 0; overflow: hidden; }
  .swatch-shelf b { flex: none; height: 100%; aspect-ratio: 2 / 3; border-radius: 3px 3px 0 0; background: var(--m-raised); transition: transform .5s var(--fr-spring); }
  .swatch-shelf b:nth-child(2n) { background: var(--m-overlay); }
  .theme-option:hover .swatch-shelf b { transform: translateY(-4%); }
  .theme-option:hover .swatch-shelf b:nth-child(2n) { transform: translateY(-8%); }
  /* Short previews keep only the bar and the shelf. */
  @container (max-height: 120px) {
    .swatch-hero { display: none; }
  }
  .theme-name { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 4px 2px; }
  .theme-tick { display: flex; color: var(--accent-fg); opacity: 0; transform: scale(.2) rotate(-40deg); transition: opacity .2s, transform .55s var(--fr-bounce); }
  .theme-option[aria-pressed="true"] .theme-tick { opacity: 1; transform: none; }

  /* Cards share their rows, so icons, titles and details line up across the three choices. */
  .entry-list { flex: 1 0 auto; max-height: 560px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: minmax(84px, 1fr) repeat(4, auto); gap: 0 14px; }
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
    grid-row: span 5;
    grid-template-rows: subgrid;
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
  .entry-icon { width: 44px; height: 44px; margin: 10px 0 8px; display: grid; place-items: center; border-radius: 14px; color: var(--accent-fg); background: var(--accent-muted); transition: transform .7s var(--fr-bounce); }
  .entry-card:hover .entry-icon { transform: translateY(-3px) rotate(-6deg) scale(1.06); }
  .entry-card strong { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; }
  .entry-card strong :global(svg) { color: var(--text-muted); transition: transform .5s var(--fr-bounce), color .3s; }
  .entry-card:hover strong :global(svg) { transform: translateX(4px); color: var(--accent-fg); }
  .entry-card small { color: var(--text-muted); font-size: 12.5px; line-height: 1.55; }
  .entry-points { display: grid; gap: 7px; margin-top: 10px; padding-top: 14px; border-top: 1px solid var(--fr-line); color: var(--text-secondary); font-size: 12.5px; line-height: 1.35; }
  .entry-points span { display: flex; align-items: flex-start; gap: 8px; }
  .entry-points :global(svg) { flex: none; margin-top: 1px; color: var(--accent-fg); }

  /* Illustrations drawn from theme tokens; they only move while the card is hovered. */
  .entry-art {
    position: relative;
    container-type: size;
    min-height: 0;
    overflow: hidden;
    display: grid;
    place-items: center;
    border-radius: 14px;
    color: var(--text-secondary);
    background:
      radial-gradient(120% 90% at 50% 110%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%),
      color-mix(in srgb, var(--text-primary) 3%, transparent);
  }
  .art-stage { display: flex; align-items: center; justify-content: center; transition: scale .6s var(--fr-spring); }
  @container (max-height: 100px) { .art-stage { scale: .66; } }
  @container (min-height: 200px) { .art-stage { scale: 1.25; } }
  @container (min-height: 260px) { .art-stage { scale: 1.45; } }
  .art-device { display: grid; place-items: center; width: 62px; height: 62px; border-radius: 18px; background: var(--fr-surface-strong); box-shadow: 0 10px 24px -14px var(--fr-shadow); transition: transform .6s var(--fr-spring); }
  .art-device:last-child { color: var(--accent-fg); background: var(--accent-muted); }
  .art-link { position: relative; width: 64px; height: 2px; margin: 0 10px; background: repeating-linear-gradient(90deg, var(--text-faint) 0 5px, transparent 5px 10px); }
  .art-link i { position: absolute; top: 50%; left: 0; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); }
  .entry-card:hover .art-link i { animation: art-travel 1.4s var(--fr-out) infinite; }
  .entry-card:hover .art-device:first-child { transform: translateX(-4px); }
  .entry-card:hover .art-device:last-child { transform: translateX(4px); }
  .art-file { position: absolute; width: 74px; height: 92px; padding: 12px 10px; display: grid; align-content: start; gap: 8px; border-radius: 10px; background: var(--bg-raised); box-shadow: 0 12px 26px -14px var(--fr-shadow); transition: transform .6s var(--fr-spring); }
  .art-file b { display: block; height: 4px; border-radius: 99px; background: var(--text-faint); }
  .art-file b:last-child { width: 60%; }
  .art-file:not(:nth-child(3)) { background: color-mix(in srgb, var(--text-primary) 6%, var(--bg-raised)); }
  .art-file:not(:nth-child(3)) b { visibility: hidden; }
  .art-file:nth-child(1) { transform: translateX(-34px) rotate(-10deg); }
  .art-file:nth-child(2) { transform: translateX(34px) rotate(10deg); }
  .art-file:nth-child(3) { color: var(--accent-fg); background: color-mix(in srgb, var(--accent) 22%, var(--bg-raised)); }
  .entry-card:hover .art-file:nth-child(1) { transform: translateX(-48px) rotate(-14deg); }
  .entry-card:hover .art-file:nth-child(2) { transform: translateX(48px) rotate(14deg); }
  .entry-card:hover .art-file:nth-child(3) { transform: translateY(-4px); }
  .art-shelf { display: grid; grid-template-columns: repeat(3, 40px); gap: 8px; }
  .art-shelf i { height: 56px; display: grid; place-items: center; border-radius: 7px; background: var(--fr-surface-strong); transition: transform .6s var(--fr-spring); }
  .art-shelf i:nth-child(n + 4) { opacity: .55; }
  .art-shelf .art-add { color: var(--accent-fg); background: var(--accent-muted); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 45%, transparent); }
  .entry-card:hover .art-shelf i:nth-child(2n) { transform: translateY(-4px); }
  .entry-card:hover .art-shelf .art-add { transform: translateY(-4px) scale(1.06); }
  @keyframes art-travel { from { left: 0; opacity: 0; } 20% { opacity: 1; } 80% { opacity: 1; } to { left: 100%; opacity: 0; } }

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
    .theme-grid { max-height: none; grid-template-columns: repeat(2, minmax(112px, 1fr)); grid-auto-rows: auto; }
    .theme-swatches { min-height: 132px; }
    .entry-list { max-height: none; grid-template-columns: 1fr; grid-template-rows: none; gap: 14px; }
    .entry-card { grid-row: auto; grid-template-rows: 110px auto auto auto auto; }
  }
  /* Short windows (the app allows 600 px) drop the illustration and the icon to keep the choices on screen. */
  @media (max-height: 700px) {
    .entry-list { grid-template-rows: repeat(3, auto); align-content: start; }
    .entry-card { grid-row: span 3; grid-template-rows: subgrid; }
    .entry-art, .entry-icon { display: none; }
  }
  @media (max-width: 520px) {
    .complete-summary { grid-template-columns: 1fr; }
  }
  /* Reduced motion follows the app setting, then the system (motion.ts). */
  :global(html[data-epigraph-reduced-motion="true"]) .loading-dot { animation: none; }
  :global(html[data-epigraph-reduced-motion="true"]) .complete-ring,
  :global(html[data-epigraph-reduced-motion="true"]) .complete-check { animation: none; stroke-dashoffset: 0; }
  :global(html[data-epigraph-reduced-motion="true"]) .complete-halo { animation: none; }
  :global(html[data-epigraph-reduced-motion="true"]) .entry-card:hover .art-link i { animation: none; }
</style>
