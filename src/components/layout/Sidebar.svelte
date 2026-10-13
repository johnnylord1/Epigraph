<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import splashMark from "../../assets/epigraph-splash-mark.png";
  import { store, setNavPage, setSettingsOpen, openHomeDashboard } from "../../store/state.svelte";
  import type { NavPage } from "../../store/state.svelte";
  import { flushSync } from "svelte";
  import { swapPage } from "../../lib/motion/motion";

  const MAIN_TABS: Array<{ id: Exclude<NavPage, "settings">; labelKey: string }> = [
    { id: "home", labelKey: "shell.navigation.home" },
    { id: "library", labelKey: "shell.navigation.library" },
    { id: "search", labelKey: "shell.navigation.browse" },
    { id: "downloads", labelKey: "shell.navigation.downloads" },
  ];
  const SIDEBAR_ICONS: Record<Exclude<NavPage, "settings"> | "settings", { idle: string; active: string }> = {
    home: { idle: "home", active: "roofing" },
    library: { idle: "book_2", active: "menu_book" },
    search: { idle: "explore", active: "travel_explore" },
    downloads: { idle: "download", active: "cloud_download" },
    settings: { idle: "settings", active: "admin_panel_settings" },
  };

  function sidebarIcon(id: Exclude<NavPage, "settings"> | "settings") {
    return shownNav === id ? SIDEBAR_ICONS[id].active : SIDEBAR_ICONS[id].idle;
  }

  const activeDownloadCount = $derived(
    store.activeDownloads.filter((item) => item.state === "QUEUED" || item.state === "DOWNLOADING" || !item.state).length,
  );
  const failedDownloadCount = $derived(
    store.activeDownloads.filter((item) => item.state === "ERROR").length,
  );
  const hasDownloadActivity = $derived(activeDownloadCount > 0);
  const hasDownloadError = $derived(!hasDownloadActivity && failedDownloadCount > 0);

  // The pressed destination lights up in the click's frame; the page swap (a heavy render) waits
  // under a cross-fade from the old page, so the highlight glides instead of jumping after the render.
  let pendingNav = $state<NavPage | null>(null);
  const shownNav = $derived(pendingNav ?? store.navPage);

  function commitNav(id: NavPage, commit: () => void) {
    if (pendingNav === id || (pendingNav === null && store.navPage === id)) {
      commit();
      return;
    }
    pendingNav = id;
    swapPage(() => {
      commit();
      if (pendingNav === id) pendingNav = null;
      flushSync();
    });
  }

  function navigate(id: Exclude<NavPage, "settings">) {
    commitNav(id, () => setNavPage(id));
  }

  function goHome() {
    openHomeDashboard();
  }

  // One highlight travels between the main destinations instead of each button toggling its own
  // background; it hides while Settings (in the footer) is the active page.
  let navElement = $state<HTMLElement>();
  let indicatorOffset = $state<number | null>(null);
  $effect(() => {
    const page = shownNav;
    const nav = navElement;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector<HTMLElement>(`.n-sidebar-btn[data-nav-id="${page}"]`);
      indicatorOffset = active ? active.offsetTop : null;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  });
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

  <nav class="n-sidebar__nav" aria-label={$_("shell.navigation.primary")} bind:this={navElement}>
    <span
      class="n-sidebar__indicator"
      class:is-hidden={indicatorOffset === null}
      style:transform={`translateY(${indicatorOffset ?? 0}px)`}
      aria-hidden="true"
    ></span>
    {#each MAIN_TABS as tab}
    <button
      class="n-sidebar-btn"
      class:is-active={shownNav === tab.id}
      class:download-active={tab.id === "downloads" && hasDownloadActivity}
      class:download-error={tab.id === "downloads" && hasDownloadError}
      data-nav-id={tab.id}
      data-ripple="off"
      data-tooltip={$_(tab.labelKey)}
      type="button"
        aria-label={$_(tab.labelKey)}
        onclick={() => navigate(tab.id)}
      >
        <span class="n-icon material-symbols-outlined" aria-hidden="true">{sidebarIcon(tab.id)}</span>
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
      class:is-active={shownNav === "settings"}
      data-nav-id="settings"
      data-tooltip={$_("shell.navigation.settings")}
      type="button"
      aria-label={$_("shell.navigation.settings")}
      onclick={() => commitNav("settings", () => setSettingsOpen(true))}
    >
      <span class="n-icon material-symbols-outlined" aria-hidden="true">{sidebarIcon("settings")}</span>
    </button>
  </div>
</aside>
