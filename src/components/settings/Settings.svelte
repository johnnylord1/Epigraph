<script lang="ts">
  import { tick } from "svelte";
  import { slide } from "svelte/transition";
  import { Book, Image, Sliders, Info, Keyboard, Gear, HardDrives, FolderSimple, Plus, Pencil, Trash, Wrench, PaintBrush, ListChecks, Lock, Eye, EyeSlash, Star, ShieldCheck, Tag, CaretDown } from "phosphor-svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getVersion } from "@tauri-apps/api/app";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { gql, gqlUpload, thumbUrl, getServerAuthHeader, serverFileUrl } from "../../lib/client";
  import {
    BUILTIN_LOCAL_PROFILES,
    DEFAULT_LOCAL_PROFILE_ID,
    getLocalProfileMeta,
    normalizeLocalProfileId,
    type LocalProfileId,
  } from "../../lib/localProfiles";
  import { getEffectiveServerUrl } from "../../lib/serverTarget";
  import type { AethonBackupPayloadBuildInput } from "../../lib/backup/aethonBackup";
  import type {
    AethonPayloadRestorePlan,
    AethonRestorePlan,
    AethonRestorePlannerRuntime,
  } from "../../lib/backup/aethonRestorePlanner";
  import {
    buildRestoreRelaunchArgs,
    currentProfileSupportsOtherLocalTarget,
    defaultExecutionSelection,
    describeRestoreTarget,
    detectBackupImportKind,
    executionBlockedReasonForProfile,
    hasAnyExecutableSelection,
    isPayloadExecutable,
    normalizeBackupSavePath,
    resolveOtherLocalProfileId,
    selectedExecutablePayloadKinds,
    type BackupExecutionSelection,
    type BackupExportMode,
    type BackupImportKind,
    type BackupLaunchIntent,
    type RestoreTargetMode,
  } from "../../lib/backup/backupRollout";
  import type { AethonNovelRuntimeState } from "../../lib/backup/novelsBackup";
  import { findMissingSourceExtensionSuggestions, type MissingSourceExtensionSuggestion } from "../../lib/extensionSourceMap";
  import { normalizeCategories } from "../../lib/library/categories";
  import { GET_CATEGORIES, CREATE_CATEGORY, UPDATE_CATEGORY, UPDATE_CATEGORY_UPDATE_RULE, DELETE_CATEGORY, UPDATE_CATEGORY_ORDER, GET_LIBRARY, GET_LIBRARY_TRACKING_SUMMARY, GET_SOURCES } from "../../lib/queries";
  import { GET_DOWNLOADS_PATH, SET_DOWNLOADS_PATH, SET_LOCAL_SOURCE_PATH, GET_TRACKERS, LOGIN_TRACKER_OAUTH, LOGIN_TRACKER_CREDENTIALS, LOGOUT_TRACKER, GET_TRACKER_RECORDS, GET_SERVER_SECURITY, SET_SERVER_AUTH, SET_SOCKS_PROXY, SET_FLARESOLVERR, CREATE_BACKUP, RESTORE_BACKUP, GET_RESTORE_STATUS, UPDATE_EXTENSION } from "../../lib/queries";
  import { buildRestoreReadiness } from "../../lib/reconciliation/readiness";
  import { normalizeTrackerOAuthInput, trackerOAuthParamName } from "../../lib/trackerOAuth";
  import {
    connectHardcover,
    disconnectHardcover,
    loadHardcoverState,
    type HardcoverTrackingState,
  } from "../../lib/novels/hardcover";
  import type { Category, Source, Extension } from "../../lib/types";
  import { BOOKS_FILTER_OPTIONS } from "../../lib/library/booksSection";
  import {
    countBooksForCategory,
    createBooksCategory,
    deleteBooksCategory,
    moveBooksCategory,
    normalizeBooksCategoryAssignments,
    renameBooksCategory,
    sortBooksCategories,
  } from "../../lib/library/domainCategories";
  import splashMark from "../../assets/aethon-splash-mark.png";
  import AppTopbar from "../layout/AppTopbar.svelte";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import SyncdConnectionPanel from "./SyncdConnectionPanel.svelte";
  import { store, updateSettings, resetSettings, resetKeybinds, clearHistory, wipeAllData, setSettingsOpen, setRuntimeSettingsTab, deleteCustomTheme, toggleHiddenCategory, setCategories, setLibraryMangaSnapshot, setLibraryTrackingSummarySnapshot, addToast, openSearchSources, replaceAppReadingState, replaceBooksState, DEFAULT_READING_STATS } from "../../store/state.svelte";
  import { cache } from "../../lib/cache";
  import { KEYBIND_LABELS, DEFAULT_KEYBINDS, eventToKeybind } from "../../lib/keybinds";
  import type { HistoryEntry, ReadLogEntry, ReadingStats, Settings, FitMode, Theme, BooksCategory, BooksLibraryStatusFilter, BooksLibraryTypeFilter, RuntimeSettingsTab } from "../../store/state.svelte";
  import type { Keybinds } from "../../lib/keybinds";
  import type { Tracker } from "../../lib/types";
  import type { AvailableExtensionEntry, OverlayEntry, ParsedBackup, ReconciliationAnalysis, ReconciliationClusterResult, RestoreReadinessSummary, SourceInventoryEntry } from "../../lib/reconciliation/types";
  import { SETTINGS_AETHON_BACKUP_EXTENSION, loadSettingsStorageRuntime } from "./settingsStorageRuntime";
  interface Props {
    onOpenThemeEditor?: (id?: string | null) => void;
    backupAuditPlan?: AethonRestorePlan | null;
    backupRestoreLaunchIntent?: BackupLaunchIntent | null;
  }
  let { onOpenThemeEditor, backupAuditPlan = null, backupRestoreLaunchIntent = null }: Props = $props();
  type Tab = "general" | "appearance" | "reader" | "library" | "performance" | "keybinds" | "storage" | "categories" | "tracking" | "security" | "content" | "about" | "devtools";
  type SettingsGroupId = "app" | "reader-library" | "content" | "system" | "advanced";
  type SettingsNavItem = { id: Tab; label: string; desc: string; icon: any };
  type SettingsNavGroup = { id: SettingsGroupId; label: string; icon: any; items: SettingsNavItem[] };
  type FlareTestState = "idle" | "testing" | "ready" | "not-reachable" | "check-url";
  type DockerFlareSolverrStatus = {
    installed: boolean;
    daemon: boolean;
    running: boolean;
    version: string | null;
    message: string | null;
  };
  type LocalFlareSolverrStatus = {
    installed: boolean;
    running: boolean;
    path: string | null;
    message: string | null;
  };
  const SETTINGS_GROUPS: SettingsNavGroup[] = [
    {
      id: "app",
      label: "App",
      icon: Gear,
      items: [
        { id: "general",    label: "General",    desc: "Core desktop behavior, launch flow, profiles and everyday shell defaults.", icon: Gear       },
        { id: "appearance", label: "Appearance", desc: "Theme, surfaces, accent tuning and visual polish.",                            icon: PaintBrush },
        { id: "keybinds",   label: "Keybinds",   desc: "Keyboard shortcuts and desktop interaction patterns.",                         icon: Keyboard   },
      ],
    },
    {
      id: "reader-library",
      label: "Reader & Library",
      icon: Book,
      items: [
        { id: "reader",     label: "Reader",     desc: "Reading modes, direction, zoom and chapter flow defaults.",  icon: Book         },
        { id: "library",    label: "Library",    desc: "Card density, overlays, layout defaults and browsing behavior.", icon: Image     },
        { id: "categories", label: "Categories", desc: "Comics and books category management.",                      icon: FolderSimple },
      ],
    },
    {
      id: "content",
      label: "Content & Integrations",
      icon: ShieldCheck,
      items: [
        { id: "content",    label: "Content",    desc: "Blocked tags, source visibility and NSFW controls.", icon: ShieldCheck },
        { id: "tracking",   label: "Tracking",   desc: "Connected tracking providers and sync state.",        icon: ListChecks  },
      ],
    },
    {
      id: "system",
      label: "System",
      icon: HardDrives,
      items: [
        { id: "storage",     label: "Storage",     desc: "Paths, usage, backup and local content management.",     icon: HardDrives },
        { id: "performance", label: "Performance", desc: "GPU usage, rendering limits and runtime responsiveness.", icon: Sliders    },
        { id: "security",    label: "Security",    desc: "PIN, proxy, FlareSolverr and trust-sensitive settings.", icon: Lock       },
      ],
    },
    {
      id: "advanced",
      label: "Advanced",
      icon: Wrench,
      items: [
        { id: "about",      label: "About",      desc: "Version, update flow and project information.", icon: Info   },
        { id: "devtools",   label: "Dev Tools",  desc: "Debug actions and internal preview helpers.",   icon: Wrench },
      ],
    },
  ];
  const TAB_LABELS: Record<Tab, string> = Object.fromEntries(
    SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label] as const))
  ) as Record<Tab, string>;
  const TAB_DESCRIPTIONS: Record<Tab, string> = {
    general: "App defaults, profiles, startup behavior, and language preferences.",
    appearance: "Theme, motion, and shell presentation across the desktop app.",
    reader: "Reading defaults and layout controls shared by the active reader surfaces.",
    library: "Library density, browse behavior, and presentation defaults.",
    performance: "Runtime controls that affect startup, caching, and responsiveness.",
    keybinds: "Keyboard shortcuts and remappable desktop actions.",
    storage: "Downloads, imports, backup, restore, and profile-scoped data.",
    categories: "Books category organization and assignment rules.",
    tracking: "Tracker sign-in and progress integration settings.",
    security: "Server auth, proxying, and request hardening options.",
    content: "Source filtering, blocked tags and content visibility rules.",
    about: "Versioning, releases, and update entry points.",
    devtools: "Internal diagnostics and developer-only surfaces.",
  };
  const TAB_TO_GROUP: Record<Tab, SettingsGroupId> = Object.fromEntries(
    SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => [item.id, group.id] as const))
  ) as Record<Tab, SettingsGroupId>;
  const DEFAULT_TAB_BY_GROUP: Record<SettingsGroupId, Tab> = Object.fromEntries(
    SETTINGS_GROUPS.map((group) => [group.id, group.items[0].id] as const)
  ) as Record<SettingsGroupId, Tab>;
  const SETTINGS_SEARCH_KEYWORDS: Record<Tab, string[]> = {
    general: ["interface scale", "profile", "server", "autostart", "idle", "discord", "language", "startup", "zoom"],
    appearance: ["theme", "oled", "accent", "visual", "surface", "custom themes", "editor"],
    keybinds: ["keyboard", "shortcuts", "bindings", "keys", "reset"],
    reader: ["reading", "direction", "fit", "zoom", "page style", "bookmarks"],
    library: ["density", "layout", "cards", "library", "books", "browse"],
    categories: ["categories", "folders", "hidden", "books categories", "assignments"],
    content: ["blocked tags", "nsfw", "sources", "allowed", "blocked", "repositories"],
    tracking: ["tracker", "oauth", "credentials", "sync", "anilist", "mal", "provider"],
    storage: ["downloads", "paths", "backup", "restore", "reconciliation", "scan", "disk"],
    performance: ["gpu", "render", "prefetch", "cache", "performance", "webview"],
    security: ["pin", "proxy", "auth", "socks", "flaresolverr", "security"],
    about: ["version", "release", "update", "github", "discord", "about"],
    devtools: ["debug", "splash", "dev", "build info", "tools"],
  };
  const SETTINGS_SEARCHABLE_SELECTOR = [
    ".section-title",
    ".toggle-label",
    ".toggle-desc",
    ".kb-label",
    ".folder-row-name",
    ".folder-row-count",
    ".tracker-label",
    ".tracker-status-pill",
    ".about-line",
    ".theme-card-label",
    ".theme-card-desc",
    ".profile-status-label",
    ".profile-status-value",
    ".profile-status-meta",
    ".content-source-name",
    ".content-source-lang",
    ".content-tag",
    ".settings-mini-row__label",
    ".settings-mini-row__hint",
  ].join(", ");
  type PaneRenderPolicy = {
    shell: "mounted";
    subtree: "mounted" | "lazy";
    continuity: string[];
  };
  const SETTINGS_PANE_RENDER_POLICY: Record<Tab, PaneRenderPolicy> = {
    general: { shell: "mounted", subtree: "mounted", continuity: [] },
    appearance: { shell: "mounted", subtree: "mounted", continuity: [] },
    keybinds: { shell: "mounted", subtree: "mounted", continuity: [] },
    reader: { shell: "mounted", subtree: "mounted", continuity: [] },
    library: { shell: "mounted", subtree: "mounted", continuity: [] },
    categories: { shell: "mounted", subtree: "mounted", continuity: [] },
    content: { shell: "mounted", subtree: "mounted", continuity: [] },
    tracking: {
      shell: "mounted",
      subtree: "lazy",
      continuity: ["selection", "filters", "oauth state", "provider context"],
    },
    storage: {
      shell: "mounted",
      subtree: "lazy",
      continuity: ["scroll", "selection", "filters", "expansion state", "toolbar context"],
    },
    performance: { shell: "mounted", subtree: "mounted", continuity: [] },
    security: { shell: "mounted", subtree: "mounted", continuity: [] },
    about: { shell: "mounted", subtree: "mounted", continuity: [] },
    devtools: { shell: "mounted", subtree: "mounted", continuity: [] },
  };
  const LAZY_TAB_SUBTREES = new Set<Tab>(
    (Object.entries(SETTINGS_PANE_RENDER_POLICY) as Array<[Tab, PaneRenderPolicy]>)
      .filter(([, policy]) => policy.subtree === "lazy")
      .map(([pane]) => pane),
  );
  const INITIAL_PANE_SCROLL_TOP: Record<Tab, number> = {
    general: 0,
    appearance: 0,
    keybinds: 0,
    reader: 0,
    library: 0,
    categories: 0,
    content: 0,
    tracking: 0,
    storage: 0,
    performance: 0,
    security: 0,
    about: 0,
    devtools: 0,
  };
  const INITIAL_PANE_HYDRATION: Record<Tab, boolean> = {
    general: true,
    appearance: true,
    keybinds: true,
    reader: true,
    library: true,
    categories: true,
    content: true,
    tracking: false,
    storage: false,
    performance: true,
    security: true,
    about: true,
    devtools: true,
  };
  const IDLE_TIMEOUT_LABELS: Record<string, string> = {
    "0": "Never",
    "1": "1 minute",
    "2": "2 minutes",
    "5": "5 minutes",
    "10": "10 minutes",
    "15": "15 minutes",
    "30": "30 minutes",
  };
  const PAGE_STYLE_LABELS: Record<string, string> = {
    single: "Single page",
    longstrip: "Long strip",
    fade: "Fade",
  };
  const READING_DIRECTION_LABELS: Record<string, string> = {
    ltr: "Left to right",
    rtl: "Right to left",
  };
  const FIT_MODE_LABELS: Record<string, string> = {
    width: "Fit width",
    height: "Fit height",
    screen: "Fit screen",
    original: "Original (1:1)",
  };

  function idleTimeoutLabel(value: number | null | undefined): string {
    const key = String(value ?? 5);
    return IDLE_TIMEOUT_LABELS[key] ?? `${value ?? 5} min`;
  }

  function libraryUpdateIntervalLabel(value: number | null | undefined): string {
    const hours = Number(value ?? 12);
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }

  function libraryUpdateIntensityLabel(value: Settings["libraryUpdateIntensity"] | null | undefined): string {
    if (value === "eco") return "Eco";
    if (value === "fast") return "Fast";
    return "Balanced";
  }

  function libraryUpdateIntensityHint(value: Settings["libraryUpdateIntensity"] | null | undefined): string {
    if (value === "eco") return "Lowest CPU/network use. Updates finish more slowly.";
    if (value === "fast") return "Checks more sources in parallel. Uses more CPU while updating.";
    return "Recommended balance between update speed and system load.";
  }

  function pageStyleLabel(value: Settings["pageStyle"]): string {
    const normalized = value === "double" ? "single" : value;
    return PAGE_STYLE_LABELS[normalized] ?? PAGE_STYLE_LABELS.single;
  }

  function readingDirectionLabel(value: Settings["readingDirection"]): string {
    return READING_DIRECTION_LABELS[value] ?? READING_DIRECTION_LABELS.ltr;
  }

  function fitModeLabel(value: FitMode | null | undefined): string {
    const normalized = value ?? "width";
    return FIT_MODE_LABELS[normalized] ?? FIT_MODE_LABELS.width;
  }
  type UiDensityMode = "compact" | "default" | "comfort";

  function uiDensityMode(value: number | null | undefined): UiDensityMode {
    const zoom = value ?? 1.0;
    if (zoom <= 0.95) return "compact";
    if (zoom >= 1.05) return "comfort";
    return "default";
  }

  function applyUiDensity(mode: UiDensityMode) {
    updateSettings({
      uiZoom: mode === "compact" ? 0.9 : mode === "comfort" ? 1.1 : 1.0,
    });
  }

  function libraryDensityLabel(value: Settings["libraryPreferredGridColumns"]): string {
    return value === "auto" ? "Auto" : `${value} cols`;
  }
  const LIBRARY_DENSITY_OPTIONS: Settings["libraryPreferredGridColumns"][] = ["auto", 4, 5, 6, 7, 8, 9, 10];
  function libraryDensityOptionLabel(value: Settings["libraryPreferredGridColumns"]): string {
    return value === "auto" ? "Auto" : String(value);
  }
  function getLibraryDensityOptionIndex(value: Settings["libraryPreferredGridColumns"]): number {
    return Math.max(0, LIBRARY_DENSITY_OPTIONS.findIndex((option) => option === value));
  }
  function libraryDensityOptionFromIndex(index: number): Settings["libraryPreferredGridColumns"] {
    const clampedIndex = Math.max(0, Math.min(LIBRARY_DENSITY_OPTIONS.length - 1, index));
    return LIBRARY_DENSITY_OPTIONS[clampedIndex];
  }
  function getLibraryDensitySliderProgress(value: Settings["libraryPreferredGridColumns"]): string {
    const maxIndex = Math.max(1, LIBRARY_DENSITY_OPTIONS.length - 1);
    return String(getLibraryDensityOptionIndex(value) / maxIndex);
  }

  function renderLimitLabel(value: number | null | undefined): string {
    return `${value ?? 48} items`;
  }

  function themeLabel(value: string | null | undefined): string {
    const normalized = value ?? "nocturne";
    const builtIn = THEMES.find((theme) => theme.id === normalized);
    if (builtIn) return builtIn.label;
    const custom = (store.settings.customThemes ?? []).find((theme) => theme.id === normalized);
    return custom?.name ?? "Nocturne";
  }
  const THEMES: { id: Theme; label: string; description: string; swatches: string[] }[] = [
    { id: "nocturne",       label: "Nocturne",       description: "Default lunar graphite HUD",    swatches: ["#080813","#0d0d1b","#8f82e6","#f1eefc"] },
    { id: "dark",           label: "Dark",           description: "Classic near-black",            swatches: ["#101010","#151515","#a8c4a8","#f0efec"] },
    { id: "high-contrast",  label: "High Contrast",  description: "Darker base, sharper text",     swatches: ["#080808","#111111","#bcd8bc","#ffffff"] },
    { id: "light",          label: "Light",          description: "Warm off-white",                swatches: ["#f4f2ee","#faf8f4","#2a5a2a","#1a1916"] },
    { id: "light-contrast", label: "Light Contrast", description: "Light with maximum contrast",   swatches: ["#ece8e2","#f5f2ec","#183818","#080806"] },
    { id: "midnight",       label: "Midnight",       description: "Deep blue-black tint",          swatches: ["#0c1020","#101428","#a8b4e8","#eeeef8"] },
    { id: "warm",           label: "Warm",           description: "Amber and sepia tones",         swatches: ["#16130c","#1c1810","#e0b860","#f5f0e0"] },
  ];
  let tab: Tab          = $state("general");
  let activeGroup: SettingsGroupId = $state("app");
  let contentBodyEl: HTMLDivElement;
  let settingsSearchInputEl: HTMLInputElement | null = $state(null);
  let backupSectionEl: HTMLDivElement | undefined = $state();
  let backupSectionScrollKey = $state<string | null>(null);
  let paneScrollTop = $state<Record<Tab, number>>({ ...INITIAL_PANE_SCROLL_TOP });
  let paneHydrated = $state<Record<Tab, boolean>>({ ...INITIAL_PANE_HYDRATION });
  let settingsSearchQuery = $state("");
  let settingsSearchAnnouncement = $state("");
  let settingsSearchFocused = $state(false);
  let activeSettingsSearchHit: HTMLElement | null = null;
  let categoriesDetailsPane = $state<"comics" | "books" | null>(null);
  let contentSourceRulesOpen = $state(false);
  let contentSourceRulesMode = $state<"allowed" | "blocked">("allowed");
  let trackingSyncdOpen = $state(false);
  let aboutReleasesOpen = $state(false);
  let securityDetailPane = $state<"auth" | "socks" | "flare" | "pin" | "syncd" | null>(null);
  const currentGroup = $derived.by(
    () => SETTINGS_GROUPS.find((group) => group.id === activeGroup) ?? SETTINGS_GROUPS[0]
  );
  const currentTabMeta = $derived.by(
    () => {
      const item = currentGroup.items.find((entry) => entry.id === tab) ?? currentGroup.items[0];
      return {
        ...item,
        desc: TAB_DESCRIPTIONS[item.id],
      };
    }
  );
  function normalizeRuntimeSettingsTab(requestedTab: RuntimeSettingsTab | null): Tab | null {
    if (!requestedTab) return null;
    if (requestedTab === "folders") return "categories";
    return requestedTab as Tab;
  }
  function ensurePaneHydrated(nextTab: Tab) {
    if (!LAZY_TAB_SUBTREES.has(nextTab) || paneHydrated[nextTab]) return;
    paneHydrated = { ...paneHydrated, [nextTab]: true };
  }
  function rememberPaneScroll() {
    if (!contentBodyEl) return;
    paneScrollTop = { ...paneScrollTop, [tab]: contentBodyEl.scrollTop };
  }
  function restorePaneScroll(nextTab: Tab) {
    tick().then(() => contentBodyEl?.scrollTo({ top: paneScrollTop[nextTab] ?? 0 }));
  }
  function openTab(nextTab: Tab) {
    if (nextTab === tab) return;
    rememberPaneScroll();
    ensurePaneHydrated(nextTab);
    tab = nextTab;
    activeGroup = TAB_TO_GROUP[nextTab];
    selectOpen = null;
    restorePaneScroll(nextTab);
  }
  function shouldRenderPane(nextTab: Tab) {
    return !LAZY_TAB_SUBTREES.has(nextTab) || paneHydrated[nextTab];
  }
  $effect(() => { activeGroup = TAB_TO_GROUP[tab]; });
  $effect(() => {
    const requestedTab = normalizeRuntimeSettingsTab(store.runtimeSettingsTab as RuntimeSettingsTab | null);
    if (requestedTab && requestedTab !== tab) {
      ensurePaneHydrated(requestedTab);
      tab = requestedTab;
      activeGroup = TAB_TO_GROUP[requestedTab];
      restorePaneScroll(requestedTab);
      setRuntimeSettingsTab(null);
    }
  });
  function openGroup(groupId: SettingsGroupId) {
    activeGroup = groupId;
    if (TAB_TO_GROUP[tab] !== groupId) openTab(DEFAULT_TAB_BY_GROUP[groupId]);
  }
  function handleLibraryDensitySliderInput(event: Event) {
    const nextIndex = Number((event.currentTarget as HTMLInputElement).value);
    updateSettings({ libraryPreferredGridColumns: libraryDensityOptionFromIndex(nextIndex) });
  }
  async function openAppLogs() {
    try {
      await invoke("open_app_logs");
    } catch (error) {
      console.error("Failed to open app logs:", error);
      addToast({ kind: "error", title: "Couldn't open the app logs." });
    }
  }
  function clearSettingsSearchHighlight() {
    if (!activeSettingsSearchHit) return;
    activeSettingsSearchHit.classList.remove("is-search-hit");
    activeSettingsSearchHit = null;
  }
  function normalizeSearchText(value: string | null | undefined) {
    return value?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  }
  function getSettingsPaneElement(targetTab: Tab) {
    return document.querySelector(`.settings-pane[data-settings-pane="${targetTab}"]`) as HTMLElement | null;
  }
  function findSettingsSearchHit(targetTab: Tab, query: string) {
    const pane = getSettingsPaneElement(targetTab);
    if (!pane) return null;
    const candidates = Array.from(pane.querySelectorAll<HTMLElement>(SETTINGS_SEARCHABLE_SELECTOR));
    return candidates.find((candidate) => normalizeSearchText(candidate.textContent).includes(query)) ?? null;
  }
  const settingsSearchMatches = $derived.by(() => {
    const query = normalizeSearchText(settingsSearchQuery);
    if (!query) return [] as Array<{ tab: Tab; score: number }>;
    return (Object.keys(TAB_LABELS) as Tab[])
      .map((candidate) => {
        const haystack = [
          TAB_LABELS[candidate],
          TAB_DESCRIPTIONS[candidate],
          SETTINGS_SEARCH_KEYWORDS[candidate].join(" "),
          TAB_TO_GROUP[candidate],
        ].join(" ");
        const normalizedHaystack = normalizeSearchText(haystack);
        const exactBoost = normalizedHaystack.includes(query) ? 10 : 0;
        const startsBoost = normalizeSearchText(TAB_LABELS[candidate]).startsWith(query) ? 8 : 0;
        const keywordBoost = SETTINGS_SEARCH_KEYWORDS[candidate].some((term) => normalizeSearchText(term).includes(query)) ? 4 : 0;
        return { tab: candidate, score: exactBoost + startsBoost + keywordBoost };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
  });
  function focusSettingsSearch() {
    settingsSearchInputEl?.focus();
    settingsSearchInputEl?.select();
  }
  function clearSettingsSearch() {
    settingsSearchQuery = "";
    settingsSearchAnnouncement = "";
    clearSettingsSearchHighlight();
    focusSettingsSearch();
  }
  function handleSettingsSearchFocusIn() {
    settingsSearchFocused = true;
  }
  function handleSettingsSearchFocusOut(event: FocusEvent) {
    const currentTarget = event.currentTarget as HTMLFormElement | null;
    const nextTarget = event.relatedTarget as Node | null;
    settingsSearchFocused = !!(currentTarget && nextTarget && currentTarget.contains(nextTarget));
  }
  function resetAllSettingsToDefaults() {
    resetSettings();
    listeningKey = null;
    selectOpen = null;
    settingsSearchQuery = "";
    settingsSearchAnnouncement = "All settings were reset to defaults.";
    clearSettingsSearchHighlight();
    categoriesDetailsPane = null;
    contentSourceRulesOpen = false;
    contentSourceRulesMode = "allowed";
    trackingSyncdOpen = false;
    aboutReleasesOpen = false;
    securityDetailPane = null;
    advStorageOpen = false;
    flareAdvancedOpen = false;
    flareLocalOpen = false;
    flareDockerOpen = false;
    backupSavedPath = null;
    backupError = null;
    backupSectionScrollKey = null;
    paneHydrated = { ...INITIAL_PANE_HYDRATION };
    paneScrollTop = { ...INITIAL_PANE_SCROLL_TOP };
    addToast({
      kind: "success",
      title: "Settings reset",
      body: "All configuration values were restored to their defaults.",
    });
  }
  function handleSettingsSearchInput() {
    if (settingsSearchQuery.trim()) return;
    settingsSearchAnnouncement = "";
    clearSettingsSearchHighlight();
  }
  function handleSettingsSearchKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !settingsSearchQuery.trim()) return;
    event.preventDefault();
    event.stopPropagation();
    clearSettingsSearch();
  }
  async function submitSettingsSearch(event: SubmitEvent) {
    event.preventDefault();
    const query = normalizeSearchText(settingsSearchQuery);
    clearSettingsSearchHighlight();
    if (!query) {
      settingsSearchAnnouncement = "";
      return;
    }
    const directMatch = findSettingsSearchHit(tab, query);
    const targetTab = directMatch
      ? tab
      : settingsSearchMatches[0]?.tab ?? null;
    if (!targetTab) {
      settingsSearchAnnouncement = `No settings match ${settingsSearchQuery}.`;
      return;
    }
    ensurePaneHydrated(targetTab);
    if (targetTab !== tab) openTab(targetTab);
    await tick();
    const hit = findSettingsSearchHit(targetTab, query);
    if (hit) {
      hit.classList.add("is-search-hit");
      activeSettingsSearchHit = hit;
      hit.scrollIntoView({ block: "center", behavior: "smooth" });
      settingsSearchAnnouncement = `Opened ${TAB_LABELS[targetTab]} for ${settingsSearchQuery}.`;
      return;
    }
    contentBodyEl?.scrollTo({ top: 0, behavior: "smooth" });
    settingsSearchAnnouncement = `Opened ${TAB_LABELS[targetTab]}.`;
  }
  const settingsSearchOverlayActive = $derived.by(() => settingsSearchFocused || settingsSearchQuery.trim().length > 0);

  $effect(() => {
    if (typeof document === "undefined") return;
    const engaged = store.navPage === "settings" && settingsSearchOverlayActive;
    document.body.classList.toggle("aethon-settings-search-engaged", engaged);
    return () => {
      document.body.classList.remove("aethon-settings-search-engaged");
    };
  });
  async function getStorageRuntime() {
    return loadSettingsStorageRuntime();
  }
  function setDefaultLocalProfile(profileId: LocalProfileId) {
    updateSettings({ defaultLocalProfileId: profileId });
  }
  function close() { setSettingsOpen(false); }
  function onKey(e: KeyboardEvent) { if (e.key === "Escape" && !listeningKey) close(); }
  $effect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  let listeningKey: keyof Keybinds | null = $state(null);
  function startListen(key: keyof Keybinds) {
    listeningKey = listeningKey === key ? null : key;
  }
  function onKeyCapture(e: KeyboardEvent) {
    if (!listeningKey) return;
    e.preventDefault(); e.stopPropagation();
    const bind = eventToKeybind(e);
    if (!bind) return;
    updateSettings({ keybinds: { ...store.settings.keybinds, [listeningKey]: bind } });
    listeningKey = null;
  }
  $effect(() => {
    if (listeningKey) {
      window.addEventListener("keydown", onKeyCapture, true);
      return () => window.removeEventListener("keydown", onKeyCapture, true);
    }
  });
  interface StorageInfo { manga_bytes: number; total_bytes: number; free_bytes: number; path: string; }
  let storageInfo: StorageInfo | null = $state(null);
  let storageLoading = $state(false);
  let storageError: string | null = $state(null);
  let clearing = $state(false);
  let cleared  = $state(false);

  // Ã¢â€â‚¬Ã¢â€â‚¬ External server detection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // A server is "external" if its URL doesn't point to localhost Ã¢â‚¬â€ in that case we
  // cannot invoke Tauri commands against its filesystem (path validation, disk usage,
  // migration). We can still read the server's paths via GraphQL, but we must never
  // overwrite the server's download directory config without the user explicitly asking.
  const currentRuntimeServerUrl = $derived.by(() => getEffectiveServerUrl());
  const currentRuntimeProfileId = $derived.by(
    () => normalizeLocalProfileId(store.runtimeResolvedLocalProfileId)
  );
  const persistedDefaultProfileId = $derived.by(
    () => normalizeLocalProfileId(store.settings.defaultLocalProfileId) ?? DEFAULT_LOCAL_PROFILE_ID
  );
  const currentProfileMeta = $derived.by(() => store.runtimeResolvedLocalProfileMeta);
  const nextLaunchProfileMeta = $derived.by(() => getLocalProfileMeta(persistedDefaultProfileId));
  const currentSessionProfileLabel = $derived.by(() => {
    const label = currentProfileMeta?.label ?? store.runtimeServerLabel?.trim().toUpperCase();
    return label && label.length ? label : "CUSTOM";
  });
  const currentSessionProfileSummary = $derived.by(
    () => store.runtimeIsOverrideSession
      ? `${currentSessionProfileLabel} (launch override)`
      : currentSessionProfileLabel
  );
  const nextLaunchProfileSummary = $derived.by(
    () => nextLaunchProfileMeta?.label ?? currentSessionProfileLabel
  );
  const otherLocalProfileId = $derived.by(
    () => resolveOtherLocalProfileId(currentRuntimeProfileId)
  );
  const otherLocalProfileMeta = $derived.by(
    () => getLocalProfileMeta(otherLocalProfileId)
  );
  const backupExecutionBlockedReason = $derived.by(
    () => executionBlockedReasonForProfile(currentRuntimeProfileId)
  );
  const isExternalServer = $derived.by(() => {
    const url = currentRuntimeServerUrl.toLowerCase().trim();
    try {
      const host = new URL(url).hostname;
      return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
    } catch { return false; }
  });
  const serverUrlManagedByProfile = $derived.by(() => Boolean(currentProfileMeta));

  // Ã¢â€â‚¬Ã¢â€â‚¬ Download path editing Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  let downloadsPathInput    = $state(store.settings.serverDownloadsPath ?? "");
  let localSourcePathInput  = $state(store.settings.serverLocalSourcePath ?? "");
  let pathsSaving           = $state(false);
  let pathsError: string | null = $state(null);
  let pathsFieldError: { dl?: string; loc?: string } = $state({});
  let pathsSaved            = $state(false);

  // The actual resolved default path from Rust Ã¢â‚¬â€ shown as placeholder + scanned when dl path is empty.
  // Only meaningful for local servers Ã¢â‚¬â€ Tauri can't stat a remote filesystem.
  // Re-fetches reactively when the server URL changes (e.g. user switches to local).
  let defaultDownloadsPath  = $state("");
  $effect(() => {
    if (!isExternalServer) {
      invoke<string>("get_default_downloads_path").then(p => { defaultDownloadsPath = p; });
    } else {
      defaultDownloadsPath = "";
    }
  });

  // The last confirmed server paths Ã¢â‚¬â€ used to detect a change requiring migration
  let confirmedDownloadsPath   = $state(store.settings.serverDownloadsPath ?? "");
  let confirmedLocalSourcePath = $state(store.settings.serverLocalSourcePath ?? "");

  // Ã¢â€â‚¬Ã¢â€â‚¬ Migration state Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  let migrateFrom: string | null   = $state(null); // old path that has content
  let migrateTo:   string | null   = $state(null); // new path
  let migrating                    = $state(false);
  let migrateProgress: { done: number; total: number; current: string } | null = $state(null);
  let migrateError: string | null  = $state(null);
  let migrateUnlisten: (() => void) | null = null;

  // Ã¢â€â‚¬Ã¢â€â‚¬ Extra scan directories (local-only, stored in app settings) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  let extraScanDirs: string[]   = $state([...(store.settings.extraScanDirs ?? [])]);
  let newScanDir                = $state("");
  let multiStorageInfos: (StorageInfo & { label: string })[] = $state([]);
  let advStorageOpen            = $state(false);
  function openStorageAdvanced() {
    advStorageOpen = true;
  }
  function openStorageBackupPanel() {
    advStorageOpen = true;
    void tick().then(() => {
      backupSectionEl?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }
  const storageLimitBytes = $derived.by(() =>
    store.settings.storageLimitGb === null ? null : store.settings.storageLimitGb * 1024 ** 3
  );
  const storageUsageSummary = $derived.by(() => {
    const infos = multiStorageInfos.length > 0
      ? multiStorageInfos
      : storageInfo
        ? [{ ...storageInfo, label: "Downloads" }]
        : [];

    if (infos.length === 0) {
      return {
        usedBytes: 0,
        capBytes: 0,
        pct: 0,
        usageLabel: "No storage path configured.",
        pathLabel: null as string | null,
        freeLabel: null as string | null,
      };
    }

    const usedBytes = infos.reduce((sum, info) => sum + info.manga_bytes, 0);
    const capBytes = infos.reduce((sum, info) => {
      const available = info.manga_bytes + info.free_bytes;
      return sum + (storageLimitBytes === null ? available : Math.min(storageLimitBytes, available));
    }, 0);
    const freeBytes = infos.reduce((sum, info) => sum + info.free_bytes, 0);
    return {
      usedBytes,
      capBytes,
      pct: capBytes > 0 ? Math.min(100, (usedBytes / capBytes) * 100) : 0,
      usageLabel: capBytes > 0 ? `${fmtBytes(usedBytes)} / ${fmtBytes(capBytes)}` : fmtBytes(usedBytes),
      pathLabel: infos[0]?.path ?? null,
      freeLabel: freeBytes > 0 ? `${fmtBytes(freeBytes)} free` : null,
    };
  });

  async function fetchStorage() {
    storageLoading = true; storageError = null;
    try {
      // Always pull the current paths from the server via GQL Ã¢â‚¬â€ works for local and external.
      const pathData = await gql<{ settings: { downloadsPath: string; localSourcePath: string } }>(GET_DOWNLOADS_PATH);
      const dl  = pathData.settings.downloadsPath  ?? "";
      const loc = pathData.settings.localSourcePath ?? "";

      downloadsPathInput    = dl;
      localSourcePathInput  = loc;
      confirmedDownloadsPath   = dl;
      confirmedLocalSourcePath = loc;
      updateSettings({ serverDownloadsPath: dl, serverLocalSourcePath: loc });

      // Disk usage scanning uses Tauri invoke Ã¢â‚¬â€ only possible when the server is local.
      // For external servers we display the paths pulled above but skip the filesystem scan.
      if (isExternalServer) {
        multiStorageInfos = []; storageInfo = null; return;
      }

      // When dl is empty the server uses the default path Ã¢â‚¬â€ scan that instead
      const effectiveDl = dl || defaultDownloadsPath;

      const dirsToScan: { path: string; label: string }[] = [];
      if (effectiveDl) dirsToScan.push({ path: effectiveDl, label: dl ? "Downloads" : "Downloads (default)" });
      if (loc && loc !== effectiveDl) dirsToScan.push({ path: loc, label: "Local source" });
      for (const p of extraScanDirs) {
        if (p && !dirsToScan.find(d => d.path === p)) dirsToScan.push({ path: p, label: p });
      }

      if (dirsToScan.length === 0) {
        multiStorageInfos = []; storageInfo = null; return;
      }

      const results = await Promise.allSettled(
        dirsToScan.map(d =>
          invoke<StorageInfo>("get_storage_info", { downloadsPath: d.path })
            .then(info => ({ ...info, label: d.label }))
        )
      );

      multiStorageInfos = results
        .filter((r): r is PromiseFulfilledResult<StorageInfo & { label: string }> => r.status === "fulfilled")
        .map(r => r.value);
      storageInfo = multiStorageInfos[0] ?? null;
    } catch (e: any) {
      storageError = e instanceof Error ? e.message : String(e);
    } finally {
      storageLoading = false;
    }
  }

  /** Validate a path exists on disk. Returns error string or null.
   *  Only runs for local servers Ã¢â‚¬â€ we can't stat a remote filesystem via Tauri. */
  async function validatePath(path: string): Promise<string | null> {
    if (!path.trim()) return null; // empty = use default, always valid
    if (isExternalServer) return null; // can't check remote paths locally
    try {
      const exists = await invoke<boolean>("check_path_exists", { path: path.trim() });
      return exists ? null : "Directory does not exist";
    } catch {
      return "Could not check path";
    }
  }

  /** Create a directory on disk via Tauri. Only valid for local servers. */
  async function createDirectory(path: string): Promise<void> {
    if (isExternalServer) throw new Error("Cannot create directories on an external server");
    await invoke("create_directory", { path });
  }

  async function savePaths() {
    const dl  = downloadsPathInput.trim();
    const loc = localSourcePathInput.trim();
    pathsError = null; pathsFieldError = {};

    // Validate paths exist before touching the server (empty = use default = always valid).
    // Skipped for external servers Ã¢â‚¬â€ we can't stat their filesystem.
    const [dlErr, locErr] = await Promise.all([validatePath(dl), validatePath(loc)]);
    if (dlErr || locErr) {
      pathsFieldError = { ...(dlErr ? { dl: dlErr } : {}), ...(locErr ? { loc: locErr } : {}) };
      return;
    }

    pathsSaving = true;
    try {
      // Send each mutation independently Ã¢â‚¬â€ localSourcePath rejects empty string server-side
      await gql(SET_DOWNLOADS_PATH, { path: dl });
      if (loc) await gql(SET_LOCAL_SOURCE_PATH, { path: loc });

      updateSettings({ serverDownloadsPath: dl, serverLocalSourcePath: loc });

      // Migration requires local filesystem access Ã¢â‚¬â€ skip for external servers.
      if (!isExternalServer) {
        const oldDl = confirmedDownloadsPath || defaultDownloadsPath;
        const newDl = dl || defaultDownloadsPath;
        if (newDl && oldDl && newDl !== oldDl) {
          const hadContent = await invoke<boolean>("check_path_exists", { path: oldDl });
          if (hadContent) { migrateFrom = oldDl; migrateTo = newDl; }
        }
      }

      confirmedDownloadsPath   = dl;
      confirmedLocalSourcePath = loc;
      pathsSaved = true;
      setTimeout(() => pathsSaved = false, 2000);
      await fetchStorage();
    } catch (e: any) {
      pathsError = e?.message ?? "Failed to save paths";
    } finally {
      pathsSaving = false;
    }
  }

  async function browseSettingsPath(kind: "downloads" | "local") {
    if (isExternalServer) return;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath:
        kind === "downloads"
          ? (downloadsPathInput.trim() || defaultDownloadsPath || undefined)
          : (localSourcePathInput.trim() || undefined),
    });
    if (typeof selected !== "string" || !selected.trim()) return;
    if (kind === "downloads") {
      downloadsPathInput = selected;
    } else {
      localSourcePathInput = selected;
    }
    await savePaths();
  }

  async function startMigration() {
    if (!migrateFrom || !migrateTo) return;
    migrating = true; migrateError = null; migrateProgress = { done: 0, total: 0, current: "" };

    // Subscribe to progress events from Tauri
    const { listen } = await import("@tauri-apps/api/event");
    migrateUnlisten = await listen<{ done: number; total: number; current: string }>(
      "migrate_progress",
      (e) => { migrateProgress = e.payload; }
    );

    try {
      await invoke("migrate_downloads", { src: migrateFrom, dst: migrateTo });
      migrateFrom = null; migrateTo = null; migrateProgress = null;
      await fetchStorage();
    } catch (e: any) {
      migrateError = e?.message ?? "Migration failed";
    } finally {
      migrating = false;
      migrateUnlisten?.(); migrateUnlisten = null;
    }
  }

  function dismissMigration() {
    migrateFrom = null; migrateTo = null; migrateError = null; migrateProgress = null;
  }

  function addExtraScanDir() {
    const dir = newScanDir.trim();
    if (!dir || extraScanDirs.includes(dir)) return;
    extraScanDirs = [...extraScanDirs, dir];
    updateSettings({ extraScanDirs });
    newScanDir = "";
    fetchStorage();
  }

  function removeExtraScanDir(path: string) {
    extraScanDirs = extraScanDirs.filter(d => d !== path);
    updateSettings({ extraScanDirs });
    fetchStorage();
  }
  $effect(() => { if (tab === "storage" && !storageInfo && !storageLoading) fetchStorage(); });
  function handleClearCache() {
    clearing = true;
    caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))).catch(() => {})
      .finally(() => { clearing = false; cleared = true; setTimeout(() => cleared = false, 2500); fetchStorage(); });
  }
  type BackupRestoreProgress = {
    mangaProgress: number;
    state: string;
    totalManga: number;
  };
  let backupFileInput = $state<HTMLInputElement | undefined>(undefined);
  let backupExporting = $state(false);
  let backupValidating = $state(false);
  let backupRestoring = $state(false);
  let backupError: string | null = $state(null);
  let backupSavedPath: string | null = $state(null);
  let backupSelectedFile: File | null = $state(null);
  let backupParsed: ParsedBackup | null = $state(null);
  let backupAnalysis: ReconciliationAnalysis | null = $state(null);
  let backupRestoreId: string | null = $state(null);
  let backupRestoreStatus: BackupRestoreProgress | null = $state(null);
  let backupSuggestedExtensions = $state<MissingSourceExtensionSuggestion[]>([]);
  let backupAvailableExtensions = $state<AvailableExtensionEntry[]>([]);
  let backupInventory = $state<SourceInventoryEntry[]>([]);
  let backupExtensionLookupError: string | null = $state(null);
  let backupExtensionLookupLoading = $state(false);
  let backupInstalling = $state(new Set<string>());
  let backupReviewSelections = $state<Record<string, string | "skip">>({});
  let backupMissingTrackers = $state<{ name: string }[]>([]);
  let backupSelectedFilePath: string | null = $state(null);
  let backupImportKind = $state<BackupImportKind | null>(null);
  let backupExportMode = $state<BackupExportMode>("unified");
  let backupUnifiedIncludeManga = $state(true);
  let backupUnifiedIncludeBooks = $state(true);
  let backupUnifiedIncludeNovels = $state(true);
  let backupUnifiedIncludeApp = $state(true);
  let backupBooksOnlyMetadataOnly = $state(false);
  let backupUnifiedPlan = $state<AethonRestorePlan | null>(null);
  let backupUnifiedSelection = $state<BackupExecutionSelection>({});
  let backupRestoreTargetMode = $state<RestoreTargetMode>("current-profile");
  let backupRestoreCurrentProfileConfirmed = $state(false);
  let backupRestoreHandoffSession = $state(false);
  let backupRestoreSourceProfileId = $state<LocalProfileId | null>(null);
  let backupRestoreResults = $state<Array<{ kind: string; status: "success" | "warning" | "failed" | "skipped"; summary: string; detail?: string | null }> | null>(null);
  let backupLaunchIntentKey = $state<string | null>(null);
  let backupLastLegacyAnalysisPath: string | null = $state(null);

  const backupNeedsReviewComplete = $derived.by<boolean>(() => {
    const analysis = backupAnalysis;
    if (!analysis) return true;
    return analysis.needsReview.every(
      (cluster: ReconciliationClusterResult) => !!backupReviewSelections[cluster.orphanSourceId],
    );
  });
  const backupReadiness = $derived.by<RestoreReadinessSummary | null>(() =>
    backupAnalysis
      ? buildRestoreReadiness(backupAnalysis, backupReviewSelections, backupInventory, backupAvailableExtensions)
      : null,
  );
  const backupRestoreBlocked = $derived(
    !backupSelectedFile
      || !backupParsed
      || !backupAnalysis
      || !backupNeedsReviewComplete
      || !!backupReadiness?.blocksRestore
      || backupValidating
      || backupRestoring,
  );
  const backupCanUseOtherProfileTarget = $derived.by(
    () => currentProfileSupportsOtherLocalTarget(currentRuntimeProfileId) && !backupRestoreHandoffSession
  );
  const backupExecutablePayloadKinds = $derived.by(
    () => backupUnifiedPlan ? selectedExecutablePayloadKinds(backupUnifiedPlan, backupUnifiedSelection) : []
  );
  const backupHasExecutableSelection = $derived.by(
    () => backupUnifiedPlan ? hasAnyExecutableSelection(backupUnifiedPlan, backupUnifiedSelection) : false
  );
  const backupCurrentTargetSummary = $derived.by(
    () => describeRestoreTarget(currentRuntimeProfileId, backupRestoreTargetMode, backupRestoreHandoffSession)
  );
  const backupCurrentProfileGateRequired = $derived.by(
    () => backupRestoreTargetMode === "current-profile" && !backupRestoreHandoffSession
  );
  const backupSelectedFileLabel = $derived.by(
    () => backupSelectedFile?.name ?? backupPathLabel(backupSelectedFilePath)
  );
  const backupUnifiedBlockedCount = $derived.by(
    () => backupUnifiedPlan?.payloads.filter((payload) => payload.status === "blocked").length ?? 0
  );
  const backupUnifiedUnsupportedCount = $derived.by(
    () => backupUnifiedPlan?.payloads.filter((payload) => payload.status === "unsupported").length ?? 0
  );
  const backupUnifiedWarningCount = $derived.by(
    () => backupUnifiedPlan?.payloads.filter((payload) => payload.status === "warning-only").length ?? 0
  );
  const backupResolvedExecutionBlockedReason = $derived.by(
    () => backupUnifiedPlan?.executionBlockedReason ?? backupExecutionBlockedReason
  );
  const backupExecuteDisabled = $derived.by(() => {
    if (backupResolvedExecutionBlockedReason) return true;
    if (backupCurrentProfileGateRequired && !backupRestoreCurrentProfileConfirmed) return true;
    if (backupRestoreTargetMode === "other-local-profile") {
      return !backupSelectedFilePath || !backupCanUseOtherProfileTarget || backupRestoring || backupValidating;
    }
    if (backupImportKind === "aethon") {
      return !backupUnifiedPlan || !backupHasExecutableSelection || backupRestoring || backupValidating;
    }
    return backupRestoreBlocked;
  });

  function backupPathLabel(path: string | null | undefined): string | null {
    const trimmed = typeof path === "string" ? path.trim() : "";
    if (!trimmed) return null;
    return trimmed.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? trimmed;
  }

  function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
    const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== "undefined") {
      return Buffer.from(normalized).toString("base64");
    }
    let binary = "";
    for (const byte of normalized) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function browserPlatform(): string | null {
    const maybeData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
    return maybeData ?? navigator.platform ?? null;
  }

  function backupPayloadKindLabel(kind: string): string {
    switch (kind) {
      case "manga":
        return "Manga";
      case "books":
        return "Books";
      case "novels":
        return "Novels";
      case "app":
        return "App metadata";
      default:
        return kind;
    }
  }

  function backupPayloadStatusLabel(status: AethonPayloadRestorePlan["status"] | "success" | "warning" | "failed"): string {
    switch (status) {
      case "restorable":
        return "Restorable";
      case "warning-only":
        return "Warning only";
      case "blocked":
        return "Blocked";
      case "unsupported":
        return "Unsupported";
      case "skipped":
        return "Skipped";
      case "success":
        return "Success";
      case "warning":
        return "Completed with warnings";
      case "failed":
        return "Failed";
      default:
        return status;
    }
  }

  function backupRestoreButtonLabel(): string {
    if (backupRestoreTargetMode === "other-local-profile") {
      return otherLocalProfileMeta
        ? `Continue in ${otherLocalProfileMeta.label}`
        : "Continue in other profile";
    }
    if (backupRestoring) {
      return backupImportKind === "aethon" ? "Restoring..." : "Restoring manga...";
    }
    return backupImportKind === "aethon" ? "Restore selected payloads" : "Restore manga backup";
  }

  function resetLegacyBackupState() {
    backupSelectedFile = null;
    backupSelectedFilePath = null;
    backupLastLegacyAnalysisPath = null;
    backupParsed = null;
    backupAnalysis = null;
    backupInventory = [];
    backupReviewSelections = {};
    backupMissingTrackers = [];
    backupRestoreId = null;
    backupRestoreStatus = null;
    backupSuggestedExtensions = [];
    backupAvailableExtensions = [];
    backupExtensionLookupError = null;
  }

  function resetUnifiedBackupState() {
    backupUnifiedPlan = null;
    backupUnifiedSelection = {};
    backupRestoreResults = null;
  }

  function resetBackupImportState() {
    backupError = null;
    backupImportKind = null;
    backupRestoreCurrentProfileConfirmed = false;
    backupRestoreHandoffSession = false;
    backupRestoreSourceProfileId = null;
    backupRestoreTargetMode = "current-profile";
    resetLegacyBackupState();
    resetUnifiedBackupState();
  }

  async function loadNovelRuntimeState(): Promise<AethonNovelRuntimeState> {
    const storageRuntime = await getStorageRuntime();
    const state = await storageRuntime.loadNovelRepositoryState({
      profileId: currentRuntimeProfileId,
      serverUrl: currentRuntimeServerUrl,
    });

    return {
      repositoryUrls: state.repositories.map((repository) => repository.normalizedUrl),
      installedPluginIds: state.installedPlugins
        .filter((plugin) => plugin.enabled)
        .map((plugin) => plugin.pluginId),
      availableSourceIds: [...new Set(state.catalogEntries.map((entry) => entry.pluginId))],
    };
  }

  async function loadAethonRestoreRuntime(): Promise<AethonRestorePlannerRuntime> {
    const storageRuntime = await getStorageRuntime();
    const [inventory, trackersData, novelsRuntime, overlay] = await Promise.all([
      storageRuntime.loadSourceInventory(),
      gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS),
      loadNovelRuntimeState(),
      storageRuntime.readOverlayFile(),
    ]);

    return {
      activeProfileId: currentRuntimeProfileId,
      manga: {
        supported: true,
        inventory: inventory.inventory,
        availableExtensions: inventory.availableExtensions,
        trackers: trackersData.trackers.nodes ?? [],
        overlay,
      },
      books: {
        supported: true,
      },
      novels: {
        ...novelsRuntime,
        supported: true,
      },
      app: {
        supported: true,
      },
    };
  }

  function backupFilenameFromUrl(path: string): string {
    const cleaned = path.split("?")[0];
    const file = cleaned.split("/").pop()?.trim();
    return file || `aethon-backup-${new Date().toISOString().slice(0, 10)}.tachibk`;
  }

  function defaultExportFilename(): string {
    const stamp = new Date().toISOString().slice(0, 10);
    switch (backupExportMode) {
      case "manga":
        return `aethon-manga-${stamp}.tachibk`;
      case "books":
        return `aethon-books-${stamp}${SETTINGS_AETHON_BACKUP_EXTENSION}`;
      case "novels":
        return `aethon-novels-${stamp}${SETTINGS_AETHON_BACKUP_EXTENSION}`;
      case "app":
        return `aethon-profile-${stamp}${SETTINGS_AETHON_BACKUP_EXTENSION}`;
      default:
        return `aethon-unified-${stamp}${SETTINGS_AETHON_BACKUP_EXTENSION}`;
    }
  }

  async function saveBytesToPath(path: string, bytes: Uint8Array | ArrayBuffer): Promise<string> {
    return invoke<string>("write_file_base64", {
      path,
      bytesBase64: bytesToBase64(bytes),
    });
  }

  async function fetchCurrentMangaBackup(): Promise<{ bytes: Uint8Array; sourceFilename: string }> {
    const res = await gql<{ createBackup: { url: string } }>(CREATE_BACKUP, {
      includeCategories: true,
      includeChapters: true,
    });
    const url = serverFileUrl(res.createBackup.url);
    const response = await fetch(url, {
      headers: getServerAuthHeader()
        ? { Authorization: getServerAuthHeader()! }
        : undefined,
    });
    if (!response.ok) {
      throw new Error(`Manga backup export failed with HTTP ${response.status}.`);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      sourceFilename: backupFilenameFromUrl(res.createBackup.url),
    };
  }

  async function buildSelectedExportBytes(): Promise<{ bytes: Uint8Array; defaultPath: string }> {
    const storageRuntime = await getStorageRuntime();
    const appVersion = await getVersion().catch(() => null);
    const sourceProfileId = currentRuntimeProfileId ?? null;

    if (backupExportMode === "manga") {
      const manga = await fetchCurrentMangaBackup();
      return {
        bytes: manga.bytes,
        defaultPath: defaultExportFilename(),
      };
    }

    if (backupExportMode === "books") {
      const booksLibraryState = await storageRuntime.loadBookLibraryState();
      const built = await storageRuntime.buildAethonBackupContainer({
        appVersion,
        platform: browserPlatform(),
        sourceSurface: "desktop",
        sourceProfileId,
        payloads: [
          await storageRuntime.buildAethonBooksPayload(
            storageRuntime.buildAethonBooksSnapshotFromLibraryState(booksLibraryState),
            {
            exportMode: backupBooksOnlyMetadataOnly ? "metadata-only" : "full",
            },
          ),
        ],
      });
      return {
        bytes: built.bytes,
        defaultPath: defaultExportFilename(),
      };
    }

    if (backupExportMode === "novels") {
      const [novelLibraryState, novelRepositoryState] = await Promise.all([
        storageRuntime.loadNovelLibraryState({
          profileId: currentRuntimeProfileId,
          serverUrl: currentRuntimeServerUrl,
        }),
        storageRuntime.loadNovelRepositoryState({
          profileId: currentRuntimeProfileId,
          serverUrl: currentRuntimeServerUrl,
        }),
      ]);
      const built = await storageRuntime.buildAethonBackupContainer({
        appVersion,
        platform: browserPlatform(),
        sourceSurface: "desktop",
        sourceProfileId,
        payloads: [
          await storageRuntime.buildAethonNovelsPayload(
            storageRuntime.buildAethonNovelsSnapshotFromAuthoritativeState({
              libraryState: novelLibraryState,
              repositoryState: novelRepositoryState,
            }),
          ),
        ],
      });
      return {
        bytes: built.bytes,
        defaultPath: defaultExportFilename(),
      };
    }

    if (backupExportMode === "app") {
      const built = await storageRuntime.buildAethonBackupContainer({
        appVersion,
        platform: browserPlatform(),
        sourceSurface: "desktop",
        sourceProfileId,
        payloads: [
          storageRuntime.buildAethonAppPayload({
            defaultLocalProfileId: persistedDefaultProfileId,
            history: store.history,
            readLog: store.readLog,
            readingStats: store.readingStats,
          }),
        ],
      });
      return {
        bytes: built.bytes,
        defaultPath: defaultExportFilename(),
      };
    }

    const payloads: AethonBackupPayloadBuildInput[] = [];
    if (backupUnifiedIncludeManga) {
      const manga = await fetchCurrentMangaBackup();
      payloads.push(await storageRuntime.buildAethonMangaPayload(manga.bytes, {
        sourceFilename: manga.sourceFilename,
      }));
    }
    if (backupUnifiedIncludeBooks) {
      const booksLibraryState = await storageRuntime.loadBookLibraryState();
      payloads.push(await storageRuntime.buildAethonBooksPayload(
        storageRuntime.buildAethonBooksSnapshotFromLibraryState(booksLibraryState),
        {
          exportMode: "full",
        },
      ));
    }
    if (backupUnifiedIncludeNovels) {
      const [novelLibraryState, novelRepositoryState] = await Promise.all([
        storageRuntime.loadNovelLibraryState({
          profileId: currentRuntimeProfileId,
          serverUrl: currentRuntimeServerUrl,
        }),
        storageRuntime.loadNovelRepositoryState({
          profileId: currentRuntimeProfileId,
          serverUrl: currentRuntimeServerUrl,
        }),
      ]);
      payloads.push(
        await storageRuntime.buildAethonNovelsPayload(
          storageRuntime.buildAethonNovelsSnapshotFromAuthoritativeState({
            libraryState: novelLibraryState,
            repositoryState: novelRepositoryState,
          }),
        ),
      );
    }
    if (backupUnifiedIncludeApp) {
      payloads.push(storageRuntime.buildAethonAppPayload({
        defaultLocalProfileId: persistedDefaultProfileId,
        history: store.history,
        readLog: store.readLog,
        readingStats: store.readingStats,
      }));
    }

    if (payloads.length === 0) {
      throw new Error("Select at least one payload to export.");
    }

    const built = await storageRuntime.buildAethonBackupContainer({
      appVersion,
      platform: browserPlatform(),
      sourceSurface: "desktop",
      sourceProfileId,
      payloads,
    });
    return {
      bytes: built.bytes,
      defaultPath: defaultExportFilename(),
    };
  }

  async function triggerBackupImport() {
    backupError = null;
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        { name: "Aethon backups", extensions: ["aethonbk"] },
        { name: "Manga backups", extensions: ["tachibk", "proto", "gz"] },
      ],
    });
    if (typeof selected !== "string" || !selected.trim()) return;
    await loadSelectedBackupPath(selected);
  }

  async function fileFromPath(path: string): Promise<File> {
    const storageRuntime = await getStorageRuntime();
    const buffer = await storageRuntime.readFileAsArrayBuffer(path);
    return new File([buffer], backupPathLabel(path) ?? "backup.tachibk", {
      type: "application/octet-stream",
    });
  }

  async function loadUnifiedBackupPlan(path: string) {
    const storageRuntime = await getStorageRuntime();
    const bytes = await storageRuntime.readFileAsArrayBuffer(path);
    const runtime = await loadAethonRestoreRuntime();
    const plan = await storageRuntime.buildAethonRestorePlan(bytes, runtime);
    backupUnifiedPlan = plan;
    backupUnifiedSelection = defaultExecutionSelection(plan);
  }

  async function loadLegacyBackupPath(path: string) {
    backupLastLegacyAnalysisPath = path;
    const file = await fileFromPath(path);
    backupSelectedFile = file;
    backupSelectedFilePath = path;
    await analyzeSelectedBackupFile(file);
  }

  async function loadSelectedBackupPath(
    path: string,
    forcedKind: BackupImportKind | null = null,
    options: {
      handoff?: boolean;
      sourceProfileId?: LocalProfileId | null;
    } = {},
  ) {
    resetBackupImportState();
    backupSelectedFilePath = path;
    backupImportKind = forcedKind ?? detectBackupImportKind(path);
    backupRestoreHandoffSession = Boolean(options.handoff);
    backupRestoreSourceProfileId = options.sourceProfileId ?? null;
    backupRestoreTargetMode = options.handoff
      ? "current-profile"
      : backupImportKind === "aethon"
        ? "current-profile"
        : "current-profile";

    if (!backupImportKind) {
      backupError = "Choose an Aethon (.aethonbk) or manga (.tachibk/.proto.gz) backup file.";
      return;
    }

    if (backupImportKind === "aethon") {
      await loadUnifiedBackupPlan(path);
      return;
    }

    if (backupRestoreTargetMode === "current-profile") {
      await loadLegacyBackupPath(path);
    } else {
      backupSelectedFile = await fileFromPath(path);
    }
  }

  $effect(() => {
    const intent = backupRestoreLaunchIntent;
    const key = intent ? `${intent.kind}:${intent.path}:${intent.handoff ? "handoff" : "direct"}` : null;
    if (!intent || !key || key === backupLaunchIntentKey) return;
    backupLaunchIntentKey = key;
    void loadSelectedBackupPath(intent.path, intent.kind, {
      handoff: intent.handoff,
      sourceProfileId: intent.sourceProfileId ?? null,
    }).catch((error) => {
      backupError = error instanceof Error ? error.message : "Could not load restore handoff.";
    });
  });

  $effect(() => {
    if (tab !== "storage") {
      backupSectionScrollKey = null;
      return;
    }
    const focusBackupSection = Boolean(backupRestoreLaunchIntent || backupSelectedFilePath || backupUnifiedPlan);
    if (!focusBackupSection) {
      backupSectionScrollKey = null;
      return;
    }
    const nextKey = [
      backupRestoreLaunchIntent ? `${backupRestoreLaunchIntent.kind}:${backupRestoreLaunchIntent.path}:${backupRestoreLaunchIntent.handoff ? "handoff" : "direct"}` : "no-intent",
      backupSelectedFilePath ?? "no-path",
      backupImportKind ?? "no-import-kind",
      backupUnifiedPlan ? String(backupUnifiedPlan.payloads.length) : "no-plan",
    ].join("|");
    if (nextKey === backupSectionScrollKey) return;
    backupSectionScrollKey = nextKey;
    void tick().then(() => {
      backupSectionEl?.scrollIntoView({ block: "start" });
    });
  });

  $effect(() => {
    const shouldAnalyze = backupImportKind === "manga"
      && backupRestoreTargetMode === "current-profile"
      && !!backupSelectedFilePath
      && backupSelectedFilePath !== backupLastLegacyAnalysisPath
      && !backupValidating
      && !backupRestoring;
    if (!shouldAnalyze) return;
    void loadLegacyBackupPath(backupSelectedFilePath!).catch((error) => {
      backupError = error instanceof Error ? error.message : "Could not prepare manga restore.";
    });
  });

  async function loadMissingSourceSuggestions(missingSources: { id: string; name: string }[]) {
    backupSuggestedExtensions = [];
    backupExtensionLookupError = null;
    if (missingSources.length === 0) return;

    backupExtensionLookupLoading = true;
    try {
      const storageRuntime = await getStorageRuntime();
      const inventory = await storageRuntime.loadSourceInventory();
      backupAvailableExtensions = inventory.availableExtensions;
      const result = await findMissingSourceExtensionSuggestions(
        missingSources,
        inventory.repoUrls,
        inventory.availableExtensions,
        store.settings.preferredExtensionLang ?? "en",
      );
      backupSuggestedExtensions = result.suggestions;
      if (result.failedRepos.length > 0) {
        backupExtensionLookupError = `Some extension repos could not be checked: ${result.failedRepos.join(", ")}`;
      }
    } catch (error) {
      backupExtensionLookupError = error instanceof Error ? error.message : "Could not load extensions";
    } finally {
      backupExtensionLookupLoading = false;
    }
  }

  async function exportBackup() {
    backupExporting = true;
    backupError = null;
    backupSavedPath = null;
    try {
      const built = await buildSelectedExportBytes();
      const savePath = await saveDialog({
        defaultPath: defaultExportFilename(),
        filters: backupExportMode === "manga"
          ? [{ name: "Manga backups", extensions: ["tachibk"] }]
          : [{ name: "Aethon backups", extensions: ["aethonbk"] }],
      });
      if (typeof savePath !== "string" || !savePath.trim()) return;
      const normalizedPath = normalizeBackupSavePath(
        savePath,
        backupExportMode === "manga" ? ".tachibk" : SETTINGS_AETHON_BACKUP_EXTENSION,
      );
      const savedPath = await saveBytesToPath(normalizedPath, built.bytes);
      backupSavedPath = savedPath;
      addToast({
        kind: "success",
        title: "Backup saved",
        body: savedPath,
      });
    } catch (e: any) {
      backupError = e?.message ?? "Failed to export backup";
    } finally {
      backupExporting = false;
    }
  }

  async function onBackupFileSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;
    resetBackupImportState();
    backupImportKind = "manga";
    backupSelectedFile = file;
    backupSelectedFilePath = null;
    if (backupRestoreTargetMode === "current-profile") {
      await analyzeSelectedBackupFile(file);
    }
  }

  async function analyzeSelectedBackupFile(file: File) {
    backupValidating = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const storageRuntime = await getStorageRuntime();
      const [inventory, trackersData, overlay] = await Promise.all([
        storageRuntime.loadSourceInventory(),
        gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS),
        storageRuntime.readOverlayFile(),
      ]);
      const parsed = await storageRuntime.parseMihonBackup(bytes, inventory.inventory);
      const { analysis } = await storageRuntime.analyzeBackupReconciliation(
        bytes,
        inventory.inventory,
        trackersData.trackers.nodes ?? [],
        overlay,
      );
      backupParsed = parsed;
      backupInventory = inventory.inventory;
      backupAnalysis = {
        ...analysis,
        warnings: [...inventory.warnings, ...analysis.warnings],
      };
      backupAvailableExtensions = inventory.availableExtensions;
      backupMissingTrackers = parsed.trackerIds
        .filter((trackerId) => !(trackersData.trackers.nodes ?? []).some((tracker) => tracker.id === trackerId))
        .map((trackerId) => ({ name: `Tracker #${trackerId}` }));
      await loadMissingSourceSuggestions(
        [...analysis.needsReview, ...analysis.unresolved].map((cluster) => ({
          id: cluster.orphanSourceId,
          name: cluster.sourceName,
        })),
      );
    } catch (e: any) {
      backupError = e?.message ?? "Failed to validate backup";
    } finally {
      backupValidating = false;
    }
  }

  async function refreshBackupReadiness() {
    if (!backupSelectedFile) return;
    backupError = null;
    await analyzeSelectedBackupFile(backupSelectedFile);
  }

  async function installMissingSourceExtension(extension: Extension, refreshAfter = true) {
    const nextWorking = new Set(backupInstalling);
    nextWorking.add(extension.pkgName);
    backupInstalling = nextWorking;
    backupError = null;
    try {
      await gql(UPDATE_EXTENSION, { id: extension.pkgName, install: true });
      addToast({
        kind: "success",
        title: "Extension installed",
        body: `${extension.name} was sent to Suwayomi. Aethon will refresh restore readiness once the source inventory catches up.`,
      });
      if (refreshAfter && backupSelectedFile) {
        await refreshBackupReadiness();
      }
    } catch (error) {
      backupError = error instanceof Error ? error.message : `Could not install ${extension.name}`;
    } finally {
      const doneWorking = new Set(backupInstalling);
      doneWorking.delete(extension.pkgName);
      backupInstalling = doneWorking;
    }
  }

  async function installRequiredRestoreExtensions() {
    const required = backupReadiness?.installableExtensions ?? [];
    if (required.length === 0) return;

    for (const extension of required) {
      if (backupInstalling.has(extension.pkgName)) continue;
      await installMissingSourceExtension(extension, false);
    }
    await refreshBackupReadiness();
  }

  async function pollRestoreStatus(id: string) {
    while (true) {
      const res = await gql<{ restoreStatus: BackupRestoreProgress }>(GET_RESTORE_STATUS, { id });
      backupRestoreStatus = res.restoreStatus;
      const state = (res.restoreStatus?.state ?? "").toUpperCase();
      if (["SUCCESS", "COMPLETED", "FAILED", "ERROR", "CANCELLED"].includes(state)) break;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  async function restoreBackup(): Promise<{ ok: boolean; finalState: string | null }> {
    if (!backupSelectedFile || !backupParsed || !backupAnalysis) {
      return { ok: false, finalState: null };
    }
    if (backupReadiness?.blocksRestore) {
      backupError = backupReadiness.requiresInstallCount > 0
        ? "Install the required extensions first so this restore lands on usable sources."
        : "Some reconciled sources are unavailable on this server right now. Resolve them before restoring.";
      return { ok: false, finalState: null };
    }
    backupRestoring = true;
    backupError = null;
    backupRestoreId = null;
    backupRestoreStatus = null;
    try {
      const storageRuntime = await getStorageRuntime();
      const reconciledFile = storageRuntime.buildReconciledBackupFile(
        backupParsed,
        backupAnalysis,
        backupReviewSelections,
        backupSelectedFile.name,
      );
      const overlayEntry: OverlayEntry = storageRuntime.overlayEntryFromAnalysis({
        ...backupAnalysis,
        needsReview: backupAnalysis.needsReview.map((cluster) => {
          const selected = backupReviewSelections[cluster.orphanSourceId];
          if (!selected || selected === "skip") return cluster;
          const chosen = cluster.candidates.find((candidate) => candidate.sourceId === selected) ?? null;
          return {
            ...cluster,
            status: chosen ? "auto_reconciled" : cluster.status,
            selectedCandidate: chosen,
          };
        }),
      });
      await storageRuntime.upsertOverlayEntry(overlayEntry);
      const res = await gqlUpload<{ restoreBackup: { id: string; status: BackupRestoreProgress | null } }>(
        RESTORE_BACKUP,
        { backup: null },
        { "variables.backup": reconciledFile },
      );
      backupRestoreId = res.restoreBackup.id;
      backupRestoreStatus = res.restoreBackup.status;
      await pollRestoreStatus(res.restoreBackup.id);
      const finalState = (backupRestoreStatus?.state ?? "").toUpperCase();
      if (["SUCCESS", "COMPLETED"].includes(finalState)) {
        if (backupImportKind === "manga") {
          try {
            await hydrateAppReadingStateFromImportedMangaBackup();
          } catch (error) {
            console.warn("Could not hydrate Home reading state from imported manga backup:", error);
          }
          await refreshHomeRestoreSnapshots();
        }
        addToast({
          kind: "success",
          title: "Backup restored",
          body: "Restart or refresh views to pick up restored library state.",
        });
        return { ok: true, finalState };
      } else {
        backupError = `Restore finished with state: ${backupRestoreStatus?.state ?? "unknown"}`;
        return { ok: false, finalState: backupRestoreStatus?.state ?? null };
      }
    } catch (e: any) {
      backupError = e?.message ?? "Failed to restore backup";
      return { ok: false, finalState: null };
    } finally {
      backupRestoring = false;
    }
  }

  async function relaunchRestoreIntoOtherProfile() {
    if (!backupImportKind || !backupSelectedFilePath) {
      throw new Error("Select a backup file before continuing to the other local profile.");
    }
    if (!otherLocalProfileId) {
      throw new Error("Sandbox restore is only available when the current session is already running on TEST or MAIN.");
    }

    const args = buildRestoreRelaunchArgs({
      targetProfileId: otherLocalProfileId,
      intent: {
        kind: backupImportKind,
        path: backupSelectedFilePath,
        handoff: true,
        sourceProfileId: currentRuntimeProfileId ?? null,
      },
    });
    await invoke("relaunch_with_args", { args });
  }

  async function applyCurrentProfileNovelsRestore(bytes: ArrayBuffer) {
    const storageRuntime = await getStorageRuntime();
    const runtime = await loadNovelRuntimeState();
    const restored = await storageRuntime.restoreAethonNovelsPayload(bytes, runtime);
    const scopeInput = {
      profileId: currentRuntimeProfileId,
      serverUrl: currentRuntimeServerUrl,
    };
    const currentState = await storageRuntime.loadNovelLibraryState(scopeInput);
    const nextState = storageRuntime.applyRestoredNovelsSnapshotToLibraryState({
      currentState,
      restored,
    });
    await storageRuntime.saveNovelLibraryState(nextState, scopeInput);
    return restored;
  }

  async function refreshHomeRestoreSnapshots() {
    try {
      const [mangaResult, categoryResult, trackingResult] = await Promise.all([
        gql<{ mangas: { nodes: Category[] } }>(GET_LIBRARY),
        gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES),
        gql(GET_LIBRARY_TRACKING_SUMMARY),
      ]);
      setLibraryMangaSnapshot(
        (mangaResult as any).mangas.nodes.map((manga: any) => ({
          ...manga,
          chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? 0,
        })),
      );
      setCategories(normalizeCategories(categoryResult.categories.nodes));
      setLibraryTrackingSummarySnapshot((trackingResult as any).trackers.nodes ?? []);
    } catch (error) {
      console.warn("Could not refresh Home snapshots after restore:", error);
    }
  }

  function normalizeImportedReadingKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function legacyMangaLookupKey(sourceId: string, title: string): string {
    return `${sourceId}|${normalizeImportedReadingKey(title)}`;
  }

  function legacyChapterLookupKey(url: string): string {
    return normalizeImportedReadingKey(url);
  }

  function historyDateKey(ts: number): string {
    const date = new Date(ts);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function computeImportedReadingStats(entries: Array<{
    manga: { source?: unknown; title?: string };
    history: { url?: string; lastRead?: number | string; readDuration?: number | string };
  }>): ReadingStats {
    if (entries.length === 0) return { ...DEFAULT_READING_STATS };

    const uniqueChapters = new Set(entries.map((entry) => `${String(entry.manga.source ?? "")}|${normalizeImportedReadingKey(entry.manga.title ?? "")}|${normalizeImportedReadingKey(entry.history.url ?? "")}`));
    const uniqueManga = new Set(entries.map((entry) => `${String(entry.manga.source ?? "")}|${normalizeImportedReadingKey(entry.manga.title ?? "")}`));
    const totalMinutes = entries.reduce((sum, entry) => {
      const raw = Number(entry.history.readDuration ?? 0);
      const minutes = raw > 0 ? Math.max(1, Math.round(raw / 60000)) : 5;
      return sum + minutes;
    }, 0);
    const orderedDays = [...new Set(entries.map((entry) => historyDateKey(Number(entry.history.lastRead ?? 0) || Date.now())))].sort();
    const lastStreakDate = orderedDays[orderedDays.length - 1] ?? "";

    let currentStreakDays = 0;
    let longestStreakDays = 0;
    let streak = 0;
    let previous = "";
    for (const day of orderedDays) {
      if (!previous) {
        streak = 1;
      } else {
        const prevDate = new Date(`${previous}T00:00:00`);
        prevDate.setDate(prevDate.getDate() + 1);
        const expected = historyDateKey(prevDate.getTime());
        streak = expected === day ? streak + 1 : 1;
      }
      longestStreakDays = Math.max(longestStreakDays, streak);
      previous = day;
    }

    if (lastStreakDate) {
      const latest = new Date(`${lastStreakDate}T00:00:00`);
      let cursor = historyDateKey(latest.getTime());
      let count = 0;
      const byDay = new Set(orderedDays);
      while (byDay.has(cursor)) {
        count += 1;
        latest.setDate(latest.getDate() - 1);
        cursor = historyDateKey(latest.getTime());
      }
      currentStreakDays = count;
    }

    return {
      totalChaptersRead: uniqueChapters.size,
      totalMangaRead: uniqueManga.size,
      totalMinutesRead: totalMinutes,
      firstReadAt: Math.min(...entries.map((entry) => Number(entry.history.lastRead ?? 0) || 0)),
      lastReadAt: Math.max(...entries.map((entry) => Number(entry.history.lastRead ?? 0) || 0)),
      currentStreakDays,
      longestStreakDays,
      lastStreakDate,
    };
  }

  async function hydrateAppReadingStateFromImportedMangaBackup(): Promise<boolean> {
    if (!backupParsed || !Array.isArray(backupParsed.mangaMessages)) return false;

    type ImportedBackupManga = {
      source?: unknown;
      title?: string;
      thumbnailUrl?: string;
      url?: string;
      chapters?: Array<{ url?: string; name?: string; chapterNumber?: number }>;
      history?: Array<{ url?: string; lastRead?: number | string; readDuration?: number | string }>;
    };

    type LiveManga = {
      id: number;
      title: string;
      thumbnailUrl?: string | null;
      source?: { id?: string | null } | null;
    };

    type LiveChapter = {
      id: number;
      name?: string | null;
      chapterNumber?: number | null;
      realUrl?: string | null;
    };

    const backupMangaMessages = backupParsed.mangaMessages as ImportedBackupManga[];
    const importedRows = backupMangaMessages.flatMap((manga) => {
      const mangaHistory = Array.isArray(manga.history) ? manga.history : [];
      return mangaHistory.map((history) => ({
        manga,
        history,
      }));
    });

    if (importedRows.length === 0) {
      replaceAppReadingState({
        history: [],
        readLog: [],
        readingStats: { ...DEFAULT_READING_STATS },
      });
      return false;
    }

    importedRows.sort((left, right) => Number(right.history.lastRead ?? 0) - Number(left.history.lastRead ?? 0));
    const historyRows = importedRows.slice(0, 300);
    const readLogRows = importedRows.slice(0, 5000);

    const libraryResult = await gql<{ mangas: { nodes: LiveManga[] } }>(GET_LIBRARY);
    const liveMangaByKey = new Map<string, LiveManga>();
    for (const manga of libraryResult.mangas.nodes ?? []) {
      const sourceId = String(manga.source?.id ?? "");
      liveMangaByKey.set(legacyMangaLookupKey(sourceId, manga.title), manga);
    }

    const resolvedMangaIds = [...new Set(
      historyRows
        .map((row) => {
          const sourceId = String(row.manga.source ?? "");
          const liveManga = liveMangaByKey.get(legacyMangaLookupKey(sourceId, row.manga.title ?? ""));
          return liveManga?.id ?? null;
        })
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
    )];

    const liveChapterByMangaId = new Map<number, LiveChapter[]>();
    const batchSize = 20;
    for (let index = 0; index < resolvedMangaIds.length; index += batchSize) {
      const batch = resolvedMangaIds.slice(index, index + batchSize);
      const aliases: string[] = [];
      const variables: Record<string, number> = {};

      batch.forEach((mangaId, batchIndex) => {
        const variableName = `m${batchIndex}`;
        variables[variableName] = mangaId;
        aliases.push(`
          c${batchIndex}: chapters(condition: { mangaId: $${variableName} }) {
            nodes {
              id
              name
              chapterNumber
              realUrl
            }
          }
        `);
      });

      const query = `query ImportedBackupChapters(${batch.map((_, batchIndex) => `$m${batchIndex}: Int!`).join(", ")}) {
        ${aliases.join("\n")}
      }`;
      const response = await gql<Record<string, { nodes: LiveChapter[] }>>(query, variables);
      batch.forEach((mangaId, batchIndex) => {
        liveChapterByMangaId.set(mangaId, response[`c${batchIndex}`]?.nodes ?? []);
      });
    }

    const historyEntries: HistoryEntry[] = [];
    const readLogEntries: ReadLogEntry[] = [];

    for (const row of historyRows) {
      const sourceId = String(row.manga.source ?? "");
      const liveManga = liveMangaByKey.get(legacyMangaLookupKey(sourceId, row.manga.title ?? ""));
      if (!liveManga) continue;

      const backupChapter = Array.isArray(row.manga.chapters)
        ? row.manga.chapters.find((chapter) => legacyChapterLookupKey(chapter.url ?? "") === legacyChapterLookupKey(row.history.url ?? ""))
        : null;
      const liveChapters = liveChapterByMangaId.get(liveManga.id) ?? [];
      const matchedLiveChapter = liveChapters.find((chapter) => legacyChapterLookupKey(chapter.realUrl ?? "") === legacyChapterLookupKey(row.history.url ?? ""))
        ?? (backupChapter?.chapterNumber !== undefined
          ? liveChapters.find((chapter) => Number(chapter.chapterNumber ?? Number.NaN) === Number(backupChapter.chapterNumber ?? Number.NaN))
          : null)
        ?? liveChapters[0]
        ?? null;

      const readAt = Number(row.history.lastRead ?? 0) || Date.now();
      const chapterId = matchedLiveChapter?.id ?? 0;
      const chapterName = matchedLiveChapter?.name
        ?? backupChapter?.name
        ?? row.history.url?.split("/").pop()
        ?? "Chapter";
      const thumbnailUrl = typeof liveManga.thumbnailUrl === "string" && liveManga.thumbnailUrl.length > 0
        ? liveManga.thumbnailUrl
        : (typeof row.manga.thumbnailUrl === "string" ? row.manga.thumbnailUrl : "");

      historyEntries.push({
        mangaId: liveManga.id,
        mangaTitle: liveManga.title,
        thumbnailUrl,
        chapterId,
        chapterName,
        readAt,
      });

      const rawReadDuration = Number(row.history.readDuration ?? 0);
      readLogEntries.push({
        mangaId: liveManga.id,
        chapterId,
        readAt,
        minutes: rawReadDuration > 0 ? Math.max(1, Math.round(rawReadDuration / 60000)) : 5,
      });
    }

    if (historyEntries.length === 0 && readLogEntries.length === 0) {
      return false;
    }

    replaceAppReadingState({
      history: historyEntries,
      readLog: readLogEntries,
      readingStats: computeImportedReadingStats(importedRows),
    });

    return true;
  }

  async function applyUnifiedRestore() {
    if (!backupUnifiedPlan || !backupSelectedFilePath) {
      throw new Error("Choose an Aethon backup before restoring.");
    }
    const selectedKinds = selectedExecutablePayloadKinds(backupUnifiedPlan, backupUnifiedSelection);
    if (selectedKinds.length === 0) {
      throw new Error("Select at least one executable payload to restore.");
    }

    const storageRuntime = await getStorageRuntime();
    const bytes = await storageRuntime.readFileAsArrayBuffer(backupSelectedFilePath);
    const results: Array<{ kind: string; status: "success" | "warning" | "failed" | "skipped"; summary: string; detail?: string | null }> = [];

    for (const kind of ["manga", "books", "novels", "app"] as const) {
      if (!selectedKinds.includes(kind)) continue;
      try {
        if (kind === "manga") {
          const extracted = await storageRuntime.extractAethonMangaPayloadFile(bytes);
          backupSelectedFile = extracted;
          await analyzeSelectedBackupFile(extracted);
          const outcome = await restoreBackup();
          results.push({
            kind,
            status: outcome.ok ? "success" : "failed",
            summary: outcome.ok
              ? "Manga restored into the current profile."
              : backupError ?? "Manga restore did not finish successfully.",
            detail: outcome.finalState,
          });
          continue;
        }

        if (kind === "books") {
          const restored = await storageRuntime.restoreAethonBooksPayload(bytes);
          replaceBooksState({
            books: restored.books,
            bookProgress: restored.bookProgress,
            bookBookmarks: restored.bookBookmarks,
            booksCategories: restored.booksCategories,
            booksCategoryAssignments: restored.booksCategoryAssignments,
          });
          results.push({
            kind,
            status: restored.issues.length > 0 ? "warning" : "success",
            summary: restored.issues.length > 0
              ? `Books restored with ${restored.issues.length} warning${restored.issues.length === 1 ? "" : "s"}.`
              : "Books restored into managed storage.",
            detail: restored.exportMode,
          });
          continue;
        }

        if (kind === "novels") {
          const restored = await applyCurrentProfileNovelsRestore(bytes);
          results.push({
            kind,
            status: restored.summary.restoredMetadataOnlyCount > 0 ? "warning" : "success",
            summary: restored.summary.restoredMetadataOnlyCount > 0
              ? `${restored.summary.totalEntries} novel entries restored with metadata-only warnings.`
              : `${restored.summary.totalEntries} novel entries restored for this profile scope.`,
            detail: `${restored.summary.restoredUsableCount} usable / ${restored.summary.restoredMetadataOnlyCount} metadata-only`,
          });
          continue;
        }

        if (kind === "app") {
          const restored = await storageRuntime.parseAethonAppPayload(new Uint8Array(bytes));
          updateSettings({
            defaultLocalProfileId: restored.profile.defaultLocalProfileId,
          });
          if (restored.profile.version >= 2) {
            replaceAppReadingState({
              history: restored.profile.history,
              readLog: restored.profile.readLog,
              readingStats: restored.profile.readingStats,
            });
          } else {
            replaceAppReadingState({
              history: [],
              readLog: [],
              readingStats: DEFAULT_READING_STATS,
            });
          }
          results.push({
            kind,
            status: restored.profile.version >= 2 ? "success" : "warning",
            summary: restored.profile.version >= 2
              ? "App reading state restored into the current session."
              : "App payload restored, but this backup does not include Home reading history.",
            detail: `schema v${restored.profile.version}`,
          });
          continue;
        }

      } catch (error) {
        results.push({
          kind,
          status: "failed",
          summary: error instanceof Error ? error.message : `Could not restore ${kind}.`,
        });
      }
    }

      if (results.some((entry) => (entry.kind === "manga" || entry.kind === "app") && entry.status !== "failed")) {
        await refreshHomeRestoreSnapshots();
      }

    backupRestoreResults = results;
    const failed = results.filter((entry) => entry.status === "failed").length;
    addToast({
      kind: failed > 0 ? "info" : "success",
      title: failed > 0 ? "Restore finished with issues" : "Restore finished",
      body: results.map((entry) => `${entry.kind.toUpperCase()}: ${entry.status}`).join(" | "),
      duration: 16000,
    });
  }

  async function executeSelectedRestore() {
    backupError = null;
    backupRestoreResults = null;

    if (backupResolvedExecutionBlockedReason) {
      backupError = backupResolvedExecutionBlockedReason;
      return;
    }

    if (backupRestoreTargetMode === "other-local-profile") {
      await relaunchRestoreIntoOtherProfile();
      return;
    }

    if (!backupRestoreHandoffSession && !backupRestoreCurrentProfileConfirmed) {
      backupError = "Confirm the advanced current-profile restore before continuing.";
      return;
    }

    if (backupImportKind === "aethon") {
      await applyUnifiedRestore();
      return;
    }

    if (!backupSelectedFile && backupSelectedFilePath) {
      await loadLegacyBackupPath(backupSelectedFilePath);
    }
    const result = await restoreBackup();
    backupRestoreResults = [{
      kind: "manga",
      status: result.ok ? "success" : "failed",
      summary: result.ok
        ? "Manga backup restored into the current profile."
        : backupError ?? "Manga backup did not finish successfully.",
      detail: result.finalState,
    }];
  }

  function setBackupClusterSelection(clusterId: string, value: string | "skip") {
    backupReviewSelections = { ...backupReviewSelections, [clusterId]: value };
  }

  function clusterConfidenceLabel(cluster: ReconciliationClusterResult): string {
    const confidence = cluster.selectedCandidate?.confidence ?? cluster.candidates[0]?.confidence ?? 0;
    return `${Math.round(confidence * 100)}%`;
  }

  function clusterReasonLabel(cluster: ReconciliationClusterResult): string {
    return cluster.selectedCandidate?.evidenceSummary
      ?? cluster.candidates[0]?.evidenceSummary
      ?? "No confident replacement was found automatically.";
  }

  function clusterReadinessLabel(cluster: ReconciliationClusterResult): string {
    const item = backupReadiness?.items.find((entry) => entry.orphanSourceId === cluster.orphanSourceId);
    switch (item?.status) {
      case "ready_now":
        return "Ready now";
      case "requires_install":
        return "Requires install";
      case "unavailable":
        return "Unavailable";
      default:
        return "Needs review";
    }
  }

  function clusterReadinessDetail(cluster: ReconciliationClusterResult): string | null {
    return backupReadiness?.items.find((entry) => entry.orphanSourceId === cluster.orphanSourceId)?.detail ?? null;
  }

  function extensionForPkg(pkgName: string | null): AvailableExtensionEntry | null {
    if (!pkgName) return null;
    return backupAvailableExtensions.find((extension) => extension.pkgName === pkgName) ?? null;
  }

  function fmtBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B","KB","MB","GB","TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
  }
  interface PerfSnapshot {
    cacheEntries: number;
    cacheKeys:    string[];
    oldestEntryMs: number | null;
    newestEntryMs: number | null;
  }
  let perfSnapshot: PerfSnapshot | null = $state(null);
  function refreshPerfMetrics() {
    const knownPrefixes = ["library", "sources", "popular", "genre:", "manga:", "chapters:", "page:", "pages:"];
    let entries = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    const foundKeys: string[] = [];
    const checkKey = (k: string) => {
      const age = cache.ageOf(k);
      if (age !== undefined) {
        entries++;
        foundKeys.push(k);
        const ts = Date.now() - age;
        if (oldest === null || ts < oldest) oldest = ts;
        if (newest === null || ts > newest) newest = ts;
      }
    };
    ["library", "sources", "popular"].forEach(checkKey);
    ["Action","Romance","Fantasy","Comedy","Drama","Horror","Sci-Fi","Adventure","Thriller",
     "Isekai","Supernatural","Historical","Psychological","Sports","Mystery","Mecha",
     "Slice of Life","School Life","Martial Arts","Magic","Military"].forEach(g => checkKey(`genre:${g}`));
    perfSnapshot = { cacheEntries: entries, cacheKeys: foundKeys, oldestEntryMs: oldest, newestEntryMs: newest };
  }
  $effect(() => { if (tab === "performance") refreshPerfMetrics(); });
  function fmtAge(ts: number | null): string {
    if (ts === null) return "-";
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  }
  let storageLimitInput = $state(String(store.settings.storageLimitGb ?? ""));
  function applyStorageLimit() {
    const v = storageLimitInput.trim();
    if (v === "" || v === "0") { updateSettings({ storageLimitGb: null }); return; }
    const n = parseFloat(v);
    if (!isNaN(n) && n > 0) updateSettings({ storageLimitGb: n });
  }
  const BOOKS_TYPE_OPTIONS: { id: BooksLibraryTypeFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "epub", label: "EPUB" },
    { id: "pdf", label: "PDF" },
    { id: "sources", label: "Sources" },
  ];
  const LIBRARY_START_OPTIONS: { id: Settings["defaultLibrarySection"]; label: string }[] = [
    { id: "last-used", label: "Last used" },
    { id: "comics", label: "Comics" },
    { id: "books", label: "Books" },
  ];
  let catsLoading:    boolean      = $state(false);
  let catsError:      string|null  = $state(null);
  let categoryDomain: "comics" | "books" = $state("comics");
  let newFolderName   = $state("");
  let editingId: string | number | null = $state(null);
  let editingName     = $state("");
  const sortedBooksCategories = $derived(sortBooksCategories(store.settings.booksCategories));
  const comicsPreviewCategories = $derived(store.categories.filter((cat) => cat.id !== 0).slice(0, 5));
  const booksPreviewCategories = $derived(sortedBooksCategories.slice(0, 5));
  const categoryPreviewChips = $derived.by(() => {
    const seen = new Set<string>();
    const chips: string[] = [];
    for (const category of [...comicsPreviewCategories, ...booksPreviewCategories]) {
      const name = category.name.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      chips.push(name);
      if (chips.length >= 5) break;
    }
    return chips;
  });
  const booksCategoryCounts = $derived(
    Object.fromEntries(
      sortedBooksCategories.map((category) => [
        category.id,
        countBooksForCategory(category.id, store.settings.booksCategoryAssignments),
      ]),
    ),
  );
  async function loadCategories() {
    catsLoading = true; catsError = null;
    try {
      const res = await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES);
      const zeroCat = store.categories.filter(c => c.id === 0);
      const fresh = res.categories.nodes.filter(c => c.id !== 0);
      const merged = fresh.map(f => {
        const existing = store.categories.find(c => c.id === f.id);
        return existing ? { ...existing, ...f } : f;
      });
      setCategories([...zeroCat, ...merged]);
    } catch (e: any) {
      catsError = e?.message ?? "Failed to load folders";
    } finally { catsLoading = false; }
  }
  async function createFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    if (categoryDomain === "books") {
      const nextCategory = createBooksCategory(store.settings.booksCategories, name);
      updateSettings({
        booksCategories: sortBooksCategories([...store.settings.booksCategories, nextCategory]),
      });
      newFolderName = "";
      return;
    }
    try {
      const res = await gql<{ createCategory: { category: Category } }>(CREATE_CATEGORY, { name });
      setCategories([...store.categories, res.createCategory.category]);
      newFolderName = "";
    } catch (e: any) { catsError = e?.message ?? "Failed to create folder"; }
  }
  function startEdit(id: string | number, name: string) { editingId = id; editingName = name; }
  async function commitEdit() {
    if (editingId !== null && editingName.trim()) {
      if (categoryDomain === "books") {
        updateSettings({
          booksCategories: renameBooksCategory(
            store.settings.booksCategories,
            String(editingId),
            editingName.trim(),
          ),
        });
        editingId = null; editingName = "";
        return;
      }
      try {
        await gql(UPDATE_CATEGORY, { id: editingId, name: editingName.trim() });
        setCategories(store.categories.map(c => c.id === editingId ? { ...c, name: editingName.trim() } : c));
      } catch (e: any) { catsError = e?.message ?? "Failed to rename"; }
    }
    editingId = null; editingName = "";
  }
  async function toggleComicFolderUpdates(category: Category) {
    const nextIncludeInUpdate = category.includeInUpdate === "EXCLUDE" ? "UNSET" : "EXCLUDE";
    setCategories(store.categories.map((entry) => (
      entry.id === category.id
        ? { ...entry, includeInUpdate: nextIncludeInUpdate }
        : entry
    )));
    try {
      const res = await gql<{ updateCategory: { category: Category } }>(UPDATE_CATEGORY_UPDATE_RULE, {
        id: category.id,
        includeInUpdate: nextIncludeInUpdate,
      });
      setCategories(store.categories.map((entry) => (
        entry.id === category.id
          ? { ...entry, ...res.updateCategory.category }
          : entry
      )));
      addToast({
        kind: "success",
        title: nextIncludeInUpdate === "EXCLUDE" ? "Folder excluded from updates" : "Folder included in updates",
        body: nextIncludeInUpdate === "EXCLUDE"
          ? `${category.name} will be skipped during Library updates.`
          : `${category.name} will be checked during Library updates.`,
      });
    } catch (e: any) {
      catsError = e?.message ?? "Failed to update folder rule";
      await loadCategories();
    }
  }
  async function deleteFolder(id: string | number) {
    if (categoryDomain === "books") {
      const result = deleteBooksCategory(
        store.settings.booksCategories,
        store.settings.booksCategoryAssignments,
        String(id),
      );
      updateSettings({
        booksCategories: result.categories,
        booksCategoryAssignments: normalizeBooksCategoryAssignments(
          result.assignments,
          result.categories.map((category) => category.id),
        ),
        booksLibraryUi: {
          ...store.settings.booksLibraryUi,
          activeCategoryId:
            store.settings.booksLibraryUi.activeCategoryId === id
              ? null
              : store.settings.booksLibraryUi.activeCategoryId,
        },
      });
      return;
    }
    try {
      await gql(DELETE_CATEGORY, { id });
      setCategories(store.categories.filter(c => c.id !== id));
    } catch (e: any) { catsError = e?.message ?? "Failed to delete folder"; }
  }
  async function moveCategory(id: string | number, direction: -1 | 1) {
    if (categoryDomain === "books") {
      updateSettings({
        booksCategories: moveBooksCategory(store.settings.booksCategories, String(id), direction),
      });
      return;
    }
    const zeroCat  = store.categories.filter(c => c.id === 0);
    const sortable = store.categories
      .filter(c => c.id !== 0)
      .sort((a, b) => a.order - b.order);
    const idx = sortable.findIndex(c => c.id === id);
    if (idx < 0) return;
    const newPos = idx + 1 + direction; // 1-based server position
    if (newPos < 1 || newPos > sortable.length) return;
    const reordered = [...sortable];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(idx + direction, 0, moved);
    setCategories([...zeroCat, ...reordered.map((c, i) => ({ ...c, order: i + 1 }))]);
    try {
      const res = await gql<{ updateCategoryOrder: { categories: Category[] } }>(UPDATE_CATEGORY_ORDER, { id, position: newPos });
      const updated = res.updateCategoryOrder.categories.filter(c => c.id !== 0);
      setCategories([
        ...zeroCat,
        ...updated
          .sort((a, b) => a.order - b.order)
          .map(fresh => {
            const existing = store.categories.find(c => c.id === fresh.id);
            return existing ? { ...existing, ...fresh } : fresh;
          }),
      ]);
    } catch (e: any) {
      catsError = e?.message ?? "Failed to reorder";
      await loadCategories();
    }
  }
  $effect(() => {
    if (tab === "categories" && categoryDomain === "comics" && !store.categories.length && !catsLoading) loadCategories();
  });
  function resetCategoryEditor() {
    editingId = null;
    editingName = "";
    newFolderName = "";
  }
  function openCategoryManager(domain: "comics" | "books") {
    categoryDomain = domain;
    categoriesDetailsPane = domain;
    resetCategoryEditor();
  }
  function closeCategoryManager() {
    categoriesDetailsPane = null;
    resetCategoryEditor();
  }
  let selectOpen: string | null = $state(null);
  function toggleSelect(id: string) { selectOpen = selectOpen === id ? null : id; }
  function onSelectOutside(e: MouseEvent) {
    if (selectOpen && !(e.target as HTMLElement).closest(".select-wrap")) selectOpen = null;
  }
  $effect(() => {
    document.addEventListener("mousedown", onSelectOutside);
    return () => document.removeEventListener("mousedown", onSelectOutside);
  });
  let splashTriggered = $state(false);
  let showAuthPass     = $state(false);
  let showSocksPass    = $state(false);
  let pinInput         = $state(store.settings.appLockPin ?? "");
  let pinError         = $state("");
  let secLoading       = $state(false);
  let secError         = $state<string | null>(null);
  let secSaved         = $state<string | null>(null);
  let authUsername     = $state(store.settings.serverAuthUser ?? "");
  let authPassword     = $state(store.settings.serverAuthPass ?? "");
  let socksEnabled     = $state(store.settings.socksProxyEnabled ?? false);
  let socksHost        = $state(store.settings.socksProxyHost ?? "");
  let socksPort        = $state(store.settings.socksProxyPort ?? "1080");
  let socksVersion     = $state(store.settings.socksProxyVersion ?? 5);
  let socksUsername    = $state(store.settings.socksProxyUsername ?? "");
  let socksPassword    = $state(store.settings.socksProxyPassword ?? "");
  let flareEnabled     = $state(store.settings.flareSolverrEnabled ?? false);
  let flareUrl         = $state(store.settings.flareSolverrUrl ?? "http://localhost:8191");
  let flareTimeout     = $state(store.settings.flareSolverrTimeout ?? 60);
  let flareSession     = $state(store.settings.flareSolverrSessionName ?? "moku");
  let flareTtl         = $state(store.settings.flareSolverrSessionTtl ?? 15);
  let flareFallback    = $state(store.settings.flareSolverrFallback ?? false);
  let flareLocalAutoStart = $state(store.settings.flareSolverrLocalAutoStart ?? false);
  let flareTestState   = $state<FlareTestState>("idle");
  let flareLocalStatus = $state<LocalFlareSolverrStatus | null>(null);
  let flareLocalBusy   = $state(false);
  let flareDockerStatus = $state<DockerFlareSolverrStatus | null>(null);
  let flareDockerBusy  = $state(false);
  let flareAdvancedOpen = $state(false);
  let flareLocalOpen = $state(false);
  let flareDockerOpen = $state(false);
  let flareAutoChecked = $state(false);
  function showSaved(key: string) {
    secSaved = key; secError = null;
    setTimeout(() => { if (secSaved === key) secSaved = null; }, 2000);
  }
  let secLoaded        = $state(false);
  async function loadServerSecurity() {
    try {
      const res = await gql<{ settings: {
        authMode: string; authUsername: string;
        socksProxyEnabled: boolean; socksProxyHost: string; socksProxyPort: string;
        socksProxyVersion: number; socksProxyUsername: string;
        flareSolverrEnabled: boolean; flareSolverrUrl: string; flareSolverrTimeout: number;
        flareSolverrSessionName: string; flareSolverrSessionTtl: number;
        flareSolverrAsResponseFallback: boolean;
      }}>(GET_SERVER_SECURITY);
      const s = res.settings;
      const authOn = s.authMode === "BASIC_AUTH";
      updateSettings({ serverAuthEnabled: authOn, serverAuthUser: s.authUsername });
      authUsername  = s.authUsername;
      socksEnabled  = s.socksProxyEnabled;  socksHost    = s.socksProxyHost;
      socksPort     = s.socksProxyPort;     socksVersion = s.socksProxyVersion;
      socksUsername = s.socksProxyUsername;
      flareEnabled  = s.flareSolverrEnabled; flareUrl    = s.flareSolverrUrl;
      flareTimeout  = s.flareSolverrTimeout; flareSession = s.flareSolverrSessionName;
      flareTtl      = s.flareSolverrSessionTtl; flareFallback = s.flareSolverrAsResponseFallback;
      updateSettings({
        socksProxyEnabled: socksEnabled, socksProxyHost: socksHost, socksProxyPort: socksPort,
        socksProxyVersion: socksVersion, socksProxyUsername: socksUsername,
        flareSolverrEnabled: flareEnabled, flareSolverrUrl: flareUrl,
        flareSolverrTimeout: flareTimeout, flareSolverrSessionName: flareSession,
        flareSolverrSessionTtl: flareTtl, flareSolverrFallback: flareFallback,
      });
      secLoaded = true;
    } catch {}
  }
  $effect(() => { if (tab === "security" && !secLoaded) loadServerSecurity(); });
  $effect(() => {
    if (tab === "security" && flareLocalStatus === null && !flareLocalBusy) {
      refreshFlareLocalStatus();
    }
    if (tab === "security" && flareDockerStatus === null && !flareDockerBusy) {
      refreshFlareDockerStatus();
    }
  });
  $effect(() => {
    if (tab !== "security") {
      flareAutoChecked = false;
      return;
    }
    if (!flareEnabled || flareAutoChecked || flareTestState !== "idle") return;
    flareAutoChecked = true;
    void testFlareSolverr();
  });
  async function enableAuth() {
    if (!authUsername.trim() || !authPassword.trim()) {
      secError = "Username and password are required"; return;
    }
    secLoading = true; secError = null;
    updateSettings({ serverAuthEnabled: true, serverAuthUser: authUsername, serverAuthPass: authPassword });
    try {
      await gql(SET_SERVER_AUTH, { authMode: "BASIC_AUTH", authUsername: authUsername.trim(), authPassword: authPassword.trim() });
      showSaved("auth");
    } catch (e: any) {
      updateSettings({ serverAuthEnabled: false });
      secError = e?.message ?? "Failed to enable authentication";
    } finally { secLoading = false; }
  }
  async function disableAuth() {
    secLoading = true; secError = null;
    try {
      await gql(SET_SERVER_AUTH, { authMode: "NONE", authUsername: "", authPassword: "" });
      updateSettings({ serverAuthEnabled: false, serverAuthUser: "", serverAuthPass: "" });
      authUsername = ""; authPassword = "";
      showSaved("auth");
    } catch (e: any) {
      secError = e?.message ?? "Failed to disable authentication";
    } finally { secLoading = false; }
  }
  async function saveSocksProxy() {
    secLoading = true; secError = null;
    try {
      await gql(SET_SOCKS_PROXY, {
        socksProxyEnabled: socksEnabled, socksProxyHost: socksHost.trim(),
        socksProxyPort: socksPort.trim(), socksProxyVersion: socksVersion,
        socksProxyUsername: socksUsername.trim(), socksProxyPassword: socksPassword.trim(),
      });
      updateSettings({
        socksProxyEnabled: socksEnabled, socksProxyHost: socksHost,
        socksProxyPort: socksPort, socksProxyVersion: socksVersion,
        socksProxyUsername: socksUsername, socksProxyPassword: socksPassword,
      });
      showSaved("socks");
    } catch (e: any) {
      secError = e?.message ?? "Failed to save SOCKS proxy";
    } finally { secLoading = false; }
  }
  async function saveFlareSolverr() {
    secLoading = true; secError = null;
    try {
      await gql(SET_FLARESOLVERR, {
        flareSolverrEnabled: flareEnabled, flareSolverrUrl: flareUrl.trim(),
        flareSolverrTimeout: flareTimeout, flareSolverrSessionName: flareSession.trim(),
        flareSolverrSessionTtl: flareTtl, flareSolverrAsResponseFallback: flareFallback,
      });
      updateSettings({
        flareSolverrEnabled: flareEnabled, flareSolverrUrl: flareUrl,
        flareSolverrTimeout: flareTimeout, flareSolverrSessionName: flareSession,
        flareSolverrSessionTtl: flareTtl, flareSolverrFallback: flareFallback,
        flareSolverrLocalAutoStart: flareLocalAutoStart,
      });
      showSaved("flare");
    } catch (e: any) {
      secError = e?.message ?? "Failed to save FlareSolverr";
    } finally { secLoading = false; }
  }
  function flareStatusLabel(state = flareTestState) {
    if (state === "testing") return "Testing";
    if (state === "ready") return "Ready";
    if (state === "not-reachable") return "Not reachable";
    if (state === "check-url") return "Check URL";
    return "";
  }
  function flareLocalStateLabel() {
    if (flareLocalBusy) return "Checking";
    if (!flareLocalStatus?.installed) return "Not installed";
    return flareLocalStatus.running ? "Running" : "Installed";
  }
  function flareDockerStateLabel() {
    if (flareDockerBusy) return "Checking";
    if (!flareDockerStatus?.installed) return "Docker not found";
    if (!flareDockerStatus.daemon) return "Docker unavailable";
    return flareDockerStatus.running ? "Running" : "Available";
  }
  function setFlareLocalAutoStart(next: boolean) {
    flareLocalAutoStart = next;
    updateSettings({ flareSolverrLocalAutoStart: next });
  }
  function normalizedFlareUrl() {
    const raw = flareUrl.trim() || "http://localhost:8191";
    const url = new URL(raw);
    return `${url.origin}/v1`;
  }
  async function testFlareSolverr({ saveOnReady = false } = {}) {
    flareTestState = "testing";
    let endpoint: string;
    try {
      endpoint = normalizedFlareUrl();
    } catch {
      flareTestState = "check-url";
      return false;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6000);
    try {
      const response = await tauriFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "sessions.list" }),
        signal: controller.signal,
      });
      if (!response.ok) {
        flareTestState = "check-url";
        return false;
      }
      const body = await response.json().catch(() => null) as { status?: string } | null;
      flareTestState = body?.status === "ok" ? "ready" : "check-url";
      if (flareTestState === "ready" && saveOnReady) {
        flareEnabled = true;
        await saveFlareSolverr();
      }
      return flareTestState === "ready";
    } catch {
      flareTestState = "not-reachable";
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }
  async function refreshFlareLocalStatus() {
    flareLocalBusy = true;
    try {
      flareLocalStatus = await invoke<LocalFlareSolverrStatus>("get_flaresolverr_local_status");
    } catch {
      flareLocalStatus = { installed: false, running: false, path: null, message: "Not installed" };
    } finally {
      flareLocalBusy = false;
    }
  }
  async function startFlareLocal() {
    flareLocalBusy = true;
    try {
      flareLocalStatus = await invoke<LocalFlareSolverrStatus>("start_flaresolverr_local");
      flareUrl = "http://localhost:8191";
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      await testFlareSolverr({ saveOnReady: true });
    } catch {
      flareTestState = "not-reachable";
    } finally {
      flareLocalBusy = false;
    }
  }
  async function stopFlareLocal() {
    flareLocalBusy = true;
    try {
      flareLocalStatus = await invoke<LocalFlareSolverrStatus>("stop_flaresolverr_local");
    } catch {
      flareTestState = "check-url";
    } finally {
      flareLocalBusy = false;
    }
  }
  async function openFlareLocalFolder() {
    try {
      await invoke("open_flaresolverr_local_folder");
    } catch {
      addToast({
        kind: "error",
        title: "Folder unavailable",
        body: "Could not open the local FlareSolverr folder.",
      });
    }
  }
  async function openFlareLocalLogs() {
    try {
      await invoke("open_flaresolverr_local_logs");
    } catch {
      addToast({
        kind: "error",
        title: "Logs unavailable",
        body: "Could not open the local FlareSolverr logs.",
      });
    }
  }
  async function refreshFlareDockerStatus() {
    flareDockerBusy = true;
    try {
      flareDockerStatus = await invoke<DockerFlareSolverrStatus>("get_flaresolverr_docker_status");
    } catch {
      flareDockerStatus = { installed: false, daemon: false, running: false, version: null, message: "Docker not found" };
    } finally {
      flareDockerBusy = false;
    }
  }
  async function startFlareDocker() {
    flareDockerBusy = true;
    try {
      flareDockerStatus = await invoke<DockerFlareSolverrStatus>("start_flaresolverr_docker");
      flareUrl = "http://localhost:8191";
      await testFlareSolverr({ saveOnReady: true });
    } catch {
      flareTestState = "not-reachable";
    } finally {
      flareDockerBusy = false;
    }
  }
  async function stopFlareDocker() {
    flareDockerBusy = true;
    try {
      flareDockerStatus = await invoke<DockerFlareSolverrStatus>("stop_flaresolverr_docker");
    } catch {
      flareTestState = "check-url";
    } finally {
      flareDockerBusy = false;
    }
  }
  function commitPin() {
    const cleaned = pinInput.replace(/\D/g, "").slice(0, 8);
    pinInput = cleaned;
    if (cleaned.length >= 4) {
      updateSettings({ appLockPin: cleaned }); pinError = "";
    } else if (cleaned.length > 0) {
      pinError = "PIN must be at least 4 digits";
    } else {
      updateSettings({ appLockPin: "" }); pinError = "";
    }
  }
  let trackers:        Tracker[]    = $state([]);
  let trackersLoading: boolean      = $state(false);
  let trackersError:   string|null  = $state(null);
  let oauthTrackerId:  number|null  = $state(null);
  let oauthCallbackInput: string    = $state("");
  let oauthSubmitting: boolean      = $state(false);
  let oauthAutoCapturing: boolean   = $state(false);
  let oauthAutoUnlisten: (() => void) | null = null;
  let credsTrackerId:  number|null  = $state(null);
  let credsUsername:   string       = $state("");
  let credsPassword:   string       = $state("");
  let credsSubmitting: boolean      = $state(false);
  let loggingOut:      number|null  = $state(null); // trackerId being logged out
  let hardcoverState: HardcoverTrackingState = $state(loadHardcoverState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));
  let hardcoverTokenInput = $state("");
  let hardcoverSubmitting = $state(false);
  let hardcoverError: string | null = $state(null);
  let hardcoverAuthOpen = $state(false);
  let hardcoverIconBroken = $state(false);
  const activeTrackerDetail = $derived.by(
    () => trackers.find((candidate) => candidate.id === oauthTrackerId || candidate.id === credsTrackerId) ?? null,
  );
  const activeTrackerDetailMode = $derived.by(
    () => (oauthTrackerId !== null ? "oauth" : credsTrackerId !== null ? "credentials" : null),
  );
  async function loadTrackers() {
    trackersLoading = true; trackersError = null;
    try {
      const res = await gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS);
      trackers = res.trackers.nodes;
    } catch (e: any) {
      trackersError = e?.message ?? "Failed to load trackers";
    } finally {
      trackersLoading = false;
    }
  }
  $effect(() => { if (tab === "tracking" && trackers.length === 0 && !trackersLoading) loadTrackers(); });
  $effect(() => {
    if (tab === "tracking") {
      hardcoverState = loadHardcoverState({
        profileId: currentRuntimeProfileId,
        serverUrl: currentRuntimeServerUrl,
      });
    }
  });
  async function submitHardcoverToken() {
    if (!hardcoverTokenInput.trim()) return;
    hardcoverSubmitting = true;
    hardcoverError = null;
    try {
      hardcoverState = await connectHardcover({
        profileId: currentRuntimeProfileId,
        serverUrl: currentRuntimeServerUrl,
      }, hardcoverTokenInput);
      hardcoverTokenInput = "";
      hardcoverAuthOpen = false;
      addToast({ kind: "success", title: "Hardcover connected", body: hardcoverState.auth.username ?? "Novel tracking is ready." });
    } catch (error: any) {
      hardcoverError = error?.message ?? "Failed to connect Hardcover";
    } finally {
      hardcoverSubmitting = false;
    }
  }
  function disconnectHardcoverAccount() {
    hardcoverState = disconnectHardcover({
      profileId: currentRuntimeProfileId,
      serverUrl: currentRuntimeServerUrl,
    });
    hardcoverTokenInput = "";
    hardcoverError = null;
    hardcoverAuthOpen = false;
    addToast({ kind: "info", title: "Hardcover disconnected" });
  }
  function startHardcoverAuth() {
    closeTrackerDetail();
    hardcoverError = null;
    hardcoverTokenInput = "";
    hardcoverAuthOpen = true;
  }
  function cancelHardcoverAuth() {
    hardcoverTokenInput = "";
    hardcoverError = null;
    hardcoverAuthOpen = false;
  }
  async function startOAuth(tracker: Tracker) {
    if (!tracker.authUrl) return;
    trackersError = null;
    hardcoverAuthOpen = false;
    credsTrackerId = null;
    credsUsername = "";
    credsPassword = "";
    oauthTrackerId     = tracker.id;
    oauthCallbackInput = "";
    oauthAutoCapturing = true;
    oauthAutoUnlisten?.();
    oauthAutoUnlisten = await listen<{ url: string }>("tracker-oauth-callback", async (event) => {
      if (oauthTrackerId !== tracker.id) return;
      oauthCallbackInput = event.payload.url;
      await submitOAuth();
      oauthAutoUnlisten?.();
      oauthAutoUnlisten = null;
      oauthAutoCapturing = false;
    });

    try {
      await invoke("open_tracker_oauth_window", { url: tracker.authUrl });
    } catch (error) {
      oauthAutoCapturing = false;
      oauthAutoUnlisten?.();
      oauthAutoUnlisten = null;
      await openUrl(tracker.authUrl);
      trackersError = "Automatic OAuth capture is unavailable. Paste the redirected callback URL below.";
    }
  }
  async function submitOAuth() {
    if (!oauthTrackerId || !oauthCallbackInput.trim()) return;
    oauthSubmitting = true;
    try {
      const tracker = trackers.find((candidate) => candidate.id === oauthTrackerId) ?? null;
      const callbackUrl = normalizeTrackerOAuthInput(tracker, oauthCallbackInput);
      if (!callbackUrl) {
        trackersError = `Paste the ${trackerOAuthParamName(tracker)} value or the redirected URL first.`;
        return;
      }
      await gql(LOGIN_TRACKER_OAUTH, {
        trackerId:   oauthTrackerId,
        callbackUrl,
      });
      await loadTrackers();
      oauthTrackerId     = null;
      oauthCallbackInput = "";
      oauthAutoCapturing = false;
      oauthAutoUnlisten?.();
      oauthAutoUnlisten = null;
    } catch (e: any) {
      trackersError = e?.message ?? "Login failed";
    } finally {
      oauthSubmitting = false;
    }
  }
  function cancelOAuth() {
    oauthTrackerId = null;
    oauthCallbackInput = "";
    oauthAutoCapturing = false;
    oauthAutoUnlisten?.();
    oauthAutoUnlisten = null;
  }
  function startCredentials(tracker: Tracker) {
    hardcoverAuthOpen = false;
    oauthTrackerId = null;
    oauthCallbackInput = "";
    oauthAutoCapturing = false;
    oauthAutoUnlisten?.();
    oauthAutoUnlisten = null;
    credsTrackerId = tracker.id;
    credsUsername  = "";
    credsPassword  = "";
  }
  async function submitCredentials() {
    if (!credsTrackerId || !credsUsername.trim() || !credsPassword.trim()) return;
    credsSubmitting = true;
    try {
      await gql(LOGIN_TRACKER_CREDENTIALS, {
        trackerId: credsTrackerId,
        username:  credsUsername.trim(),
        password:  credsPassword.trim(),
      });
      await loadTrackers();
      credsTrackerId = null;
      credsUsername  = "";
      credsPassword  = "";
    } catch (e: any) {
      trackersError = e?.message ?? "Login failed";
    } finally {
      credsSubmitting = false;
    }
  }
  function cancelCredentials() { credsTrackerId = null; credsUsername = ""; credsPassword = ""; }
  async function logoutTracker(trackerId: number) {
    loggingOut = trackerId;
    try {
      await gql(LOGOUT_TRACKER, { trackerId });
      await loadTrackers();
    } catch (e: any) {
      trackersError = e?.message ?? "Logout failed";
    } finally {
      loggingOut = null;
    }
  }
  function closeTrackerDetail() {
    hardcoverAuthOpen = false;
    oauthTrackerId = null;
    oauthCallbackInput = "";
    oauthAutoCapturing = false;
    oauthAutoUnlisten?.();
    oauthAutoUnlisten = null;
    credsTrackerId = null;
    credsUsername = "";
    credsPassword = "";
  }
  function usesOAuth(t: Tracker): boolean { return !!t.authUrl; }
  interface ReleaseInfo {
    tag_name:     string;
    name:         string;
    body:         string;
    published_at: string;
    html_url:     string;
  }
  type UpdatePhase =
    | "idle"
    | "downloading"
    | "ready"      // downloaded, awaiting restart
    | "error";
  const IS_WINDOWS = navigator.userAgent.includes("Windows");
  let appVersion      = $state("...");
  let releases        = $state<ReleaseInfo[]>([]);
  let releasesLoading = $state(false);
  let releasesError   = $state<string | null>(null);
  let expandedTag     = $state<string | null>(null);
  let updatePhase     = $state<UpdatePhase>("idle");
  let updateError     = $state<string | null>(null);
  let dlBytes         = $state(0);
  let dlTotal         = $state<number | null>(null);
  let targetTag       = $state<string | null>(null); // tag being installed
  let releasesLoaded = false; // plain var, not $state, so effect does not re-run on change
  $effect(() => {
    if (tab !== "about") return;
    getVersion().then(v => appVersion = v).catch(() => appVersion = "unknown");
    if (!releasesLoaded) { releasesLoaded = true; loadReleases(); }
  });
  async function loadReleases() {
    releasesLoading = true; releasesError = null;
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out after 10s")), 10_000)
      );
      const all = await Promise.race([
        invoke<ReleaseInfo[]>("list_releases"),
        timeout,
      ]);
      releases = all.filter(r => typeof r.tag_name === "string" && r.tag_name.trim());
    } catch (e: any) {
      releasesError = e instanceof Error ? e.message : String(e);
    } finally {
      releasesLoading = false;
    }
  }
  function stripV(v: string) { return v.replace(/^v/, ""); }
  function isCurrentVersion(tag: string) { return stripV(tag) === appVersion; }
  function parseSemver(v: string): number[] {
    return stripV(v).split(".").map(Number);
  }
  function compareSemver(a: string, b: string): number {
    const pa = parseSemver(a), pb = parseSemver(b);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
    }
    return 0;
  }
  let onLatestVersion = $derived((() => {
    if (releasesLoading || releases.length === 0 || !appVersion || appVersion === "...") return false;
    const sorted = releases.slice().sort((a, b) => compareSemver(a.tag_name, b.tag_name));
    return compareSemver(appVersion, sorted[0].tag_name) >= 0;
  })());
  function fmtDate(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  let unlistenProgress: (() => void) | undefined;
  $effect(() => {
    listen<{ downloaded: number; total: number | null }>("update-progress", (e) => {
      dlBytes = e.payload.downloaded;
      dlTotal = e.payload.total ?? null;
    }).then(fn => { unlistenProgress = fn; });
    return () => unlistenProgress?.();
  });
  async function installUpdate(release: ReleaseInfo) {
    if (updatePhase === "downloading") return;
    targetTag   = release.tag_name;
    updatePhase = "downloading";
    updateError = null;
    dlBytes     = 0;
    dlTotal     = null;
    try {
      if (IS_WINDOWS) {
        try { await invoke("kill_server", { serverUrl: currentRuntimeServerUrl }); } catch {}
        await invoke("download_and_install_update");
        updatePhase = "ready";
      } else {
        await openUrl(release.html_url);
        updatePhase = "idle";
        targetTag   = null;
      }
    } catch (e: any) {
      updateError = e instanceof Error ? e.message : String(e);
      updatePhase = "error";
    }
  }
  async function restartNow() {
    await invoke("restart_app");
  }
  function cancelUpdate() {
    updatePhase = "idle";
    updateError = null;
    targetTag   = null;
    dlBytes     = 0;
    dlTotal     = null;
  }
  function fmtProgress(): string {
    if (dlTotal) {
      return `${fmtBytes(dlBytes)} / ${fmtBytes(dlTotal)} (${Math.round((dlBytes / dlTotal) * 100)}%)`;
    }
    return fmtBytes(dlBytes);
  }
  function triggerSplash() {
    splashTriggered = true;
    setTimeout(() => splashTriggered = false, 200);
    (window as any).__mokuShowSplash?.();
  }
  let contentSources:        Source[] = $state([]);
  let contentSourcesLoading: boolean  = $state(false);
  let newTagInput:           string   = $state("");
  let sourceSearch:          string   = $state("");
  $effect(() => {
    if (tab === "content" && contentSources.length === 0 && !contentSourcesLoading) {
      loadContentSources();
    }
  });
  async function loadContentSources() {
    contentSourcesLoading = true;
    try {
      const d = await gql<{ sources: { nodes: Source[] } }>(GET_SOURCES);
      contentSources = d.sources.nodes.filter(s => s.id !== "0");
    } catch (e) { console.error(e); }
    finally { contentSourcesLoading = false; }
  }
  function addTag() {
    const t = newTagInput.trim().toLowerCase();
    if (!t) return;
    const tags = store.settings.nsfwFilteredTags ?? [];
    if (!tags.includes(t)) updateSettings({ nsfwFilteredTags: [...tags, t] });
    newTagInput = "";
  }
  function removeTag(tag: string) {
    updateSettings({ nsfwFilteredTags: (store.settings.nsfwFilteredTags ?? []).filter(t => t !== tag) });
  }
  function resetTags() {
    updateSettings({ nsfwFilteredTags: [] });
  }
  function toggleSourceAllowed(ids: string[]) {
    const allowed = store.settings.nsfwAllowedSourceIds ?? [];
    const blocked = store.settings.nsfwBlockedSourceIds ?? [];
    const allAllowed = ids.every(id => allowed.includes(id));
    if (allAllowed) {
      updateSettings({ nsfwAllowedSourceIds: allowed.filter(x => !ids.includes(x)) });
    } else {
      updateSettings({
        nsfwAllowedSourceIds: [...allowed.filter(x => !ids.includes(x)), ...ids],
        nsfwBlockedSourceIds: blocked.filter(x => !ids.includes(x)),
      });
    }
  }
  function toggleSourceBlocked(ids: string[]) {
    const allowed = store.settings.nsfwAllowedSourceIds ?? [];
    const blocked = store.settings.nsfwBlockedSourceIds ?? [];
    const allBlocked = ids.every(id => blocked.includes(id));
    if (allBlocked) {
      updateSettings({ nsfwBlockedSourceIds: blocked.filter(x => !ids.includes(x)) });
    } else {
      updateSettings({
        nsfwBlockedSourceIds: [...blocked.filter(x => !ids.includes(x)), ...ids],
        nsfwAllowedSourceIds: allowed.filter(x => !ids.includes(x)),
      });
    }
  }
  interface ContentSourceGroup {
    name:    string;
    iconUrl: string;
    isNsfw:  boolean;
    sources: Source[];
  }
  const contentSourcesFiltered = $derived.by(() => {
    const q = sourceSearch.trim().toLowerCase();
    const filtered = q
      ? contentSources.filter(s => s.displayName.toLowerCase().includes(q) || s.lang.toLowerCase().includes(q))
      : contentSources;
    const map = new Map<string, ContentSourceGroup>();
    for (const s of filtered) {
      const key = s.name;
      if (!map.has(key)) map.set(key, { name: s.name, iconUrl: s.iconUrl, isNsfw: s.isNsfw, sources: [] });
      map.get(key)!.sources.push(s);
    }
    return Array.from(map.values());
  });
</script>
<main class="settings-page n-shell aethon-port--settings" class:is-search-engaged={settingsSearchOverlayActive}>
  <AppTopbar className="n-topbar--settings">
    {#snippet center()}
      <form
        class="n-search n-search--settings"
        role="search"
        aria-label="Search settings"
        onsubmit={submitSettingsSearch}
        onfocusin={handleSettingsSearchFocusIn}
        onfocusout={handleSettingsSearchFocusOut}
      >
        <span class="n-search__icon material-symbols-outlined" aria-hidden="true">search</span>
        <input
          class="n-search__input"
          aria-label="Search settings"
          placeholder="Search settings..."
          bind:this={settingsSearchInputEl}
          bind:value={settingsSearchQuery}
          autocomplete="off"
          spellcheck="false"
          oninput={handleSettingsSearchInput}
          onkeydown={handleSettingsSearchKeydown}
        />
      </form>
      <span class="settings-search-live" aria-live="polite">{settingsSearchAnnouncement}</span>
    {/snippet}
    {#snippet right()}
      <button class="n-icon-btn" aria-label="Open about settings" type="button" onclick={() => openTab("about")}>
        <Info size={16} weight="light" />
      </button>
      <WindowControlsInline />
    {/snippet}
  </AppTopbar>
  <div class="settings-search-overlay" class:is-active={settingsSearchOverlayActive} aria-hidden="true"></div>

  <aside class="settings-group-rail" id="settingsGroupRail">
    <nav class="settings-group-rail__nav" aria-label="Settings groups">
      {#each SETTINGS_GROUPS as group}
        <button
          class="cat-btn"
          class:is-active={activeGroup === group.id}
          type="button"
          data-settings-group={group.id}
          onclick={() => openGroup(group.id)}
        >
          <span class="cat-btn__icon"><group.icon size={16} weight="light" /></span>
          <span class="cat-btn__label">{group.label}</span>
        </button>
      {/each}
    </nav>
    <div class="settings-group-rail__footer">
      <div class="settings-brand-card">
        <div class="settings-brand-card__header">
          <div class="settings-brand-card__badge">
            <img src={splashMark} alt="" />
          </div>
          <div class="settings-brand-card__copy">
            <p class="settings-brand-card__title">Aethon Nocturne</p>
            <p class="settings-brand-card__meta">v{appVersion}</p>
          </div>
        </div>
        <div class="settings-brand-card__actions">
          <button class="settings-rail-action" type="button" onclick={() => openTab("about")}>Updates</button>
          <button class="settings-rail-action" type="button" onclick={() => openUrl("https://github.com/Youwes09/Moku")}>GitHub</button>
        </div>
      </div>
    </div>
  </aside>

  <div class="settings-workbench">
    <aside class="settings-subnav" aria-label={`${currentGroup.label} settings sections`}>
      <p class="settings-subnav__eyebrow">{currentGroup.label}</p>
      <div class="settings-subnav__list">
        {#each currentGroup.items as t}
          <button
            class="settings-subnav-btn"
            class:is-active={tab === t.id}
            type="button"
            data-settings-autofocus={tab === t.id ? "true" : undefined}
            onclick={() => openTab(t.id)}
          >
            <span class="settings-subnav-btn__icon"><t.icon size={16} weight="light" /></span>
            <span class="settings-subnav-btn__label">{t.label}</span>
          </button>
        {/each}
      </div>
    </aside>

    <section class="settings-pane-shell">
      <header class="settings-pane-header">
        <div>
          <p class="settings-pane-header__eyebrow" id="settingsPaneGroupLabel">{currentGroup.label}</p>
          <h2 class="settings-pane-header__title" id="settingsPaneTitle">{currentTabMeta.label}</h2>
          <p class="settings-pane-header__desc" id="settingsPaneDesc">{currentTabMeta.desc}</p>
        </div>
      </header>

      <div class="settings-pane-body content-body" bind:this={contentBodyEl} onscroll={rememberPaneScroll}>
        <section
          class="settings-pane"
          class:is-active={tab === "general"}
          data-settings-pane="general"
          hidden={tab !== "general"}
          aria-hidden={tab !== "general"}
        >
          <div class="settings-grid">
            <div class="settings-card">
              <p class="settings-card__title">Startup</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Launch into library</p>
                    <p class="settings-mini-row__hint">Open the last active library section on startup.</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.launchIntoLibrary}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.launchIntoLibrary}
                    aria-label="Launch into library"
                    onclick={() => updateSettings({ launchIntoLibrary: !store.settings.launchIntoLibrary })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Auto-start local server</p>
                    <p class="settings-mini-row__hint">Only when using the embedded desktop server.</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.autoStartServer}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.autoStartServer}
                    aria-label="Auto-start local server"
                    onclick={() => updateSettings({ autoStartServer: !store.settings.autoStartServer })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Automatic library updates</p>
                    <p class="settings-mini-row__hint">Wake the local server on schedule, sync new chapters, then return to standby when safe.</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.autoLibraryUpdatesEnabled}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.autoLibraryUpdatesEnabled}
                    aria-label="Automatic library updates"
                    onclick={() => updateSettings({ autoLibraryUpdatesEnabled: !store.settings.autoLibraryUpdatesEnabled })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Library update interval</p>
                    <p class="settings-mini-row__hint">How often Aethon checks your comics library for new chapters.</p>
                  </div>
                  <div class="select-wrap" id="general-library-update-interval">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("general-library-update-interval")}>
                      <span>{libraryUpdateIntervalLabel(store.settings.libraryUpdateIntervalHours)}</span>
                      <svg class="select-caret" class:open={selectOpen === "general-library-update-interval"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "general-library-update-interval"}
                      <div class="select-menu">
                        {#each [6, 12, 24, 48] as hours}
                          <button
                            class="select-option"
                            class:active={(store.settings.libraryUpdateIntervalHours ?? 12) === hours}
                            type="button"
                            onclick={() => {
                              updateSettings({ libraryUpdateIntervalHours: hours });
                              selectOpen = null;
                            }}
                          >
                            {libraryUpdateIntervalLabel(hours)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Update intensity</p>
                    <p class="settings-mini-row__hint">{libraryUpdateIntensityHint(store.settings.libraryUpdateIntensity)}</p>
                  </div>
                  <div class="select-wrap" id="general-library-update-intensity">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("general-library-update-intensity")}>
                      <span>{libraryUpdateIntensityLabel(store.settings.libraryUpdateIntensity)}</span>
                      <svg class="select-caret" class:open={selectOpen === "general-library-update-intensity"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "general-library-update-intensity"}
                      <div class="select-menu">
                        {#each ["eco", "balanced", "fast"] as intensity}
                          <button
                            class="select-option"
                            class:active={(store.settings.libraryUpdateIntensity ?? "balanced") === intensity}
                            type="button"
                            onclick={() => {
                              updateSettings({ libraryUpdateIntensity: intensity as Settings["libraryUpdateIntensity"] });
                              selectOpen = null;
                            }}
                          >
                            {libraryUpdateIntensityLabel(intensity as Settings["libraryUpdateIntensity"])}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Local server standby</p>
                    <p class="settings-mini-row__hint">Let Aethon stop Suwayomi after idle while Library can use its local snapshot.</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.localServerStandbyEnabled}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.localServerStandbyEnabled}
                    aria-label="Local server standby"
                    onclick={() => updateSettings({ localServerStandbyEnabled: !store.settings.localServerStandbyEnabled })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Standby after idle</p>
                    <p class="settings-mini-row__hint">Minimum idle time before the embedded server may sleep.</p>
                  </div>
                  <div class="select-wrap" id="general-server-standby-idle">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("general-server-standby-idle")}>
                      <span>{idleTimeoutLabel(store.settings.localServerStandbyIdleMin)}</span>
                      <svg class="select-caret" class:open={selectOpen === "general-server-standby-idle"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "general-server-standby-idle"}
                      <div class="select-menu">
                        {#each [5, 10, 15, 30] as minutes}
                          <button
                            class="select-option"
                            class:active={(store.settings.localServerStandbyIdleMin ?? 10) === minutes}
                            type="button"
                            onclick={() => {
                              updateSettings({ localServerStandbyIdleMin: minutes });
                              selectOpen = null;
                            }}
                          >
                            {idleTimeoutLabel(minutes)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Discord Rich Presence</p>
                    <p class="settings-mini-row__hint">Show reading activity when supported.</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.discordRpc}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.discordRpc}
                    aria-label="Discord Rich Presence"
                    onclick={() => updateSettings({ discordRpc: !store.settings.discordRpc })}
                  ></button>
                </div>
              </div>
            </div>
            <div class="settings-card">
              <p class="settings-card__title">Profiles</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Active profile</p>
                    <p class="settings-mini-row__hint">Local profile controls workspace, paths and session defaults.</p>
                  </div>
                  <div class="select-wrap" id="general-profile">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("general-profile")}>
                      <span>{nextLaunchProfileSummary}</span>
                      <svg class="select-caret" class:open={selectOpen === "general-profile"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "general-profile"}
                      <div class="select-menu">
                        {#each BUILTIN_LOCAL_PROFILES as profile}
                          <button
                            class="select-option"
                            class:active={persistedDefaultProfileId === profile.id}
                            type="button"
                            onclick={() => {
                              setDefaultLocalProfile(profile.id);
                              selectOpen = null;
                            }}
                          >
                            {profile.label} :{profile.port}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Idle timeout</p>
                    <p class="settings-mini-row__hint">Pause background operations after inactivity.</p>
                  </div>
                  <div class="select-wrap" id="general-idle-timeout">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("general-idle-timeout")}>
                      <span>{idleTimeoutLabel(store.settings.idleTimeoutMin)}</span>
                      <svg class="select-caret" class:open={selectOpen === "general-idle-timeout"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "general-idle-timeout"}
                      <div class="select-menu">
                        {#each [["0","Never"],["1","1 minute"],["2","2 minutes"],["5","5 minutes"],["10","10 minutes"],["15","15 minutes"],["30","30 minutes"]] as [value, label]}
                          <button
                            class="select-option"
                            class:active={String(store.settings.idleTimeoutMin ?? 5) === value}
                            type="button"
                            onclick={() => {
                              updateSettings({ idleTimeoutMin: Number(value) });
                              selectOpen = null;
                            }}
                          >
                            {label}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
              <div class="settings-card__surface" style="margin-top:16px">
                <div class="settings-card__head">
                  <p class="settings-card__title">Desktop defaults</p>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">Server URL</p>
                      <p class="settings-mini-row__hint">
                        {serverUrlManagedByProfile
                          ? "Managed by the active profile for this session."
                          : "Base URL of your Suwayomi instance."}
                      </p>
                    </div>
                    <input
                      class="settings-text-input"
                      value={currentRuntimeServerUrl}
                      oninput={(event) => {
                        if (!serverUrlManagedByProfile) updateSettings({ serverUrl: event.currentTarget.value });
                      }}
                      placeholder="http://localhost:4567"
                      spellcheck="false"
                      readonly={serverUrlManagedByProfile}
                    />
                  </div>
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">Preferred source language</p>
                      <p class="settings-mini-row__hint">Used to preselect languages in Search and deduplicate sources.</p>
                    </div>
                    <input
                      class="settings-text-input settings-text-input--short"
                      value={store.settings.preferredExtensionLang ?? ""}
                      oninput={(event) => updateSettings({ preferredExtensionLang: event.currentTarget.value.trim().toLowerCase() })}
                      placeholder="en"
                      spellcheck="false"
                    />
                  </div>
                </div>
                <div class="settings-card__footer settings-card__footer--split" style="margin-top:16px">
                  <div class="settings-meta-card">
                    <span class="settings-meta-card__label">Current session</span>
                    <span class="settings-meta-card__value">{currentSessionProfileSummary}</span>
                    <span class="settings-meta-card__hint">{currentRuntimeServerUrl}</span>
                  </div>
                  <div class="settings-meta-card">
                    <span class="settings-meta-card__label">Next launch default</span>
                    <span class="settings-meta-card__value">{nextLaunchProfileSummary}</span>
                    <span class="settings-meta-card__hint">{nextLaunchProfileMeta?.serverUrl ?? currentRuntimeServerUrl}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "appearance"}
          data-settings-pane="appearance"
          hidden={tab !== "appearance"}
          aria-hidden={tab !== "appearance"}
        >
          <div class="settings-grid">
            <div class="settings-card settings-card--wide">
              <p class="settings-card__title">Theme</p>
              <div class="settings-theme-preview">
                <div class="settings-theme-preview__glow"></div>
                <div class="settings-theme-preview__topbar">
                  <span class="settings-theme-preview__pill"></span>
                  <span class="settings-theme-preview__dash"></span>
                </div>
                <div class="settings-theme-preview__grid">
                  {#each Array(6) as _, index}
                    <span class="settings-theme-preview__tile" style={`animation-delay:${index * 18}ms`}></span>
                  {/each}
                </div>
              </div>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Theme preset</p>
                    <p class="settings-mini-row__hint">Choose the desktop surface palette.</p>
                  </div>
                  <div class="select-wrap" id="appearance-theme">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("appearance-theme")}>
                      <span>{themeLabel(store.settings.theme)}</span>
                      <svg class="select-caret" class:open={selectOpen === "appearance-theme"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "appearance-theme"}
                      <div class="select-menu">
                        {#each THEMES as theme}
                          <button
                            class="select-option"
                            class:active={(store.settings.theme ?? "nocturne") === theme.id}
                            type="button"
                            onclick={() => {
                              updateSettings({ theme: theme.id });
                              selectOpen = null;
                            }}
                          >
                            {theme.label}
                          </button>
                        {/each}
                        {#each store.settings.customThemes ?? [] as custom}
                          <button
                            class="select-option"
                            class:active={store.settings.theme === custom.id}
                            type="button"
                            onclick={() => {
                              updateSettings({ theme: custom.id });
                              selectOpen = null;
                            }}
                          >
                            {custom.name}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Custom theme editor</p>
                    <p class="settings-mini-row__hint">Create or adjust custom Nocturne-derived palettes.</p>
                  </div>
                  <div class="settings-section-actions settings-inline-actions">
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" title="Create a custom theme" onclick={() => onOpenThemeEditor?.(null)}>
                      New theme
                    </button>
                    {#if (store.settings.customThemes ?? []).some((theme) => theme.id === store.settings.theme)}
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" title="Edit current theme" onclick={() => onOpenThemeEditor?.(store.settings.theme)}>
                        Edit current
                      </button>
                    {/if}
                  </div>
                </div>
                <!-- Mockup-only controls preserved until dedicated appearance behaviors exist. -->
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">OLED dark mode</p>
                    <p class="settings-mini-row__hint">Pure black surfaces for high contrast displays.</p>
                  </div>
                  <button class="settings-toggle is-on" type="button" aria-disabled="true" aria-label="OLED dark mode" data-inert-control="settings-oled-mode"></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Accent intensity</p>
                    <p class="settings-mini-row__hint">Tune the lavender highlight strength.</p>
                  </div>
                  <input class="settings-range" type="range" min="0" max="100" value="62" aria-disabled="true" data-inert-control="settings-accent-intensity" />
                </div>
              </div>
            </div>
            <div class="settings-card">
              <p class="settings-card__title">Window chrome</p>
              <div class="settings-card__stack">
                <!-- Mockup-only controls preserved until shell-level chrome options are implemented. -->
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Compact topbar</p>
                    <p class="settings-mini-row__hint">Reduce shell chrome height for dense layouts.</p>
                  </div>
                  <button class="settings-toggle" type="button" aria-disabled="true" aria-label="Compact topbar" data-inert-control="settings-compact-topbar"></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Sidebar glow</p>
                    <p class="settings-mini-row__hint">Keep brand glow subtle in dark mode.</p>
                  </div>
                  <button class="settings-toggle is-on" type="button" aria-disabled="true" aria-label="Sidebar glow" data-inert-control="settings-sidebar-glow"></button>
                </div>
              </div>
            </div>
            <div class="settings-card">
              <p class="settings-card__title">UI density</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Interface scale</p>
                    <p class="settings-mini-row__hint">Desktop sizing for controls and labels.</p>
                  </div>
                  <div class="n-inline-segmented">
                    <button class="n-inline-segment" class:is-selected={uiDensityMode(store.settings.uiZoom) === "compact"} type="button" onclick={() => applyUiDensity("compact")}>Compact</button>
                    <button class="n-inline-segment" class:is-selected={uiDensityMode(store.settings.uiZoom) === "default"} type="button" onclick={() => applyUiDensity("default")}>Default</button>
                    <button class="n-inline-segment" class:is-selected={uiDensityMode(store.settings.uiZoom) === "comfort"} type="button" onclick={() => applyUiDensity("comfort")}>Comfort</button>
                  </div>
                </div>
                <!-- Mockup-only control preserved until card emphasis tuning exists as a first-class setting. -->
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Card emphasis</p>
                    <p class="settings-mini-row__hint">Covers vs metadata balance.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" aria-disabled="true" data-inert-control="settings-card-emphasis">
                    Balanced
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "reader"}
          data-settings-pane="reader"
          hidden={tab !== "reader"}
          aria-hidden={tab !== "reader"}
        >
          <div class="settings-grid">
            <div class="settings-card">
              <p class="settings-card__title">Layout</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Page style</p>
                    <p class="settings-mini-row__hint">How chapters open by default.</p>
                  </div>
                  <div class="n-inline-segmented">
                    <button class="n-inline-segment" class:is-selected={store.settings.pageStyle === "single"} type="button" onclick={() => updateSettings({ pageStyle: "single" })}>Single</button>
                    <button class="n-inline-segment" class:is-selected={store.settings.pageStyle === "double"} type="button" onclick={() => updateSettings({ pageStyle: "double" })}>Double</button>
                    <button class="n-inline-segment" class:is-selected={store.settings.pageStyle === "longstrip"} type="button" onclick={() => updateSettings({ pageStyle: "longstrip" })}>Longstrip</button>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Reading direction</p>
                    <p class="settings-mini-row__hint">Left-to-right for most manga, right-to-left for Japanese.</p>
                  </div>
                  <div class="n-inline-segmented">
                    <button class="n-inline-segment" class:is-selected={store.settings.readingDirection === "ltr"} type="button" onclick={() => updateSettings({ readingDirection: "ltr" })}>LTR</button>
                    <button class="n-inline-segment" class:is-selected={store.settings.readingDirection === "rtl"} type="button" onclick={() => updateSettings({ readingDirection: "rtl" })}>RTL</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">Behavior</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Page gap</p>
                    <p class="settings-mini-row__hint">Keep a slim spacer between reader pages.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.pageGap} aria-label="Page gap" class="settings-toggle" class:is-on={store.settings.pageGap} type="button" onclick={() => updateSettings({ pageGap: !store.settings.pageGap })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Overlay bars</p>
                    <p class="settings-mini-row__hint">Keep top and bottom chrome docked over the page.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.overlayBars ?? false} aria-label="Overlay bars" class="settings-toggle" class:is-on={store.settings.overlayBars ?? false} type="button" onclick={() => updateSettings({ overlayBars: !(store.settings.overlayBars ?? false) })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Auto next chapter</p>
                    <p class="settings-mini-row__hint">Continue automatically when the current chapter ends.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.autoNextChapter ?? false} aria-label="Auto next chapter" class="settings-toggle" class:is-on={store.settings.autoNextChapter ?? false} type="button" onclick={() => updateSettings({ autoNextChapter: !(store.settings.autoNextChapter ?? false) })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Mark read on next</p>
                    <p class="settings-mini-row__hint">Apply read state when skipping manually.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.markReadOnNext ?? true} aria-label="Mark read on next" class="settings-toggle" class:is-on={store.settings.markReadOnNext ?? true} type="button" disabled={store.settings.autoNextChapter ?? false} onclick={() => updateSettings({ markReadOnNext: !(store.settings.markReadOnNext ?? true) })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Auto-bookmark</p>
                    <p class="settings-mini-row__hint">Save your last page position as you read.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.autoBookmark ?? true} aria-label="Auto-bookmark" class="settings-toggle" class:is-on={store.settings.autoBookmark ?? true} type="button" onclick={() => updateSettings({ autoBookmark: !(store.settings.autoBookmark ?? true) })}></button>
                </div>
              </div>
            </div>

            <div class="settings-card settings-card--wide">
              <p class="settings-card__title">Fit &amp; Zoom</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default fit mode</p>
                    <p class="settings-mini-row__hint">Choose how pages fill the reader when a chapter opens.</p>
                  </div>
                  <div class="select-wrap" id="fit-mode">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("fit-mode")}>
                      <span>{fitModeLabel(store.settings.fitMode)}</span>
                      <svg class="select-caret" class:open={selectOpen === "fit-mode"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "fit-mode"}
                      <div class="select-menu">
                        {#each [["width","Fit width"],["height","Fit height"],["screen","Fit screen"],["original","Original (1:1)"]] as [v, l]}
                          <button class="select-option" class:active={(store.settings.fitMode ?? "width") === v} onclick={() => { updateSettings({ fitMode: v as FitMode }); selectOpen = null; }}>{l}</button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row settings-mini-row--stretch">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default zoom</p>
                    <p class="settings-mini-row__hint">100% fills the reader using the current fit mode.</p>
                  </div>
                  <div class="settings-zoom-controls">
                    <div class="scale-row">
                      <input type="range" min={10} max={400} step={5}
                        value={Math.round((store.settings.readerZoom ?? 0.5) * 100)}
                        oninput={(e) => updateSettings({ readerZoom: Number(e.currentTarget.value) / 100 })}
                        class="scale-slider" />
                      <input
                        type="number" min={10} max={400} step={5}
                        class="scale-val-input"
                        value={Math.round((store.settings.readerZoom ?? 0.5) * 100)}
                        oninput={(e) => {
                          const n = parseInt(e.currentTarget.value, 10);
                          if (!isNaN(n) && n >= 10 && n <= 400) updateSettings({ readerZoom: n / 100 });
                        }}
                        onblur={(e) => {
                          const n = parseInt(e.currentTarget.value, 10);
                          if (isNaN(n) || n < 10) { updateSettings({ readerZoom: 0.1 }); e.currentTarget.value = "10"; }
                          else if (n > 400) { updateSettings({ readerZoom: 4.0 }); e.currentTarget.value = "400"; }
                        }}
                      />
                      <span class="scale-pct">%</span>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => updateSettings({ readerZoom: 0.5 })} disabled={(store.settings.readerZoom ?? 0.5) === 0.5} title="Reset to 100%">100%</button>
                    </div>
                    <div class="settings-chip-list settings-chip-list--presets">
                      {#each [50, 75, 100, 125, 150, 200] as v}
                        <button class="settings-chip" class:is-active={Math.round((store.settings.readerZoom ?? 0.5) * 100) === v} type="button" onclick={() => updateSettings({ readerZoom: v / 100 })}>{v}%</button>
                      {/each}
                    </div>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Optimize contrast</p>
                    <p class="settings-mini-row__hint">Enhance faint panels and low-contrast scans.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.optimizeContrast} aria-label="Optimize contrast" class="settings-toggle" class:is-on={store.settings.optimizeContrast} type="button" onclick={() => updateSettings({ optimizeContrast: !store.settings.optimizeContrast })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Pages to preload</p>
                    <p class="settings-mini-row__hint">Keep upcoming pages warm in memory for faster turns.</p>
                  </div>
                  <div class="step-controls">
                    <button class="step-btn" type="button" onclick={() => updateSettings({ preloadPages: Math.max(0, store.settings.preloadPages - 1) })} disabled={store.settings.preloadPages <= 0}>-</button>
                    <span class="step-val">{store.settings.preloadPages}</span>
                    <button class="step-btn" type="button" onclick={() => updateSettings({ preloadPages: Math.min(10, store.settings.preloadPages + 1) })} disabled={store.settings.preloadPages >= 10}>+</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-card settings-card--wide">
              <p class="settings-card__title">Prose Reader Defaults (EPUB &amp; Novels)</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default Font Family</p>
                    <p class="settings-mini-row__hint">Select default typeface for novels and books.</p>
                  </div>
                  <div class="select-wrap" id="prose-font">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("prose-font")}>
                      <span>{store.settings.proseReaderFontFamily ? (store.settings.proseReaderFontFamily.split(",")[0].replace(/"/g, "")) : "Georgia"}</span>
                      <svg class="select-caret" class:open={selectOpen === "prose-font"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "prose-font"}
                      <div class="select-menu">
                        {#each [["Georgia, serif", "Georgia"], ["Merriweather, Georgia, serif", "Merriweather"], ["Inter, sans-serif", "Inter"], ["Atkinson Hyperlegible, Inter, sans-serif", "Atkinson"], ['"Segoe UI", sans-serif', "Segoe UI"]] as [v, l]}
                          <button class="select-option" class:active={(store.settings.proseReaderFontFamily ?? "Georgia, serif") === v} onclick={() => { updateSettings({ proseReaderFontFamily: v }); selectOpen = null; }}>{l}</button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default Font Size</p>
                    <p class="settings-mini-row__hint">Adjust text size in pixels.</p>
                  </div>
                  <div class="step-controls">
                    <button class="step-btn" type="button" onclick={() => updateSettings({ proseReaderFontSize: Math.max(12, (store.settings.proseReaderFontSize ?? 18) - 1) })} disabled={(store.settings.proseReaderFontSize ?? 18) <= 12}>-</button>
                    <span class="step-val">{store.settings.proseReaderFontSize ?? 18}px</span>
                    <button class="step-btn" type="button" onclick={() => updateSettings({ proseReaderFontSize: Math.min(32, (store.settings.proseReaderFontSize ?? 18) + 1) })} disabled={(store.settings.proseReaderFontSize ?? 18) >= 32}>+</button>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default Line Height</p>
                    <p class="settings-mini-row__hint">Spacing between text lines.</p>
                  </div>
                  <div class="step-controls">
                    <button class="step-btn" type="button" onclick={() => updateSettings({ proseReaderLineHeight: Math.round(Math.max(1.2, (store.settings.proseReaderLineHeight ?? 1.75) - 0.05) * 100) / 100 })} disabled={(store.settings.proseReaderLineHeight ?? 1.75) <= 1.2}>-</button>
                    <span class="step-val">{(store.settings.proseReaderLineHeight ?? 1.75).toFixed(2)}</span>
                    <button class="step-btn" type="button" onclick={() => updateSettings({ proseReaderLineHeight: Math.round(Math.min(2.4, (store.settings.proseReaderLineHeight ?? 1.75) + 0.05) * 100) / 100 })} disabled={(store.settings.proseReaderLineHeight ?? 1.75) >= 2.4}>+</button>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default Column Width</p>
                    <p class="settings-mini-row__hint">Constrain max width of the text block.</p>
                  </div>
                  <div class="step-controls">
                    <button class="step-btn" type="button" onclick={() => updateSettings({ proseReaderContentWidth: Math.max(520, (store.settings.proseReaderContentWidth ?? 760) - 40) })} disabled={(store.settings.proseReaderContentWidth ?? 760) <= 520}>-</button>
                    <span class="step-val">{store.settings.proseReaderContentWidth ?? 760}px</span>
                    <button class="step-btn" type="button" onclick={() => updateSettings({ proseReaderContentWidth: Math.min(980, (store.settings.proseReaderContentWidth ?? 760) + 40) })} disabled={(store.settings.proseReaderContentWidth ?? 760) >= 980}>+</button>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Text Alignment</p>
                    <p class="settings-mini-row__hint">Choose left-aligned or justified spacing.</p>
                  </div>
                  <div class="n-inline-segmented">
                    <button class="n-inline-segment" class:is-selected={(store.settings.proseReaderTextAlign ?? "left") === "left"} type="button" onclick={() => updateSettings({ proseReaderTextAlign: "left" })}>Left</button>
                    <button class="n-inline-segment" class:is-selected={(store.settings.proseReaderTextAlign ?? "left") === "justify"} type="button" onclick={() => updateSettings({ proseReaderTextAlign: "justify" })}>Justify</button>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Prose Reader Theme</p>
                    <p class="settings-mini-row__hint">Select colors for text and background canvas.</p>
                  </div>
                  <div class="select-wrap" id="prose-theme">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("prose-theme")}>
                      <span>{(store.settings.proseReaderTheme ?? "nocturne").toUpperCase()}</span>
                      <svg class="select-caret" class:open={selectOpen === "prose-theme"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "prose-theme"}
                      <div class="select-menu">
                        {#each [["nocturne","Nocturne"], ["dark","Dark"], ["sepia","Sepia"], ["light","Light"], ["oled","OLED"]] as [v, l]}
                          <button class="select-option" class:active={(store.settings.proseReaderTheme ?? "nocturne") === v} onclick={() => { updateSettings({ proseReaderTheme: v as any }); selectOpen = null; }}>{l}</button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Custom Palette Colors</p>
                    <p class="settings-mini-row__hint">Adjust text color (left) and paper background (right) directly.</p>
                  </div>
                  <div style="display: flex; gap: 8px;">
                    <input
                      type="color"
                      value={store.settings.proseReaderTextColor || "#efe9de"}
                      onchange={(e) => updateSettings({ proseReaderTheme: "nocturne", proseReaderTextColor: e.currentTarget.value })}
                      style="width: 24px; height: 24px; border: 1px solid rgba(255, 255, 255, 0.1); padding: 0; background: transparent; cursor: pointer; border-radius: 9999px; overflow: hidden;"
                      title="Custom text color"
                    />
                    <input
                      type="color"
                      value={store.settings.proseReaderBackgroundColor || "#17121c"}
                      onchange={(e) => updateSettings({ proseReaderTheme: "nocturne", proseReaderBackgroundColor: e.currentTarget.value })}
                      style="width: 24px; height: 24px; border: 1px solid rgba(255, 255, 255, 0.1); padding: 0; background: transparent; cursor: pointer; border-radius: 9999px; overflow: hidden;"
                      title="Custom paper color"
                    />
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Book Reader Flow</p>
                    <p class="settings-mini-row__hint">Choose paginated pages or vertical continuous scroll.</p>
                  </div>
                  <div class="n-inline-segmented">
                    <button class="n-inline-segment" class:is-selected={(store.settings.bookReaderFlow ?? "paginated") === "paginated"} type="button" onclick={() => updateSettings({ bookReaderFlow: "paginated" })}>Paginated</button>
                    <button class="n-inline-segment" class:is-selected={(store.settings.bookReaderFlow ?? "paginated") === "scrolled"} type="button" onclick={() => updateSettings({ bookReaderFlow: "scrolled" })}>Continuous</button>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Full Width Reading Panel</p>
                    <p class="settings-mini-row__hint">Expand EPUB, PDF, and Novel text areas to the edge of the screen.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.proseReaderFullWidth ?? false} aria-label="Full Width Reading Panel" class="settings-toggle" class:is-on={store.settings.proseReaderFullWidth ?? false} type="button" onclick={() => updateSettings({ proseReaderFullWidth: !(store.settings.proseReaderFullWidth ?? false) })}></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">PDF Defaults</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default PDF Fit Mode</p>
                    <p class="settings-mini-row__hint">Choose default viewport layout for PDF pages.</p>
                  </div>
                  <div class="select-wrap" id="pdf-fit">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("pdf-fit")}>
                      <span>{store.settings.pdfFitMode || "width"}</span>
                      <svg class="select-caret" class:open={selectOpen === "pdf-fit"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "pdf-fit"}
                      <div class="select-menu">
                        {#each [["width","Width"], ["page","Page"], ["actual","Actual"]] as [v, l]}
                          <button class="select-option" class:active={(store.settings.pdfFitMode ?? "width") === v} onclick={() => { updateSettings({ pdfFitMode: v as any }); selectOpen = null; }}>{l}</button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">PDF Dark Mode</p>
                    <p class="settings-mini-row__hint">Enable dark mode canvas filter by default.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.pdfDarkMode ?? false} aria-label="PDF Dark Mode" class="settings-toggle" class:is-on={store.settings.pdfDarkMode ?? false} type="button" onclick={() => updateSettings({ pdfDarkMode: !(store.settings.pdfDarkMode ?? false) })}></button>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "library"}
          data-settings-pane="library"
          hidden={tab !== "library"}
          aria-hidden={tab !== "library"}
        >
          <div class="settings-grid">
            <div class="settings-card">
              <p class="settings-card__title">Display</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default layout</p>
                    <p class="settings-mini-row__hint">Shared card presentation for Comics and Books.</p>
                  </div>
                  <div class="n-inline-segmented">
                    {#each [["grid", "Grid"], ["compact_grid", "Compact"], ["list", "List"]] as [mode, label]}
                      <button class="n-inline-segment" class:is-selected={store.settings.libraryViewMode === mode} type="button" onclick={() => updateSettings({ libraryViewMode: mode as Settings["libraryViewMode"] })}>{label}</button>
                    {/each}
                  </div>
                </div>
                <div class="settings-row settings-mini-row settings-mini-row--stretch settings-mini-row--density">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Density</p>
                    <p class="settings-mini-row__hint">Preferred items per row.</p>
                  </div>
                  <div
                    class="settings-density-slider"
                    class:is-disabled={store.settings.libraryViewMode === "list"}
                    style={`--settings-density-progress:${getLibraryDensitySliderProgress(store.settings.libraryPreferredGridColumns)};`}
                  >
                    <div class="scale-row settings-density-slider__controls">
                      <div class="settings-density-slider__track">
                        <div class="settings-density-slider__line" aria-hidden="true"></div>
                        <div class="settings-density-slider__steps" aria-hidden="true">
                          {#each LIBRARY_DENSITY_OPTIONS as option}
                            <span
                              class="settings-density-slider__step"
                              class:is-active={store.settings.libraryPreferredGridColumns === option}
                            ></span>
                          {/each}
                        </div>
                        <div class="settings-density-slider__knob" aria-hidden="true"></div>
                        <input
                          type="range"
                          min="0"
                          max={LIBRARY_DENSITY_OPTIONS.length - 1}
                          step="1"
                          value={getLibraryDensityOptionIndex(store.settings.libraryPreferredGridColumns)}
                          oninput={handleLibraryDensitySliderInput}
                          class="scale-slider settings-density-slider__range"
                          disabled={store.settings.libraryViewMode === "list"}
                          aria-label="Preferred items per row"
                        />
                      </div>
                      <div class="settings-density-slider__readout" aria-hidden="true">
                        {libraryDensityOptionLabel(store.settings.libraryPreferredGridColumns)}
                      </div>
                    </div>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Library start</p>
                    <p class="settings-mini-row__hint">Choose what opens first when you land in Library.</p>
                  </div>
                  <div class="n-inline-segmented">
                    {#each LIBRARY_START_OPTIONS as option}
                      <button class="n-inline-segment" class:is-selected={store.settings.defaultLibrarySection === option.id} type="button" onclick={() => updateSettings({ defaultLibrarySection: option.id })}>{option.label}</button>
                    {/each}
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">Metadata overlays</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Show progress</p>
                    <p class="settings-mini-row__hint">Hide progress gracefully when an item has none.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.libraryShowProgress} aria-label="Show progress" class="settings-toggle" class:is-on={store.settings.libraryShowProgress} type="button" onclick={() => updateSettings({ libraryShowProgress: !store.settings.libraryShowProgress })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Show outlines</p>
                    <p class="settings-mini-row__hint">Keep focus, hover, and selection cues visible.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.libraryShowCardOutline} aria-label="Show outlines" class="settings-toggle" class:is-on={store.settings.libraryShowCardOutline} type="button" onclick={() => updateSettings({ libraryShowCardOutline: !store.settings.libraryShowCardOutline })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Crop covers</p>
                    <p class="settings-mini-row__hint">Keep Comics covers in cover mode while Books stays independent.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.libraryCropCovers} aria-label="Crop cover images" class="settings-toggle" class:is-on={store.settings.libraryCropCovers} type="button" onclick={() => updateSettings({ libraryCropCovers: !store.settings.libraryCropCovers })}></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">Books defaults</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default Books type filter</p>
                    <p class="settings-mini-row__hint">Choose which type opens first in the Books view.</p>
                  </div>
                  <div class="n-inline-segmented">
                    {#each BOOKS_TYPE_OPTIONS as option}
                      <button class="n-inline-segment" class:is-selected={store.settings.booksLibraryUi.typeFilter === option.id} type="button" onclick={() => updateSettings({ booksLibraryUi: { ...store.settings.booksLibraryUi, typeFilter: option.id as BooksLibraryTypeFilter } })}>{option.label}</button>
                    {/each}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Default Books reading status</p>
                    <p class="settings-mini-row__hint">Choose which subset of your library opens first.</p>
                  </div>
                  <div class="select-wrap" id="books-status-filter">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("books-status-filter")}>
                      <span>{BOOKS_FILTER_OPTIONS.find((option) => option.id === store.settings.booksLibraryUi.statusFilter)?.label ?? "All books"}</span>
                      <svg class="select-caret" class:open={selectOpen === "books-status-filter"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "books-status-filter"}
                      <div class="select-menu">
                        {#each BOOKS_FILTER_OPTIONS as option}
                          <button
                            class="select-option"
                            class:active={store.settings.booksLibraryUi.statusFilter === option.id}
                            onclick={() => {
                              updateSettings({
                                booksLibraryUi: { ...store.settings.booksLibraryUi, statusFilter: option.id as BooksLibraryStatusFilter },
                              });
                              selectOpen = null;
                            }}
                          >
                            {option.label}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">History</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Reading history</p>
                    <p class="settings-mini-row__hint">{store.history.length} entries saved for quick return.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={clearHistory} disabled={store.history.length === 0}>Clear</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Wipe all data</p>
                    <p class="settings-mini-row__hint">History, stats, pins, and manga links.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={wipeAllData}>Wipe</button>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "performance"}
          data-settings-pane="performance"
          hidden={tab !== "performance"}
          aria-hidden={tab !== "performance"}
        >
          <div class="settings-grid">
            <div class="settings-card">
              <p class="settings-card__title">Rendering</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">GPU acceleration</p>
                    <p class="settings-mini-row__hint">Use GPU compositing for smoother surfaces when available.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.gpuAcceleration} aria-label="GPU acceleration" class="settings-toggle" class:is-on={store.settings.gpuAcceleration} type="button" onclick={() => updateSettings({ gpuAcceleration: !store.settings.gpuAcceleration })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Render limit</p>
                    <p class="settings-mini-row__hint">Lower values can feel faster on large libraries.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button">{renderLimitLabel(store.settings.renderLimit)}</button>
                </div>
                <div class="settings-chip-list settings-chip-list--presets">
                  {#each [12, 24, 48, 96, 200] as v}
                    <button class="settings-chip" class:is-active={(store.settings.renderLimit ?? 48) === v} type="button" onclick={() => updateSettings({ renderLimit: v })}>{v}</button>
                  {/each}
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Animated splash cards</p>
                    <p class="settings-mini-row__hint">Keep the splash card background in motion while idle.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.splashCards ?? true} aria-label="Animated splash cards" class="settings-toggle" class:is-on={store.settings.splashCards ?? true} type="button" onclick={() => updateSettings({ splashCards: !(store.settings.splashCards ?? true) })}></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">Diagnostics</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Compact sidebar</p>
                    <p class="settings-mini-row__hint">Reduce rail spacing for denser navigation.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.compactSidebar} aria-label="Compact sidebar" class="settings-toggle" class:is-on={store.settings.compactSidebar} type="button" onclick={() => updateSettings({ compactSidebar: !store.settings.compactSidebar })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Refresh metrics</p>
                    <p class="settings-mini-row__hint">Update CPU, memory, and renderer indicators.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={refreshPerfMetrics}>Refresh</button>
                </div>
              </div>
              <div class="settings-card__surface" style="margin-top:16px">
                <div class="settings-card__head">
                  <p class="settings-card__title">Session cache</p>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">Cache entries</p>
                      <p class="settings-mini-row__hint">In-memory and cleared on restart.</p>
                    </div>
                    <div class="settings-stat-pill">
                      <span>{perfSnapshot?.cacheEntries ?? 0} entries</span>
                    </div>
                  </div>
                  {#if perfSnapshot && perfSnapshot.cacheEntries > 0}
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Oldest entry</p>
                      </div>
                      <span class="perf-stat">{fmtAge(perfSnapshot.oldestEntryMs)}</span>
                    </div>
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Newest entry</p>
                      </div>
                      <span class="perf-stat">{fmtAge(perfSnapshot.newestEntryMs)}</span>
                    </div>
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Cached keys</p>
                        <p class="settings-mini-row__hint">{perfSnapshot.cacheKeys.join(", ")}</p>
                      </div>
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "keybinds"}
          data-settings-pane="keybinds"
          hidden={tab !== "keybinds"}
          aria-hidden={tab !== "keybinds"}
        >
          <div class="settings-grid">
            <div class="settings-card settings-card--wide">
              <div class="settings-card__head">
                <p class="settings-card__title">Keybinds</p>
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={resetKeybinds}>Reset all</button>
              </div>
              <p class="settings-card__intro">Click a binding to rebind it, then press the new key combination.</p>
              <div class="settings-card__stack">
                {#each Object.keys(KEYBIND_LABELS) as key}
                  {@const k = key as keyof Keybinds}
                  {@const isListening = listeningKey === k}
                  {@const isDefault   = store.settings.keybinds[k] === DEFAULT_KEYBINDS[k]}
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{KEYBIND_LABELS[k]}</p>
                      <p class="settings-mini-row__hint">Desktop shortcut</p>
                    </div>
                    <div class="settings-keybind-actions">
                      <button class="n-btn n-btn--sm n-btn-ghost settings-value-pill" class:listening={isListening} type="button" onclick={() => startListen(k)}>
                        {isListening ? "Press key..." : store.settings.keybinds[k]}
                      </button>
                      <button class="n-btn n-btn--sm n-btn-ghost settings-mini-action" type="button" onclick={() => updateSettings({ keybinds: { ...store.settings.keybinds, [k]: DEFAULT_KEYBINDS[k] } })} disabled={isDefault} title="Reset">Reset</button>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "storage"}
          data-settings-pane="storage"
          hidden={tab !== "storage"}
          aria-hidden={tab !== "storage"}
        >
          {#if shouldRenderPane("storage")}
          <div class="settings-grid">

            <!-- Ã¢â€â‚¬Ã¢â€â‚¬ Migration banner Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ -->
            <!-- Ã¢â€â‚¬Ã¢â€â‚¬ Disk Usage Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ -->
            <div class="settings-card">
              <div class="settings-card__head">
                <p class="settings-card__title">Usage</p>
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={fetchStorage} disabled={storageLoading}>
                  {storageLoading ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              {#if storageError}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Storage" title="Could not load disk usage" body={storageError} />
                </div>
              {:else if isExternalServer}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="info" icon="info" eyebrow="Storage" title="Disk usage unavailable" body="External servers do not expose local filesystem usage to this desktop runtime." />
                </div>
              {:else}
                <div class="mb-3 flex items-baseline justify-between">
                  <span class="settings-mini-row__label">Storage usage</span>
                  <span class="settings-mini-row__hint" style="font-family:var(--font-mono)">{storageUsageSummary.usageLabel}</span>
                </div>
                <div class="storage-bar">
                  <div class="storage-bar-fill" class:critical={storageUsageSummary.pct > 90} class:warn={storageUsageSummary.pct > 75 && storageUsageSummary.pct <= 90} style="width:{storageUsageSummary.pct}%"></div>
                </div>
                <p class="settings-card__intro" style="margin-top:16px">
                  {store.settings.storageLimitGb === null
                    ? "No limit is set yet. Use Advanced to define a warning threshold and extra scan paths."
                    : `Warn when usage crosses ${store.settings.storageLimitGb} GB.`}
                </p>
                <div class="settings-card__footer" style="margin-top:16px">
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openStorageAdvanced}>
                    {store.settings.storageLimitGb === null ? "Set limit" : "Edit limit"}
                  </button>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={handleClearCache} disabled={clearing}>
                    {cleared ? "Cleared" : clearing ? "Clearing..." : "Clean cache"}
                  </button>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openStorageBackupPanel}>
                    Create backup
                  </button>
                </div>
              {/if}
            </div>

            <!-- Ã¢â€â‚¬Ã¢â€â‚¬ Downloads path Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ -->
            <div class="settings-card">
              <p class="settings-card__title">Paths</p>
              {#if isExternalServer}
                <p class="settings-card__intro">Connected to an external server. Path changes here update the server config directly, so they must be valid on the remote filesystem.</p>
              {/if}
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Downloads path</p>
                    <p class="settings-mini-row__hint" style="font-family:var(--font-mono)">{downloadsPathInput || defaultDownloadsPath || "Not configured"}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => browseSettingsPath("downloads")} disabled={isExternalServer}>Browse</button>
                </div>

                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Local source path</p>
                    <p class="settings-mini-row__hint" style="font-family:var(--font-mono)">{localSourcePathInput || "Optional"}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => browseSettingsPath("local")} disabled={isExternalServer}>Browse</button>
                </div>
              </div>
              <div class="settings-card__footer" style="margin-top:16px">
                {#if pathsError}
                  <span class="settings-mini-row__hint" style="color:var(--color-error)">{pathsError}</span>
                {:else if pathsSaved}
                  <span class="settings-mini-row__hint" style="color:var(--accent-fg)">Paths saved.</span>
                {:else}
                  <span class="settings-mini-row__hint">Manual path edits and validation stay in Advanced.</span>
                {/if}
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openStorageAdvanced}>
                  Edit paths
                </button>
              </div>
            </div>

            <!-- Ã¢â€â‚¬Ã¢â€â‚¬ Storage Limit Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ -->
            <!-- Ã¢â€â‚¬Ã¢â€â‚¬ Advanced (collapsible) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ -->
            {#if advStorageOpen}
            <div class="settings-card settings-card--wide" bind:this={backupSectionEl}>
              <p class="settings-card__title">Backup & Restore</p>
              <p class="settings-card__intro">
                Unified Aethon backups now live here, while subsystem-only manga, novels, and Books flows remain available. Restore stays sandbox-first by default.
              </p>
              <div class="settings-card__surface">
                <div class="settings-card__head">
                  <p class="settings-card__title">Export</p>
                </div>
                <p class="settings-card__intro">Choose a unified backup or keep one subsystem isolated when that is safer.</p>
                <div class="settings-chip-list" style="margin-top:14px">
                  {#each [
                    ["unified", "Unified Aethon"],
                    ["manga", "Manga only"],
                    ["books", "Books only"],
                    ["novels", "Novels only"],
                    ["app", "App metadata"],
                  ] as [mode, label]}
                    <button
                      class="settings-chip"
                      class:is-active={backupExportMode === mode}
                      type="button"
                      onclick={() => {
                        backupExportMode = mode as BackupExportMode;
                        backupSavedPath = null;
                      }}
                    >
                      {label}
                    </button>
                  {/each}
                </div>
                <div class="settings-card__stack" style="margin-top:14px">
                  {#if backupExportMode === "unified"}
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Include Manga</p>
                        <p class="settings-mini-row__hint">Embeds the native .tachibk payload inside the unified .aethonbk file.</p>
                      </div>
                      <button role="switch" aria-checked={backupUnifiedIncludeManga} aria-label="Include Manga" class="settings-toggle" class:is-on={backupUnifiedIncludeManga} type="button" onclick={() => backupUnifiedIncludeManga = !backupUnifiedIncludeManga}></button>
                    </div>
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Include Books</p>
                        <p class="settings-mini-row__hint">Default is full EPUB/PDF files plus metadata, progress, bookmarks, and covers.</p>
                      </div>
                      <button role="switch" aria-checked={backupUnifiedIncludeBooks} aria-label="Include Books" class="settings-toggle" class:is-on={backupUnifiedIncludeBooks} type="button" onclick={() => backupUnifiedIncludeBooks = !backupUnifiedIncludeBooks}></button>
                    </div>
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Include Novels</p>
                        <p class="settings-mini-row__hint">Exports repository-aware novel state without bundling plugin binaries.</p>
                      </div>
                      <button role="switch" aria-checked={backupUnifiedIncludeNovels} aria-label="Include Novels" class="settings-toggle" class:is-on={backupUnifiedIncludeNovels} type="button" onclick={() => backupUnifiedIncludeNovels = !backupUnifiedIncludeNovels}></button>
                    </div>
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Include app/profile metadata</p>
                        <p class="settings-mini-row__hint">Optional and minimal. Carries only portable next-launch profile metadata.</p>
                      </div>
                      <button role="switch" aria-checked={backupUnifiedIncludeApp} aria-label="Include app metadata" class="settings-toggle" class:is-on={backupUnifiedIncludeApp} type="button" onclick={() => backupUnifiedIncludeApp = !backupUnifiedIncludeApp}></button>
                    </div>
                  {:else if backupExportMode === "books"}
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Metadata-only mode</p>
                        <p class="settings-mini-row__hint">Exports Books metadata without packaging EPUB/PDF files.</p>
                      </div>
                      <button role="switch" aria-checked={backupBooksOnlyMetadataOnly} aria-label="Books metadata only" class="settings-toggle" class:is-on={backupBooksOnlyMetadataOnly} type="button" onclick={() => backupBooksOnlyMetadataOnly = !backupBooksOnlyMetadataOnly}></button>
                    </div>
                  {:else if backupExportMode === "manga"}
                    <p class="settings-card__intro">Uses the native manga export flow and saves a .tachibk file.</p>
                  {:else if backupExportMode === "novels"}
                    <p class="settings-card__intro">Creates a single-payload .aethonbk with repository-aware novel metadata and progress.</p>
                  {:else if backupExportMode === "app"}
                    <p class="settings-card__intro">Exports portable profile metadata only. Machine-local settings are intentionally excluded.</p>
                  {/if}
                </div>
                <div class="settings-row settings-mini-row settings-mini-row--stretch" style="margin-top:14px">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Save backup</p>
                    <p class="settings-mini-row__hint">
                      {#if backupExportMode === "unified"}
                        Produces one .aethonbk container with separated payloads.
                      {:else if backupExportMode === "manga"}
                        Produces a native .tachibk manga backup.
                      {:else}
                        Produces a single-payload .aethonbk backup for {backupPayloadKindLabel(backupExportMode)}.
                      {/if}
                    </p>
                    {#if backupSavedPath}
                      <p class="settings-mini-row__hint" style="color:var(--accent-fg)">{backupSavedPath}</p>
                    {/if}
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={exportBackup} disabled={backupExporting || backupValidating || backupRestoring}>
                    {backupExporting ? "Exporting..." : "Export backup"}
                  </button>
                </div>
              </div>
              <div class="settings-card__surface" style="margin-top:16px">
                <div class="settings-card__head">
                  <p class="settings-card__title">Import / Restore</p>
                </div>
                <p class="settings-card__intro">Pick a backup file, inspect the summary, then choose where restore should run.</p>
                <div class="settings-row settings-mini-row settings-mini-row--stretch" style="margin-top:14px">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Selected file</p>
                    <p class="settings-mini-row__hint">{backupSelectedFileLabel ?? "No backup selected yet."}</p>
                    {#if backupImportKind}
                      <p class="settings-mini-row__hint">
                        Detected format: {backupImportKind === "aethon" ? ".aethonbk" : "native manga backup"}
                      </p>
                    {/if}
                    {#if backupRestoreHandoffSession}
                      <p class="settings-mini-row__hint" style="color:var(--accent-fg)">
                        Restore handoff active. Review the plan here and confirm it in this target profile session.
                      </p>
                    {:else if backupRestoreSourceProfileId}
                      <p class="settings-mini-row__hint" style="color:var(--text-secondary)">
                        Origin session: {getLocalProfileMeta(backupRestoreSourceProfileId)?.label ?? backupRestoreSourceProfileId.toUpperCase()}
                      </p>
                    {/if}
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={triggerBackupImport} disabled={backupExporting || backupValidating || backupRestoring}>
                    {backupValidating ? "Inspecting..." : "Choose file"}
                  </button>
                </div>
                {#if backupImportKind === "aethon" && backupUnifiedPlan}
                  <div class="settings-card__surface" style="margin-top:16px">
                    <div class="settings-card__head">
                      <p class="settings-card__title">Restore summary</p>
                    </div>
                    <p class="settings-card__intro">{backupUnifiedPlan.summary.summaryLabel}</p>
                    <p class="settings-card__intro">{backupUnifiedPlan.summary.summaryBody}</p>
                    <div class="settings-chip-list" style="margin-top:14px">
                      <span class="settings-chip">Recommended: other local profile</span>
                      <span class="settings-chip">Blocked: {backupUnifiedBlockedCount}</span>
                      <span class="settings-chip">Unsupported: {backupUnifiedUnsupportedCount}</span>
                      <span class="settings-chip">Warnings: {backupUnifiedWarningCount}</span>
                    </div>
                    {#if backupUnifiedPlan.executionBlockedReason}
                      <div class="settings-state settings-state--spaced">
                        <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Restore" title="Restore is blocked" body={backupUnifiedPlan.executionBlockedReason} />
                      </div>
                    {/if}
                    {#if backupUnifiedPlan.containerIssues.length > 0}
                      <div class="settings-card__stack" style="margin-top:14px">
                        {#each backupUnifiedPlan.containerIssues as issue}
                          <div class="settings-row settings-mini-row settings-mini-row--stretch">
                            <div class="settings-mini-row__body">
                              <p class="settings-mini-row__label">Container issue</p>
                              <p class="settings-mini-row__hint">{issue.code} - {issue.message}</p>
                            </div>
                          </div>
                        {/each}
                      </div>
                    {/if}
                    <div class="settings-card__stack" style="margin-top:14px">
                      {#each backupUnifiedPlan.payloads as payload}
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">{backupPayloadKindLabel(payload.kind)} - {backupPayloadStatusLabel(payload.status)}</p>
                            <p class="settings-mini-row__hint">{payload.summaryLabel}</p>
                            <p class="settings-mini-row__hint">Ready now: {payload.canRestoreNow ? "Yes" : "No"} · Needs action: {payload.needsUserAction ? "Yes" : "No"} · Executable: {payload.canExecuteRestore ? "Yes" : "No"}</p>
                            {#if payload.availableRestoreModes.length > 0}
                              <p class="settings-mini-row__hint">Restore modes: {payload.availableRestoreModes.join(", ")}{payload.defaultRestoreMode ? ` · default: ${payload.defaultRestoreMode}` : ""}</p>
                            {/if}
                            {#if payload.reasons.length > 0}
                              {#each payload.reasons as reason}
                                <p class="settings-mini-row__hint">Reason: {reason.code} - {reason.message}</p>
                              {/each}
                            {/if}
                            {#if payload.warnings.length > 0}
                              {#each payload.warnings as warning}
                                <p class="settings-mini-row__hint">Warning: {warning.code} - {warning.message}</p>
                              {/each}
                            {/if}
                          </div>
                          <div class="settings-section-actions settings-inline-actions">
                            {#if isPayloadExecutable(payload)}
                              <button
                                class="settings-chip"
                                class:is-active={Boolean(backupUnifiedSelection[payload.kind])}
                                type="button"
                                onclick={() => {
                                  backupUnifiedSelection = {
                                    ...backupUnifiedSelection,
                                    [payload.kind]: !Boolean(backupUnifiedSelection[payload.kind]),
                                  };
                                }}
                                disabled={!payload.canExecuteRestore || !payload.canRestoreNow || backupRestoring}
                              >
                                {backupUnifiedSelection[payload.kind] ? "Selected" : "Select"}
                              </button>
                            {:else}
                              <span class="settings-chip">{payload.canExecuteRestore ? "Info" : "Preview"}</span>
                            {/if}
                          </div>
                        </div>
                      {/each}
                    </div>
                    {#if backupUnifiedPlan.topLevelSkipped.length > 0}
                      <div class="settings-card__stack" style="margin-top:14px">
                        {#each backupUnifiedPlan.topLevelSkipped as skipped}
                          <div class="settings-row settings-mini-row settings-mini-row--stretch">
                            <div class="settings-mini-row__body">
                              <p class="settings-mini-row__label">{backupPayloadKindLabel(skipped.kind)} - {backupPayloadStatusLabel(skipped.status)}</p>
                              <p class="settings-mini-row__hint">{skipped.summaryLabel}</p>
                              <p class="settings-mini-row__hint">{skipped.reason}</p>
                            </div>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {:else if backupImportKind === "manga"}
                  <div class="settings-card__surface" style="margin-top:16px">
                    <div class="settings-card__head">
                      <p class="settings-card__title">Manga restore path</p>
                    </div>
                    <p class="settings-card__intro">Native manga backups stay on the current Mihon-style restore flow. You can keep the restore sandboxed by handing it off to the other local profile first.</p>
                    {#if backupRestoreTargetMode === "other-local-profile" && otherLocalProfileMeta}
                      <p class="settings-card__intro">Aethon will relaunch into {otherLocalProfileMeta.label}, reopen this backup in Settings > Storage, and wait for confirmation there.</p>
                    {:else if backupRestoreTargetMode === "current-profile"}
                      <p class="settings-card__intro">Source reconciliation and restore readiness run in the current profile before restore is allowed.</p>
                    {/if}
                  </div>
                {/if}
                {#if backupImportKind}
                  <div class="settings-card__surface" style="margin-top:16px">
                    <div class="settings-card__head">
                      <p class="settings-card__title">Restore target</p>
                    </div>
                    <p class="settings-card__intro">{backupCurrentTargetSummary}</p>
                    {#if backupCanUseOtherProfileTarget}
                      <div class="settings-chip-list" style="margin-top:14px">
                        <button
                          class="settings-chip"
                          class:is-active={backupRestoreTargetMode === "other-local-profile"}
                          type="button"
                          onclick={() => {
                            backupRestoreTargetMode = "other-local-profile";
                            backupRestoreCurrentProfileConfirmed = false;
                          }}
                        >
                          {otherLocalProfileMeta ? `Restore into ${otherLocalProfileMeta.label}` : "Other local profile"}
                        </button>
                        <button
                          class="settings-chip"
                          class:is-active={backupRestoreTargetMode === "current-profile"}
                          type="button"
                          onclick={() => (backupRestoreTargetMode = "current-profile")}
                        >
                          Current profile
                        </button>
                      </div>
                    {:else if backupRestoreHandoffSession}
                      <p class="settings-card__intro" style="margin-top:14px">This handoff is now scoped to the current profile session. Review the summary here and confirm to continue.</p>
                    {:else}
                      <p class="settings-card__intro" style="margin-top:14px">Restore execution is only available when the current session is already running on TEST or MAIN.</p>
                    {/if}
                    {#if backupCurrentProfileGateRequired}
                      <div class="settings-row settings-mini-row settings-mini-row--stretch" style="margin-top:14px">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">Confirm current-profile restore</p>
                          <p class="settings-mini-row__hint">This advanced path restores directly into {currentProfileMeta?.label ?? currentSessionProfileLabel} instead of the recommended sandbox target.</p>
                        </div>
                        <button
                          role="switch"
                          aria-checked={backupRestoreCurrentProfileConfirmed}
                          aria-label="Confirm current profile restore"
                          class="settings-toggle"
                          class:is-on={backupRestoreCurrentProfileConfirmed}
                          type="button"
                          onclick={() => (backupRestoreCurrentProfileConfirmed = !backupRestoreCurrentProfileConfirmed)}
                        ></button>
                      </div>
                    {/if}
                    {#if backupResolvedExecutionBlockedReason}
                      <div class="settings-state settings-state--spaced">
                        <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Restore" title="Restore target needs attention" body={backupResolvedExecutionBlockedReason} />
                      </div>
                    {/if}
                    <div class="settings-row settings-mini-row settings-mini-row--stretch" style="margin-top:14px">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Restore action</p>
                        <p class="settings-mini-row__hint">
                          {#if backupRestoreTargetMode === "other-local-profile"}
                            The selected backup will be handed off to the inactive local profile and confirmed there before restore starts.
                          {:else if backupImportKind === "aethon"}
                            Will restore: {backupExecutablePayloadKinds.length > 0 ? backupExecutablePayloadKinds.map((kind) => backupPayloadKindLabel(kind)).join(", ") : "nothing yet"}.
                          {:else}
                            Runs the proven manga restore path in the current profile after the current confirmation gate is satisfied.
                          {/if}
                        </p>
                        {#if backupRestoreStatus}
                          <p class="settings-mini-row__hint">{backupRestoreStatus.state} - {backupRestoreStatus.mangaProgress}/{backupRestoreStatus.totalManga || 0} manga</p>
                        {/if}
                      </div>
                      <div class="settings-section-actions settings-inline-actions">
                        {#if backupImportKind === "manga" && backupRestoreTargetMode === "current-profile"}
                          <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={refreshBackupReadiness} disabled={!backupSelectedFile || backupValidating || backupRestoring}>
                            Refresh readiness
                          </button>
                        {/if}
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={executeSelectedRestore} disabled={backupExecuteDisabled}>
                          {backupRestoreButtonLabel()}
                        </button>
                      </div>
                    </div>
                  </div>
                {/if}
                <input bind:this={backupFileInput} type="file" accept=".tachibk,.proto.gz,.proto,*/*" style="display:none" onchange={onBackupFileSelected} />
              </div>
              {#if backupImportKind === "manga" && backupAnalysis && backupRestoreTargetMode === "current-profile"}
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">Reconciliation summary</p>
                  </div>
                  <p class="settings-card__intro">
                    {#if backupAnalysis.exactMatches.length === 0 && backupAnalysis.autoReconciled.length === 0 && backupAnalysis.needsReview.length === 0 && backupAnalysis.unresolved.length === 0}
                      No source reconciliation work was needed.
                    {:else}
                      Aethon parsed this backup locally, resolved exact matches first, and then ran bounded source inference on the leftovers.
                    {/if}
                  </p>
                  {#if backupReadiness}
                    <div class="settings-card__surface" style="margin-top:16px">
                      <div class="settings-card__head">
                        <p class="settings-card__title">Restore readiness</p>
                      </div>
                      <p class="settings-card__intro">
                        Ready now: {backupReadiness.readyNowCount} · Requires install: {backupReadiness.requiresInstallCount} · Unavailable: {backupReadiness.unavailableCount} · Unresolved: {backupReadiness.unresolvedCount}
                      </p>
                      {#if backupReadiness.requiresInstallCount > 0}
                        <p class="settings-card__intro">Restore is intentionally blocked until the required extensions are usable on this server.</p>
                        {#if backupReadiness.installableExtensions.length > 0}
                          <div class="settings-section-actions settings-inline-actions" style="margin-top:12px;flex-wrap:wrap">
                            <button
                              class="n-btn n-btn--sm n-btn-ghost"
                              onclick={installRequiredRestoreExtensions}
                              disabled={backupRestoring || backupValidating || backupReadiness.installableExtensions.every((extension) => backupInstalling.has(extension.pkgName))}
                            >
                              Install required extensions
                            </button>
                            <button class="n-btn n-btn--sm n-btn-ghost" onclick={() => openSearchSources("extensions", "repos")}>
                              Open Extensions & Repos
                            </button>
                          </div>
                        {/if}
                      {/if}
                      {#if backupReadiness.unavailableCount > 0}
                        <p class="settings-card__intro">Some reconciled targets still have no installable extension candidate on this server. Restore stays blocked until those targets become available.</p>
                      {/if}
                    </div>
                  {/if}
                  {#if backupAnalysis.exactMatches.length > 0}
                    <div class="settings-card__surface" style="margin-top:16px">
                      <div class="settings-card__head">
                        <p class="settings-card__title">Exact matches</p>
                      </div>
                      <div class="settings-card__stack">
                        {#each backupAnalysis.exactMatches as cluster}
                          <div class="settings-row settings-mini-row settings-mini-row--stretch">
                            <div class="settings-mini-row__body">
                              <p class="settings-mini-row__label">{cluster.sourceName}</p>
                              <p class="settings-mini-row__hint">{cluster.selectedCandidate?.displayName} · {clusterConfidenceLabel(cluster)} · {clusterReasonLabel(cluster)}</p>
                              {#if clusterReadinessDetail(cluster)}
                                <p class="settings-mini-row__hint">{clusterReadinessLabel(cluster)} · {clusterReadinessDetail(cluster)}</p>
                              {/if}
                            </div>
                            {#if cluster.selectedCandidate?.requiresInstall && extensionForPkg(cluster.selectedCandidate.extensionPkgName)}
                              <button
                                class="n-btn n-btn--sm n-btn-ghost"
                                onclick={() => installMissingSourceExtension(extensionForPkg(cluster.selectedCandidate!.extensionPkgName)!)}
                                disabled={backupRestoring || backupValidating || backupInstalling.has(cluster.selectedCandidate.extensionPkgName!)}
                              >
                                {backupInstalling.has(cluster.selectedCandidate.extensionPkgName!) ? "Installing..." : "Install"}
                              </button>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                  {#if backupAnalysis.autoReconciled.length > 0}
                    <div class="settings-card__surface" style="margin-top:16px">
                      <div class="settings-card__head">
                        <p class="settings-card__title">Auto-reconciled</p>
                      </div>
                      <div class="settings-card__stack">
                        {#each backupAnalysis.autoReconciled as cluster}
                          <div class="settings-row settings-mini-row settings-mini-row--stretch">
                            <div class="settings-mini-row__body">
                              <p class="settings-mini-row__label">{cluster.sourceName}</p>
                              <p class="settings-mini-row__hint">{cluster.selectedCandidate?.displayName} · {clusterConfidenceLabel(cluster)} · {clusterReasonLabel(cluster)}</p>
                              {#if clusterReadinessDetail(cluster)}
                                <p class="settings-mini-row__hint">{clusterReadinessLabel(cluster)} · {clusterReadinessDetail(cluster)}</p>
                              {/if}
                            </div>
                            {#if cluster.selectedCandidate?.requiresInstall && extensionForPkg(cluster.selectedCandidate.extensionPkgName)}
                              <button
                                class="n-btn n-btn--sm n-btn-ghost"
                                onclick={() => installMissingSourceExtension(extensionForPkg(cluster.selectedCandidate!.extensionPkgName)!)}
                                disabled={backupRestoring || backupValidating || backupInstalling.has(cluster.selectedCandidate.extensionPkgName!)}
                              >
                                {backupInstalling.has(cluster.selectedCandidate.extensionPkgName!) ? "Installing..." : "Install"}
                              </button>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                  {#if backupAnalysis.needsReview.length > 0}
                    <div class="settings-card__surface" style="margin-top:16px">
                      <div class="settings-card__head">
                        <p class="settings-card__title">Needs review</p>
                      </div>
                      <p class="settings-card__intro">Only these ambiguous leftovers need your approval. Choose a candidate or explicitly skip the remap.</p>
                      <div class="settings-card__stack">
                        {#each backupAnalysis.needsReview as cluster}
                          <div class="settings-card__surface">
                            <div class="settings-card__head">
                              <p class="settings-card__title">{cluster.sourceName}</p>
                            </div>
                            <p class="settings-card__intro">Backup source ID {cluster.orphanSourceId}</p>
                            <div class="settings-card__stack">
                              {#if cluster.sampleManga.length > 0}
                                <p class="settings-card__intro">Sample titles: {cluster.sampleManga.map((manga) => manga.title).join(", ")}</p>
                              {/if}
                              {#each cluster.candidates as candidate}
                                <div class="settings-row settings-mini-row settings-mini-row--stretch">
                                  <div class="settings-mini-row__body">
                                    <p class="settings-mini-row__label">{candidate.displayName}</p>
                                    <p class="settings-mini-row__hint">{Math.round(candidate.confidence * 100)}% · {candidate.evidenceSummary}</p>
                                  </div>
                                  <button
                                    class="settings-chip"
                                    class:is-active={backupReviewSelections[cluster.orphanSourceId] === candidate.sourceId}
                                    type="button"
                                    onclick={() => setBackupClusterSelection(cluster.orphanSourceId, candidate.sourceId)}
                                  >
                                    {backupReviewSelections[cluster.orphanSourceId] === candidate.sourceId ? "Selected" : "Choose"}
                                  </button>
                                </div>
                              {/each}
                              <div class="settings-row settings-mini-row settings-mini-row--stretch">
                                <div class="settings-mini-row__body">
                                  <p class="settings-mini-row__label">Skip remap</p>
                                  <p class="settings-mini-row__hint">Keep this orphan source untouched in the reconciled restore payload.</p>
                                </div>
                                <button
                                  class="settings-chip"
                                  class:is-active={backupReviewSelections[cluster.orphanSourceId] === "skip"}
                                  type="button"
                                  onclick={() => setBackupClusterSelection(cluster.orphanSourceId, "skip")}
                                >
                                  {backupReviewSelections[cluster.orphanSourceId] === "skip" ? "Selected" : "Skip"}
                                </button>
                              </div>
                            </div>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                  {#if backupAnalysis.unresolved.length > 0}
                    <div class="settings-card__surface" style="margin-top:16px">
                      <div class="settings-card__head">
                        <p class="settings-card__title">Unresolved</p>
                      </div>
                      <p class="settings-card__intro">These sources still could not be reconciled automatically. Restore can continue, but their original backup source IDs will stay untouched.</p>
                      <p class="settings-card__intro">{backupAnalysis.unresolved.map((cluster) => cluster.sourceName).join(", ")}</p>
                    </div>
                  {/if}
                  {#if backupMissingTrackers.length > 0}
                    <div class="settings-card__surface" style="margin-top:16px">
                      <div class="settings-card__head">
                        <p class="settings-card__title">Missing trackers</p>
                      </div>
                      <p class="settings-card__intro">{backupMissingTrackers.map((tracker) => tracker.name).join(", ")}</p>
                    </div>
                  {/if}
                  {#if backupSuggestedExtensions.length > 0 || backupExtensionLookupLoading || backupExtensionLookupError}
                    <div class="settings-card__surface" style="margin-top:16px">
                      <div class="settings-card__head">
                        <p class="settings-card__title">Extension recovery</p>
                      </div>
                      {#if backupExtensionLookupLoading}
                        <p class="settings-card__intro">Checking available extensions...</p>
                      {:else if backupSuggestedExtensions.length > 0}
                        <div class="settings-card__stack">
                          <p class="settings-card__intro">Aethon found matching extensions for leftovers that still depend on source installs.</p>
                          {#each backupSuggestedExtensions as suggestion}
                            <div class="settings-row settings-mini-row settings-mini-row--stretch">
                              <div class="settings-mini-row__body">
                                <p class="settings-mini-row__label">{suggestion.extension.name}</p>
                                <p class="settings-mini-row__hint">Matches backup source: {suggestion.missingSource.name} ({suggestion.matchedBy === "source-id" ? "matched by source id" : "matched by source name"})</p>
                              </div>
                              <button
                                class="n-btn n-btn--sm n-btn-ghost"
                                onclick={() => installMissingSourceExtension(suggestion.extension)}
                                disabled={backupRestoring || backupValidating || backupInstalling.has(suggestion.extension.pkgName)}
                              >
                                {backupInstalling.has(suggestion.extension.pkgName) ? "Installing..." : "Install"}
                              </button>
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <div class="settings-section-actions settings-inline-actions" style="margin-top:12px;flex-wrap:wrap">
                          <p class="settings-card__intro" style="margin:0">No confident installable matches were found for the remaining leftovers.</p>
                          <button class="n-btn n-btn--sm n-btn-ghost" onclick={() => openSearchSources("extensions", "repos")}>
                            Open Extensions & Repos
                          </button>
                        </div>
                      {/if}
                      {#if backupExtensionLookupError}
                        <div class="settings-state settings-state--spaced">
                          <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="Extensions" title="Could not inspect extension matches" body={backupExtensionLookupError} />
                        </div>
                      {/if}
                    </div>
                  {/if}
                  {#if backupAnalysis.warnings.length > 0}
                    <div class="settings-card__surface" style="margin-top:16px">
                      <div class="settings-card__head">
                        <p class="settings-card__title">Warnings</p>
                      </div>
                      <div class="settings-card__stack">
                        {#each backupAnalysis.warnings as warning}
                          <div class="settings-row settings-mini-row settings-mini-row--stretch">
                            <div class="settings-mini-row__body">
                              <p class="settings-mini-row__label">{warning.message}</p>
                              {#if warning.details}
                                <p class="settings-mini-row__hint">{warning.details}</p>
                              {/if}
                            </div>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>
              {/if}
              {#if backupRestoreResults}
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">Restore results</p>
                  </div>
                  <div class="settings-card__stack" style="margin-top:12px">
                    {#each backupRestoreResults as result}
                      <div class="settings-row settings-mini-row settings-mini-row--stretch">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">{backupPayloadKindLabel(result.kind)} - {backupPayloadStatusLabel(result.status)}</p>
                          <p class="settings-mini-row__hint">{result.summary}</p>
                          {#if result.detail}
                            <p class="settings-mini-row__hint">{result.detail}</p>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
              {#if backupError}
                <div class="settings-state settings-state--spaced">
                  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Backup" title="Backup action failed" body={backupError} />
                </div>
              {/if}
            </div>
            {/if}

            <div class="settings-card settings-card--wide">
              <div class="settings-card__head">
                <p class="settings-card__title">Advanced</p>
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (advStorageOpen = !advStorageOpen)}>
                  {advStorageOpen ? "Collapse" : "Expand"}
                </button>
              </div>
              <p class="settings-card__intro">Limits, migration, extra scan directories and backup flows stay tucked here so the main shell keeps the approved composition.</p>
              {#if advStorageOpen}
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">Path editor</p>
                  </div>
                  <div class="settings-card__stack">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Downloads path</p>
                        <p class="settings-mini-row__hint">Manual edit for the main downloads directory.</p>
                      </div>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => browseSettingsPath("downloads")} disabled={isExternalServer}>Browse</button>
                    </div>
                    <div class="settings-input-line settings-input-line--stack">
                      <div class="settings-input-line">
                        <input
                          class="settings-text-input settings-input-line__grow"
                          class:path-input-error={!!pathsFieldError.dl}
                          bind:value={downloadsPathInput}
                          placeholder={isExternalServer ? "Server default" : (defaultDownloadsPath || "Default location")}
                          spellcheck="false"
                          onkeydown={(event) => event.key === "Enter" && savePaths()}
                          oninput={() => { pathsFieldError = { ...pathsFieldError, dl: undefined }; }}
                        />
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={savePaths} disabled={pathsSaving}>
                          {pathsSaved ? "Saved" : pathsSaving ? "Saving..." : "Save"}
                        </button>
                      </div>
                      {#if pathsFieldError.dl}
                        <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="Path" title="Download path needs attention" body={pathsFieldError.dl} />
                      {/if}
                    </div>
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Local source path</p>
                        <p class="settings-mini-row__hint">Optional directory for manga already present on disk.</p>
                      </div>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => browseSettingsPath("local")} disabled={isExternalServer}>Browse</button>
                    </div>
                    <div class="settings-input-line settings-input-line--stack">
                      <div class="settings-input-line">
                        <input
                          class="settings-text-input settings-input-line__grow"
                          class:path-input-error={!!pathsFieldError.loc}
                          bind:value={localSourcePathInput}
                          placeholder="Optional"
                          spellcheck="false"
                          onkeydown={(event) => event.key === "Enter" && savePaths()}
                          oninput={() => { pathsFieldError = { ...pathsFieldError, loc: undefined }; }}
                        />
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={savePaths} disabled={pathsSaving}>
                          {pathsSaved ? "Saved" : pathsSaving ? "Saving..." : "Save"}
                        </button>
                      </div>
                      {#if pathsFieldError.loc}
                        <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="Path" title="Local source path needs attention" body={pathsFieldError.loc} />
                      {/if}
                      {#if pathsError}
                        <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Path" title="Could not save paths" body={pathsError} />
                      {/if}
                    </div>
                  </div>
                </div>
                {#if migrateFrom && !isExternalServer}
                  <div class="settings-card__surface" style="margin-top:16px">
                    <div class="settings-card__head">
                      <p class="settings-card__title">Migration</p>
                      <div class="settings-section-actions settings-inline-actions">
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={startMigration} disabled={migrating}>
                          {migrating ? (migrateProgress ? `Moving ${migrateProgress.done}/${migrateProgress.total}` : "Starting...") : "Move files"}
                        </button>
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={dismissMigration} disabled={migrating}>Skip</button>
                      </div>
                    </div>
                    <p class="settings-card__intro">Manga was found at the previous downloads path. Move it now to keep the new location in sync with Aethon.</p>
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Path change</p>
                        <p class="settings-mini-row__hint" style="font-family:var(--font-mono)">{migrateFrom} ? {migrateTo}</p>
                      </div>
                      {#if migrateProgress && migrateProgress.total > 0}
                        <span class="sec-status-pill">{migrateProgress.done}/{migrateProgress.total}</span>
                      {/if}
                    </div>
                    {#if migrateProgress && migrateProgress.total > 0}
                      <div class="storage-bar" style="margin-top:14px">
                        <div class="storage-bar-fill" style="width:{Math.round((migrateProgress.done / migrateProgress.total) * 100)}%"></div>
                      </div>
                    {/if}
                    {#if migrateError}
                      <div class="settings-state settings-state--spaced">
                        <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Migration" title="Path migration failed" body={migrateError} />
                      </div>
                    {/if}
                  </div>
                {/if}
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">Usage guardrails</p>
                  </div>
                  <div class="settings-card__stack">
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Warn when limit is reached</p>
                        <p class="settings-mini-row__hint">Set a soft threshold for local disk usage monitoring.</p>
                      </div>
                      <div class="settings-input-line" style="max-width:180px">
                        <input
                          class="settings-text-input settings-text-input--short"
                          bind:value={storageLimitInput}
                          inputmode="decimal"
                          placeholder="GB"
                          spellcheck="false"
                          onkeydown={(event) => event.key === "Enter" && applyStorageLimit()}
                        />
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={applyStorageLimit}>Save</button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">Extra scan paths</p>
                  </div>
                  {#if extraScanDirs.length > 0}
                    <div class="settings-card__stack">
                      {#each extraScanDirs as dir}
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label" style="font-family:var(--font-mono)">{dir}</p>
                            <p class="settings-mini-row__hint">Extra scan directory</p>
                          </div>
                          <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={() => removeExtraScanDir(dir)}>Remove</button>
                        </div>
                      {/each}
                    </div>
                  {/if}
                  <div class="settings-field-block" style="margin-top:16px">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Additional scan path</p>
                        <p class="settings-mini-row__hint">Include an extra directory in disk usage readings.</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <input
                        class="settings-text-input settings-input-line__grow"
                        bind:value={newScanDir}
                        placeholder="/path/to/dir"
                        spellcheck="false"
                        onkeydown={(event) => event.key === "Enter" && addExtraScanDir()}
                      />
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={addExtraScanDir} disabled={!newScanDir.trim() || extraScanDirs.includes(newScanDir.trim())}>
                        Add
                      </button>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          </div>
          {/if}
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "categories"}
          data-settings-pane="categories"
          hidden={tab !== "categories"}
          aria-hidden={tab !== "categories"}
        >
          <div class="settings-grid">
            <div class="settings-card settings-card--wide">
              <p class="settings-card__title">Categories</p>
              <div class="settings-chip-list">
                {#each categoryPreviewChips as category}
                  <span class="settings-chip">{category}</span>
                {/each}
                {#if categoryPreviewChips.length === 0}
                  <span class="settings-chip settings-chip--empty">No categories yet</span>
                {/if}
              </div>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Comics categories</p>
                    <p class="settings-mini-row__hint">Sync with the server and other clients.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => openCategoryManager("comics")}>Manage</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Books categories</p>
                    <p class="settings-mini-row__hint">Local to desktop and separated from comics.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => openCategoryManager("books")}>Manage</button>
                </div>
              </div>
              {#if categoriesDetailsPane}
                <div class="settings-card__surface" style="margin-top:16px">
                <div class="settings-card__head">
                  <p class="settings-card__title">Manage {categoriesDetailsPane === "comics" ? "Comics" : "Books"} categories</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={closeCategoryManager}>Close</button>
                </div>
                <div class="n-inline-segmented">
                  {#each [
                    { id: "comics", label: "Comics" },
                    { id: "books", label: "Books" },
                  ] as option}
                    <button
                      class="n-inline-segment"
                      class:is-selected={categoryDomain === option.id}
                      type="button"
                      onclick={() => openCategoryManager(option.id as "comics" | "books")}
                    >
                      {option.label}
                    </button>
                  {/each}
                </div>
                <p class="settings-card__intro">
                  {categoryDomain === "comics"
                    ? "Comics categories stay synced with Suwayomi. Library updates check every title except folders marked as excluded."
                    : "Books categories are local to Aethon and stay separate from Comics."}
                </p>
                {#if categoryDomain === "comics" && catsError}
                  <div class="settings-state">
                    <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="Categories" title="Could not load comic folders" body={catsError} />
                  </div>
                {/if}
                <div class="settings-card__footer settings-card__footer--editor">
                  <div class="settings-input-line settings-input-line__grow">
                    <input class="settings-text-input settings-input-line__grow" placeholder="New category name..." bind:value={newFolderName} onkeydown={(e) => e.key === "Enter" && createFolder()} />
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={createFolder} disabled={!newFolderName.trim()}><Plus size={13} weight="bold" /> Create</button>
                </div>
                {#if categoryDomain === "comics"}
                  {#if catsLoading}
                    <NocturneState layout="compact" tone="info" icon="folder" eyebrow="Categories" title="Loading categories" />
                  {:else if store.categories.filter((c) => c.id !== 0).length === 0}
                    <NocturneState layout="compact" tone="info" icon="folder" eyebrow="Categories" title="No categories yet" body="Create one above to organize your library." />
                  {:else}
                    {@const displayCats = store.categories
                      .filter((c) => c.id !== 0)
                      .sort((a, b) => {
                        const defaultId = store.settings.defaultLibraryCategoryId ?? null;
                        if (a.id === defaultId) return -1;
                        if (b.id === defaultId) return 1;
                        return a.order - b.order;
                      })}
                    <div class="settings-card__stack" style="margin-top:16px">
                      {#each displayCats as cat, i}
                        <div class="settings-row settings-mini-row settings-mini-row--stretch settings-mini-row--category">
                          {#if editingId === cat.id}
                            <div class="settings-input-line settings-input-line__grow">
                              <input class="settings-text-input settings-input-line__grow" bind:value={editingName} onkeydown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") editingId = null; }} onblur={commitEdit} use:focusInput />
                            </div>
                            <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={commitEdit} title="Save">Save</button>
                          {:else}
                            <div class="settings-mini-row__body">
                              <p class="settings-mini-row__label">{cat.name}</p>
                              <p class="settings-mini-row__hint">{cat.mangas?.nodes.length ?? 0} manga{(store.settings.defaultLibraryCategoryId ?? null) === cat.id ? " / default" : ""}{(store.settings.hiddenCategoryIds ?? []).includes(cat.id) ? " / hidden from Saved" : ""}{cat.includeInUpdate === "EXCLUDE" ? " / skipped by updates" : ""}</p>
                            </div>
                            <div class="settings-section-actions settings-inline-actions settings-inline-actions--dense">
                              <button
                                class="n-btn n-btn--sm n-btn-ghost settings-folder-action"
                                class:folder-update-excluded={cat.includeInUpdate === "EXCLUDE"}
                                type="button"
                                onclick={() => toggleComicFolderUpdates(cat)}
                                title={cat.includeInUpdate === "EXCLUDE" ? "Include this folder in Library updates" : "Exclude this folder from Library updates"}
                              >
                                {cat.includeInUpdate === "EXCLUDE" ? "Skip updates" : "Update"}
                              </button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" class:folder-default-active={(store.settings.defaultLibraryCategoryId ?? null) === cat.id} type="button" onclick={() => updateSettings({ defaultLibraryCategoryId: (store.settings.defaultLibraryCategoryId ?? null) === cat.id ? null : cat.id })} title={(store.settings.defaultLibraryCategoryId ?? null) === cat.id ? "Remove as default category" : "Set as default category"}><Star size={13} weight={(store.settings.defaultLibraryCategoryId ?? null) === cat.id ? "fill" : "light"} /></button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" class:folder-hidden={(store.settings.hiddenCategoryIds ?? []).includes(cat.id)} type="button" onclick={() => toggleHiddenCategory(cat.id)} title={(store.settings.hiddenCategoryIds ?? []).includes(cat.id) ? "Show in Saved tab" : "Hide from Saved tab"}>{#if (store.settings.hiddenCategoryIds ?? []).includes(cat.id)}<EyeSlash size={13} weight="light" />{:else}<Eye size={13} weight="light" />{/if}</button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => moveCategory(cat.id, -1)} disabled={i === 0} title="Move up">Up</button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => moveCategory(cat.id, 1)} disabled={i === displayCats.length - 1} title="Move down">Down</button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => startEdit(cat.id, cat.name)} title="Rename"><Pencil size={12} weight="light" /></button>
                              <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger settings-folder-action folder-delete" type="button" onclick={() => deleteFolder(cat.id)} title="Delete"><Trash size={12} weight="light" /></button>
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                {:else if sortedBooksCategories.length === 0}
                  <NocturneState layout="compact" tone="info" icon="folder" eyebrow="Books categories" title="No categories yet" body="Create one above to organize books and novels." />
                {:else}
                  <div class="settings-card__stack" style="margin-top:16px">
                    {#each sortedBooksCategories as cat, i}
                      <div class="settings-row settings-mini-row settings-mini-row--stretch settings-mini-row--category">
                        {#if editingId === cat.id}
                          <div class="settings-input-line settings-input-line__grow">
                            <input class="settings-text-input settings-input-line__grow" bind:value={editingName} onkeydown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") editingId = null; }} onblur={commitEdit} use:focusInput />
                          </div>
                          <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={commitEdit} title="Save">Save</button>
                        {:else}
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">{cat.name}</p>
                            <p class="settings-mini-row__hint">{booksCategoryCounts[cat.id] ?? 0} book</p>
                          </div>
                          <div class="settings-section-actions settings-inline-actions settings-inline-actions--dense">
                            <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => moveCategory(cat.id, -1)} disabled={i === 0} title="Move up">Up</button>
                            <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => moveCategory(cat.id, 1)} disabled={i === sortedBooksCategories.length - 1} title="Move down">Down</button>
                            <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => startEdit(cat.id, cat.name)} title="Rename"><Pencil size={12} weight="light" /></button>
                            <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger settings-folder-action folder-delete" type="button" onclick={() => deleteFolder(cat.id)} title="Delete"><Trash size={12} weight="light" /></button>
                          </div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
                </div>
              {/if}
            </div>
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "tracking"}
          data-settings-pane="tracking"
          hidden={tab !== "tracking"}
          aria-hidden={tab !== "tracking"}
        >
          {#if shouldRenderPane("tracking")}
          <div class="settings-grid">
            <div class="settings-card">
              <p class="settings-card__title">Connected services</p>
              {#if trackersError}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Trackers" title="Could not load trackers" body={trackersError} />
                </div>
              {/if}
              {#if trackersLoading}
                <NocturneState layout="compact" tone="info" icon="retry" eyebrow="Trackers" title="Loading trackers" />
              {:else}
                <div class="settings-card__stack">
                  {#each trackers as tracker}
                    <div class="settings-row settings-mini-row settings-mini-row--tracker" class:tracker-row-active={tracker.isLoggedIn}>
                      <div class="tracker-identity">
                        <img src={thumbUrl(tracker.icon)} alt={tracker.name} class="tracker-logo" />
                        <div class="tracker-name-block">
                          <span class="tracker-label">{tracker.name}</span>
                          <span class="tracker-status-pill" class:pill-on={tracker.isLoggedIn}>
                            {tracker.isLoggedIn ? "Connected" : "Not connected"}
                          </span>
                        </div>
                      </div>
                      <div class="tracker-action">
                        {#if tracker.isLoggedIn}
                          <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={() => logoutTracker(tracker.id)} disabled={loggingOut === tracker.id}>
                            {loggingOut === tracker.id ? "Disconnecting..." : "Disconnect"}
                          </button>
                        {:else}
                          <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => usesOAuth(tracker) ? startOAuth(tracker) : startCredentials(tracker)}>
                            {usesOAuth(tracker) ? "Login" : "Connect"}
                          </button>
                        {/if}
                      </div>
                    </div>
                  {/each}
                  <div class="settings-row settings-mini-row settings-mini-row--tracker" class:tracker-row-active={hardcoverState.auth.connected}>
                    <div class="tracker-identity">
                      {#if hardcoverIconBroken}
                        <div class="tracker-logo tracker-logo--text">HC</div>
                      {:else}
                        <img
                          src="https://hardcover.app/favicon.ico"
                          alt="Hardcover"
                          class="tracker-logo"
                          onerror={() => (hardcoverIconBroken = true)}
                        />
                      {/if}
                      <div class="tracker-name-block">
                        <span class="tracker-label">Hardcover</span>
                        <span class="tracker-status-pill" class:pill-on={hardcoverState.auth.connected}>
                          {hardcoverState.auth.connected ? "Connected" : "Not connected"}
                        </span>
                      </div>
                    </div>
                    <div class="tracker-action">
                      {#if hardcoverState.auth.connected}
                        <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={disconnectHardcoverAccount}>
                          Disconnect
                        </button>
                      {:else}
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={startHardcoverAuth}>
                          Login
                        </button>
                      {/if}
                    </div>
                  </div>
                </div>
                {#if activeTrackerDetail}
                  <div class="settings-card__surface" style="margin-top:16px">
                    <div class="settings-card__head">
                      <p class="settings-card__title">{activeTrackerDetail.name}</p>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={closeTrackerDetail}>Close</button>
                    </div>
                    {#if activeTrackerDetailMode === "oauth"}
                      <p class="settings-card__intro">
                        {oauthAutoCapturing
                          ? "Finish login in the Tracker Login window. Aethon will connect automatically when the tracker redirects back."
                          : "Aethon opens a tracker login window and captures the OAuth callback automatically. If your system blocks it, paste the redirected callback URL below."}
                      </p>
                      <div class="settings-card__stack">
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">Callback URL</p>
                            <p class="settings-mini-row__hint">Paste the full redirected URL or just the required callback token.</p>
                          </div>
                        </div>
                        <input
                          class="settings-text-input"
                          placeholder="https://suwayomi.org/tracker-oauth#access_token=..."
                          bind:value={oauthCallbackInput}
                          onkeydown={(e) => { if (e.key === "Enter") submitOAuth(); if (e.key === "Escape") cancelOAuth(); }}
                          use:focusEl
                        />
                      </div>
                      <div class="settings-card__footer">
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={submitOAuth} disabled={oauthSubmitting || !oauthCallbackInput.trim()}>
                          {oauthSubmitting ? "Connecting..." : "Connect"}
                        </button>
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={cancelOAuth}>Cancel</button>
                      </div>
                    {:else if activeTrackerDetailMode === "credentials"}
                      <p class="settings-card__intro">Credential-based trackers keep their login flow inside the same card instead of replacing the pane layout.</p>
                      <div class="settings-card__stack">
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">Username or email</p>
                          </div>
                        </div>
                        <input
                          class="settings-text-input"
                          placeholder="Username / Email"
                          bind:value={credsUsername}
                          onkeydown={(e) => e.key === "Escape" && cancelCredentials()}
                          use:focusEl
                        />
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">Password</p>
                          </div>
                        </div>
                        <input
                          class="settings-text-input"
                          type="password"
                          placeholder="Password"
                          bind:value={credsPassword}
                          onkeydown={(e) => { if (e.key === "Enter") submitCredentials(); if (e.key === "Escape") cancelCredentials(); }}
                        />
                      </div>
                      <div class="settings-card__footer">
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={submitCredentials} disabled={credsSubmitting || !credsUsername.trim() || !credsPassword.trim()}>
                          {credsSubmitting ? "Connecting..." : "Connect"}
                        </button>
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={cancelCredentials}>Cancel</button>
                      </div>
                    {/if}
                  </div>
                {:else if hardcoverAuthOpen}
                  <div class="settings-card__surface" style="margin-top:16px">
                    <div class="settings-card__head">
                      <p class="settings-card__title">Hardcover</p>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={cancelHardcoverAuth}>Close</button>
                    </div>
                    <p class="settings-card__intro">
                      Hardcover currently authenticates third-party apps with an API key. Aethon stores it only in this local profile and uses it for novels/books.
                    </p>
                    {#if hardcoverError}
                      <div class="settings-state">
                        <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Hardcover" title="Could not connect Hardcover" body={hardcoverError} />
                      </div>
                    {/if}
                    <div class="settings-card__stack">
                      <div class="settings-row settings-mini-row settings-mini-row--stretch">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">Hardcover API key</p>
                          <p class="settings-mini-row__hint">Create an API key in Hardcover account settings, then paste the key value here.</p>
                        </div>
                      </div>
                      <input
                        class="settings-text-input"
                        type="password"
                        placeholder="Hardcover API key"
                        bind:value={hardcoverTokenInput}
                        onkeydown={(e) => { if (e.key === "Enter") submitHardcoverToken(); if (e.key === "Escape") cancelHardcoverAuth(); }}
                        use:focusEl
                      />
                    </div>
                    <div class="settings-card__footer">
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={submitHardcoverToken} disabled={hardcoverSubmitting || !hardcoverTokenInput.trim()}>
                        {hardcoverSubmitting ? "Connecting..." : "Connect"}
                      </button>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => openUrl("https://hardcover.app/account/api")}>
                        Get API key
                      </button>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={cancelHardcoverAuth}>Cancel</button>
                    </div>
                  </div>
                {/if}
              {/if}
            </div>

            <div class="settings-card">
              <p class="settings-card__title">Sync behavior</p>
              <div class="settings-card__stack">
                <!-- Mockup-only control preserved until tracker sync behavior is configurable from desktop settings. -->
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Update progress automatically</p>
                    <p class="settings-mini-row__hint">Push chapter progress as you read.</p>
                  </div>
                  <button class="settings-toggle is-on" type="button" aria-disabled="true" aria-label="Update progress automatically" data-inert-control="settings-tracking-auto-progress"></button>
                </div>
                <!-- Mockup-only control preserved until tracker auth preference becomes a first-class setting. -->
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Prefer OAuth login</p>
                    <p class="settings-mini-row__hint">Use browser auth when a tracker supports it.</p>
                  </div>
                  <button class="settings-toggle is-on" type="button" aria-disabled="true" aria-label="Prefer OAuth login" data-inert-control="settings-tracking-prefer-oauth"></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Desktop sync pairing</p>
                    <p class="settings-mini-row__hint">Reconnect trusted desktop sync sessions without leaving the settings shell.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (trackingSyncdOpen = !trackingSyncdOpen)}>
                    {trackingSyncdOpen ? "Close" : "Manage"}
                  </button>
                </div>
              </div>
              {#if trackingSyncdOpen}
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">Desktop sync pairing</p>
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (trackingSyncdOpen = false)}>Close</button>
                  </div>
                  <p class="settings-card__intro">Keep the sync runtime tucked inside the existing card so the top-level layout stays faithful to the approved mockup.</p>
                  <div class="settings-card__embed">
                    <SyncdConnectionPanel
                      profileId={currentRuntimeProfileId}
                      scopeLabel={currentSessionProfileSummary}
                    />
                  </div>
                </div>
              {/if}
            </div>
          </div>
          {/if}
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "security"}
          data-settings-pane="security"
          hidden={tab !== "security"}
          aria-hidden={tab !== "security"}
        >
          <div class="settings-grid">
            {#if secError}
              <div class="settings-card settings-card--wide">
                <p class="settings-card__title">Security status</p>
                <div class="settings-state">
                  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Security" title="Security setting failed" body={secError} />
                </div>
              </div>
            {/if}

            <div class="settings-card">
              <p class="settings-card__title">Security</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Require PIN on open</p>
                    <p class="settings-mini-row__hint">
                      {store.settings.appLockEnabled ? "PIN lock is active for launch and idle resume." : "Protect the shell when reopening the app."}
                    </p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.appLockEnabled ?? false}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.appLockEnabled ?? false}
                    aria-label="Require PIN on open"
                    onclick={() => {
                      updateSettings({ appLockEnabled: !(store.settings.appLockEnabled ?? false) });
                      securityDetailPane = "pin";
                    }}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">SOCKS proxy</p>
                    <p class="settings-mini-row__hint">
                      {socksEnabled ? `${socksHost || "Unset host"}:${socksPort || "1080"}` : "Disabled"}
                    </p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = securityDetailPane === "socks" ? null : "socks")}>Edit</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">FlareSolverr</p>
                    <p class="settings-mini-row__hint">{flareEnabled ? (flareStatusLabel() || "Enabled") : "Disabled"}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={flareEnabled}
                    type="button"
                    role="switch"
                    aria-checked={flareEnabled}
                    aria-label="Enable FlareSolverr"
                    onclick={() => {
                      flareEnabled = !flareEnabled;
                      securityDetailPane = "flare";
                    }}
                  ></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">Authentication</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Server auth</p>
                    <p class="settings-mini-row__hint">Require credentials for remote access.</p>
                  </div>
                  <div class="settings-section-actions settings-inline-actions">
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = securityDetailPane === "auth" ? null : "auth")}>Edit</button>
                    <button
                      class="settings-toggle"
                      class:is-on={store.settings.serverAuthEnabled}
                      type="button"
                      role="switch"
                      aria-checked={store.settings.serverAuthEnabled}
                      aria-label="Enable server authentication"
                      onclick={async () => {
                        if (store.settings.serverAuthEnabled) {
                          await disableAuth();
                        } else {
                          securityDetailPane = "auth";
                        }
                      }}
                    ></button>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Proxy mode</p>
                    <p class="settings-mini-row__hint">Choose local, Docker, or custom instance routing.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = securityDetailPane === "flare" ? null : "flare")}>
                    {flareDockerStatus?.running ? "Docker" : flareLocalStatus?.running ? "Local" : "Custom"}
                  </button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Desktop sync pairing</p>
                    <p class="settings-mini-row__hint">Trust, reconnect, or revoke profile-scoped desktop sync sessions.</p>
                  </div>
                  <button
                    class="n-btn n-btn--sm n-btn-ghost"
                    type="button"
                    data-testid="settings-security-syncd-manage"
                    onclick={() => (securityDetailPane = securityDetailPane === "syncd" ? null : "syncd")}
                  >
                    {securityDetailPane === "syncd" ? "Close" : "Manage"}
                  </button>
                </div>
              </div>
              {#if store.settings.serverAuthEnabled}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="info" icon="info" eyebrow="Security" title="Image proxy enabled" body="Images are proxied through Tauri while Basic Auth is active, so image loading can be slower." />
                </div>
              {/if}
            </div>

            {#if securityDetailPane === "syncd"}
              <div class="settings-card settings-card--wide">
                <div class="settings-card__head">
                  <p class="settings-card__title">Desktop sync pairing</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = null)}>Close</button>
                </div>
                <p class="settings-card__intro">Keep trusted desktop pairing controls inside Authentication so the top-level pane still matches the approved mockup.</p>
                <div class="settings-card__embed">
                  <SyncdConnectionPanel
                    profileId={currentRuntimeProfileId}
                    scopeLabel={currentSessionProfileSummary}
                  />
                </div>
              </div>
            {/if}

            {#if securityDetailPane === "auth"}
              <div class="settings-card settings-card--wide">
                <div class="settings-card__head">
                  <p class="settings-card__title">Server authentication</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = null)}>Close</button>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Username</p>
                        <p class="settings-mini-row__hint">Used by remote clients when Basic Auth is enabled.</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <input class="settings-text-input settings-input-line__grow" bind:value={authUsername} placeholder="admin" spellcheck="false" onkeydown={(event) => event.key === "Enter" && enableAuth()} />
                    </div>
                  </div>
                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Password</p>
                        <p class="settings-mini-row__hint">Stored locally and sent to the server only when you save.</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <div class="sec-field-wrap settings-input-line__grow">
                        <input
                          class="settings-text-input settings-input-line__grow"
                          type={showAuthPass ? "text" : "password"}
                          bind:value={authPassword}
                          placeholder="••••••••"
                          autocomplete="new-password"
                          onkeydown={(event) => event.key === "Enter" && enableAuth()}
                        />
                        <button class="sec-eye-btn" type="button" onclick={() => (showAuthPass = !showAuthPass)} title={showAuthPass ? "Hide password" : "Show password"}>
                          {#if showAuthPass}
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                          {:else}
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                          {/if}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="settings-card__footer">
                  {#if store.settings.serverAuthEnabled}
                    <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={disableAuth} disabled={secLoading}>{secLoading ? "Saving..." : "Disable"}</button>
                  {/if}
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={enableAuth} disabled={secLoading || !authUsername.trim() || !authPassword.trim()}>{secLoading ? "Saving..." : secSaved === "auth" ? "Saved" : store.settings.serverAuthEnabled ? "Update" : "Enable"}</button>
                </div>
              </div>
            {/if}

            {#if securityDetailPane === "pin"}
              <div class="settings-card settings-card--wide">
                <div class="settings-card__head">
                  <p class="settings-card__title">PIN lock</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = null)}>Close</button>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">Require PIN on launch</p>
                      <p class="settings-mini-row__hint">Prompt after startup and when returning from the idle splash.</p>
                    </div>
                    <button
                      class="settings-toggle"
                      class:is-on={store.settings.appLockEnabled ?? false}
                      type="button"
                      role="switch"
                      aria-checked={store.settings.appLockEnabled ?? false}
                      aria-label="Enable PIN lock"
                      onclick={() => updateSettings({ appLockEnabled: !(store.settings.appLockEnabled ?? false) })}
                    ></button>
                  </div>
                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">PIN</p>
                        <p class="settings-mini-row__hint">Use 4 to 8 digits. Leave empty to clear the stored PIN.</p>
                      </div>
                    </div>
                    <div class="settings-input-line settings-input-line--stack">
                      <div class="settings-input-line">
                        <input class="settings-text-input sec-pin-input" type="password" inputmode="numeric" maxlength={8} value={pinInput} placeholder="••••" autocomplete="off" oninput={(event) => { pinInput = event.currentTarget.value.replace(/\D/g, "").slice(0, 8); pinError = ""; }} onkeydown={(event) => event.key === "Enter" && commitPin()} />
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={commitPin} disabled={pinInput.length > 0 && pinInput.length < 4}>{store.settings.appLockPin && pinInput === store.settings.appLockPin ? "Saved" : "Save"}</button>
                      </div>
                      {#if pinError}
                        <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="PIN" title="PIN needs attention" body={pinError} />
                      {/if}
                    </div>
                  </div>
                </div>
              </div>
            {/if}
            {#if securityDetailPane === "socks"}
              <div class="settings-card settings-card--wide">
                <div class="settings-card__head">
                  <p class="settings-card__title">SOCKS proxy</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = null)}>Close</button>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">Enable proxy</p>
                      <p class="settings-mini-row__hint">Route Suwayomi traffic through SOCKS4 or SOCKS5.</p>
                    </div>
                    <button
                      class="settings-toggle"
                      class:is-on={socksEnabled}
                      type="button"
                      role="switch"
                      aria-checked={socksEnabled}
                      aria-label="Enable SOCKS proxy"
                      onclick={() => (socksEnabled = !socksEnabled)}
                    ></button>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Version</p>
                        <p class="settings-mini-row__hint">Choose the protocol expected by your proxy endpoint.</p>
                      </div>
                    </div>
                    <div class="n-inline-segmented">
                      {#each [
                        { id: 4, label: "SOCKS4" },
                        { id: 5, label: "SOCKS5" },
                      ] as option}
                        <button
                          class="n-inline-segment"
                          class:is-selected={socksVersion === option.id}
                          type="button"
                          onclick={() => (socksVersion = option.id)}
                        >
                          {option.label}
                        </button>
                      {/each}
                    </div>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Host</p>
                        <p class="settings-mini-row__hint">Hostname or IP address of the proxy server.</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <input class="settings-text-input settings-input-line__grow" bind:value={socksHost} placeholder="127.0.0.1" spellcheck="false" onkeydown={(event) => event.key === "Enter" && saveSocksProxy()} />
                    </div>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Port</p>
                        <p class="settings-mini-row__hint">Default is 1080 for most local SOCKS bridges.</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <input class="settings-text-input settings-input-line__grow" bind:value={socksPort} inputmode="numeric" placeholder="1080" onkeydown={(event) => event.key === "Enter" && saveSocksProxy()} />
                    </div>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Username</p>
                        <p class="settings-mini-row__hint">Optional, only if your proxy requires auth.</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <input class="settings-text-input settings-input-line__grow" bind:value={socksUsername} placeholder="Optional" spellcheck="false" onkeydown={(event) => event.key === "Enter" && saveSocksProxy()} />
                    </div>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Password</p>
                        <p class="settings-mini-row__hint">Stored locally and applied only when you save.</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <div class="sec-field-wrap settings-input-line__grow">
                        <input
                          class="settings-text-input settings-input-line__grow"
                          type={showSocksPass ? "text" : "password"}
                          bind:value={socksPassword}
                          placeholder="••••••••"
                          autocomplete="new-password"
                          onkeydown={(event) => event.key === "Enter" && saveSocksProxy()}
                        />
                        <button class="sec-eye-btn" type="button" onclick={() => (showSocksPass = !showSocksPass)} title={showSocksPass ? "Hide password" : "Show password"} aria-label={showSocksPass ? "Hide SOCKS proxy password" : "Show SOCKS proxy password"}>
                          {#if showSocksPass}
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                          {:else}
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                          {/if}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="settings-card__footer">
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={saveSocksProxy} disabled={secLoading}>
                    {secLoading ? "Saving..." : secSaved === "socks" ? "Saved" : "Save proxy"}
                  </button>
                </div>
              </div>
            {/if}
            {#if securityDetailPane === "flare"}
              <div class="settings-card settings-card--wide">
                <div class="settings-card__head">
                  <p class="settings-card__title">FlareSolverr</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = null)}>Close</button>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">Enable FlareSolverr</p>
                      <p class="settings-mini-row__hint">Bypass Cloudflare challenges for supported sources.</p>
                    </div>
                    <button
                      class="settings-toggle"
                      class:is-on={flareEnabled}
                      type="button"
                      role="switch"
                      aria-checked={flareEnabled}
                      aria-label="Enable FlareSolverr"
                      onclick={() => (flareEnabled = !flareEnabled)}
                    ></button>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">URL</p>
                        <p class="settings-mini-row__hint">Use a local, Docker, or custom FlareSolverr instance.</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                  <input class="settings-text-input settings-input-line__grow" bind:value={flareUrl} placeholder="http://127.0.0.1:8191" spellcheck="false" onkeydown={(event) => event.key === "Enter" && saveFlareSolverr()} />
                    </div>
                  </div>

                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">Connection</p>
                      <p class="settings-mini-row__hint">{flareStatusLabel() || "Check the instance status before saving."}</p>
                    </div>
                    <div class="settings-section-actions settings-inline-actions">
                      <span class="sec-status-pill" class:sec-pill-on={flareTestState === "ready"}>{flareStatusLabel() || "Idle"}</span>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => testFlareSolverr()} disabled={flareTestState === "testing" || secLoading}>
                        {flareTestState === "testing" ? "Testing..." : "Test"}
                      </button>
                    </div>
                  </div>

                  <div class="settings-card__surface">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Local instance</p>
                        <p class="settings-mini-row__hint">{flareLocalStateLabel()}</p>
                      </div>
                      <div class="settings-section-actions settings-inline-actions">
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={refreshFlareLocalStatus} disabled={flareLocalBusy}>Refresh</button>
                        {#if flareLocalStatus?.installed}
                          {#if flareLocalStatus.running}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={stopFlareLocal} disabled={flareLocalBusy}>Stop</button>
                          {:else}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={startFlareLocal} disabled={flareLocalBusy}>Start</button>
                          {/if}
                        {/if}
                      </div>
                    </div>
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Start on app launch</p>
                        <p class="settings-mini-row__hint">{flareLocalStatus?.path ?? "Install FlareSolverr locally to enable autostart."}</p>
                      </div>
                      <button
                        class="settings-toggle"
                        class:is-on={flareLocalAutoStart}
                        type="button"
                        role="switch"
                        aria-checked={flareLocalAutoStart}
                        aria-label="Start FlareSolverr on app launch"
                        onclick={() => setFlareLocalAutoStart(!flareLocalAutoStart)}
                        disabled={!flareLocalStatus?.installed}
                      ></button>
                    </div>
                  </div>

                  <div class="settings-card__surface">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Docker instance</p>
                        <p class="settings-mini-row__hint">{flareDockerStateLabel()}</p>
                      </div>
                      <div class="settings-section-actions settings-inline-actions">
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={refreshFlareDockerStatus} disabled={flareDockerBusy}>Refresh</button>
                        {#if flareDockerStatus?.installed && flareDockerStatus?.daemon}
                          {#if flareDockerStatus.running}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={stopFlareDocker} disabled={flareDockerBusy}>Stop</button>
                          {:else}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={startFlareDocker} disabled={flareDockerBusy}>Start</button>
                          {/if}
                        {/if}
                      </div>
                    </div>
                  </div>

                  <div class="settings-card__surface">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">Advanced</p>
                        <p class="settings-mini-row__hint">Tune timeout, session reuse, and response fallback.</p>
                      </div>
                    </div>
                    <div class="settings-card__stack">
                      <div class="settings-row settings-mini-row">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">Timeout</p>
                          <p class="settings-mini-row__hint">Maximum wait per request in seconds.</p>
                        </div>
                        <div class="step-controls">
                          <button class="step-btn" type="button" onclick={() => (flareTimeout = Math.max(10, flareTimeout - 10))}>-</button>
                          <span class="step-val">{flareTimeout}s</span>
                          <button class="step-btn" type="button" onclick={() => (flareTimeout = Math.min(300, flareTimeout + 10))}>+</button>
                        </div>
                      </div>
                      <div class="settings-field-block">
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">Session name</p>
                            <p class="settings-mini-row__hint">Reuse a named browser session between requests.</p>
                          </div>
                        </div>
                        <div class="settings-input-line">
                  <input class="settings-text-input settings-input-line__grow" bind:value={flareSession} placeholder="aethon" spellcheck="false" onkeydown={(event) => event.key === "Enter" && saveFlareSolverr()} />
                        </div>
                      </div>
                      <div class="settings-row settings-mini-row">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">Session TTL</p>
                          <p class="settings-mini-row__hint">Refresh the browser session after this many minutes.</p>
                        </div>
                        <div class="step-controls">
                          <button class="step-btn" type="button" onclick={() => (flareTtl = Math.max(1, flareTtl - 1))}>-</button>
                          <span class="step-val">{flareTtl}m</span>
                          <button class="step-btn" type="button" onclick={() => (flareTtl = Math.min(60, flareTtl + 1))}>+</button>
                        </div>
                      </div>
                      <div class="settings-row settings-mini-row">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">Response fallback</p>
                          <p class="settings-mini-row__hint">Use FlareSolverr's response when direct requests fail.</p>
                        </div>
                        <button
                          class="settings-toggle"
                          class:is-on={flareFallback}
                          type="button"
                          role="switch"
                          aria-checked={flareFallback}
                          aria-label="Use FlareSolverr response as fallback"
                          onclick={() => (flareFallback = !flareFallback)}
                        ></button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="settings-card__footer">
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={saveFlareSolverr} disabled={secLoading}>
                    {secLoading ? "Saving..." : secSaved === "flare" ? "Saved" : "Save FlareSolverr"}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "content"}
          data-settings-pane="content"
          hidden={tab !== "content"}
          aria-hidden={tab !== "content"}
        >
          <div class="settings-grid">
            <div class="settings-card">
              <p class="settings-card__title">Content filters</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Show adult content</p>
                    <p class="settings-mini-row__hint">Allow titles and sources marked as adult or suggestive.</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.showNsfw} aria-label="Show adult content" class="settings-toggle" class:is-on={store.settings.showNsfw} type="button" onclick={() => updateSettings({ showNsfw: !store.settings.showNsfw })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Filter by blocked tags</p>
                    <p class="settings-mini-row__hint">Hide anything matching your personal blocked tag list.</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.filterBlockedTags}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.filterBlockedTags}
                    aria-label="Filter by blocked tags"
                    onclick={() => updateSettings({ filterBlockedTags: !store.settings.filterBlockedTags })}
                  ></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">Blocked tags</p>
              <div class="settings-chip-list">
                {#each (store.settings.nsfwFilteredTags ?? []) as tag}
                  <span class="settings-chip settings-chip--removable">
                    <Tag size={10} weight="light" />
                    {tag}
                    <button class="content-tag-remove" type="button" onclick={() => removeTag(tag)} title="Remove tag">×</button>
                  </span>
                {/each}
                {#if (store.settings.nsfwFilteredTags ?? []).length === 0}
                  <span class="settings-chip settings-chip--empty">No blocked tags</span>
                {/if}
              </div>
              <div class="settings-card__footer">
                <input
                  class="settings-text-input"
                  placeholder="Add tag substring..."
                  bind:value={newTagInput}
                  onkeydown={(e) => { if (e.key === "Enter") addTag(); }}
                />
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={addTag} disabled={!newTagInput.trim()}>Add</button>
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={resetTags}>Reset</button>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">Source rules</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Allowed sources</p>
                    <p class="settings-mini-row__hint">Whitelist trusted catalogs.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => { contentSourceRulesMode = "allowed"; contentSourceRulesOpen = true; }}>Manage</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Blocked sources</p>
                    <p class="settings-mini-row__hint">Hide noisy or broken catalogs.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => { contentSourceRulesMode = "blocked"; contentSourceRulesOpen = true; }}>Manage</button>
                </div>
              </div>
              {#if contentSourceRulesOpen}
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">{contentSourceRulesMode === "allowed" ? "Allowed sources" : "Blocked sources"}</p>
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (contentSourceRulesOpen = false)}>Close</button>
                  </div>
                  <p class="settings-card__intro">Allow lets a source through even if flagged NSFW. Block always hides it.</p>
                  <div class="content-source-search-wrap">
                    <input class="settings-text-input" placeholder="Filter sources..." bind:value={sourceSearch} />
                  </div>
                  {#if contentSourcesLoading}
                    <NocturneState layout="compact" tone="info" icon="retry" eyebrow="Sources" title="Loading sources" />
                  {:else if contentSources.length === 0}
                    <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="Sources" title="No sources found" body="Check your server connection or source visibility rules." />
                  {:else}
                    <div class="content-source-list">
                      {#each contentSourcesFiltered as group (group.name)}
                        {@const ids = group.sources.map((source) => source.id)}
                        {@const allowed = store.settings.nsfwAllowedSourceIds ?? []}
                        {@const blocked = store.settings.nsfwBlockedSourceIds ?? []}
                        {@const isAllowed = ids.every((id) => allowed.includes(id))}
                        {@const isBlocked = ids.every((id) => blocked.includes(id))}
                        <div class="content-source-row" class:content-source-allowed={isAllowed} class:content-source-blocked={isBlocked}>
                          <img src={thumbUrl(group.iconUrl)} alt="" class="content-source-icon" loading="lazy" decoding="async" />
                          <div class="content-source-info">
                            <span class="content-source-name">{group.name}</span>
                            <span class="content-source-lang">{group.sources[0].isNsfw ? "NSFW · " : ""}{group.sources.length > 1 ? `${group.sources.length} languages` : group.sources[0].lang.toUpperCase()}</span>
                          </div>
                          <div class="content-source-actions">
                            <button
                              class="content-action-btn"
                              class:content-action-active-allow={isAllowed}
                              type="button"
                              onclick={() => toggleSourceAllowed(ids)}
                              title={isAllowed ? "Remove allow override" : "Allow this source through regardless of NSFW flag"}
                            >Allow</button>
                            <button
                              class="content-action-btn"
                              class:content-action-active-block={isBlocked}
                              type="button"
                              onclick={() => toggleSourceBlocked(ids)}
                              title={isBlocked ? "Remove block override" : "Always block this source"}
                            >Block</button>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "about"}
          data-settings-pane="about"
          hidden={tab !== "about"}
          aria-hidden={tab !== "about"}
        >
          <div class="settings-grid">
            <div class="settings-card settings-card--wide">
              <p class="settings-card__title">About</p>
              <p class="settings-card__intro settings-card__intro--body">Aethon is a desktop manga and books frontend for Suwayomi-inspired reading workflows, adapted here into the Nocturne shell.</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Current build</p>
                    <p class="settings-mini-row__hint">v{appVersion}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => { releasesError = null; loadReleases(); }} disabled={releasesLoading}>
                    {releasesLoading ? "Loading..." : "Check updates"}
                  </button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Release history</p>
                    <p class="settings-mini-row__hint">Browse recent builds and changelogs without leaving the page shell.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (aboutReleasesOpen = !aboutReleasesOpen)}>
                    {aboutReleasesOpen ? "Hide" : "Browse"}
                  </button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">GitHub</p>
                    <p class="settings-mini-row__hint">Project home and release notes.</p>
                  </div>
                  <a href="https://github.com/Youwes09/Moku" target="_blank" class="n-btn n-btn--sm n-btn-ghost">Open</a>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Discord</p>
                    <p class="settings-mini-row__hint">Community support and announcements.</p>
                  </div>
                  <a href="https://discord.gg/Jq3pwuNqPp" target="_blank" class="n-btn n-btn--sm n-btn-ghost">Open</a>
                </div>
              </div>
              {#if onLatestVersion}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="success" icon="info" eyebrow="Updates" title="You're on the latest version" />
                </div>
              {/if}
              {#if updatePhase === "downloading" && IS_WINDOWS}
                <div class="update-progress-wrap">
                  <div class="update-progress-bar">
                    <div class="update-progress-fill" style="width:{dlTotal ? Math.round((dlBytes / dlTotal) * 100) : 0}%"></div>
                  </div>
                  <div class="update-progress-row">
                    <span class="update-progress-label">Downloading {targetTag ?? "update"}...</span>
                    <span class="update-progress-val">{fmtProgress()}</span>
                  </div>
                </div>
              {/if}
              {#if updatePhase === "ready"}
                <div class="update-ready-row">
                  <span class="update-ready-label">{targetTag} downloaded - restart to finish installing.</span>
                  <button class="update-action-btn primary" type="button" onclick={restartNow}>Restart now</button>
                  <button class="n-btn n-btn--sm n-btn-ghost settings-mini-action" type="button" onclick={cancelUpdate} title="Dismiss">Dismiss</button>
                </div>
              {/if}
              {#if updatePhase === "error"}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Updates" title="Update failed" body={updateError} />
                </div>
                <div class="update-error-row">
                  <button class="n-btn n-btn--sm n-btn-ghost settings-mini-action" type="button" onclick={cancelUpdate}>Dismiss</button>
                </div>
              {/if}
              {#if aboutReleasesOpen}
              <div class="settings-card__surface" style="margin-top:16px">
                <div class="settings-card__head">
                  <p class="settings-card__title">Releases</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (aboutReleasesOpen = false)}>Close</button>
                </div>
                {#if releasesError}
                  <div class="settings-state">
                    <NocturneState layout="compact" tone="warning" icon="warning" eyebrow="Releases" title="Could not fetch releases" body={releasesError} />
                  </div>
                {:else if releasesLoading}
                  <NocturneState layout="compact" tone="info" icon="retry" eyebrow="Releases" title="Fetching releases" />
                {:else if releases.length === 0}
                  <NocturneState layout="compact" tone="info" icon="info" eyebrow="Releases" title="No releases found" />
                {:else}
                  <div class="release-list-scroll">
                    <div class="release-list">
                      {#each releases as release}
                        {@const isCurrent = isCurrentVersion(release.tag_name)}
                        {@const isExpanded = expandedTag === release.tag_name}
                        {@const isTarget = targetTag === release.tag_name}
                        {@const isInstalling = isTarget && updatePhase === "downloading"}
                        <div class="release-row" class:current={isCurrent}>
                          <div class="release-header">
                            <div class="release-meta">
                              <span class="release-tag">{release.tag_name}</span>
                              {#if isCurrent}
                                <span class="release-badge current-badge">installed</span>
                              {/if}
                              {#if release.published_at}
                                <span class="release-date">{fmtDate(release.published_at)}</span>
                              {/if}
                            </div>
                            <div class="release-actions">
                              {#if release.body.trim()}
                                <button class="release-changelog-btn" type="button" onclick={() => expandedTag = isExpanded ? null : release.tag_name}>{isExpanded ? "Hide" : "Changelog"}</button>
                              {/if}
                              {#if !isCurrent}
                                {#if IS_WINDOWS}
                                  <button class="update-action-btn" class:primary={!isInstalling} disabled={updatePhase === "downloading"} type="button" onclick={() => installUpdate(release)}>
                                    {isInstalling ? "Downloading..." : "Install"}
                                  </button>
                                {:else}
                                  <button class="update-action-btn" type="button" onclick={() => installUpdate(release)}>Open on GitHub</button>
                                {/if}
                              {/if}
                            </div>
                          </div>
                          {#if isExpanded && release.body.trim()}
                            <div class="release-body">
                              <pre class="release-body-pre">{release.body.trim()}</pre>
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
              {/if}
            </div>
          </div>
        </section>
        <section
          class="settings-pane"
          class:is-active={tab === "devtools"}
          data-settings-pane="devtools"
          hidden={tab !== "devtools"}
          aria-hidden={tab !== "devtools"}
        >
          <div class="settings-grid">
            <div class="settings-card">
              <p class="settings-card__title">Dev tools</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Preview idle screen</p>
                    <p class="settings-mini-row__hint">Show the idle splash. Shortcut: Ctrl+Alt+Shift+S also triggers it.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={triggerSplash} style={splashTriggered ? "background:var(--accent-fg);color:var(--bg-base);border-color:var(--accent-fg);transition:all 0.15s ease" : ""}>
                    Show idle
                  </button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Open logs</p>
                    <p class="settings-mini-row__hint">Inspect runtime output and diagnostics.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openAppLogs}>Open</button>
                </div>
                <!-- Mockup-only control preserved until theme token inspector is promoted into a stable settings action. -->
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Inspect theme tokens</p>
                    <p class="settings-mini-row__hint">Preview live Nocturne tokens and surface values.</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" aria-disabled="true" data-inert-control="settings-inspect-theme-tokens">Inspect</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Build mode</p>
                    <p class="settings-mini-row__hint settings-mini-row__hint--mono">{import.meta.env.MODE}</p>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-card settings-reset-card">
              <p class="settings-card__title">Reset settings</p>
              <p class="settings-card__intro settings-card__intro--body">Restore reader, library, shell, security, theme and content preferences to their default Nocturne values.</p>
              <div class="settings-card__surface settings-reset-card__surface">
                <div class="settings-row settings-mini-row settings-mini-row--stretch">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">Reset all configs to default</p>
                    <p class="settings-mini-row__hint">Saved library data, downloads and history stay intact. Only preferences and desktop settings are reset.</p>
                  </div>
                  <button class="n-btn n-btn--sm settings-reset-all-btn" type="button" onclick={resetAllSettingsToDefaults}>
                    Reset all settings
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </section>
  </div>
</main>
<script module lang="ts">
  function focusInput(node: HTMLElement) { node.focus(); }
  function focusEl(node: HTMLElement) { setTimeout(() => node.focus(), 0); }
</script>
<style>
  .step-controls { display: flex; align-items: center; gap: var(--sp-1); flex-shrink: 0; }
  .step-btn { font-family: var(--font-ui); font-size: 12px; font-weight: 700; width: 30px; height: 30px; border-radius: 12px; border: 1px solid rgba(72, 69, 79, 0.16); background: rgba(255, 255, 255, 0.02); color: rgba(229, 226, 225, 0.82); cursor: pointer; transition: color var(--t-base), border-color var(--t-base), background var(--t-base), transform 100ms ease; display: flex; align-items: center; justify-content: center; }
  .step-btn:hover:not(:disabled) { color: var(--n-on-surface); border-color: rgba(184, 167, 234, 0.18); background: rgba(184, 167, 234, 0.06); }
  .step-btn:active:not(:disabled) { transform: scale(0.97); }
  .step-btn:disabled { opacity: 0.3; cursor: default; }
  .step-val { font-family: var(--font-ui); font-size: 11px; color: rgba(202, 196, 208, 0.58); letter-spacing: 0.08em; min-width: 40px; text-align: center; text-transform: uppercase; }
  .select-wrap { position: relative; flex-shrink: 0; }
  .select-btn { display: flex; align-items: center; gap: var(--sp-2); min-height: 32px; font-size: 12px; font-weight: 600; color: var(--n-on-surface); background: rgba(21, 21, 25, 0.72); border: 1px solid rgba(72, 69, 79, 0.16); border-radius: 14px; padding: 0 12px; cursor: pointer; min-width: 130px; transition: border-color 140ms ease, background 140ms ease; }
  .select-btn:hover { border-color: rgba(184, 167, 234, 0.18); background: rgba(28, 27, 27, 0.82); }
  .select-caret { color: var(--text-faint); transition: transform var(--t-base); flex-shrink: 0; margin-left: auto; }
  .select-caret.open { transform: rotate(180deg); }
  .select-menu { position: absolute; top: calc(100% + 4px); right: 0; min-width: 100%; background: var(--bg-raised); border: 1px solid var(--border-base); border-radius: var(--radius-md); padding: var(--sp-1); z-index: 200; box-shadow: 0 8px 24px rgba(0,0,0,0.4); animation: scaleIn 0.1s ease both; transform-origin: top right; }
  .select-option { display: block; width: 100%; padding: 6px var(--sp-3); border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--text-secondary); background: none; border: none; cursor: pointer; text-align: left; transition: background var(--t-fast), color var(--t-fast); }
  .select-option:hover { background: var(--bg-overlay); color: var(--text-primary); }
  .select-option.active { color: var(--accent-fg); background: var(--accent-muted); }
  .scale-row { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); }
  .scale-slider { flex: 1; }
  .scale-val-input {
    font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-secondary);
    width: 42px; text-align: center; padding: 3px 4px;
    background: var(--bg-raised); border: 1px solid var(--border-dim);
    border-radius: var(--radius-sm); outline: none;
    transition: border-color var(--t-base);
    appearance: textfield;
    -moz-appearance: textfield;
  }
  .scale-val-input::-webkit-inner-spin-button,
  .scale-val-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .scale-val-input:focus { border-color: var(--border-strong); }
  .scale-pct { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-faint); margin-left: calc(var(--sp-1) * -1); }
  .settings-mini-action,
  .settings-folder-action {
    min-height: 28px;
    padding: 0 10px;
    border-radius: 10px;
    font-size: 11px;
    line-height: 1;
  }
  .settings-inline-actions--dense {
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .settings-card__footer--editor {
    align-items: center;
  }
  .settings-folder-action {
    min-width: 28px;
    padding: 0 8px;
  }
  .settings-state {
    margin-top: 12px;
  }
  .settings-state:first-child {
    margin-top: 0;
  }
  .settings-state--spaced {
    margin-top: 14px;
  }
  .path-input-error {
    border-color: rgba(216, 180, 255, 0.32) !important;
    box-shadow: 0 0 0 1px rgba(216, 180, 255, 0.08);
  }
  .release-list-scroll { max-height: 336px; overflow-y: auto; padding: 0 var(--sp-1); scrollbar-width: thin; scrollbar-color: var(--border-base) transparent; }
  .release-list-scroll::-webkit-scrollbar { width: 4px; }
  .release-list-scroll::-webkit-scrollbar-track { background: transparent; }
  .release-list-scroll::-webkit-scrollbar-thumb { background: var(--border-base); border-radius: 2px; }
  .folder-delete:hover:not(:disabled) { color: var(--color-error) !important; }
  .folder-hidden { opacity: 0.35; }
  .folder-default-active { color: var(--accent-fg) !important; }
  .folder-update-excluded {
    color: var(--color-warning, #eacb8a) !important;
    border-color: rgba(234, 203, 138, 0.24) !important;
  }
  .release-list { display: flex; flex-direction: column; gap: 1px; padding: 0 var(--sp-1); }
  .release-row {
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    transition: background var(--t-fast), border-color var(--t-fast);
    overflow: hidden;
  }
  .release-row:hover { background: var(--bg-raised); }
  .release-row.current {
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }
  .release-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--sp-2) var(--sp-3); gap: var(--sp-3);
  }
  .release-meta { display: flex; align-items: center; gap: var(--sp-2); flex: 1; min-width: 0; flex-wrap: wrap; }
  .release-tag { font-family: var(--font-ui); font-size: var(--text-xs); font-weight: var(--weight-medium); color: var(--text-secondary); letter-spacing: var(--tracking-wide); flex-shrink: 0; }
  .release-badge { font-family: var(--font-ui); font-size: 10px; padding: 1px 5px; border-radius: var(--radius-sm); letter-spacing: var(--tracking-wide); flex-shrink: 0; }
  .current-badge { background: var(--accent-muted); border: 1px solid var(--accent-dim); color: var(--accent-fg); }
  .release-date { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); flex-shrink: 0; }
  .release-actions { display: flex; align-items: center; gap: var(--sp-2); flex-shrink: 0; }
  .release-changelog-btn {
    font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide);
    padding: 2px 8px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim); background: none; color: var(--text-faint);
    cursor: pointer; transition: color var(--t-base), border-color var(--t-base);
  }
  .release-changelog-btn:hover { color: var(--text-muted); border-color: var(--border-strong); }
  .update-action-btn {
    font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide);
    padding: 3px 10px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim); background: none; color: var(--text-muted);
    cursor: pointer; flex-shrink: 0;
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base);
  }
  .update-action-btn:hover:not(:disabled) { color: var(--text-secondary); border-color: var(--border-strong); }
  .update-action-btn.primary { background: var(--accent-muted); border-color: var(--accent-dim); color: var(--accent-fg); }
  .update-action-btn.primary:hover:not(:disabled) { filter: brightness(1.1); }
  .update-action-btn:disabled { opacity: 0.4; cursor: default; }
  .release-body { padding: 0 var(--sp-3) var(--sp-3); }
  .release-body-pre {
    font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-muted);
    letter-spacing: var(--tracking-wide); line-height: var(--leading-snug);
    white-space: pre-wrap; word-break: break-word; margin: 0;
    max-height: 220px; overflow-y: auto;
  }
  .update-progress-wrap { padding: var(--sp-1) var(--sp-3) var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-1); }
  .update-progress-bar { height: 4px; background: var(--bg-overlay); border-radius: var(--radius-full); overflow: hidden; }
  .update-progress-fill { height: 100%; background: var(--accent); border-radius: var(--radius-full); transition: width 0.3s ease; }
  .update-progress-row { display: flex; justify-content: space-between; align-items: center; }
  .update-progress-label { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); }
  .update-progress-val   { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-secondary); letter-spacing: var(--tracking-wide); }
  .update-ready-row {
    display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
    padding: var(--sp-2) var(--sp-3);
    background: var(--accent-muted); border-radius: var(--radius-md);
    margin: 0 var(--sp-3) var(--sp-2);
  }
  .update-ready-label { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--accent-fg); letter-spacing: var(--tracking-wide); flex: 1; }
  .update-error-row { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); padding: var(--sp-2) 0 0; }
  .tracker-identity { display: flex; align-items: center; gap: var(--sp-3); flex-shrink: 0; }
  .tracker-logo { width: 28px; height: 28px; border-radius: var(--radius-sm); object-fit: contain; flex-shrink: 0; }
  .tracker-logo--text { display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--accent-dim); background: var(--accent-muted); color: var(--accent-fg); font-family: var(--font-ui); font-size: 10px; font-weight: var(--weight-bold); letter-spacing: var(--tracking-wide); }
  .tracker-name-block { display: flex; flex-direction: column; gap: 3px; }
  .tracker-label { font-size: var(--text-sm); color: var(--text-secondary); font-weight: var(--weight-medium); }
  .tracker-status-pill { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wider); text-transform: uppercase; padding: 2px 7px; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); color: var(--text-faint); background: var(--bg-overlay); width: fit-content; }
  .tracker-status-pill.pill-on { border-color: var(--accent-dim); color: var(--accent-fg); background: var(--accent-muted); }
  .tracker-action { display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-2); flex: 1; min-width: 0; }
  .sec-status-pill { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wider); text-transform: uppercase; padding: 2px 8px; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); color: var(--text-faint); background: var(--bg-overlay); flex-shrink: 0; cursor: default; }
  .sec-pill-on { border-color: var(--accent-dim); color: var(--accent-fg); background: var(--accent-muted); }
  .sec-field-wrap { position: relative; flex-shrink: 0; }
  .sec-eye-btn { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; padding: 0; border: none; background: none; color: var(--text-faint); cursor: pointer; transition: color var(--t-base); }
  .sec-eye-btn:hover { color: var(--text-muted); }
  @keyframes fadeIn  { from { opacity: 0 }           to { opacity: 1 } }
  @keyframes scaleIn { from { transform: scale(0.97); opacity: 0 } to { transform: scale(1); opacity: 1 } }
  .content-source-search-wrap { padding: 0 var(--sp-3) var(--sp-3); }
  .content-source-list { display: flex; flex-direction: column; gap: 2px; padding: 0 var(--sp-2); }
  .content-source-row { display: flex; align-items: center; gap: var(--sp-3); padding: 8px var(--sp-3); border-radius: var(--radius-md); border: 1px solid transparent; transition: background var(--t-fast), border-color var(--t-fast); }
  .content-source-row:hover { background: var(--bg-raised); }
  .content-source-allowed { background: color-mix(in srgb, var(--color-success) 6%, transparent); border-color: color-mix(in srgb, var(--color-success) 25%, transparent) !important; }
  .content-source-blocked  { background: color-mix(in srgb, var(--color-error)   6%, transparent); border-color: color-mix(in srgb, var(--color-error)   25%, transparent) !important; }
  .content-source-icon { width: 28px; height: 28px; border-radius: var(--radius-sm); object-fit: cover; flex-shrink: 0; border: 1px solid var(--border-dim); background: var(--bg-overlay); }
  .content-source-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .content-source-name { font-size: var(--text-sm); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .content-source-lang { font-family: var(--font-ui); font-size: var(--text-2xs); color: var(--text-faint); letter-spacing: var(--tracking-wide); }
  .content-source-actions { display: flex; gap: var(--sp-1); flex-shrink: 0; }
  .content-action-btn { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); padding: 3px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); background: none; color: var(--text-faint); cursor: pointer; transition: color var(--t-base), border-color var(--t-base), background var(--t-base); }
  .content-action-btn:hover { color: var(--text-muted); border-color: var(--border-strong); background: var(--bg-overlay); }
  .content-action-active-allow { color: var(--color-success) !important; border-color: color-mix(in srgb, var(--color-success) 40%, transparent) !important; background: color-mix(in srgb, var(--color-success) 10%, transparent) !important; }
  .content-action-active-block  { color: var(--color-error)   !important; border-color: color-mix(in srgb, var(--color-error)   40%, transparent) !important; background: color-mix(in srgb, var(--color-error)   10%, transparent) !important; }
</style>




