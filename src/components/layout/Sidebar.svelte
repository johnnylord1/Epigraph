<script lang="ts">
  import { _ } from "svelte-i18n";
  import splashMark from "../../assets/aethon-splash-mark.png";
  import { store, setNavPage, setSettingsOpen, openHomeDashboard } from "../../store/state.svelte";
  import type { NavPage } from "../../store/state.svelte";

  const MAIN_TABS: Array<{ id: Exclude<NavPage, "settings">; labelKey: string }> = [
    { id: "home", labelKey: "shell.navigation.home" },
    { id: "library", labelKey: "shell.navigation.library" },
    { id: "search", labelKey: "shell.navigation.browse" },
    { id: "downloads", labelKey: "shell.navigation.downloads" },
  ];

  const activeDownloadCount = $derived(
    store.activeDownloads.filter((item) => item.state === "QUEUED" || item.state === "DOWNLOADING" || !item.state).length,
  );
  const failedDownloadCount = $derived(
    store.activeDownloads.filter((item) => item.state === "ERROR").length,
  );
  const hasDownloadActivity = $derived(activeDownloadCount > 0);
  const hasDownloadError = $derived(!hasDownloadActivity && failedDownloadCount > 0);

  function navigate(id: Exclude<NavPage, "settings">) {
    setNavPage(id);
  }

  function goHome() {
    openHomeDashboard();
  }
</script>

<aside class="n-sidebar" aria-label={$_("shell.navigation.primary")}>
  <button
    class="n-sidebar__brand"
    type="button"
    title={$_("shell.navigation.home")}
    aria-label={$_("shell.navigation.goHome")}
    onclick={goHome}
  >
    <img src={splashMark} alt={$_("shell.navigation.logoAlt")} />
  </button>

  <nav class="n-sidebar__nav" aria-label={$_("shell.navigation.primary")}>
    {#each MAIN_TABS as tab}
    <button
      class="n-sidebar-btn"
      class:is-active={store.navPage === tab.id}
      class:download-active={tab.id === "downloads" && hasDownloadActivity}
      class:download-error={tab.id === "downloads" && hasDownloadError}
      data-tooltip={$_(tab.labelKey)}
      type="button"
        aria-label={$_(tab.labelKey)}
        title={$_(tab.labelKey)}
        onclick={() => navigate(tab.id)}
      >
        <span class="n-icon" aria-hidden="true"></span>
        {#if tab.id === "downloads" && hasDownloadActivity}
          <span class="n-sidebar-badge">{activeDownloadCount}</span>
        {:else if tab.id === "downloads" && hasDownloadError}
          <span class="n-sidebar-badge n-sidebar-badge--error">!</span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="n-sidebar__footer">
    <button
      class="n-sidebar-btn"
      class:is-active={store.navPage === "settings"}
      data-tooltip={$_("shell.navigation.settings")}
      type="button"
      title={$_("shell.navigation.settings")}
      aria-label={$_("shell.navigation.settings")}
      onclick={() => setSettingsOpen(true)}
    >
      <span class="n-icon" aria-hidden="true"></span>
    </button>
  </div>
</aside>
