<script lang="ts">
  import splashMark from "../../assets/aethon-splash-mark.png";
  import { store, setNavPage, setSettingsOpen, openHomeDashboard } from "../../store/state.svelte";
  import type { NavPage } from "../../store/state.svelte";

  const MAIN_TABS: Array<{ id: Exclude<NavPage, "settings">; label: string }> = [
    { id: "home", label: "Home" },
    { id: "library", label: "Library" },
    { id: "search", label: "Browse" },
    { id: "downloads", label: "Downloads" },
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

<aside class="n-sidebar" aria-label="Primary navigation">
  <button
    class="n-sidebar__brand"
    type="button"
    title="Home"
    aria-label="Go to Home"
    onclick={goHome}
  >
    <img src={splashMark} alt="Aethon Logo" />
  </button>

  <nav class="n-sidebar__nav" aria-label="Primary">
    {#each MAIN_TABS as tab}
    <button
      class="n-sidebar-btn"
      class:is-active={store.navPage === tab.id}
      class:download-active={tab.id === "downloads" && hasDownloadActivity}
      class:download-error={tab.id === "downloads" && hasDownloadError}
      data-tooltip={tab.label}
      type="button"
        aria-label={tab.label}
        title={tab.label}
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
      data-tooltip="Settings"
      type="button"
      title="Settings"
      aria-label="Settings"
      onclick={() => setSettingsOpen(true)}
    >
      <span class="n-icon" aria-hidden="true"></span>
    </button>
  </div>
</aside>
