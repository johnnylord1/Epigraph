<script lang="ts">
  import { onMount, tick } from "svelte";
  import { _ } from "../../lib/i18n/runtime";
  import {
    getSuwayomiRuntimeStatus,
    installSuwayomiRuntimeUpdate,
    stageSuwayomiRuntimeUpdate,
    type SuwayomiRuntimeStatus,
    type SuwayomiUpdateCheckResult,
    type SuwayomiUpdateStageResult,
  } from "../../lib/suwayomiRuntimeUpdate";
  import {
    recordSuwayomiUpdateCheck,
    refreshSuwayomiUpdateUx,
    suwayomiUpdateUx,
  } from "../../lib/suwayomiUpdateUx.svelte";

  type UpdateUiState =
    | "checking"
    | "upToDate"
    | "updateAvailable"
    | "downloading"
    | "readyToInstall"
    | "installing"
    | "restarting"
    | "rollingBack"
    | "failed"
    | "external"
    | "userManagedBinary"
    | "blocked";

  let runtime: SuwayomiRuntimeStatus | null = $state(null);
  let checkResult: SuwayomiUpdateCheckResult | null = $state(null);
  let staged: SuwayomiUpdateStageResult | null = $state(null);
  let state: UpdateUiState = $state("checking");
  let message = $state("");
  let detailsOpen = $state(false);
  let changelogOpen = $state(false);
  let detailsDialog: HTMLDialogElement | null = $state(null);
  let detailsButton: HTMLButtonElement | null = $state(null);
  let closeButton: HTMLButtonElement | null = $state(null);
  let operationSerial = 0;

  const busy = $derived(["checking", "downloading", "installing", "restarting", "rollingBack"].includes(state));
  const canCheck = $derived(Boolean(runtime?.updateAllowed) && !busy);
  const canDownload = $derived(checkResult?.status === "updateAvailable" && !staged && !busy);
  const canInstall = $derived(Boolean(staged) && state === "readyToInstall" && !busy);
  const releaseNotes = $derived((checkResult?.releaseNotes ?? "").trim());
  const hasChangelog = $derived(Boolean(releaseNotes));
  const currentVersion = $derived(checkResult?.currentVersion ?? runtime?.version ?? $_("suwayomi.update.unknown"));
  const latestVersion = $derived(checkResult?.latestCompatibleVersion ?? $_("suwayomi.update.none"));
  const lastCheckedLabel = $derived(formatDateTime(suwayomiUpdateUx.lastCheckedAt));

  function applyRuntimeStatus(status: SuwayomiRuntimeStatus) {
    runtime = status;
    if (status.mode === "external") {
      state = "external";
      message = status.blockReason ?? $_("suwayomi.update.externalBlocked");
      return;
    }
    if (status.mode === "managed-user-binary") {
      state = "userManagedBinary";
      message = status.blockReason ?? $_("suwayomi.update.userBinaryBlocked");
      return;
    }
    if (!status.updateAllowed) {
      state = "blocked";
      message = status.blockReason ?? $_("suwayomi.update.runtimeBlocked");
      return;
    }
    state = "upToDate";
    message = status.version
      ? $_("suwayomi.update.currentRuntime", { version: status.version })
      : $_("suwayomi.update.managedRuntimeDetected");
  }

  function nextOperation() {
    operationSerial += 1;
    return operationSerial;
  }

  function isCurrentOperation(operation: number) {
    return operation === operationSerial;
  }

  function formatUpdaterError(error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/^((OwnershipError|CompatibilityError|DownloadError|ChecksumError|SnapshotError|PromotionError|RollbackError|HealthCheckError):\s*)+/, "");
  }

  function fail(error: unknown) {
    state = String(error).toLowerCase().includes("rollback") ? "rollingBack" : "failed";
    message = formatUpdaterError(error);
    if (state === "rollingBack") {
      setTimeout(() => {
        state = "failed";
      }, 900);
    }
  }

  function applyCheckResult(result: SuwayomiUpdateCheckResult) {
    checkResult = result;
    if (result.status === "updateAvailable") {
      state = "updateAvailable";
      message = $_("suwayomi.update.availableMessage", { version: result.latestCompatibleVersion ?? result.releaseTag ?? $_("suwayomi.update.unknown") });
    } else if (result.status === "upToDate") {
      state = "upToDate";
      message = $_("suwayomi.update.upToDateMessage");
    } else if (result.status === "blocked") {
      state = "blocked";
      message = result.blockReason ?? $_("suwayomi.update.noCompatibleUpdate");
    } else {
      state = "failed";
      message = result.blockReason ?? $_("suwayomi.update.checkFailedMessage");
    }
  }

  async function refreshRuntime() {
    const operation = nextOperation();
    state = "checking";
    message = $_("suwayomi.update.checkingRuntime");
    try {
      const status = await getSuwayomiRuntimeStatus();
      if (!isCurrentOperation(operation)) return;
      applyRuntimeStatus(status);
    } catch (error) {
      if (!isCurrentOperation(operation)) return;
      fail(error);
    }
  }

  async function checkUpdates(force = false) {
    if (!force && !canCheck) return;
    const operation = nextOperation();
    state = "checking";
    message = $_("suwayomi.update.checkingReleases");
    staged = null;
    try {
      const result = await refreshSuwayomiUpdateUx({ notify: true });
      if (!isCurrentOperation(operation)) return;
      applyCheckResult(result);
    } catch (error) {
      if (!isCurrentOperation(operation)) return;
      fail(error);
    }
  }

  async function downloadUpdate() {
    if (!canDownload || !checkResult?.latestCompatibleVersion) return;
    const operation = nextOperation();
    state = "downloading";
    message = $_("suwayomi.update.downloadingVersion", { version: checkResult.latestCompatibleVersion });
    try {
      const result = await stageSuwayomiRuntimeUpdate({ targetVersion: checkResult.latestCompatibleVersion });
      if (!isCurrentOperation(operation)) return;
      staged = result;
      state = "readyToInstall";
      message = $_("suwayomi.update.readyToInstallMessage", { version: staged.version });
    } catch (error) {
      if (!isCurrentOperation(operation)) return;
      fail(error);
    }
  }

  async function installUpdate() {
    if (!canInstall || !staged) return;
    const operation = nextOperation();
    state = "installing";
    message = $_("suwayomi.update.creatingSnapshot");
    try {
      state = "restarting";
      message = $_("suwayomi.update.installingRestarting");
      await installSuwayomiRuntimeUpdate({
        stagedVersion: staged.version,
      });
      if (!isCurrentOperation(operation)) return;
      const installed = staged;
      staged = null;
      recordSuwayomiUpdateCheck({
        status: "upToDate",
        currentVersion: installed.version,
        latestCompatibleVersion: installed.version,
        releaseTag: installed.releaseTag,
        releaseUrl: installed.releaseUrl,
        updateAllowed: false,
        blockReason: null,
        notes: null,
        releaseNotes: null,
      });
      await checkUpdates(true);
    } catch (error) {
      if (!isCurrentOperation(operation)) return;
      fail(error);
    }
  }

  onMount(() => {
    void refreshRuntime();
  });

  $effect(() => {
    if (!detailsOpen) return;
    void tick().then(() => {
      if (!detailsDialog) return;
      if (typeof detailsDialog.showModal === "function") {
        if (!detailsDialog.open) detailsDialog.showModal();
      } else {
        detailsDialog.setAttribute("open", "");
      }
      closeButton?.focus();
    });
  });

  $effect(() => {
    const result = suwayomiUpdateUx.lastCheck;
    if (!result || busy || staged) return;
    applyCheckResult(result);
  });

  function stateLabel(state: UpdateUiState) {
    switch (state) {
      case "upToDate": return $_("suwayomi.update.state.upToDate");
      case "updateAvailable": return $_("suwayomi.update.state.updateAvailable");
      case "checking": return $_("suwayomi.update.state.checking");
      case "downloading": return $_("suwayomi.update.state.downloading");
      case "readyToInstall": return $_("suwayomi.update.state.readyToInstall");
      case "installing": return $_("suwayomi.update.state.installing");
      case "restarting": return $_("suwayomi.update.state.restarting");
      case "rollingBack": return $_("suwayomi.update.state.rollingBack");
      case "external": return $_("suwayomi.update.state.external");
      case "userManagedBinary": return $_("suwayomi.update.state.userManagedBinary");
      case "blocked": return $_("suwayomi.update.state.blocked");
      default: return $_("suwayomi.update.state.failed");
    }
  }

  function formatDateTime(value: number | null) {
    if (!value) return $_("common_never");
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function closeDetails() {
    detailsDialog?.close();
    detailsOpen = false;
    void tick().then(() => detailsButton?.focus());
  }
</script>

<div class="settings-card settings-card--wide suwayomi-update-panel suwayomi-update-panel--compact" data-testid="suwayomi-update-panel">
  <div class="settings-row settings-mini-row suwayomi-update-summary">
    <div class="settings-mini-row__body">
      <p class="settings-mini-row__label">Suwayomi</p>
      <p class="settings-mini-row__hint">{currentVersion} - {runtime?.mode ?? $_("suwayomi.update.runtimeChecking")}</p>
    </div>
    <span class="suwayomi-update-pill" data-state={state}>{stateLabel(state)}</span>
    <button
      bind:this={detailsButton}
      class="n-btn n-btn--sm n-btn-ghost"
      type="button"
      aria-haspopup="dialog"
      onclick={() => (detailsOpen = true)}
    >{$_("suwayomi.update.details")}</button>
  </div>
</div>

{#if detailsOpen}
  <dialog
    bind:this={detailsDialog}
    class="suwayomi-update-modal"
    aria-label={$_("suwayomi.update.detailsTitle")}
    onclose={() => (detailsOpen = false)}
    onkeydown={(event) => {
      if (event.key === "Escape") closeDetails();
    }}
    onclick={(event) => {
      if (event.target === detailsDialog) closeDetails();
    }}
  >
      <div class="settings-card__head">
        <div>
          <p class="settings-card__title">{$_("suwayomi.update.detailsTitle")}</p>
          <p class="settings-card__intro settings-card__intro--body">
            {$_("suwayomi.update.detailsIntro")}
          </p>
        </div>
        <button bind:this={closeButton} class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={closeDetails}>{$_("common_close")}</button>
      </div>

      <div class="suwayomi-update-modal__status">
        <span class="suwayomi-update-pill" data-state={state}>{stateLabel(state)}</span>
        <span>{message}</span>
      </div>

      <div class="settings-card__stack">
    <div class="settings-row settings-mini-row">
      <div class="settings-mini-row__body">
        <p class="settings-mini-row__label">{$_("ui_runtime")}</p>
        <p class="settings-mini-row__hint">{runtime?.mode ?? $_("suwayomi.update.runtimeChecking")}{runtime?.version ? ` - ${runtime.version}` : ""}</p>
      </div>
      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={refreshRuntime} disabled={busy}>{$_("common_refresh")}</button>
    </div>

    <div class="settings-row settings-mini-row">
      <div class="settings-mini-row__body">
        <p class="settings-mini-row__label">{$_("suwayomi.update.currentVersion")}</p>
        <p class="settings-mini-row__hint">{currentVersion}</p>
      </div>
    </div>

    <div class="settings-row settings-mini-row">
      <div class="settings-mini-row__body">
        <p class="settings-mini-row__label">{$_("suwayomi.update.latestAvailable")}</p>
        <p class="settings-mini-row__hint">{latestVersion}</p>
      </div>
      {#if hasChangelog}
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (changelogOpen = true)}>{$_("suwayomi.update.viewChangelog")}</button>
      {/if}
    </div>

    <div class="settings-row settings-mini-row">
      <div class="settings-mini-row__body">
        <p class="settings-mini-row__label">{$_("suwayomi.update.lastChecked")}</p>
        <p class="settings-mini-row__hint">{lastCheckedLabel}</p>
      </div>
    </div>

    <div class="settings-row settings-mini-row">
      <div class="settings-mini-row__body">
        <p class="settings-mini-row__label">{$_("suwayomi.update.status")}</p>
        <p class="settings-mini-row__hint">{message}</p>
      </div>
    </div>
  </div>

      <div class="settings-card__footer settings-card__footer--actions">
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={checkUpdates} disabled={!canCheck}>
          {state === "checking" ? $_("suwayomi.update.state.checking") : $_("suwayomi.update.checkForUpdates")}
        </button>
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={downloadUpdate} disabled={!canDownload}>
          {state === "downloading" ? $_("suwayomi.update.state.downloading") : $_("suwayomi.update.downloadUpdate")}
        </button>
        <button class="n-btn n-btn--sm" type="button" onclick={installUpdate} disabled={!canInstall}>
          {state === "installing" || state === "restarting" ? $_("suwayomi.update.state.installing") : $_("suwayomi.update.installUpdate")}
        </button>
      </div>
  </dialog>
{/if}

{#if changelogOpen && hasChangelog}
  <div class="suwayomi-update-changelog-backdrop" role="presentation" onclick={() => (changelogOpen = false)}>
    <dialog
      open
      class="suwayomi-update-changelog"
      aria-label={$_("suwayomi.update.changelogTitle")}
      onclick={(event) => event.stopPropagation()}
    >
      <div class="settings-card__head">
        <div>
          <p class="settings-card__title">{$_("suwayomi.update.changelogTitle")}</p>
          <p class="settings-card__intro">{checkResult?.releaseTag ?? checkResult?.latestCompatibleVersion}</p>
        </div>
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (changelogOpen = false)}>{$_("common_close")}</button>
      </div>
      <pre class="suwayomi-update-changelog__body">{releaseNotes}</pre>
    </dialog>
  </div>
{/if}

<style>
  .suwayomi-update-panel {
    gap: 16px;
  }

  .suwayomi-update-panel--compact {
    gap: 0;
  }

  .suwayomi-update-summary {
    margin: 0;
  }

  .suwayomi-update-summary .suwayomi-update-pill {
    margin-left: auto;
  }

  .suwayomi-update-pill {
    align-self: flex-start;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--text);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0;
    padding: 6px 10px;
    white-space: nowrap;
  }

  .suwayomi-update-pill[data-state="failed"],
  .suwayomi-update-pill[data-state="blocked"],
  .suwayomi-update-pill[data-state="external"],
  .suwayomi-update-pill[data-state="userManagedBinary"] {
    background: rgba(255, 116, 148, 0.12);
    border-color: rgba(255, 116, 148, 0.34);
    color: #ffb4c6;
  }

  .suwayomi-update-pill[data-state="readyToInstall"],
  .suwayomi-update-pill[data-state="updateAvailable"] {
    background: rgba(199, 180, 255, 0.16);
    border-color: rgba(199, 180, 255, 0.38);
  }

  .suwayomi-update-changelog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9800;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(4, 4, 8, 0.64);
    backdrop-filter: blur(12px);
  }

  .suwayomi-update-modal,
  .suwayomi-update-changelog {
    position: fixed;
    inset: 0;
    width: min(680px, calc(100vw - 48px));
    max-height: min(680px, calc(100vh - 48px));
    margin: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
    border: 1px solid rgba(72, 69, 79, 0.38);
    border-radius: 14px;
    box-sizing: border-box;
    background:
      radial-gradient(circle at 0% 0%, rgba(201, 181, 255, 0.08), transparent 42%),
      rgba(18, 17, 23, 0.96);
    color: var(--text);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.56), inset 0 1px 0 rgba(255, 255, 255, 0.035);
  }

  .suwayomi-update-modal::backdrop {
    background: rgba(4, 4, 8, 0.64);
    backdrop-filter: blur(12px);
  }

  .suwayomi-update-modal__status {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 38px;
    padding: 10px 12px;
    border: 1px solid rgba(72, 69, 79, 0.2);
    border-radius: 12px;
    background: rgba(8, 8, 13, 0.42);
    color: rgba(229, 226, 225, 0.76);
    font-size: 12px;
    line-height: 1.4;
  }

  .suwayomi-update-changelog__body {
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: 14px;
    border: 1px solid rgba(72, 69, 79, 0.2);
    border-radius: 12px;
    background: rgba(8, 8, 13, 0.64);
    color: rgba(229, 226, 225, 0.88);
    font-family: "Manrope", "Inter", system-ui, sans-serif;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
  }
</style>
