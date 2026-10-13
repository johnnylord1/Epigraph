<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { readableErrorText } from "../../lib/i18n/networkErrorText";
  import { CircleNotch, StackSimple, Trash, X } from "phosphor-svelte";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import type { ManagedExtension } from "../../lib/managedExtensions";
  import type {
    ObservedCompatibilityReport,
    ObservedCompatibilityStage,
    SourcePreference,
    SourcePreferenceAccess,
    SourcePreferenceGroup,
    SourcePreferenceUpdateInput,
  } from "../../lib/manga/runtime";
  import NocturneState from "../shared/NocturneState.svelte";

  let {
    extension,
    busy = false,
    compatibilityReport = null,
    compatibilityBusy = false,
    preferenceGroups = [],
    preferenceAccess = "unsupported",
    preferenceLoading = false,
    preferenceLoadError = null,
    preferenceBusyKey = null,
    preferenceErrors = {},
    novelPreferenceKeys = [],
    selectedPreferenceSourceId = "",
    dismissible = true,
    onClose,
    onCheckCompatibility,
    onInstall,
    onRemove,
    onMassMigration,
    onSelectPreferenceSource,
    onUpdatePreference,
  }: {
    extension: ManagedExtension;
    busy?: boolean;
    compatibilityReport?: ObservedCompatibilityReport | null;
    compatibilityBusy?: boolean;
    preferenceGroups?: readonly SourcePreferenceGroup[];
    preferenceAccess?: SourcePreferenceAccess;
    preferenceLoading?: boolean;
    preferenceLoadError?: string | null;
    preferenceBusyKey?: string | null;
    preferenceErrors?: Readonly<Record<string, string>>;
    novelPreferenceKeys?: readonly string[];
    selectedPreferenceSourceId?: string;
    /** False while another dialog (mass migration) sits on top and owns Escape. */
    dismissible?: boolean;
    onClose: () => void;
    onCheckCompatibility?: (extension: ManagedExtension) => void;
    onInstall: (extension: ManagedExtension) => void;
    onRemove: (extension: ManagedExtension) => void;
    onMassMigration?: (extension: ManagedExtension) => void;
    onSelectPreferenceSource: (sourceId: string) => void;
    onUpdatePreference: (input: SourcePreferenceUpdateInput) => void;
  } = $props();

  const description = $derived(
    extension.isInstalled
      ? extension.kind === "novels"
        ? $_("extensionSettings_descriptionNovel", { name: extension.name })
        : $_("extensionSettings_descriptionManga", { name: extension.name })
      : $_("extensionSettings_descriptionAvailable", { name: extension.name }),
  );
  const originLabel = $derived(
    extension.kind === "novels"
      ? $_("extensionSettings_originNovel")
      : $_("extensionSettings_originManga"),
  );
  const repositoryLabel = $derived(
    extension.kind === "novels"
      ? extension.repositoryUrl || $_("sources_repositories_novelRepository")
      : extension.apkName || $_("sources_repositories_extensionRepository"),
  );
  const artifactLabel = $derived(
    extension.kind === "novels"
      ? extension.apkName || extension.novelPluginId || $_("extensionSettings_novelPlugin")
      : extension.apkName || $_("extensionSettings_repositoryPackage"),
  );
  const installStateLabel = $derived(
    extension.hasUpdate
      ? $_("ui_updateReady")
      : extension.isInstalled
        ? $_("sources_status_installed")
        : $_("sources_status_available"),
  );

  let panel = $state<HTMLElement | null>(null);

  $effect(() => {
    // Move focus into the dialog so keyboard users land on it and Escape reaches it.
    panel?.focus({ preventScroll: true });
  });

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !dismissible || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  }

  function preferenceKey(sourceId: string, position: number): string {
    return `${sourceId}:${position}`;
  }

  function currentPreferenceValue(preference: SourcePreference) {
    if (preference.type === "UnsupportedPreference") return null;
    return preference.currentValue ?? preference.defaultValue;
  }

  function updatePreference(
    group: SourcePreferenceGroup,
    position: number,
    preference: SourcePreference,
    value: boolean | string | readonly string[],
  ) {
    if (preference.type === "UnsupportedPreference") return;
    onUpdatePreference({
      sourceId: group.source.id,
      position,
      expectedKey: preference.key,
      expectedType: preference.type,
      value,
    });
  }

  function selectedValues(event: Event): string[] {
    return Array.from((event.currentTarget as HTMLSelectElement).selectedOptions)
      .map((option) => option.value);
  }

  function isSelectedPreferenceValue(preference: SourcePreference, value: string): boolean {
    const current = currentPreferenceValue(preference);
    return Array.isArray(current) && current.includes(value);
  }

  const canMassMigrate = $derived(extension.kind === "manga" && extension.isInstalled);
  const selectedPreferenceGroup = $derived(
    preferenceGroups.find((group) => group.source.id === selectedPreferenceSourceId)
      ?? preferenceGroups[0]
      ?? null,
  );

  function reportStatusLabel(status: ObservedCompatibilityReport["aggregateStatus"]): string {
    return status === "PASS"
      ? $_("extensionSettings_passed")
      : status === "DEGRADED"
        ? $_("extensionSettings_degraded")
        : status === "FAIL"
          ? $_("extensionSettings_failed")
          : status === "CANCELLED"
            ? $_("extensionSettings_cancelled")
            : $_("extensionSettings_inconclusive");
  }

  const stageLabelKeys: Record<string, string> = {
    "runtime-readiness": "extensionSettings_stageRuntimeReadiness",
    "source-registration": "extensionSettings_stageSourceRegistration",
    "live-search": "extensionSettings_stageLiveSearch",
    "http-parser-internals": "extensionSettings_stageHttpParserInternals",
  };

  function stageLabel(stage: ObservedCompatibilityStage): string {
    const key = stageLabelKeys[stage.id];
    return key ? $_(key) : stage.label;
  }

  function stageStatusLabel(status: ObservedCompatibilityStage["status"]): string {
    switch (status) {
      case "PASS": return $_("extensionSettings_passed");
      case "FAIL": return $_("extensionSettings_failed");
      case "SKIPPED": return $_("extensionSettings_skipped");
      case "UNSUPPORTED": return $_("extensionSettings_unsupported");
      case "NOT_OBSERVED": return $_("extensionSettings_notObserved");
      case "TIMED_OUT": return $_("extensionSettings_timedOut");
      case "CANCELLED": return $_("extensionSettings_cancelled");
      default: return $_("extensionSettings_inconclusive");
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="settingsLayer">
<div class="settingsBackdrop" onclick={onClose} aria-hidden="true"></div>

<aside
  class="settingsPanel"
  class:settingsPanelSingle={!extension.isInstalled}
  role="dialog"
  aria-modal="true"
  aria-label={`Settings for ${extension.name}`}
  tabindex="-1"
  bind:this={panel}
>
  <header class="settingsHeader">
    <div class="extensionIdentity">
      <img
        class="extensionIcon"
        src={resolveServiceIconUrl(extension.iconUrl, { kind: "extension" })}
        alt=""
        loading="lazy"
        decoding="async"
        onerror={(event) => applyServiceIconFallback(event, "extension")}
      />
      <div class="identityCopy">
        <p class="eyebrow">{$_("ui_extensionSettings")}</p>
        <h2>{extension.name}</h2>
        <div class="extensionMeta">
          <span>{extension.lang.toUpperCase()}</span>
          <span>v{extension.versionName}</span>
          {#if extension.hasUpdate}<span>{$_("ui_updateReady")}</span>{/if}
        </div>
      </div>
    </div>
    <button class="closeBtn" type="button" onclick={onClose} aria-label={$_("ui_closeExtensionSettings")}>
      <X size={16} weight="bold" />
    </button>
  </header>

  <div class="settingsBody">
  <div class="settingsAside">
  <p class="description">{description}</p>

  <section class="detailsSection">
    <div class="detailTopline">
      <span>{$_("ui_extensionDetails")}</span>
      <small>{originLabel}</small>
    </div>
    <div class="detailsGrid">
      <div class="detailItem detailItemWide">
        <span class="fieldLabel">{$_("ui_package")}</span>
        <strong>{extension.pkgName}</strong>
      </div>
      <div class="detailItem">
        <span class="fieldLabel">{$_("ui_installState")}</span>
        <strong>{installStateLabel}</strong>
      </div>
      <div class="detailItem">
        <span class="fieldLabel">{$_("sources_table_language")}</span>
        <strong>{extension.lang.toUpperCase()}</strong>
      </div>
      <div class="detailItem">
        <span class="fieldLabel">{$_("sources_table_version")}</span>
        <strong>v{extension.versionName}</strong>
      </div>
      <div class="detailItem detailItemWide">
        <span class="fieldLabel">{extension.kind === "novels" ? $_("sources_table_repository") : $_("ui_apkPackage")}</span>
        <strong>{repositoryLabel}</strong>
      </div>
      {#if artifactLabel !== repositoryLabel}
        <div class="detailItem detailItemWide">
          <span class="fieldLabel">{extension.kind === "novels" ? $_("ui_pluginArtifact") : $_("ui_apkPackage")}</span>
          <strong>{artifactLabel}</strong>
        </div>
      {/if}
      {#if extension.kind === "novels" && extension.novelPluginId}
        <div class="detailItem detailItemWide">
          <span class="fieldLabel">{$_("ui_novelPluginId")}</span>
          <strong>{extension.novelPluginId}</strong>
        </div>
      {/if}
      {#if extension.isObsolete}
        <div class="detailWarning">{$_("ui_thisExtensionIsMarkedObsoleteByTheRepository")}</div>
      {/if}
    </div>
  </section>

  {#if compatibilityReport}
    <details class="compatibilitySection">
      <summary>
        <span>{$_("extensionSettings_compatibility")}</span>
        <strong
          class:reportFailed={compatibilityReport.aggregateStatus === "FAIL"}
          class:reportDegraded={compatibilityReport.aggregateStatus !== "PASS" && compatibilityReport.aggregateStatus !== "FAIL"}
        >{reportStatusLabel(compatibilityReport.aggregateStatus)}</strong>
      </summary>
      <div class="compatibilityMeta">
        <span>{compatibilityReport.adapterProfile}</span>
        <span>{compatibilityReport.runtimeVersion}</span>
        <span>{compatibilityReport.runtimeScope === "REMOTE_SHARED" ? $_("extensionSettings_remoteRuntime") : $_("extensionSettings_localRuntime")}</span>
      </div>
      <div class="compatibilityStages">
        {#each compatibilityReport.stages as stage}
          <div>
            <span>{stageLabel(stage)}</span>
            <strong>{stageStatusLabel(stage.status)}</strong>
          </div>
        {/each}
      </div>
      {#if onCheckCompatibility}
        <button
          class="compatibilityProbeButton"
          type="button"
          disabled={compatibilityBusy}
          onclick={() => onCheckCompatibility?.(extension)}
        >{compatibilityBusy ? $_("extensionSettings_checking") : $_("extensionSettings_checkAgain")}</button>
      {/if}
    </details>
  {:else if extension.kind === "manga" && extension.isInstalled && onCheckCompatibility}
    <section class="compatibilitySection compatibilityEmpty">
      <div>
        <strong>{$_("extensionSettings_compatibility")}</strong>
        <span>{$_("extensionSettings_noCompatibility")}</span>
      </div>
      <button
        class="compatibilityProbeButton"
        type="button"
        disabled={compatibilityBusy}
        onclick={() => onCheckCompatibility?.(extension)}
      >{compatibilityBusy ? $_("extensionSettings_checking") : $_("extensionSettings_checkCompatibility")}</button>
    </section>
  {/if}

  {#if !extension.isInstalled}
    <section class="availablePanel">
      <button class="primaryCta" type="button" disabled={busy} onclick={() => onInstall(extension)}>
        {busy ? $_("sources_actions_installing") : $_("ui_installExtension")}
      </button>
    </section>
  {:else}
    {#if canMassMigrate && onMassMigration}
      <section class="availablePanel">
        <button class="primaryCta massMigrationCta" type="button" disabled={busy} onclick={() => onMassMigration?.(extension)}>
          <StackSimple size={15} weight="bold" />
          {$_("massMigration_title")}
        </button>
      </section>
    {/if}

    <section class="removePanel">
      <button class="dangerCta" type="button" disabled={busy} onclick={() => onRemove(extension)}>
        <Trash size={15} weight="bold" />
        {$_("sources_actions_remove")}
      </button>
    </section>
  {/if}
  </div>

  {#if extension.isInstalled}
  <div class="settingsMain">
    <section class="settingsSection">
      <div class="sectionTitle">
        <span>{$_("extensionSettings_sourcePreferences")}</span>
        <small>
          {extension.kind === "novels"
            ? $_("extensionSettings_lnreaderReadOnly")
            : preferenceAccess === "read-write"
              ? $_("extensionSettings_suwayomiManaged")
              : preferenceAccess === "read-only"
                ? $_("extensionSettings_readOnly")
                : $_("ui_unavailable")}
        </small>
      </div>

      {#if preferenceLoading}
        <div class="preferenceState" aria-live="polite">
          <span class="preferenceSpinner"><CircleNotch size={15} weight="bold" /></span>
          <span>{$_("extensionSettings_loadingPreferences")}</span>
        </div>
      {:else if preferenceLoadError}
        <NocturneState
          layout="compact"
          tone="danger"
          icon="warning"
          eyebrow={$_("extensionSettings_sourcePreferences")}
          title={$_("extensionSettings_preferencesLoadFailed")}
          body={preferenceLoadError}
        />
      {:else if extension.kind === "novels"}
        <div class="preferenceState">
          <strong>{$_("extensionSettings_readOnlySourceSettings")}</strong>
          <span>
            {$_("extensionSettings_readOnlySourceSettingsHint")}
          </span>
        </div>
        {#if novelPreferenceKeys.length > 0}
          <div class="novelPreferenceList" aria-label={$_("extensionSettings_preferenceKeys")}>
            {#each novelPreferenceKeys as key}
              <span>{key}</span>
            {/each}
          </div>
        {:else}
          <p class="preferenceEmpty">{$_("extensionSettings_noPreferencesDeclared")}</p>
        {/if}
      {:else if preferenceAccess === "unsupported"}
        <p class="preferenceEmpty">
          {$_("extensionSettings_preferencesUnsupported")}
        </p>
      {:else if preferenceGroups.length === 0}
        <p class="preferenceEmpty">{$_("extensionSettings_noSourcesRegistered")}</p>
      {:else if selectedPreferenceGroup}
        {#if preferenceGroups.length > 1}
          <label class="preferenceSourcePicker">
            <span>{$_("sources_table_source")}</span>
            <select
              value={selectedPreferenceSourceId}
              onchange={(event) => {
                onSelectPreferenceSource((event.currentTarget as HTMLSelectElement).value);
              }}
            >
              {#each preferenceGroups as group}
                <option value={group.source.id}>
                  {group.source.displayName || group.source.name} ({group.source.language.toUpperCase()})
                </option>
              {/each}
            </select>
          </label>
        {/if}

        {@const group = selectedPreferenceGroup}
          <div class="preferenceGroup">
            <div class="preferenceGroupHeader">
              <span>
                <strong>{group.source.displayName || group.source.name}</strong>
                <small>{group.source.language.toUpperCase()}</small>
              </span>
              <small>{$_("extensionSettings_settingsCount", { count: group.preferences.length })}</small>
            </div>

            {#if group.status === "pending" || group.status === "loading"}
              <div class="preferenceState" aria-live="polite">
                <span class="preferenceSpinner"><CircleNotch size={15} weight="bold" /></span>
                <span>{$_("extensionSettings_loadingSourcePreferences")}</span>
              </div>
            {:else if group.error}
              <NocturneState
                layout="compact"
                tone="danger"
                icon="warning"
                eyebrow={group.source.displayName || group.source.name}
                title={$_("extensionSettings_sourcePreferencesFailed")}
                body={group.error}
              />
            {:else if group.preferences.length === 0}
              <p class="preferenceEmpty">{$_("extensionSettings_sourceNoPreferences")}</p>
            {:else}
              {#each group.preferences as preference, position (`${group.source.id}:${position}:${preference.key}`)}
                {@const key = preferenceKey(group.source.id, position)}
                {@const isBusy = preferenceBusyKey === key}
                {@const isEditable = preferenceAccess === "read-write" && preference.enabled && !isBusy}
                <div class="preferenceRow" class:preferenceDisabled={!preference.enabled}>
                  <div class="preferenceCopy">
                    <strong>{preference.title}</strong>
                    {#if preference.summary}<small>{preference.summary}</small>{/if}
                  </div>

                  {#if preference.type === "CheckBoxPreference" || preference.type === "SwitchPreference"}
                    <input
                      aria-label={preference.title}
                      type="checkbox"
                      checked={currentPreferenceValue(preference) === true}
                      disabled={!isEditable}
                      onchange={(event) => updatePreference(
                        group,
                        position,
                        preference,
                        (event.currentTarget as HTMLInputElement).checked,
                      )}
                    />
                  {:else if preference.type === "ListPreference"}
                    <select
                      aria-label={preference.title}
                      value={String(currentPreferenceValue(preference) ?? "")}
                      disabled={!isEditable}
                      onchange={(event) => updatePreference(
                        group,
                        position,
                        preference,
                        (event.currentTarget as HTMLSelectElement).value,
                      )}
                    >
                      {#each preference.entryValues as value, index}
                        <option {value}>{preference.entries[index] ?? value}</option>
                      {/each}
                    </select>
                  {:else if preference.type === "EditTextPreference"}
                    <input
                      aria-label={preference.title}
                      value={String(currentPreferenceValue(preference) ?? preference.text ?? "")}
                      disabled={!isEditable}
                      onchange={(event) => updatePreference(
                        group,
                        position,
                        preference,
                        (event.currentTarget as HTMLInputElement).value,
                      )}
                    />
                  {:else if preference.type === "MultiSelectListPreference"}
                    <select
                      aria-label={preference.title}
                      multiple
                      disabled={!isEditable}
                      onchange={(event) => updatePreference(
                        group,
                        position,
                        preference,
                        selectedValues(event),
                      )}
                    >
                      {#each preference.entryValues as value, index}
                        <option
                          {value}
                          selected={isSelectedPreferenceValue(preference, value)}
                        >{preference.entries[index] ?? value}</option>
                      {/each}
                    </select>
                  {:else}
                    <span class="unsupportedPreference">
                      {$_("ui_unsupported")} {preference.upstreamType}
                    </span>
                  {/if}

                  {#if isBusy}
                    <span class="preferenceFeedback" aria-live="polite">{$_("extensionSettings_savingAndVerifying")}</span>
                  {:else if preferenceErrors[key]}
                    <span class="preferenceFeedback preferenceFeedbackError" role="alert">
                      {readableErrorText(preferenceErrors[key])}
                    </span>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
      {/if}
    </section>
  </div>
  {/if}
  </div>
</aside>
</div>

<style>
  /* A centered dialog: identity on top, details and actions on the left, source preferences on the right. */
  .settingsLayer {
    position: fixed;
    inset: 0;
    z-index: var(--component-sources-settings-mobile-panel-z-index);
    display: grid;
    place-items: center;
    padding: 64px 32px 28px;
  }

  .settingsBackdrop {
    position: absolute;
    inset: 0;
    background: var(--component-sources-settings-mobile-backdrop-bg);
    animation: fadeIn 140ms ease both;
  }

  .settingsPanel {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(980px, 100%);
    height: min(720px, 100%);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--component-sources-settings-mobile-border);
    border-radius: var(--component-sources-settings-dialog-radius);
    background: var(--component-sources-settings-dialog-bg);
    box-shadow: var(--component-sources-settings-dialog-shadow);
    outline: none;
    animation: dialogIn 180ms ease both;
  }

  .settingsPanelSingle {
    width: min(560px, 100%);
    height: auto;
    max-height: 100%;
  }

  .settingsHeader,
  .extensionIdentity,
  .extensionMeta,
  .sectionTitle {
    display: flex;
    align-items: center;
  }

  .settingsHeader {
    justify-content: space-between;
    gap: 16px;
    padding: 20px 24px 18px;
    border-bottom: 1px solid var(--component-sources-panel-border);
    background: var(--component-sources-settings-panel-bg);
  }

  .extensionIdentity {
    gap: 14px;
    min-width: 0;
  }

  .extensionIcon {
    width: 48px;
    height: 48px;
    flex: 0 0 auto;
    border-radius: var(--component-sources-settings-item-radius);
    object-fit: cover;
    background: var(--component-sources-settings-icon-bg);
    border: 1px solid var(--component-sources-settings-icon-border);
  }

  .identityCopy {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .eyebrow,
  .fieldLabel,
  .detailTopline small,
  .sectionTitle small {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--component-sources-subtle-fg);
  }

  h2 {
    margin: 0;
    font-size: 20px;
    line-height: 1.2;
    color: var(--component-sources-title-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .extensionMeta {
    gap: 6px;
    flex-wrap: wrap;
  }

  .extensionMeta span {
    border: 1px solid var(--component-sources-settings-icon-border);
    border-radius: var(--component-sources-settings-meta-radius);
    padding: 2px 9px;
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 700;
    color: var(--component-sources-muted-fg);
    background: var(--component-sources-badge-bg);
  }

  .closeBtn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    border-radius: var(--component-sources-settings-close-radius);
    color: var(--component-sources-control-fg);
    border: 1px solid var(--component-sources-settings-panel-border);
    background: var(--component-sources-hint-bg);
    transition: color 160ms ease, background 160ms ease, border-color 160ms ease;
  }

  .closeBtn:hover {
    color: var(--component-sources-strong-fg);
    border-color: var(--component-sources-control-hover-border);
    background: var(--component-sources-control-hover-bg);
  }

  .closeBtn:focus-visible {
    outline: 2px solid var(--component-sources-card-focus-outline);
    outline-offset: 2px;
  }

  .settingsBody {
    display: grid;
    grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
    flex: 1 1 auto;
    min-height: 0;
  }

  .settingsPanelSingle .settingsBody {
    grid-template-columns: minmax(0, 1fr);
  }

  .settingsAside,
  .settingsMain {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--component-sources-scrollbar-thumb) transparent;
  }

  .settingsAside {
    display: flex;
    flex-direction: column;
    padding: 18px 22px 20px;
    border-right: 1px solid var(--component-sources-panel-border);
  }

  .settingsPanelSingle .settingsAside {
    border-right: 0;
  }

  .settingsMain {
    padding: 18px 24px 22px;
  }

  .description {
    margin: 0 0 16px;
    color: var(--component-sources-body-fg);
    font-size: 13px;
    line-height: 1.5;
  }

  .availablePanel,
  .detailsSection,
  .compatibilitySection {
    border: 0;
    border-top: 1px solid var(--component-sources-panel-border);
    border-radius: 0;
    background: transparent;
    padding: 14px 0;
  }

  .detailsSection {
    display: grid;
    gap: 10px;
  }

  .compatibilitySection summary,
  .compatibilityStages div,
  .compatibilityMeta {
    display: flex;
    align-items: center;
  }

  .compatibilitySection summary {
    justify-content: space-between;
    gap: 10px;
    color: var(--component-sources-strong-fg);
    font-size: 13px;
    font-weight: 850;
    cursor: pointer;
  }

  .compatibilitySection summary strong {
    color: var(--component-sources-installed-fg);
    font-family: var(--font-ui);
    font-size: 12px;
    text-transform: none;
  }

  .compatibilitySection summary strong.reportFailed {
    color: var(--component-sources-danger-fg);
  }

  .compatibilitySection summary strong.reportDegraded {
    color: var(--component-sources-warning-fg);
  }

  .compatibilityMeta {
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 10px;
  }

  .compatibilityMeta span {
    border: 1px solid var(--component-sources-settings-icon-border);
    border-radius: var(--component-sources-settings-meta-radius);
    padding: 2px 8px;
    color: var(--component-sources-muted-fg);
    background: var(--component-sources-badge-bg);
    font-family: var(--font-ui);
    font-size: 10px;
  }

  .compatibilityStages {
    display: grid;
    gap: 6px;
    margin-top: 10px;
  }

  .compatibilityStages div {
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--component-sources-settings-item-radius);
    border: 1px solid var(--component-sources-available-border);
    background: var(--component-sources-variant-bg);
    color: var(--component-sources-cell-fg);
    font-size: 12px;
  }

  .compatibilityStages strong {
    color: var(--component-sources-muted-fg);
    font-family: var(--font-ui);
    font-size: 11px;
  }

  .compatibilityEmpty {
    display: grid;
    gap: 10px;
  }

  .compatibilityEmpty div {
    display: grid;
    gap: 4px;
    color: var(--component-sources-strong-fg);
    font-size: 13px;
  }

  .compatibilityEmpty span {
    color: var(--component-sources-body-fg);
    font-size: 12px;
    line-height: 1.4;
  }

  .compatibilityProbeButton {
    min-height: 34px;
    margin-top: 10px;
    padding: 0 14px;
    border-radius: var(--component-sources-settings-item-radius);
    border: 1px solid var(--component-sources-control-border);
    background: var(--component-sources-control-bg);
    color: var(--component-sources-control-fg);
    font-size: 12px;
    font-weight: 800;
  }

  .compatibilityEmpty .compatibilityProbeButton {
    margin-top: 0;
  }

  .compatibilityProbeButton:hover:not(:disabled) {
    border-color: var(--component-sources-control-hover-border);
    background: var(--component-sources-control-hover-bg);
    color: var(--component-sources-strong-fg);
  }

  .compatibilityProbeButton:focus-visible,
  .primaryCta:focus-visible,
  .dangerCta:focus-visible {
    outline: 2px solid var(--component-sources-card-focus-outline);
    outline-offset: 2px;
  }

  .compatibilityProbeButton:disabled {
    opacity: 0.55;
  }

  .detailTopline {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px 10px;
  }

  .detailTopline span {
    color: var(--component-sources-strong-fg);
    font-size: 13px;
    font-weight: 900;
  }

  .availablePanel {
    display: grid;
    gap: 12px;
  }

  .detailsGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 14px;
  }

  .detailItem {
    display: grid;
    gap: 3px;
    min-width: 0;
    padding: 6px 0;
  }

  .detailItemWide,
  .detailWarning {
    grid-column: 1 / -1;
  }

  .detailWarning {
    padding: 10px 12px;
    border-radius: var(--component-sources-control-radius);
    color: var(--component-sources-warning-fg);
    background: var(--component-sources-warning-bg);
    border: 1px solid var(--component-sources-warning-border);
    font-size: 12px;
    line-height: 1.4;
  }

  .detailItem strong {
    color: var(--component-sources-cell-fg);
    font-size: 13px;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .primaryCta,
  .dangerCta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-height: 38px;
    font-size: 13px;
  }

  .primaryCta {
    border-radius: var(--component-sources-search-radius);
    background: var(--component-sources-primary-bg);
    color: var(--component-sources-primary-ink);
    font-weight: 900;
    border: 1px solid var(--component-sources-primary-border);
    box-shadow: var(--component-sources-primary-shadow);
  }

  .primaryCta:disabled,
  .dangerCta:disabled {
    opacity: 0.55;
  }

  .removePanel {
    margin-top: auto;
    padding-top: 14px;
    border-top: 1px solid var(--component-sources-panel-border);
  }

  .dangerCta {
    border: 1px solid var(--component-sources-danger-border);
    border-radius: var(--component-sources-control-radius);
    color: var(--component-sources-danger-fg);
    background: var(--component-sources-danger-bg);
    font-weight: 800;
  }

  .settingsSection {
    display: grid;
    gap: 14px;
  }

  .sectionTitle {
    justify-content: space-between;
    gap: 12px;
  }

  .sectionTitle span {
    font-size: 16px;
    font-weight: 900;
    color: var(--component-sources-strong-fg);
  }

  input,
  select {
    min-height: 36px;
    border-radius: var(--component-sources-settings-item-radius);
    border: 1px solid var(--component-sources-settings-icon-border);
    background: var(--component-sources-field-bg);
    color: var(--component-sources-field-fg);
    padding: 0 12px;
    outline: none;
    font: inherit;
    font-size: 13px;
  }

  input:focus,
  select:focus {
    border-color: var(--component-sources-control-hover-border);
  }

  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--component-sources-card-focus-outline);
    outline-offset: 2px;
  }

  input[type="checkbox"] {
    appearance: none;
    flex: 0 0 auto;
    width: 40px;
    height: 24px;
    min-height: 24px;
    border-radius: var(--component-sources-settings-meta-radius);
    padding: 0;
    background: var(--component-sources-toggle-track-bg);
    position: relative;
    cursor: pointer;
    transition: background 160ms ease;
  }

  input[type="checkbox"]:disabled {
    cursor: default;
  }

  input[type="checkbox"]::after {
    content: "";
    position: absolute;
    top: 4px;
    left: 4px;
    width: 16px;
    height: 16px;
    border-radius: var(--component-sources-settings-meta-radius);
    background: var(--component-sources-toggle-knob-bg);
    transition: transform 160ms ease;
  }

  input[type="checkbox"]:checked {
    background: var(--component-sources-toggle-on-bg);
  }

  input[type="checkbox"]:checked::after {
    transform: translateX(16px);
  }

  .preferenceState,
  .preferenceGroupHeader,
  .preferenceRow {
    display: flex;
    align-items: center;
  }

  .preferenceState {
    gap: 10px;
    min-width: 0;
    padding: 12px 14px;
    border-radius: var(--component-sources-settings-item-radius);
    border: 1px solid var(--component-sources-available-border);
    background: var(--component-sources-variant-bg);
    color: var(--component-sources-cell-fg);
    font-size: 12px;
    line-height: 1.45;
  }

  .preferenceState > span,
  .preferenceState > strong {
    min-width: 0;
  }

  .preferenceFeedbackError {
    color: var(--component-sources-danger-fg);
  }

  .preferenceSpinner {
    display: inline-flex;
    flex: 0 0 auto;
    animation: spin 800ms linear infinite;
  }

  .novelPreferenceList {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .novelPreferenceList span,
  .unsupportedPreference {
    border: 1px solid var(--component-sources-settings-icon-border);
    border-radius: var(--component-sources-settings-meta-radius);
    padding: 3px 9px;
    color: var(--component-sources-muted-fg);
    background: var(--component-sources-badge-bg);
    font-family: var(--font-ui);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .preferenceEmpty {
    margin: 0;
    color: var(--component-sources-body-fg);
    font-size: 12px;
    line-height: 1.45;
  }

  .preferenceSourcePicker {
    display: grid;
    gap: 6px;
    color: var(--component-sources-cell-fg);
    font-size: 12px;
    font-weight: 800;
  }

  .preferenceSourcePicker select {
    width: min(100%, 420px);
  }

  .preferenceGroup {
    display: grid;
    border: 1px solid var(--component-sources-available-border);
    border-radius: var(--component-sources-settings-item-radius);
    background: var(--component-sources-variant-bg);
    overflow: hidden;
  }

  .preferenceGroupHeader {
    justify-content: space-between;
    gap: 10px;
    padding: 12px 16px;
    color: var(--component-sources-strong-fg);
    font-size: 13px;
  }

  .preferenceGroupHeader > span {
    display: flex;
    align-items: baseline;
    min-width: 0;
    gap: 8px;
  }

  .preferenceGroupHeader small {
    color: var(--component-sources-subtle-fg);
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 800;
    text-transform: none;
  }

  .preferenceGroup > .preferenceState,
  .preferenceGroup > .preferenceEmpty {
    margin: 0 16px 14px;
  }

  .preferenceRow {
    position: relative;
    justify-content: space-between;
    gap: 16px;
    min-width: 0;
    padding: 14px 16px 18px;
    border-top: 1px solid var(--component-sources-panel-border);
  }

  .preferenceRow select,
  .preferenceRow input:not([type="checkbox"]) {
    flex: 0 0 auto;
    width: min(280px, 44%);
  }

  .preferenceRow select[multiple] {
    min-height: 96px;
    padding: 6px 8px;
  }

  .preferenceRow select[multiple] option {
    padding: 2px 6px;
    border-radius: var(--component-sources-settings-meta-radius);
  }

  .preferenceRow select[multiple] option:checked {
    background: var(--component-sources-toggle-on-bg);
    color: var(--component-sources-primary-ink);
  }

  .preferenceCopy {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .preferenceCopy strong {
    color: var(--component-sources-cell-fg);
    font-size: 13px;
    font-weight: 750;
    overflow-wrap: anywhere;
  }

  .preferenceCopy small,
  .preferenceFeedback {
    color: var(--component-sources-table-head-fg);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.4;
  }

  .preferenceDisabled {
    opacity: 0.65;
  }

  .preferenceFeedback {
    position: absolute;
    inset: auto 16px 3px;
    font-size: 11px;
    text-align: right;
  }

  /* Reduced motion follows the app setting, then the system (motion.ts). */
  :global(html[data-epigraph-reduced-motion="true"]) .settingsPanel,
  :global(html[data-epigraph-reduced-motion="true"]) .settingsBackdrop,
  :global(html[data-epigraph-reduced-motion="true"]) .preferenceSpinner {
    animation: none;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 860px) {
    .settingsBody {
      display: block;
      overflow-y: auto;
    }

    .settingsAside,
    .settingsMain {
      overflow: visible;
    }

    .settingsAside {
      border-right: 0;
    }

    .removePanel {
      margin-top: 0;
    }
  }

  @media (max-width: 760px) {
    .settingsLayer {
      z-index: var(--component-sources-settings-mobile-backdrop-z-index);
      place-items: end stretch;
      padding: 0;
    }

    .settingsPanel {
      width: 100%;
      height: auto;
      max-height: min(86vh, 760px);
      border-width: 1px 0 0;
      border-radius: var(--component-sources-settings-mobile-radius);
      box-shadow: var(--component-sources-settings-mobile-shadow);
      animation: sheetIn 180ms ease both;
    }
  }

  @keyframes dialogIn {
    from { opacity: 0; transform: translateY(10px) scale(0.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  @keyframes sheetIn {
    from { opacity: 0; transform: translateY(18px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
