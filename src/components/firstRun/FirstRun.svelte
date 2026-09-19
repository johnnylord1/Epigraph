<script lang="ts">
  import { tick, untrack, type Component } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import {
    ArrowLeft,
    ArrowRight,
    Check,
    CloudArrowDown,
    Compass,
    DeviceMobile,
    FolderOpen,
    Link,
    PaintBrush,
    Stack,
  } from "phosphor-svelte";
  import { resolveAppLocale } from "../../lib/i18n/languages";
  import { _ } from "../../lib/i18n/runtime";
  import { BUILTIN_THEMES } from "../../lib/theme/contract";
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
    setExtensionsPanelHint,
    setNavPage,
    store,
    updateSettings,
  } from "../../store/state.svelte";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";

  interface Props { onComplete?: () => void; initialState?: FirstRunState }
  let { onComplete = () => {}, initialState }: Props = $props();

  type ContentType = "manga" | "novels";
  type SyncPanelComponent = Component<{
    profileId?: string | null;
    scopeLabel: string;
    presentation?: "modal" | "embedded";
    onReadyChange?: (ready: boolean) => void;
  }>;
  type SettingsPanelComponent = Component<{
    firstRunPane?: "backup" | "tracking" | null;
    onOpenFirstRunSources?: () => void;
    onFirstRunBackupReadyChange?: (readiness: FirstRunBackupReadiness) => void;
  }>;
  type SourcesPanelComponent = Component<{
    contentType?: ContentType;
    onSetupReadinessChange?: (readiness: {
      contentType: ContentType;
      repositoryCount: number;
      installedCount: number;
      ready: boolean;
    }) => void;
  }>;
  type SearchPanelComponent = Component<Record<string, never>>;
  type Copy = {
    appearance: string; data: string; setup: string; trackers: string; library: string;
    themeTitle: string; entryTitle: string; sync: string; backup: string; fresh: string;
    syncTitle: string; backupTitle: string; sourcesTitle: string; trackersTitle: string;
    discoverTitle: string; completeTitle: string; continue: string; back: string;
    returnRestore: string; finish: string; openLibrary: string; comics: string; novels: string;
  };
  const COPY: Record<string, Copy> = {
    en: { appearance: "Appearance", data: "Your data", setup: "Set up", trackers: "Trackers", library: "Library", themeTitle: "Choose your theme", entryTitle: "How do you want to begin?", sync: "Sync a device", backup: "Restore backups", fresh: "Set up from scratch", syncTitle: "Sync a device", backupTitle: "Restore your backups", sourcesTitle: "Add repositories and extensions", trackersTitle: "Connect trackers", discoverTitle: "Add titles to your library", completeTitle: "Everything is ready", continue: "Continue", back: "Back", returnRestore: "Return to restore", finish: "Finish setup", openLibrary: "Open library", comics: "Comics", novels: "Novels" },
    "pt-BR": { appearance: "Aparência", data: "Seus dados", setup: "Preparar", trackers: "Trackers", library: "Biblioteca", themeTitle: "Escolha seu tema", entryTitle: "Como você quer começar?", sync: "Sincronizar dispositivo", backup: "Restaurar backups", fresh: "Configurar do zero", syncTitle: "Sincronize um dispositivo", backupTitle: "Restaure seus backups", sourcesTitle: "Adicione repositórios e extensões", trackersTitle: "Conecte trackers", discoverTitle: "Adicione obras à biblioteca", completeTitle: "Tudo pronto", continue: "Continuar", back: "Voltar", returnRestore: "Voltar à restauração", finish: "Concluir configuração", openLibrary: "Abrir biblioteca", comics: "Quadrinhos", novels: "Novels" },
    es: { appearance: "Apariencia", data: "Tus datos", setup: "Preparar", trackers: "Trackers", library: "Biblioteca", themeTitle: "Elige tu tema", entryTitle: "¿Cómo quieres empezar?", sync: "Sincronizar dispositivo", backup: "Restaurar copias", fresh: "Configurar desde cero", syncTitle: "Sincroniza un dispositivo", backupTitle: "Restaura tus copias", sourcesTitle: "Añade repositorios y extensiones", trackersTitle: "Conecta trackers", discoverTitle: "Añade títulos a tu biblioteca", completeTitle: "Todo listo", continue: "Continuar", back: "Volver", returnRestore: "Volver a la restauración", finish: "Finalizar configuración", openLibrary: "Abrir biblioteca", comics: "Cómics", novels: "Novelas" },
    ja: { appearance: "外観", data: "データ", setup: "セットアップ", trackers: "トラッカー", library: "ライブラリ", themeTitle: "テーマを選択", entryTitle: "どのように始めますか？", sync: "端末を同期", backup: "バックアップを復元", fresh: "最初から設定", syncTitle: "端末を同期", backupTitle: "バックアップを復元", sourcesTitle: "リポジトリと拡張機能を追加", trackersTitle: "トラッカーを接続", discoverTitle: "作品をライブラリに追加", completeTitle: "準備完了", continue: "続ける", back: "戻る", returnRestore: "復元に戻る", finish: "セットアップを完了", openLibrary: "ライブラリを開く", comics: "コミック", novels: "小説" },
    "zh-CN": { appearance: "外观", data: "你的数据", setup: "设置", trackers: "追踪器", library: "书库", themeTitle: "选择主题", entryTitle: "你想如何开始？", sync: "同步设备", backup: "恢复备份", fresh: "从头设置", syncTitle: "同步设备", backupTitle: "恢复备份", sourcesTitle: "添加仓库和扩展", trackersTitle: "连接追踪器", discoverTitle: "将作品添加到书库", completeTitle: "一切就绪", continue: "继续", back: "返回", returnRestore: "返回恢复", finish: "完成设置", openLibrary: "打开书库", comics: "漫画", novels: "小说" },
  };

  let stepTitle = $state<HTMLHeadingElement>();
  let SyncPanel = $state<SyncPanelComponent | null>(null);
  let SettingsPanel = $state<SettingsPanelComponent | null>(null);
  let SourcesPanel = $state<SourcesPanelComponent | null>(null);
  let SearchPanel = $state<SearchPanelComponent | null>(null);
  let loadingStep = $state<FirstRunStep | null>(null);
  let loadError = $state<string | null>(null);
  let syncReady = $state(false);
  let backupReady = $state(false);
  let mangaSourcesReady = $state(false);
  let novelSourcesReady = $state(false);
  let firstRun = $state(untrack(() => initialState ?? loadFirstRun()));
  let contentType = $state<ContentType>(untrack(() => firstRun.sourceContentType ?? "manga"));
  let copy = $derived(COPY[resolveAppLocale(store.settings.appLanguage)] ?? COPY.en);

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
    loadError = null;
    firstRun = updateFirstRunState(firstRun, { step });
    persistFirstRun();
  }

  function setFirstRunPath(path: FirstRunPath, step: FirstRunStep) {
    loadError = null;
    syncReady = false;
    backupReady = false;
    firstRun = updateFirstRunState(firstRun, { path, step, backupRestored: undefined, backupNeedsSources: undefined });
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
  let hasLibraryContent = $derived(
    store.libraryMangaSnapshot.length > 0 || store.books.length > 0 || store.searchNovelLibraryEntries.length > 0,
  );
  let readiness = $derived<FirstRunReadiness>({
    syncConnected: syncReady,
    backupRestored: backupReady,
    sourcesConfigured: mangaSourcesReady || novelSourcesReady,
    hasLibraryContent,
  });
  let canAdvance = $derived(canAdvanceFirstRun(firstRun, readiness));

  function setLoading(step: FirstRunStep) {
    loadingStep = step;
    loadError = null;
  }

  function failLoading(step: FirstRunStep, error: unknown) {
    if (loadingStep === step) loadingStep = null;
    if (firstRun.step !== step) return;
    loadError = error instanceof Error ? error.message : String(error);
  }

  $effect(() => {
    const step = firstRun.step;
    void tick().then(() => stepTitle?.focus());
    if (loadError) return;

    if (step === "sync" && !SyncPanel && loadingStep !== step) {
      setLoading(step);
      void import("../settings/SyncdConnectionPanel.svelte").then((module) => {
        SyncPanel = module.default;
        loadingStep = null;
      }).catch((error) => failLoading(step, error));
    }
    if ((step === "backup" || step === "trackers" || (firstRun.path === "backup" && step === "sources")) && !SettingsPanel && loadingStep !== step) {
      setLoading(step);
      void import("../settings/Settings.svelte").then((module) => {
        SettingsPanel = module.default;
        loadingStep = null;
      }).catch((error) => failLoading(step, error));
    }
    if (step === "sources" && !SourcesPanel && loadingStep !== step) {
      setLoading(step);
      setExtensionsPanelHint("repos");
      void import("../pages/SourcesView.svelte").then((module) => {
        SourcesPanel = module.default;
        loadingStep = null;
      }).catch((error) => failLoading(step, error));
    }
    if (step === "discover" && !SearchPanel && loadingStep !== step) {
      setLoading(step);
      void import("../pages/Search.svelte").then((module) => {
        SearchPanel = module.default;
        loadingStep = null;
      }).catch((error) => failLoading(step, error));
    }
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
    if (step === "complete" && !hasLibraryContent) return setFirstRunStep("discover");
  }

  function finishTrackers() {
    setFirstRunStep(hasLibraryContent ? "complete" : "discover");
  }

  function openBackupSources() {
    setFirstRunStep("sources");
  }

  function updateSourceReadiness(next: { contentType: ContentType; ready: boolean }) {
    if (next.contentType === "manga") mangaSourcesReady = next.ready;
    else novelSourcesReady = next.ready;
  }

  function updateSyncReadiness(ready: boolean) {
    syncReady = ready;
  }

  function updateBackupReadiness(next: FirstRunBackupReadiness) {
    backupReady = next.ready;
    if (next.ready) {
      contentType = next.contentType;
      firstRun = updateFirstRunState(firstRun, { backupRestored: true, backupNeedsSources: next.requiresSources !== false, sourceContentType: next.contentType });
      persistFirstRun();
    } else if (next.hasSelection && firstRun.backupRestored) {
      firstRun = updateFirstRunState(firstRun, { backupRestored: undefined, backupNeedsSources: undefined });
      persistFirstRun();
    }
  }

  function retrySurfaceLoad() {
    loadError = null;
    loadingStep = null;
  }

  function advance(step: FirstRunStep) {
    if (!canAdvance) return;
    setFirstRunStep(step);
  }

  function finish() {
    if (!canAdvance) {
      setFirstRunStep("discover");
      return;
    }
    firstRun = completeFirstRunState(firstRun);
    persistFirstRun();
    setNavPage("library");
    onComplete();
  }

  function handleBrandPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("button, [data-no-window-drag]")) return;
    getCurrentWindow().startDragging().catch(() => {});
  }
</script>

<main class="first-run-shell">
  <!-- svelte-ignore a11y_no_static_element_interactions: desktop window drag starts from empty header regions. -->
  <header class="first-run-brand" aria-label="Epigraph" data-tauri-drag-region onpointerdown={handleBrandPointerDown}>
    <div class="brand-identity">
      <span class="brand-mark" aria-hidden="true">◇</span>
      <strong>Epigraph</strong>
    </div>
    <WindowControlsInline />
  </header>

  <nav class="first-run-progress" aria-label="Setup progress">
    <ol>
      {#each progress as item, index}
        <li aria-current={index === activeProgressIndex ? "step" : undefined} class:is-complete={index < activeProgressIndex}>
          <span class="progress-icon" aria-hidden="true">
            {#if index < activeProgressIndex}<Check size={15} weight="bold" />{:else}<item.icon size={16} weight="regular" />{/if}
          </span>
          <span>{copy[item.label]}</span>
        </li>
      {/each}
    </ol>
  </nav>

  <section class="first-run-stage" class:is-embedded={["sync", "backup", "sources", "trackers", "discover"].includes(firstRun.step)}>
    <div class="stage-copy" class:is-complete={firstRun.step === "complete"}>
      {#if firstRun.step === "theme"}
        <h1 tabindex="-1" bind:this={stepTitle}>{copy.themeTitle}</h1>
        <div class="theme-grid">
          {#each BUILTIN_THEMES as theme}
            <button
              type="button"
              class="theme-option"
              class:is-selected={store.settings.theme === theme.id}
              aria-pressed={store.settings.theme === theme.id}
              onclick={() => updateSettings({ theme: theme.id })}
            >
              <span class="theme-swatches" aria-hidden="true">
                {#each theme.swatches as swatch}<i style:background={swatch}></i>{/each}
              </span>
              <span>{theme.label}</span>
              {#if store.settings.theme === theme.id}<Check size={16} weight="bold" />{/if}
            </button>
          {/each}
        </div>
        <div class="stage-actions single"><button class="primary" type="button" onclick={() => setFirstRunStep("entry")}>{copy.continue}<ArrowRight size={16} /></button></div>

      {:else if firstRun.step === "entry"}
        <h1 tabindex="-1" bind:this={stepTitle}>{copy.entryTitle}</h1>
        <div class="entry-list">
          <button type="button" onclick={() => setFirstRunPath("sync", "sync")}><DeviceMobile size={22} /><span>{copy.sync}</span><ArrowRight size={16} /></button>
          <button type="button" onclick={() => setFirstRunPath("backup", "backup")}><CloudArrowDown size={22} /><span>{copy.backup}</span><ArrowRight size={16} /></button>
          <button type="button" onclick={() => setFirstRunPath("fresh", "sources")}><Stack size={22} /><span>{copy.fresh}</span><ArrowRight size={16} /></button>
        </div>
        <div class="stage-actions"><button class="secondary" type="button" onclick={goBack}><ArrowLeft size={16} />{copy.back}</button></div>

      {:else if firstRun.step === "sync"}
        <h1 tabindex="-1" bind:this={stepTitle}>{copy.syncTitle}</h1>
        <div class="embedded-area">{#if SyncPanel}<SyncPanel profileId={store.runtimeResolvedLocalProfileId ?? store.settings.defaultLocalProfileId} scopeLabel="First run" presentation="embedded" onReadyChange={updateSyncReadiness} />{:else if loadError}<div class="load-error" role="alert"><span>{$_("shell.pageState.failedTitle")}</span><button class="secondary" type="button" onclick={retrySurfaceLoad}>{$_("shell.pageState.retry")}</button></div>{:else}<span class="loading-dot" aria-label="Loading"></span>{/if}</div>
        <div class="stage-actions"><button class="secondary" type="button" onclick={goBack}><ArrowLeft size={16} />{copy.back}</button><button class="primary" type="button" disabled={!canAdvance} onclick={() => advance("trackers")}>{copy.continue}<ArrowRight size={16} /></button></div>

      {:else if firstRun.path === "backup" && (firstRun.step === "backup" || firstRun.step === "sources")}
        {#if firstRun.step === "backup"}
          <h1 tabindex="-1" bind:this={stepTitle}>{copy.backupTitle}</h1>
          {#if firstRun.backupRestored}<p class="setup-status"><Check size={16} />{$_("ui_backupRestored")}</p>{/if}
        {:else}
          <div class="stage-heading-row">
            <h1 tabindex="-1" bind:this={stepTitle}>{copy.sourcesTitle}</h1>
            <div class="content-toggle" role="group" aria-label="Content type">
              <button type="button" class:is-active={contentType === "manga"} onclick={() => contentType = "manga"}>{copy.comics}</button>
              <button type="button" class:is-active={contentType === "novels"} onclick={() => contentType = "novels"}>{copy.novels}</button>
            </div>
          </div>
        {/if}
        <div class:surface-hidden={firstRun.step !== "backup"} class="embedded-area settings-embed">{#if SettingsPanel}<SettingsPanel firstRunPane="backup" onOpenFirstRunSources={openBackupSources} onFirstRunBackupReadyChange={updateBackupReadiness} />{:else if loadError && firstRun.step === "backup"}<div class="load-error" role="alert"><span>{$_("shell.pageState.failedTitle")}</span><button class="secondary" type="button" onclick={retrySurfaceLoad}>{$_("shell.pageState.retry")}</button></div>{:else}<span class="loading-dot" aria-label="Loading"></span>{/if}</div>
        <div class:surface-hidden={firstRun.step !== "sources"} class="embedded-area sources-embed">{#if SourcesPanel}<SourcesPanel {contentType} onSetupReadinessChange={updateSourceReadiness} />{:else if loadError && firstRun.step === "sources"}<div class="load-error" role="alert"><span>{$_("shell.pageState.failedTitle")}</span><button class="secondary" type="button" onclick={retrySurfaceLoad}>{$_("shell.pageState.retry")}</button></div>{:else}<span class="loading-dot" aria-label="Loading"></span>{/if}</div>
        {#if firstRun.step === "backup"}
          <div class="stage-actions"><button class="secondary" type="button" onclick={goBack}><ArrowLeft size={16} />{copy.back}</button><button class="primary" type="button" disabled={!canAdvance} onclick={() => advance(firstRun.backupNeedsSources === false ? "trackers" : "sources")}>{copy.continue}<ArrowRight size={16} /></button></div>
        {:else}
          <div class="stage-actions"><button class="secondary" type="button" onclick={goBack}><ArrowLeft size={16} />{copy.back}</button><button class="primary" type="button" disabled={!canAdvance} onclick={() => advance(firstRun.backupRestored ? "trackers" : "backup")}>{firstRun.backupRestored ? copy.continue : copy.returnRestore}<ArrowRight size={16} /></button></div>
        {/if}

      {:else if firstRun.step === "sources"}
        <div class="stage-heading-row">
          <h1 tabindex="-1" bind:this={stepTitle}>{copy.sourcesTitle}</h1>
          <div class="content-toggle" role="group" aria-label="Content type">
            <button type="button" class:is-active={contentType === "manga"} onclick={() => contentType = "manga"}>{copy.comics}</button>
            <button type="button" class:is-active={contentType === "novels"} onclick={() => contentType = "novels"}>{copy.novels}</button>
          </div>
        </div>
        <div class="embedded-area sources-embed">{#if SourcesPanel}<SourcesPanel {contentType} onSetupReadinessChange={updateSourceReadiness} />{:else if loadError}<div class="load-error" role="alert"><span>{$_("shell.pageState.failedTitle")}</span><button class="secondary" type="button" onclick={retrySurfaceLoad}>{$_("shell.pageState.retry")}</button></div>{:else}<span class="loading-dot" aria-label="Loading"></span>{/if}</div>
        <div class="stage-actions"><button class="secondary" type="button" onclick={goBack}><ArrowLeft size={16} />{copy.back}</button><button class="primary" type="button" disabled={!canAdvance} onclick={() => advance("trackers")}>{copy.continue}<ArrowRight size={16} /></button></div>

      {:else if firstRun.step === "trackers"}
        <h1 tabindex="-1" bind:this={stepTitle}>{copy.trackersTitle}</h1>
        <div class="embedded-area settings-embed">{#if SettingsPanel}<SettingsPanel firstRunPane="tracking" />{:else if loadError}<div class="load-error" role="alert"><span>{$_("shell.pageState.failedTitle")}</span><button class="secondary" type="button" onclick={retrySurfaceLoad}>{$_("shell.pageState.retry")}</button></div>{:else}<span class="loading-dot" aria-label="Loading"></span>{/if}</div>
        <div class="stage-actions"><button class="secondary" type="button" onclick={goBack}><ArrowLeft size={16} />{copy.back}</button><button class="primary" type="button" onclick={finishTrackers}>{copy.continue}<ArrowRight size={16} /></button></div>

      {:else if firstRun.step === "discover"}
        <h1 tabindex="-1" bind:this={stepTitle}>{copy.discoverTitle}</h1>
        <div class="embedded-area discover-embed">{#if SearchPanel}<SearchPanel />{:else if loadError}<div class="load-error" role="alert"><span>{$_("shell.pageState.failedTitle")}</span><button class="secondary" type="button" onclick={retrySurfaceLoad}>{$_("shell.pageState.retry")}</button></div>{:else}<span class="loading-dot" aria-label="Loading"></span>{/if}</div>
        <div class="stage-actions"><button class="secondary" type="button" onclick={goBack}><ArrowLeft size={16} />{copy.back}</button><button class="primary" type="button" disabled={!canAdvance} onclick={() => advance("complete")}>{copy.finish}<ArrowRight size={16} /></button></div>

      {:else}
        <span class="complete-mark" aria-hidden="true"><Check size={26} weight="bold" /></span>
        <h1 tabindex="-1" bind:this={stepTitle}>{copy.completeTitle}</h1>
        <button class="primary complete-action" type="button" disabled={!canAdvance} onclick={finish}>{copy.openLibrary}<ArrowRight size={16} /></button>
      {/if}
    </div>
  </section>
</main>

<style>
  .first-run-shell { min-height: 100vh; display: grid; grid-template-rows: 56px 74px minmax(0, 1fr); color: var(--text-primary); background: var(--color-background); font-family: var(--font-ui, inherit); overflow: hidden; }
  .first-run-brand { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 0 10px 0 32px; -webkit-app-region: drag; }
  .brand-identity { display: flex; align-items: center; gap: 10px; pointer-events: none; }
  .brand-mark { color: var(--accent); }
  .first-run-progress { display: flex; justify-content: center; }
  .first-run-progress ol { width: min(900px, calc(100% - 48px)); display: grid; grid-template-columns: repeat(5, 1fr); list-style: none; padding: 0; margin: 0; }
  .first-run-progress li { display: flex; justify-content: center; align-items: center; gap: 9px; color: var(--text-faint); font-size: 13px; font-weight: 600; position: relative; }
  .first-run-progress li[aria-current="step"] { color: var(--text-primary); }
  .progress-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--hud-control-radius, 8px); background: var(--bg-subtle); }
  .first-run-progress li[aria-current="step"] .progress-icon { color: var(--accent-fg); background: var(--accent-muted); }
  .first-run-stage { min-height: 0; display: grid; place-items: center; padding: 38px 48px 48px; overflow: auto; }
  .first-run-stage.is-embedded { place-items: stretch center; padding-top: 28px; }
  .stage-copy { width: min(760px, 100%); animation: enter var(--motion-duration-slow, 220ms) var(--motion-easing-emphasized, ease-out); }
  .is-embedded .stage-copy { width: min(1120px, 100%); min-height: 0; display: flex; flex-direction: column; }
  h1 { margin: 0 0 28px; font-size: clamp(30px, 3.2vw, 46px); line-height: 1.08; letter-spacing: -0.035em; outline: none; }
  .stage-heading-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
  .stage-heading-row h1 { margin-bottom: 20px; }
  .theme-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .theme-option, .entry-list button { border: 1px solid var(--border-base); color: var(--text-primary); background: var(--bg-surface); }
  .theme-option { min-height: 62px; border-radius: 12px; padding: 10px 14px; display: grid; grid-template-columns: 72px 1fr 18px; align-items: center; gap: 14px; text-align: left; font: inherit; font-weight: 650; }
  .theme-option.is-selected { border-color: var(--accent); background: var(--accent-muted); }
  .theme-swatches { height: 34px; display: grid; grid-template-columns: repeat(4, 1fr); overflow: hidden; border-radius: 7px; }
  .theme-swatches i { display: block; }
  .entry-list { display: grid; gap: 10px; }
  .entry-list button { width: 100%; min-height: 66px; border-radius: 12px; padding: 0 18px; display: grid; grid-template-columns: 30px 1fr 18px; align-items: center; gap: 14px; color: var(--text-primary); text-align: left; font: inherit; font-size: 16px; font-weight: 650; }
  .stage-actions { display: flex; justify-content: space-between; gap: 10px; margin-top: 22px; }
  .stage-actions.single { justify-content: flex-end; }
  .primary, .secondary { min-height: 38px; border-radius: var(--hud-control-radius, 8px); padding: 0 15px; display: inline-flex; align-items: center; justify-content: center; gap: 9px; font: inherit; font-size: 13px; font-weight: 700; transition: transform var(--motion-duration-fast, 80ms), filter var(--motion-duration-fast, 80ms), background var(--motion-duration-fast, 80ms); }
  .primary { border: 1px solid transparent; color: var(--text-inverse); background: var(--accent); }
  .primary:hover { filter: brightness(1.08); transform: translateY(-1px); }
  button:disabled { opacity: .46; cursor: not-allowed; filter: none; transform: none; }
  .secondary { border: 1px solid var(--border-base); color: var(--text-secondary); background: transparent; }
  .embedded-area { min-height: 0; flex: 1; border-top: 1px solid var(--border-dim); border-bottom: 1px solid var(--border-dim); overflow: auto; position: relative; }
  .embedded-area.surface-hidden { display: none; }
  .settings-embed { min-height: 420px; }
  .sources-embed, .discover-embed { min-height: 430px; }
  .content-toggle { display: inline-flex; padding: 3px; border: 1px solid var(--border-base); border-radius: 9px; background: var(--bg-surface); }
  .content-toggle button { min-height: 30px; padding: 0 12px; border: 0; border-radius: 6px; color: var(--text-muted); background: transparent; font: inherit; font-size: 12px; font-weight: 700; }
  .content-toggle button.is-active { color: var(--text-primary); background: var(--bg-subtle); }
  .loading-dot { position: absolute; inset: 50% auto auto 50%; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pulse 900ms ease-in-out infinite alternate; }
  .load-error { min-height: 220px; display: grid; place-content: center; justify-items: center; gap: 14px; color: var(--text-muted); }
  .setup-status { display: flex; align-items: center; gap: 8px; margin: -12px 0 20px; color: var(--color-success); font-size: 13px; }
  .settings-embed :global(.settings-page--first-run) { min-height: 100%; height: auto; display: block; overflow: visible; background: transparent; }
  .settings-embed :global(.settings-workbench--first-run) { display: block; min-height: 100%; }
  .settings-embed :global(.settings-page--first-run .settings-pane-body.content-body) { overflow: visible; padding: 20px 4px; }
  .stage-copy.is-complete { text-align: left; }
  .complete-mark { width: 52px; height: 52px; display: grid; place-items: center; margin-bottom: 18px; border-radius: 16px; color: var(--color-success); background: var(--color-success-bg); }
  @keyframes enter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes pulse { to { opacity: .25; transform: scale(.7); } }
  @media (max-width: 760px) {
    .first-run-progress li span:last-child { display: none; }
    .first-run-stage { padding: 28px 20px; }
    .theme-grid { grid-template-columns: 1fr; }
    .stage-heading-row { flex-direction: column; align-items: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) { .stage-copy, .loading-dot { animation: none; } * { transition-duration: 0.01ms !important; } }
</style>
