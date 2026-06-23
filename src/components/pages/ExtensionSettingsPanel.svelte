<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { X } from "phosphor-svelte";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import type { ManagedExtension } from "../../lib/managedExtensions";
  import type { MockExtensionSettings, MockExtensionSettingsPatch } from "../../store/mockSettingsStore";

  let {
    extension,
    config,
    busy = false,
    onClose,
    onInstall,
    onUpdateConfig,
  }: {
    extension: ManagedExtension;
    config: MockExtensionSettings;
    busy?: boolean;
    onClose: () => void;
    onInstall: (extension: ManagedExtension) => void;
    onUpdateConfig: (pkgName: string, patch: MockExtensionSettingsPatch) => void;
  } = $props();

  const description = $derived(
    extension.isInstalled
      ? `Manage runtime preferences, sync behavior, and credentials for ${extension.name}.`
      : `${extension.name} is available from your configured repositories. Install it before changing extension preferences.`,
  );
  const originLabel = $derived(extension.kind === "novels" ? "LNReader source" : "Suwayomi extension");
  const repositoryLabel = $derived(
    extension.kind === "novels"
      ? extension.repositoryUrl || "Local novel repository"
      : extension.apkName || "Extension repository",
  );
  const artifactLabel = $derived(
    extension.kind === "novels"
      ? extension.apkName || extension.novelPluginId || "Novel plugin"
      : extension.apkName || "Repository package",
  );
  const installStateLabel = $derived(
    extension.hasUpdate
      ? "Update available"
      : extension.isInstalled
        ? "Installed"
        : "Available",
  );

  function update(patch: MockExtensionSettingsPatch) {
    onUpdateConfig(extension.pkgName, patch);
  }
</script>

<div class="settingsBackdrop" onclick={onClose} aria-hidden="true"></div>

<aside class="settingsPanel" aria-label={`Settings for ${extension.name}`}>
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
      <X size={15} weight="bold" />
    </button>
  </header>

  <p class="description">{description}</p>

  <section class="detailsSection">
    <div class="detailTopline">
      <span>{$_("ui_extensionDetails")}</span>
      <small>{originLabel}</small>
    </div>
    <div class="detailsGrid">
      <div class="detailItem">
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
        <span class="fieldLabel">{extension.kind === "novels" ? "Repository" : "Artifact"}</span>
        <strong>{repositoryLabel}</strong>
      </div>
      <div class="detailItem detailItemWide">
        <span class="fieldLabel">{extension.kind === "novels" ? $_("ui_pluginArtifact") : $_("ui_apkPackage")}</span>
        <strong>{artifactLabel}</strong>
      </div>
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

  {#if !extension.isInstalled}
    <section class="availablePanel">
      <button class="primaryCta" type="button" disabled={busy} onclick={() => onInstall(extension)}>
        {busy ? "Installing..." : $_("ui_installExtension")}
      </button>
    </section>
  {:else}
    <section class="settingsSection">
      <div class="sectionTitle">
        <span>{$_("ui_runtime")}</span>
        <small>{$_("ui_autosaved")}</small>
      </div>

      <label class="toggleRow">
        <span>
          <strong>{$_("ui_enabled")}</strong>
          <small>{$_("ui_allowThisExtensionToAppearAcrossSourceAware")}</small>
        </span>
        <input
          type="checkbox"
          checked={config.isEnabled}
          onchange={(event) => update({ isEnabled: (event.currentTarget as HTMLInputElement).checked })}
        />
      </label>

      <label class="formRow">
        <span>{$_("ui_syncInterval")}</span>
        <select
          value={config.syncInterval}
          onchange={(event) => update({ syncInterval: (event.currentTarget as HTMLSelectElement).value as MockExtensionSettings["syncInterval"] })}
        >
          <option value="manual">{$_("ui_manual")}</option>
          <option value="hourly">{$_("ui_hourly")}</option>
          <option value="daily">{$_("ui_daily")}</option>
          <option value="weekly">{$_("ui_weekly")}</option>
        </select>
      </label>

      <label class="formRow">
        <span>{$_("ui_languagePreference")}</span>
        <input
          value={config.languagePref}
          placeholder={extension.lang}
          oninput={(event) => update({ languagePref: (event.currentTarget as HTMLInputElement).value })}
        />
      </label>

      <label class="toggleRow">
        <span>
          <strong>{$_("ui_autoUpdate")}</strong>
          <small>{$_("ui_keepThisExtensionUpdatedWhenRepositoryMetadataChanges")}</small>
        </span>
        <input
          type="checkbox"
          checked={config.autoUpdate}
          onchange={(event) => update({ autoUpdate: (event.currentTarget as HTMLInputElement).checked })}
        />
      </label>
    </section>

    <section class="settingsSection">
      <div class="sectionTitle">
        <span>{$_("ui_credentials")}</span>
        <small>{$_("ui_mockLocalState")}</small>
      </div>

      <label class="formRow">
        <span>{$_("ui_username")}</span>
        <input
          value={config.credentials.username}
          placeholder={$_("ui_optionalUsername")}
          oninput={(event) => update({ credentials: { username: (event.currentTarget as HTMLInputElement).value } })}
        />
      </label>

      <label class="formRow">
        <span>{$_("ui_token")}</span>
        <input
          value={config.credentials.token}
          placeholder={$_("ui_optionalToken")}
          type="password"
          oninput={(event) => update({ credentials: { token: (event.currentTarget as HTMLInputElement).value } })}
        />
      </label>
    </section>

    <footer class="settingsFooter">
      <span>{$_("ui_lastLocalSave")}</span>
      <strong>{new Date(config.updatedAt).toLocaleString()}</strong>
    </footer>
  {/if}
</aside>

<style>
  .settingsBackdrop {
    display: none;
  }

  .settingsPanel {
    width: clamp(300px, 22vw, 360px);
    min-width: 292px;
    height: 100%;
    overflow-y: auto;
    border-left: 1px solid rgba(255, 255, 255, 0.055);
    background:
      radial-gradient(circle at 20% 0%, rgba(184, 167, 234, 0.08), transparent 36%),
      rgba(16, 15, 21, 0.92);
    padding: calc(12px * var(--n-hud-scale));
    animation: panelIn 160ms ease both;
  }

  .settingsHeader,
  .extensionIdentity,
  .extensionMeta,
  .sectionTitle,
  .settingsFooter {
    display: flex;
    align-items: center;
  }

  .settingsHeader {
    justify-content: space-between;
    gap: 10px;
  }

  .extensionIdentity {
    gap: 9px;
    min-width: 0;
  }

  .extensionIcon {
    width: 32px;
    height: 32px;
    border-radius: 9px;
    object-fit: cover;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
  }

  .identityCopy {
    min-width: 0;
  }

  .eyebrow,
  .fieldLabel,
  .detailTopline small,
  .sectionTitle small,
  .settingsFooter span {
    font-family: var(--font-ui);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(202, 196, 208, 0.48);
  }

  h2 {
    margin: 2px 0;
    font-size: 14px;
    line-height: 1.15;
    color: rgba(244, 241, 243, 0.92);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .extensionMeta {
    gap: 5px;
    flex-wrap: wrap;
  }

  .extensionMeta span {
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 999px;
    padding: 1px 6px;
    font-family: var(--font-ui);
    font-size: 9px;
    color: rgba(229, 226, 225, 0.58);
    background: rgba(255, 255, 255, 0.028);
  }

  .closeBtn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: 0 0 auto;
    border-radius: 8px;
    color: rgba(229, 226, 225, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.055);
    background: rgba(255, 255, 255, 0.025);
    transition: color 160ms ease, background 160ms ease, border-color 160ms ease;
  }

  .closeBtn:hover {
    color: rgba(244, 241, 243, 0.9);
    border-color: rgba(184, 167, 234, 0.22);
    background: rgba(184, 167, 234, 0.1);
  }

  .description {
    margin: 9px 0 10px;
    color: rgba(202, 196, 208, 0.62);
    font-size: 12px;
    line-height: 1.45;
  }

  .availablePanel,
  .detailsSection,
  .settingsSection {
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.022);
    padding: 10px;
  }

  .detailsSection {
    display: grid;
    gap: 8px;
    margin-bottom: 8px;
  }

  .detailTopline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .detailTopline span {
    color: rgba(244, 241, 243, 0.9);
    font-size: 12px;
    font-weight: 900;
  }

  .availablePanel {
    display: grid;
    gap: 12px;
  }

  .detailsGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 7px;
  }

  .detailItem {
    display: grid;
    gap: 3px;
    min-width: 0;
    padding: 7px;
    border-radius: 9px;
    background: rgba(7, 7, 11, 0.24);
    border: 1px solid rgba(255, 255, 255, 0.04);
  }

  .detailItemWide,
  .detailWarning {
    grid-column: 1 / -1;
  }

  .detailWarning {
    padding: 8px;
    border-radius: 10px;
    color: rgba(255, 214, 153, 0.82);
    background: rgba(255, 214, 153, 0.07);
    border: 1px solid rgba(255, 214, 153, 0.12);
    font-size: 11px;
    line-height: 1.35;
  }

  .detailItem strong,
  .settingsFooter strong {
    color: rgba(229, 226, 225, 0.74);
    font-size: 11px;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .primaryCta {
    min-height: 34px;
    border-radius: 11px;
    background: var(--n-primary);
    color: #211933;
    font-weight: 900;
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 14px 30px rgba(184, 167, 234, 0.16);
  }

  .primaryCta:disabled {
    opacity: 0.55;
  }

  .settingsSection {
    display: grid;
    gap: 8px;
    margin-top: 8px;
  }

  .sectionTitle {
    justify-content: space-between;
  }

  .sectionTitle span {
    font-size: 12px;
    font-weight: 900;
    color: rgba(244, 241, 243, 0.9);
  }

  .toggleRow,
  .formRow {
    display: grid;
    gap: 6px;
    color: rgba(229, 226, 225, 0.74);
    font-size: 11px;
    font-weight: 800;
  }

  .toggleRow {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }

  .toggleRow small {
    display: block;
    margin-top: 3px;
    color: rgba(202, 196, 208, 0.46);
    font-weight: 600;
    line-height: 1.35;
  }

  input,
  select {
    min-height: 30px;
    border-radius: 9px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(7, 7, 11, 0.42);
    color: rgba(244, 241, 243, 0.86);
    padding: 0 12px;
    outline: none;
    font: inherit;
  }

  input:focus,
  select:focus {
    border-color: rgba(184, 167, 234, 0.36);
  }

  input[type="checkbox"] {
    appearance: none;
    width: 34px;
    height: 20px;
    min-height: 20px;
    border-radius: 999px;
    padding: 0;
    background: rgba(255, 255, 255, 0.18);
    position: relative;
    transition: background 160ms ease;
  }

  input[type="checkbox"]::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: rgba(244, 241, 243, 0.85);
    transition: transform 160ms ease;
  }

  input[type="checkbox"]:checked {
    background: rgba(184, 167, 234, 0.78);
  }

  input[type="checkbox"]:checked::after {
    transform: translateX(14px);
  }

  .settingsFooter {
    justify-content: space-between;
    gap: 12px;
    margin-top: 10px;
    padding-top: 9px;
    border-top: 1px solid rgba(255, 255, 255, 0.055);
  }

  @media (max-width: 760px) {
    .settingsBackdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 80;
      background: rgba(0, 0, 0, 0.56);
      animation: fadeIn 140ms ease both;
    }

    .settingsPanel {
      position: fixed;
      inset: auto 0 0;
      z-index: 81;
      width: 100%;
      min-width: 0;
      max-height: min(86vh, 760px);
      height: auto;
      border-left: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px 24px 0 0;
      box-shadow: 0 -24px 80px rgba(0, 0, 0, 0.44);
      animation: sheetIn 180ms ease both;
    }
  }

  @keyframes panelIn {
    from { opacity: 0; transform: translateX(10px); }
    to { opacity: 1; transform: translateX(0); }
  }

  @keyframes sheetIn {
    from { opacity: 0; transform: translateY(18px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
