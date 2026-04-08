<script lang="ts">
  import { House, Books, MagnifyingGlass, DownloadSimple, GearSix, CircleNotch } from "phosphor-svelte";
  import { store, setNavPage, openHomeDashboard } from "../../store/state.svelte";
  import type { NavPage } from "../../store/state.svelte";

  const MAIN_TABS: { id: NavPage; label: string; icon: any }[] = [
    { id: "home",       label: "Home",       icon: House },
    { id: "library",    label: "Library",    icon: Books },
    { id: "search",     label: "Browse",     icon: MagnifyingGlass },
  ];

  const UTILITY_TABS: { id: NavPage; label: string; icon: any }[] = [
    { id: "downloads",  label: "Downloads",  icon: DownloadSimple },
  ];

  const activeDownloadCount = $derived(
    store.activeDownloads.filter(item => item.state === "QUEUED" || item.state === "DOWNLOADING" || !item.state).length,
  );
  const failedDownloadCount = $derived(
    store.activeDownloads.filter(item => item.state === "ERROR").length,
  );
  const hasDownloadActivity = $derived(activeDownloadCount > 0);
  const hasDownloadError = $derived(!hasDownloadActivity && failedDownloadCount > 0);

  function navigate(id: NavPage) {
    setNavPage(id);
    store.activeManga = null;
    store.genreFilter = "";
    if (id !== "search") store.activeSource = null;
  }

  function goHome() {
    openHomeDashboard();
    store.activeSource  = null;
    store.activeManga   = null;
    store.libraryFilter = "library";
    store.genreFilter   = "";
  }
</script>

<aside class="root">
  <button class="logo" onclick={goHome} title="Home" aria-label="Go to Home">
    <div class="logo-icon"></div>
  </button>
  <nav class="nav">
    {#each MAIN_TABS as tab}
      <button class="tab" class:active={store.navPage === tab.id}
        title={tab.label} onclick={() => navigate(tab.id)}>
        <tab.icon size={18} weight="light" />
      </button>
    {/each}
  </nav>
  <div class="bottom">
    {#each UTILITY_TABS as tab}
      <button class="tab" class:active={store.navPage === tab.id}
        class:download-active={tab.id === "downloads" && hasDownloadActivity}
        class:download-error={tab.id === "downloads" && hasDownloadError}
        title={tab.id === "downloads" && hasDownloadActivity ? `Downloads (${activeDownloadCount})` : tab.id === "downloads" && hasDownloadError ? `Downloads failed (${failedDownloadCount})` : tab.label}
        aria-label={tab.id === "downloads" && hasDownloadActivity ? `Downloads, ${activeDownloadCount} active` : tab.id === "downloads" && hasDownloadError ? `Downloads, ${failedDownloadCount} failed` : tab.label}
        onclick={() => navigate(tab.id)}>
        {#if tab.id === "downloads" && hasDownloadActivity}
          <CircleNotch size={18} weight="light" class="anim-spin" />
        {:else}
          <tab.icon size={18} weight={tab.id === "downloads" && hasDownloadError ? "fill" : "light"} />
        {/if}
        {#if tab.id === "downloads" && hasDownloadActivity}
          <span class="download-badge">{activeDownloadCount}</span>
        {:else if tab.id === "downloads" && hasDownloadError}
          <span class="download-badge download-badge-error">!</span>
        {/if}
      </button>
    {/each}
    <button class="settings-btn" class:active={store.settingsOpen} onclick={() => store.settingsOpen = true} title="Settings">
      <GearSix size={18} weight="light" />
    </button>
  </div>
</aside>

<style>
  .root { width: var(--sidebar-width); flex-shrink: 0; background: var(--bg-void); display: flex; flex-direction: column; align-items: center; padding: var(--sp-4) 0; overflow: hidden; min-height: 0; height: 100%; }
  .logo { width: 80px; height: 80px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; margin-bottom: var(--sp-3); background: none; border: none; outline: none; cursor: pointer; border-radius: var(--radius-lg); transition: opacity var(--t-base), transform var(--t-base); padding: 0; appearance: none; -webkit-appearance: none; }
  .logo:hover { opacity: 0.8; transform: scale(0.96); }
  .logo:active { transform: scale(0.92); }
  .logo:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .logo-icon { width: 67px; height: 67px; background-color: var(--accent); mask-image: url("../../assets/moku-icon-wordmark.svg"); mask-repeat: no-repeat; mask-position: center; mask-size: contain; -webkit-mask-image: url("../../assets/moku-icon-wordmark.svg"); -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; -webkit-mask-size: contain; filter: drop-shadow(0 0 8px rgba(107,143,107,0.35)); pointer-events: none; }
  .nav { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); width: 100%; padding: 0 var(--sp-2); overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
  .nav::-webkit-scrollbar { display: none; }
  .tab { position: relative; width: 36px; height: 36px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-md); color: var(--text-faint); background: none; border: none; outline: none; cursor: pointer; padding: 0; appearance: none; -webkit-appearance: none; transition: color var(--t-base), background var(--t-base); }
  .tab:hover { color: var(--text-muted); background: var(--bg-raised); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tab.active { color: var(--accent-fg); background: var(--accent-muted); }
  .tab.active:hover { color: var(--accent-fg); background: var(--accent-muted); }
  .tab.download-active {
    color: var(--accent-fg);
    background: var(--accent-muted);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent), 0 0 18px color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .tab.download-error {
    color: var(--color-error);
    background: var(--color-error-bg);
  }
  .download-badge {
    position: absolute;
    right: 3px;
    bottom: 3px;
    min-width: 13px;
    height: 13px;
    padding: 0 3px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-ui);
    font-size: 9px;
    line-height: 1;
    color: var(--bg-void);
    background: var(--accent-fg);
    border: 1px solid var(--bg-void);
    box-sizing: border-box;
  }
  .download-badge-error {
    color: #fff;
    background: var(--color-error);
  }
  .bottom { flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); width: 100%; padding: var(--sp-3) var(--sp-2) 0; border-top: 1px solid var(--border-dim); margin-top: var(--sp-3); }
  .settings-btn { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-md); color: var(--text-faint); background: none; border: none; outline: none; cursor: pointer; padding: 0; appearance: none; -webkit-appearance: none; transition: color var(--t-base), background var(--t-base), transform var(--t-slow); }
  .settings-btn:hover { color: var(--text-muted); background: var(--bg-raised); transform: rotate(30deg); }
  .settings-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .settings-btn.active { color: var(--accent-fg); background: var(--accent-muted); transform: none; }
</style>
