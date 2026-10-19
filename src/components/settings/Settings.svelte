<script lang="ts">
  import { createProductionRestoreWorkflow } from "../../lib/backup/productionRestoreWorkflow";
  import RestoreNovelDependencies from "./RestoreNovelDependencies.svelte";
  import RestoreMangaDependencies from "./RestoreMangaDependencies.svelte";
  import { novelRestoreRuntimeState } from "../../lib/backup/novelsRestoreProvisioning";
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { enterOnChange, leaveView, systemPrefersReducedMotion } from "../../lib/motion/motion";
  import "../pages/migrationModal.css";
  import { slide } from "svelte/transition";
  import { _, translate } from "../../lib/i18n/runtime";
  import { formatRelativeTime } from "../../lib/i18n/format";
  import { operationFailure, presentOperationFailure, restoreNote, restorePayloadSummary, type OperationFailure } from "../../lib/i18n/operationPresentation";
  import "../../lib/i18n/runtime";
  import { SETTINGS_SEARCH_KEYWORDS as SHARED_SETTINGS_SEARCH_KEYWORDS } from "../../lib/search/settingsCatalog";
  import { PROSE_READER_SETTING_KEYS, READER_BRIGHTNESS_SETTING_KEY, type ReaderKind } from "../../lib/reader/readerSettingsScope";
  import { Book, Image, Sliders, Info, Keyboard, Gear, HardDrives, FolderSimple, Plus, Pencil, Trash, Wrench, PaintBrush, ListChecks, Lock, Eye, EyeSlash, Star, ShieldCheck, CheckCircle, PuzzlePiece, CircleNotch, Tag, CaretDown, CaretLeft, CaretRight, FileArrowUp, GitBranch, X, Check, Warning } from "phosphor-svelte";
  import { invoke } from "@tauri-apps/api/core";
  import {
    completeEpigraphMyAnimeListLogin,
    epigraphMyAnimeListAuthUrl,
    isEpigraphMyAnimeListCallback,
    publishTrackerLogin,
    publishTrackerLogout,
  } from "../../lib/syncdTrackerCredentials";
  import { listen } from "@tauri-apps/api/event";
  import { getVersion } from "@tauri-apps/api/app";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { gql, gqlUpload, getServerAuthHeader, getServerUrl, serverFileUrl } from "../../lib/client";
  import { withSuwayomiOperationLease } from "../../lib/suwayomiUpdateLock.svelte";
  import { cache, CACHE_KEYS } from "../../lib/cache";
  import { setMigrationPresence } from "../../lib/discord";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import {
    createCustomLocalProfile,
    LocalProfileInputError,
    DEFAULT_LOCAL_PROFILE_ID,
    getAllLocalProfiles,
    getLocalProfileMeta,
    isBuiltInLocalProfileId,
    localProfileDisplayName,
    normalizeCustomLocalProfiles,
    normalizeLocalProfileId,
    type LocalProfileId,
  } from "../../lib/localProfiles";
  import { getEffectiveServerUrl } from "../../lib/serverTarget";
  import { getMangaProgressForScope } from "../../lib/reader/mangaProgressRuntime";
  import type { EpigraphBackupPayloadBuildInput } from "../../lib/backup/epigraphBackup";
  import { preflightEpigraphRestorePayloads } from "../../lib/backup/epigraphRestorePreflight";
  import type {
    EpigraphPayloadRestorePlan,
    EpigraphRestorePlan,
    EpigraphRestorePlannerRuntime,
  } from "../../lib/backup/epigraphRestorePlanner";
  import {
    buildRestoreRelaunchArgs,
    currentProfileSupportsOtherLocalTarget,
    defaultExecutionSelection,
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
  import type { EpigraphNovelRuntimeState } from "../../lib/backup/novelsBackup";
  import { buildBackupDependencyPreview, type BackupDependencyPreview } from "../../lib/backup/dependencyPreview";
  import { extensionStoreKey, getManagedSourceRuntime } from "../../lib/manga/runtime";
  import { createProductionMangaDependencySession } from "../../lib/backup/mangaRestoreDependencies";
  import { findMissingSourceExtensionSuggestions, type MissingSourceExtensionSuggestion } from "../../lib/extensionSourceMap";
  import { normalizeCategories } from "../../lib/library/categories";
  import { GET_CATEGORIES, CREATE_CATEGORY, UPDATE_CATEGORY, UPDATE_CATEGORY_UPDATE_RULE, DELETE_CATEGORY, UPDATE_CATEGORY_ORDER, GET_LIBRARY, GET_LIBRARY_TRACKING_SUMMARY, GET_SOURCES } from "../../lib/queries";
  import { GET_DOWNLOADS_PATH, SET_DOWNLOADS_PATH, SET_LOCAL_SOURCE_PATH, GET_TRACKERS, LOGIN_TRACKER_OAUTH, LOGIN_TRACKER_CREDENTIALS, LOGOUT_TRACKER, GET_TRACKER_RECORDS, GET_SERVER_SECURITY, SET_SERVER_AUTH, SET_SOCKS_PROXY, SET_FLARESOLVERR, CREATE_BACKUP, RESTORE_BACKUP, GET_RESTORE_STATUS } from "../../lib/queries";
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
  import { BUILTIN_THEMES } from "../../lib/theme/contract";
  import { builtinThemeLabel } from "../../lib/theme/themeLabels";
  import {
    DEFAULT_PROSE_READER_BACKGROUND_COLOR,
    DEFAULT_PROSE_READER_TEXT_COLOR,
  } from "../../lib/reader/prosePalette";
  import {
    countBooksForCategory,
    createBooksCategory,
    deleteBooksCategory,
    getBooksUpdateExcludedBookIds,
    moveBooksCategory,
    normalizeBooksCategoryUpdateRule,
    normalizeBooksCategoryAssignments,
    renameBooksCategory,
    sortBooksCategories,
    toggleBooksCategoryUpdateRule,
  } from "../../lib/library/domainCategories";
  import splashMark from "../../assets/epigraph-splash-mark.png";
  import hardcoverLogo from "../../assets/service-icons/hardcover.png";
  import AppTopbar from "../layout/AppTopbar.svelte";
  import ActivityButton from "../layout/ActivityButton.svelte";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import SyncdConnectionPanel from "./SyncdConnectionPanel.svelte";
  import SuwayomiUpdatePanel from "./SuwayomiUpdatePanel.svelte";
  import { store, updateSettings, resetSettings, resetKeybinds, clearHistory, wipeAllData, setSettingsOpen, setRuntimeSettingsTab, engageSearch, disengageSearch, openSearchPalette, setSearchQuery, deleteCustomTheme, toggleHiddenCategory, setCategories, setLibraryMangaSnapshot, setLibraryTrackingSummarySnapshot, addToast, openSearchSources, replaceAppReadingState, replaceBooksState, flushBookLibraryPersistence, DEFAULT_READING_STATS } from "../../store/state.svelte";
  import { KEYBIND_LABELS, DEFAULT_KEYBINDS, eventToKeybind } from "../../lib/keybinds";
  import type { HistoryEntry, ReadLogEntry, ReadingStats, Settings, FitMode, BooksCategory, BooksLibraryStatusFilter, BooksLibraryTypeFilter, RuntimeSettingsTab } from "../../store/state.svelte";
  import type { Keybinds } from "../../lib/keybinds";
  import type { Tracker } from "../../lib/types";
  import type { AvailableExtensionEntry, NativeSourceRestoreChoice, OverlayEntry, ParsedBackup, ReconciliationAnalysis, ReconciliationClusterResult, RestoreReadinessSummary, SourceInventoryEntry } from "../../lib/reconciliation/types";
  import { SETTINGS_EPIGRAPH_BACKUP_EXTENSION, loadSettingsStorageRuntime } from "./settingsStorageRuntime";
  import { APP_LANGUAGE_OPTIONS, appLanguageLabel, resolveAppLocale, type AppLanguageCode } from "../../lib/i18n/languages";
  import {
    desktopReleaseNotes,
    isAuthorizedEpigraphUpdate,
    sortEpigraphReleaseHistory,
    type EpigraphReleaseInfo,
    type EpigraphUpdateStatus,
  } from "../../lib/epigraphUpdater";
  import { normalizeSocksProxyInput } from "../../lib/proxySettings";
  import {
    startDockerFlareSolverrAndEnable,
    startLocalFlareSolverrAndEnable,
  } from "../../lib/flaresolverr";
  import { FIRST_RUN_REOPENED_EVENT, isFirstRunBackupRestoreComplete, type FirstRunBackupReadiness } from "../../lib/firstRun";
  import { reopenFirstRun } from "../../lib/firstRunCleanInstall";

  // The switch shows what the app does now: the user's choice, or the system setting until one is made.
  const animationsOn = $derived(
    typeof store.settings.uiAnimations === "boolean" ? store.settings.uiAnimations : !systemPrefersReducedMotion(),
  );
  interface Props {
    onOpenThemeEditor?: (id?: string | null) => void;
    backupAuditPlan?: EpigraphRestorePlan | null;
    backupRestoreLaunchIntent?: BackupLaunchIntent | null;
    firstRunPane?: "backup" | "tracking" | null;
    onOpenFirstRunSources?: () => void;
    onFirstRunBackupReadyChange?: (readiness: FirstRunBackupReadiness) => void;
  }
  let {
    onOpenThemeEditor,
    backupAuditPlan = null,
    backupRestoreLaunchIntent = null,
    firstRunPane = null,
    onOpenFirstRunSources = () => {},
    onFirstRunBackupReadyChange = () => {},
  }: Props = $props();
  const DEFAULT_EPIGRAPH_GITHUB_REPO = "johnnylord1/Epigraph";
  const EPIGRAPH_GITHUB_REPO = (import.meta.env.VITE_EPIGRAPH_GITHUB_REPO ?? "").trim() || DEFAULT_EPIGRAPH_GITHUB_REPO;
  const EPIGRAPH_GITHUB_URL = `https://github.com/${EPIGRAPH_GITHUB_REPO}`;
  type Tab = "general" | "appearance" | "reader" | "library" | "performance" | "keybinds" | "storage" | "categories" | "tracking" | "security" | "content" | "about" | "devtools";
  type SettingsGroupId = "app" | "reader-library" | "content" | "system" | "advanced";
  type SettingsNavItem = { id: Tab; labelKey: string; descKey: string; icon: any };
  type SettingsNavGroup = { id: SettingsGroupId; labelKey: string; icon: any; items: SettingsNavItem[] };
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
      labelKey: "settings.nav.app",
      icon: Gear,
      items: [
        { id: "general",    labelKey: "settings.nav.general",    descKey: "settings.desc.general",    icon: Gear       },
        { id: "appearance", labelKey: "settings.nav.appearance", descKey: "settings.desc.appearance", icon: PaintBrush },
        { id: "keybinds",   labelKey: "settings.nav.keybinds",   descKey: "settings.desc.keybinds",   icon: Keyboard   },
      ],
    },
    {
      id: "reader-library",
      labelKey: "settings.nav.readerLibrary",
      icon: Book,
      items: [
        { id: "reader",     labelKey: "settings.nav.reader",     descKey: "settings.desc.reader",     icon: Book         },
        { id: "library",    labelKey: "settings.nav.library",    descKey: "settings.desc.library",    icon: Image        },
        { id: "categories", labelKey: "settings.nav.categories", descKey: "settings.desc.categories", icon: FolderSimple },
      ],
    },
    {
      id: "content",
      labelKey: "settings.nav.contentIntegrations",
      icon: ShieldCheck,
      items: [
        { id: "content",    labelKey: "settings.nav.content",  descKey: "settings.desc.content",  icon: ShieldCheck },
        { id: "tracking",   labelKey: "settings.nav.tracking", descKey: "settings.desc.tracking", icon: ListChecks  },
      ],
    },
    {
      id: "system",
      labelKey: "settings.nav.system",
      icon: HardDrives,
      items: [
        { id: "storage",     labelKey: "settings.nav.storage",     descKey: "settings.desc.storage",     icon: HardDrives },
        { id: "performance", labelKey: "settings.nav.performance", descKey: "settings.desc.performance", icon: Sliders    },
        { id: "security",    labelKey: "settings.nav.security",    descKey: "settings.desc.security",    icon: Lock       },
      ],
    },
    {
      id: "advanced",
      labelKey: "settings.nav.advanced",
      icon: Wrench,
      items: [
        { id: "about",      labelKey: "settings.nav.about",    descKey: "settings.desc.about",    icon: Info   },
        { id: "devtools",   labelKey: "settings.nav.devtools", descKey: "settings.desc.devtools", icon: Wrench },
      ],
    },
  ];
  const TAB_LABEL_KEYS: Record<Tab, string> = Object.fromEntries(
    SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.labelKey] as const))
  ) as Record<Tab, string>;
  const TAB_DESCRIPTION_KEYS: Record<Tab, string> = Object.fromEntries(
    SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.descKey] as const))
  ) as Record<Tab, string>;
  const TAB_TO_GROUP: Record<Tab, SettingsGroupId> = Object.fromEntries(
    SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => [item.id, group.id] as const))
  ) as Record<Tab, SettingsGroupId>;
  const DEFAULT_TAB_BY_GROUP: Record<SettingsGroupId, Tab> = Object.fromEntries(
    SETTINGS_GROUPS.map((group) => [group.id, group.items[0].id] as const)
  ) as Record<SettingsGroupId, Tab>;
  const SETTINGS_SEARCH_KEYWORDS: Record<Tab, string[]> = {
    general: SHARED_SETTINGS_SEARCH_KEYWORDS.general,
    appearance: SHARED_SETTINGS_SEARCH_KEYWORDS.appearance,
    keybinds: SHARED_SETTINGS_SEARCH_KEYWORDS.keybinds,
    reader: SHARED_SETTINGS_SEARCH_KEYWORDS.reader,
    library: SHARED_SETTINGS_SEARCH_KEYWORDS.library,
    categories: SHARED_SETTINGS_SEARCH_KEYWORDS.folders,
    content: SHARED_SETTINGS_SEARCH_KEYWORDS.content,
    tracking: SHARED_SETTINGS_SEARCH_KEYWORDS.tracking,
    storage: SHARED_SETTINGS_SEARCH_KEYWORDS.storage,
    performance: SHARED_SETTINGS_SEARCH_KEYWORDS.performance,
    security: SHARED_SETTINGS_SEARCH_KEYWORDS.security,
    about: SHARED_SETTINGS_SEARCH_KEYWORDS.about,
    devtools: SHARED_SETTINGS_SEARCH_KEYWORDS.devtools,
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
  const PAGE_STYLE_LABELS: Record<string, string> = {
    single: "settings_reader_singlePage",
    longstrip: "settings_reader_longStrip",
    fade: "ui_fade",
  };
  const READING_DIRECTION_LABELS: Record<string, string> = {
    ltr: "settings_reader_leftToRight",
    rtl: "settings_reader_rightToLeft",
  };
  const FIT_MODE_LABELS: Record<string, string> = {
    width: "ui_fitWidth",
    height: "ui_fitHeight",
    screen: "ui_fitScreen",
    original: "ui_original11",
  };

  function idleTimeoutLabel(value: number | null | undefined): string {
    const minutes = Number(value ?? 5);
    if (minutes <= 0) return $_("common.never");
    return $_(minutes === 1 ? "common.minute" : "common.minutes", {
      values: { count: minutes },
    });
  }

  function libraryUpdateIntervalLabel(value: number | null | undefined): string {
    const hours = Number(value ?? 12);
    return hours === 1 ? translate("settings_inline_everyHour") : translate("settings_inline_everyHours", { hours });
  }

  function libraryUpdateIntensityLabel(value: Settings["libraryUpdateIntensity"] | null | undefined): string {
    if (value === "eco") return translate("settings_inline_eco");
    if (value === "fast") return translate("settings_inline_fast");
    return translate("settings_inline_balanced");
  }

  function libraryUpdateIntensityHint(value: Settings["libraryUpdateIntensity"] | null | undefined): string {
    if (value === "eco") return translate("settings_inline_ecoHint");
    if (value === "fast") return translate("settings_inline_fastHint");
    return translate("settings_inline_balancedHint");
  }

  function pageStyleLabel(value: Settings["pageStyle"]): string {
    const normalized = value === "double" ? "single" : value;
    return $_(PAGE_STYLE_LABELS[normalized] ?? PAGE_STYLE_LABELS.single);
  }

  function readingDirectionLabel(value: Settings["readingDirection"]): string {
    return $_(READING_DIRECTION_LABELS[value] ?? READING_DIRECTION_LABELS.ltr);
  }

  function fitModeLabel(value: FitMode | null | undefined): string {
    const normalized = value ?? "width";
    return $_(FIT_MODE_LABELS[normalized] ?? FIT_MODE_LABELS.width);
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
    return value === "auto" ? $_("library_display_auto") : $_("settings_library_columns", { count: value });
  }
  const LIBRARY_DENSITY_OPTIONS: Settings["libraryPreferredGridColumns"][] = ["auto", 4, 5, 6, 7, 8, 9, 10];
  function libraryDensityOptionLabel(value: Settings["libraryPreferredGridColumns"]): string {
    return value === "auto" ? $_("library_display_auto") : String(value);
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
    return translate("settings_inline_renderLimitCount", { count: value ?? 48 });
  }

  function themeLabel(value: string | null | undefined): string {
    const normalized = value ?? "nocturne";
    const builtIn = BUILTIN_THEMES.find((theme) => theme.id === normalized);
    if (builtIn) return builtinThemeLabel(builtIn, $_);
    const custom = (store.settings.customThemes ?? []).find((theme) => theme.id === normalized);
    return custom?.name ?? "Nocturne";
  }
  let previousNonAmoledTheme = $state(
    store.settings.theme === "amoled" ? "nocturne" : (store.settings.theme ?? "nocturne"),
  );
  function toggleAmoledTheme() {
    const currentTheme = store.settings.theme ?? "nocturne";
    if (currentTheme === "amoled") {
      updateSettings({ theme: previousNonAmoledTheme });
      return;
    }
    previousNonAmoledTheme = currentTheme;
    updateSettings({ theme: "amoled" });
  }
  let tab: Tab = $state("general");
  let activeGroup: SettingsGroupId = $state("app");
  $effect(() => {
    if (firstRunPane === "backup") {
      tab = "storage";
      activeGroup = "system";
    } else if (firstRunPane === "tracking") {
      ensurePaneHydrated("tracking");
      tab = "tracking";
      activeGroup = "content";
    }
  });
  let contentBodyEl: HTMLDivElement;
  let settingsSearchInputEl: HTMLInputElement | null = $state(null);
  let backupSectionEl: HTMLDivElement | undefined = $state();
  let backupSectionScrollKey = $state<string | null>(null);
  let paneScrollTop = $state<Record<Tab, number>>({ ...INITIAL_PANE_SCROLL_TOP });
  let paneHydrated = $state<Record<Tab, boolean>>({ ...INITIAL_PANE_HYDRATION });
  let settingsSearchQuery = $state("");
  let settingsSearchAnnouncement = $state("");
  let activeSettingsSearchHit: HTMLElement | null = null;
  let categoriesDetailsPane = $state<"comics" | "books" | null>(null);
  let contentSourceRulesOpen = $state(false);
  let contentSourceRulesMode = $state<"allowed" | "blocked">("allowed");
  let aboutReleasesOpen = $state(false);
  let securityDetailPane = $state<"auth" | "socks" | "flare" | "pin" | "syncd" | null>(null);
  const currentGroup = $derived.by(
    () => SETTINGS_GROUPS.find((group) => group.id === activeGroup) ?? SETTINGS_GROUPS[0]
  );
  const currentGroupLabel = $derived.by(() => $_(currentGroup.labelKey));
  const currentTabMeta = $derived.by(
    () => {
      const item = currentGroup.items.find((entry) => entry.id === tab) ?? currentGroup.items[0];
      return {
        ...item,
        label: $_(item.labelKey),
        desc: $_(item.descKey),
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
      addToast({ kind: "error", title: translate("ui_couldnTOpenTheAppLogs") });
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
    return (Object.keys(TAB_LABEL_KEYS) as Tab[])
      .map((candidate) => {
        const label = translate(TAB_LABEL_KEYS[candidate]);
        const description = translate(TAB_DESCRIPTION_KEYS[candidate]);
        const haystack = [
          label,
          description,
          SETTINGS_SEARCH_KEYWORDS[candidate].join(" "),
          TAB_TO_GROUP[candidate],
        ].join(" ");
        const normalizedHaystack = normalizeSearchText(haystack);
        const exactBoost = normalizedHaystack.includes(query) ? 10 : 0;
        const startsBoost = normalizeSearchText(label).startsWith(query) ? 8 : 0;
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
    if (store.isSearchFocusRestoreInProgress) return;
    engageSearch();
  }
  function handleSettingsSearchFocusOut() {
    disengageSearch();
  }
  function resetAllSettingsToDefaults() {
    resetSettings();
    listeningKey = null;
    selectOpen = null;
    settingsSearchQuery = "";
    settingsSearchAnnouncement = translate("settings.search.resetAnnouncement");
    clearSettingsSearchHighlight();
    categoriesDetailsPane = null;
    contentSourceRulesOpen = false;
    contentSourceRulesMode = "allowed";
    aboutReleasesOpen = false;
    securityDetailPane = null;
    advStorageOpen = false;
    storageAdvancedSource = null;
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
      title: translate("settings.search.resetToastTitle"),
      body: translate("settings.search.resetToastBody"),
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
      settingsSearchAnnouncement = translate("settings.search.noMatch", { query: settingsSearchQuery });
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
      settingsSearchAnnouncement = translate("settings.search.openedFor", { tab: translate(TAB_LABEL_KEYS[targetTab]), query: settingsSearchQuery });
      return;
    }
    contentBodyEl?.scrollTo({ top: 0, behavior: "smooth" });
    settingsSearchAnnouncement = translate("settings.search.opened", { tab: translate(TAB_LABEL_KEYS[targetTab]) });
  }
  $effect(() => {
    if (store.searchContext === "settings" && settingsSearchQuery !== store.searchQuery) {
      settingsSearchQuery = store.searchQuery;
      handleSettingsSearchInput();
    }
  });

  $effect(() => {
    if (typeof document === "undefined") return;
    const engaged = store.navPage === "settings"
      && store.searchOpen
      && store.searchContext === "settings";
    document.body.classList.toggle("epigraph-settings-search-engaged", engaged);
    return () => {
      document.body.classList.remove("epigraph-settings-search-engaged");
    };
  });
  async function getStorageRuntime() {
    return loadSettingsStorageRuntime();
  }
  let profileCreateLabel = $state("");
  let profileCreatePort = $state("");
  let profileCreateError: OperationFailure | null = $state(null);
  let profileDataDeleteConfirmId: LocalProfileId | null = $state(null);
  let profileDataDeleteBusy: LocalProfileId | null = $state(null);
  const profileOptions = $derived.by(() => getAllLocalProfiles(store.settings.customLocalProfiles));

  function setDefaultLocalProfile(profileId: LocalProfileId) {
    const profile = getLocalProfileMeta(profileId, store.settings.customLocalProfiles);
    if (!profile) return;
    updateSettings({ defaultLocalProfileId: profile.id, serverUrl: profile.serverUrl });
  }

  /** Leaves Settings and walks through setup again; library, sources and settings stay as they are. */
  function redoFirstRun() {
    try { reopenFirstRun(localStorage, { cancellable: true }); } catch { return; }
    setSettingsOpen(false);
    window.dispatchEvent(new Event(FIRST_RUN_REOPENED_EVENT));
  }

  function createLocalProfileFromSettings() {
    profileCreateError = null;
    try {
      const profile = createCustomLocalProfile(
        {
          label: profileCreateLabel,
          port: Number(profileCreatePort),
          fallbackLabel: translate("profiles_defaultLabel", { port: Number(profileCreatePort) }),
        },
        store.settings.customLocalProfiles,
      );
      const customLocalProfiles = [
        ...normalizeCustomLocalProfiles(store.settings.customLocalProfiles),
        profile,
      ];
      const meta = getLocalProfileMeta(profile.id, customLocalProfiles);
      updateSettings({
        customLocalProfiles,
        defaultLocalProfileId: profile.id,
        serverUrl: meta?.serverUrl ?? `http://127.0.0.1:${profile.port}`,
      });
      profileCreateLabel = "";
      profileCreatePort = "";
    } catch (error) {
      profileCreateError = error instanceof LocalProfileInputError
        ? operationFailure(null, error.code === "port-in-use" ? "profiles_portInUse" : "profiles_portOutOfRange")
        : operationFailure(error, "outcomes.failed");
    }
  }

  function deleteLocalProfileFromSettings(profileId: LocalProfileId) {
    const normalized = normalizeLocalProfileId(profileId);
    if (!normalized || isBuiltInLocalProfileId(normalized)) return;
    if (currentRuntimeProfileId === normalized) {
      profileCreateError = operationFailure(null, "outcomes.closeProfileFirst");
      return;
    }
    const customLocalProfiles = normalizeCustomLocalProfiles(store.settings.customLocalProfiles)
      .filter((profile) => profile.id !== normalized);
    const deletedDefault = persistedDefaultProfileId === normalized;
    const fallback = getLocalProfileMeta(DEFAULT_LOCAL_PROFILE_ID, customLocalProfiles);
    updateSettings({
      customLocalProfiles,
      ...(deletedDefault
        ? {
            defaultLocalProfileId: DEFAULT_LOCAL_PROFILE_ID,
            serverUrl: fallback?.serverUrl ?? "http://127.0.0.1:4567",
          }
        : {}),
    });
    profileCreateError = null;
    if (profileDataDeleteConfirmId === normalized) profileDataDeleteConfirmId = null;
  }

  async function resetLocalProfileDataFromSettings(profileId: LocalProfileId) {
    const normalized = normalizeLocalProfileId(profileId);
    if (!normalized) return;
    if (profileDataDeleteConfirmId !== normalized) {
      profileDataDeleteConfirmId = normalized;
      profileCreateError = operationFailure(null, "outcomes.confirmProfileReset");
      return;
    }

    profileDataDeleteBusy = normalized;
    profileCreateError = null;
    try {
      await invoke<boolean>("reset_local_profile_data", { profileId: normalized });
      addToast({
        kind: "success",
        title: translate("ui_profileDataReset"),
        body: currentRuntimeProfileId === normalized
          ? translate("settings_profile_resetRestartHint")
          : translate("settings_profile_resetNextStartHint"),
      });
      profileDataDeleteConfirmId = null;
    } catch (error) {
      profileCreateError = operationFailure(error, "outcomes.failed");
    } finally {
      profileDataDeleteBusy = null;
    }
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
  let storageError: OperationFailure | null = $state(null);
  let clearing = $state(false);
  let cleared  = $state(false);

  // Ã¢â€â‚¬Ã¢â€â‚¬ External server detection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // A server is "external" if its URL doesn't point to localhost Ã¢â‚¬â€ in that case we
  // cannot invoke Tauri commands against its filesystem (path validation, disk usage,
  // migration). We can still read the server's paths via GraphQL, but we must never
  // overwrite the server's download directory config without the user explicitly asking.
  const currentRuntimeServerUrl = $derived.by(() => getEffectiveServerUrl());
  const currentRuntimeProfileId = $derived.by(
    () => getLocalProfileMeta(normalizeLocalProfileId(store.runtimeResolvedLocalProfileId), store.settings.customLocalProfiles)?.id ?? null
  );
  const persistedDefaultProfileId = $derived.by(
    () => getLocalProfileMeta(normalizeLocalProfileId(store.settings.defaultLocalProfileId), store.settings.customLocalProfiles)?.id ?? DEFAULT_LOCAL_PROFILE_ID
  );
  const profileName = (label: string | null | undefined) => localProfileDisplayName(label, $_);
  const currentProfileMeta = $derived.by(() => store.runtimeResolvedLocalProfileMeta);
  const nextLaunchProfileMeta = $derived.by(() => getLocalProfileMeta(persistedDefaultProfileId, store.settings.customLocalProfiles));
  const currentSessionProfileLabel = $derived.by(() => {
    const label = currentProfileMeta?.label ?? store.runtimeServerLabel?.trim().toUpperCase();
    return label && label.length ? label : "CUSTOM";
  });
  const currentSessionProfileSummary = $derived.by(
    () => store.runtimeIsOverrideSession
      ? $_("settings.general.profiles.launchOverride", { profile: profileName(currentSessionProfileLabel) })
      : profileName(currentSessionProfileLabel)
  );
  const nextLaunchProfileSummary = $derived.by(
    () => profileName(nextLaunchProfileMeta?.label ?? currentSessionProfileLabel)
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
  let pathsError: OperationFailure | null = $state(null);
  let pathsFieldError: { dl?: OperationFailure; loc?: OperationFailure } = $state({});
  let pathsSaved            = $state(false);

  // The actual resolved default path from Rust Ã¢â‚¬â€ shown as placeholder + scanned when dl path is empty.
  // Only meaningful for local servers Ã¢â‚¬â€ Tauri can't stat a remote filesystem.
  // Re-fetches reactively when the server URL changes (e.g. user switches to local).
  let defaultDownloadsPath  = $state("");
  $effect(() => {
    if (!isExternalServer) {
      invoke<string>("get_default_downloads_path", { profileId: currentRuntimeProfileId }).then(p => { defaultDownloadsPath = p; });
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
  let migrateError: OperationFailure | null  = $state(null);
  let migrateUnlisten: (() => void) | null = null;

  // Ã¢â€â‚¬Ã¢â€â‚¬ Extra scan directories (local-only, stored in app settings) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  let extraScanDirs: string[]   = $state([...(store.settings.extraScanDirs ?? [])]);
  let newScanDir                = $state("");
  let multiStorageInfos: (StorageInfo & { label: string })[] = $state([]);
  type StorageAdvancedSource = "limit" | "paths" | "backup" | "advanced";
  let advStorageOpen            = $state(false);
  let storageAdvancedSource     = $state<StorageAdvancedSource | null>(null);
  function toggleStorageAdvanced(source: StorageAdvancedSource) {
    if (advStorageOpen && storageAdvancedSource === source) {
      advStorageOpen = false;
      storageAdvancedSource = null;
      return;
    }
    advStorageOpen = true;
    storageAdvancedSource = source;
  }
  function openStorageAdvanced() {
    toggleStorageAdvanced("advanced");
  }
  function openStorageLimit() {
    toggleStorageAdvanced("limit");
  }
  function openStoragePaths() {
    toggleStorageAdvanced("paths");
  }
  let backupViewMode = $state<"create" | "restore" | null>(null);
  let backupRestorePage = $state<"main" | "sources" | "confirm">("main");
  function openStorageBackupPanel() {
    backupViewMode = "create";
    advStorageOpen = true;
    storageAdvancedSource = "backup";
  }
  function openStorageRestore() {
    backupViewMode = "restore";
    advStorageOpen = true;
    storageAdvancedSource = "backup";
  }
  function openRestoreRepositories() {
    if (firstRunPane === "backup") {
      onOpenFirstRunSources();
      return;
    }
    openSearchSources("extensions", "repos");
  }
  function closeStorageBackupPanel() {
    if (!backupRestoring && backupRestoreResults) resetBackupImportState();
    backupViewMode = null;
    advStorageOpen = false;
    storageAdvancedSource = null;
    backupRestorePage = "main";
  }
  const storageLimitBytes = $derived.by(() =>
    store.settings.storageLimitGb === null ? null : store.settings.storageLimitGb * 1024 ** 3
  );
  const storageUsageSummary = $derived.by(() => {
    const infos = multiStorageInfos.length > 0
      ? multiStorageInfos
      : storageInfo
        ? [{ ...storageInfo, label: translate("shell_navigation_downloads") }]
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
      freeLabel: freeBytes > 0 ? translate("settings_storage_freeSpace", { size: fmtBytes(freeBytes) }) : null,
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
      if (effectiveDl) dirsToScan.push({ path: effectiveDl, label: dl ? translate("shell_navigation_downloads") : translate("ui_downloadsDefault") });
      if (loc && loc !== effectiveDl) dirsToScan.push({ path: loc, label: translate("ui_localSource") });
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
      storageError = operationFailure(e, "outcomes.failed");
    } finally {
      storageLoading = false;
    }
  }

  /** Validate a path exists on disk. Returns a presentation error or null.
   *  Only runs for local servers Ã¢â‚¬â€ we can't stat a remote filesystem via Tauri. */
  async function validatePath(path: string): Promise<OperationFailure | null> {
    if (!path.trim()) return null; // empty = use default, always valid
    if (isExternalServer) return null; // can't check remote paths locally
    try {
      const exists = await invoke<boolean>("check_path_exists", { path: path.trim() });
      return exists ? null : operationFailure(null, "outcomes.missingDirectory");
    } catch {
      return operationFailure(null, "outcomes.pathCheckFailed");
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

    // A new folder inside the one holding the downloads could never receive them, so refuse it before
    // the server starts writing there.
    const oldDl = confirmedDownloadsPath || defaultDownloadsPath;
    const newDl = dl || defaultDownloadsPath;
    const offerMove = !isExternalServer && !!newDl && !!oldDl && newDl !== oldDl;
    if (offerMove) {
      try {
        await invoke("check_downloads_move", { src: oldDl, dst: newDl });
      } catch (e) {
        pathsFieldError = { dl: operationFailure(e, "outcomes.pathCheckFailed") };
        return;
      }
    }

    pathsSaving = true;
    try {
      // Send each mutation independently Ã¢â‚¬â€ localSourcePath rejects empty string server-side
      await gql(SET_DOWNLOADS_PATH, { path: dl });
      if (loc) await gql(SET_LOCAL_SOURCE_PATH, { path: loc });

      updateSettings({ serverDownloadsPath: dl, serverLocalSourcePath: loc });

      // Migration requires local filesystem access Ã¢â‚¬â€ skip for external servers.
      if (offerMove) {
        const hadContent = await invoke<boolean>("check_path_exists", { path: oldDl });
        if (hadContent) { migrateFrom = oldDl; migrateTo = newDl; }
      }

      confirmedDownloadsPath   = dl;
      confirmedLocalSourcePath = loc;
      pathsSaved = true;
      setTimeout(() => pathsSaved = false, 2000);
      await fetchStorage();
    } catch (e: any) {
      pathsError = operationFailure(e, "settings.storage.pathSaveError");
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
    // The picker saves at once, so open the editor when the choice needs attention or offers to move files.
    if (pathsFieldError.dl || pathsFieldError.loc || pathsError || migrateFrom) {
      advStorageOpen = true;
      storageAdvancedSource = "paths";
    }
  }

  async function startMigration() {
    if (!migrateFrom || !migrateTo) return;
    migrating = true; migrateError = null; migrateProgress = { done: 0, total: 0, current: "" };
    void setMigrationPresence(true, store.settings, "settings");

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
      migrateError = operationFailure(e, "settings_inline_pathMigrationFailed");
    } finally {
      void setMigrationPresence(false, store.settings, "settings");
      migrating = false;
      migrateUnlisten?.(); migrateUnlisten = null;
    }
  }

  function dismissMigration() {
    // Keeping the files where they are is a valid choice; say where they stayed so they are not taken for lost.
    if (migrateFrom) addToast({ kind: "info", title: translate("settings_inline_migrationKeptTitle"), body: migrateFrom, duration: 6000 });
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
  const restoreWorkflows = new Map<string, ReturnType<typeof createProductionRestoreWorkflow>>();
  let activeRestoreWorkflow = $state<ReturnType<typeof createProductionRestoreWorkflow> | null>(null);
  let restoreCancellationRequested = $state(false);
  onDestroy(() => { activeRestoreWorkflow?.detach(); });
  function cancelRestore() {
    activeRestoreWorkflow?.requestCancel();
    restoreCancellationRequested = true;
  }
  let backupFileInput = $state<HTMLInputElement | undefined>(undefined);
  let backupExporting = $state(false);
  let backupValidating = $state(false);
  let backupRestoring = $state(false);
  let backupError: OperationFailure | null = $state(null);
  let backupSavedPath: string | null = $state(null);
  let backupSelectedFile: File | null = $state(null);
  let backupParsed: ParsedBackup | null = $state(null);
  let backupAnalysis: ReconciliationAnalysis | null = $state(null);
  let backupRestoreId: string | null = $state(null);
  let backupRestoreStatus: BackupRestoreProgress | null = $state(null);
  let backupSuggestedExtensions = $state<MissingSourceExtensionSuggestion[]>([]);
  let backupAvailableExtensions = $state<AvailableExtensionEntry[]>([]);
  let backupInventory = $state<SourceInventoryEntry[]>([]);
  let backupExtensionLookupError: OperationFailure | null = $state(null);
  let backupExtensionLookupLoading = $state(false);
  let backupInstalling = $state(new Set<string>());
  let backupReviewSelections = $state<Record<string, NativeSourceRestoreChoice>>({});
  let backupMissingTrackers = $state<{ name: string }[]>([]);
  let backupSelectedFilePath: string | null = $state(null);
  let backupImportKind = $state<BackupImportKind | null>(null);
  let backupUnifiedIncludeManga = $state(true);
  let backupUnifiedIncludeBooks = $state(true);
  let backupUnifiedIncludeNovels = $state(true);
  let backupUnifiedIncludeApp = $state(true);
  let backupBooksOnlyMetadataOnly = $state(false);
  let backupMangaNativeFormat = $state(false);
  // One list of what to include; the Mihon .tachibk format only fits when comics are all there is.
  const backupOnlyMangaSelected = $derived(backupUnifiedIncludeManga && !backupUnifiedIncludeBooks && !backupUnifiedIncludeNovels && !backupUnifiedIncludeApp);
  const backupNothingSelected = $derived(!backupUnifiedIncludeManga && !backupUnifiedIncludeBooks && !backupUnifiedIncludeNovels && !backupUnifiedIncludeApp);
  const backupExportMode = $derived<BackupExportMode>(backupOnlyMangaSelected && backupMangaNativeFormat ? "manga" : "unified");
  let backupUnifiedPlan = $state<EpigraphRestorePlan | null>(null);
  let backupUnifiedSelection = $state<BackupExecutionSelection>({});
  let backupRestoreTargetMode = $state<RestoreTargetMode>("current-profile");
  let backupRestoreCurrentProfileConfirmed = $state(false);
  let backupRestoreHandoffSession = $state(false);
  let backupRestoreSourceProfileId = $state<LocalProfileId | null>(null);
  let backupRestoreResults = $state<Array<{ kind: string; status: "success" | "warning" | "failed" | "skipped"; outcome: string; warnings: string[]; summary: string; detail?: string | null }> | null>(null);
  let backupLaunchIntentKey = $state<string | null>(null);
  let backupAuditPlanKey = $state<string | null>(null);
  let backupLastLegacyAnalysisPath: string | null = $state(null);
  let backupDependencyPreview = $state<BackupDependencyPreview | null>(null);
  let backupDependenciesConfirmed = $state(false);
  let backupDependenciesWorking = $state(false);
  let mangaDependencyPanel = $state<{ review(): Promise<void> }>();

  const backupReadiness = $derived.by<RestoreReadinessSummary | null>(() =>
    backupAnalysis
      ? buildRestoreReadiness(backupAnalysis, backupReviewSelections, backupInventory, backupAvailableExtensions)
      : null,
  );
  const backupRestoreBlocked = $derived(
    !backupSelectedFile
      || !backupParsed
      || !backupAnalysis
      || !!backupReadiness?.blocksRestore
      || backupValidating
      || backupRestoring,
  );
  $effect(() => {
    if (firstRunPane === "backup") {
      const snapshot: FirstRunBackupReadiness = {
        ready: isFirstRunBackupRestoreComplete(backupRestoreResults),
        hasSelection: Boolean(backupSelectedFile || backupUnifiedPlan),
        requiresSources: backupRestoreResults?.some((result) =>
          (result.kind === "manga" || result.kind === "novels") && result.status !== "skipped") ?? true,
        sourceTypes: (["manga", "novels"] as const).filter((kind) =>
          backupRestoreResults?.some((result) => result.kind === kind && result.status !== "skipped")),
        contentType: backupImportKind === "novels-lnreader"
          || (backupRestoreResults?.some((result) => result.kind === "novels")
            && !backupRestoreResults.some((result) => result.kind === "manga"))
          ? "novels" : "manga",
      };
      const onReadinessChange = onFirstRunBackupReadyChange;
      untrack(() => onReadinessChange(snapshot));
    }
  });
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
    () => backupRestoreTargetMode === "current-profile"
      ? `${$_("settings_inline_currentProfile")} (${profileName(currentProfileMeta?.label ?? currentSessionProfileLabel)})`
      : otherLocalProfileMeta
        ? `${$_("settings_inline_otherLocalProfile")} (${profileName(otherLocalProfileMeta.label)})`
        : $_("settings_inline_otherLocalProfile")
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
  const backupDependencyConfirmationRequired = $derived.by(() => {
    const preview = backupDependencyPreview as BackupDependencyPreview | null;
    return preview?.requiresConfirmation === true && !backupDependenciesConfirmed;
  });
  function computeBackupRestoreDisabled(ignoreConfirmations: boolean): boolean {
    if (backupDependenciesWorking) return true;
    if (backupResolvedExecutionBlockedReason) return true;
    if (!ignoreConfirmations && backupCurrentProfileGateRequired && !backupRestoreCurrentProfileConfirmed) return true;
    if (!ignoreConfirmations && backupRestoreTargetMode === "current-profile" && backupDependencyConfirmationRequired) return true;
    if (backupRestoreTargetMode === "other-local-profile") {
      return !backupSelectedFilePath || !backupCanUseOtherProfileTarget || backupRestoring || backupValidating;
    }
    if (backupImportKind === "epigraph") {
      return !backupUnifiedPlan || !backupHasExecutableSelection || backupRestoring || backupValidating;
    }
    if (backupImportKind === "novels-lnreader") {
      return (!backupSelectedFilePath && !backupSelectedFile) || backupRestoring || backupValidating;
    }
    return backupRestoreBlocked;
  }
  const backupExecuteDisabled = $derived(computeBackupRestoreDisabled(false));
  const backupStartDisabled = $derived(computeBackupRestoreDisabled(true));

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
        return translate("settings_backup_includeComics");
      case "books":
        return translate("settings_backup_includeBooks");
      case "novels":
        return translate("settings_backup_includeNovels");
      case "app":
        return translate("settings_backup_includeHistory");
      case "repositories":
        return translate("settings_backup_repositoriesFound");
      default:
        return kind;
    }
  }

  // "https://raw.githubusercontent.com/owner/repo/branch" -> "owner/repo"; other hosts -> host + path.
  function backupRepositoryShortName(url: string): string {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parsed.hostname === "raw.githubusercontent.com" || parsed.hostname === "github.com") {
        return parts.slice(0, 2).join("/") || parsed.hostname;
      }
      return `${parsed.hostname}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
      return url;
    }
  }

  function backupPayloadStatusLabel(status: EpigraphPayloadRestorePlan["status"] | "success" | "warning" | "failed" | "unknown"): string {
    switch (status) {
      case "restorable":
        return translate("settings_inline_restorable");
      case "warning-only":
        return translate("settings_inline_warningOnly");
      case "blocked":
        return translate("settings_inline_blocked");
      case "unsupported":
        return translate("settings_inline_unsupported");
      case "skipped":
        return translate("settings_inline_skipped");
      case "success":
        return translate("settings_inline_success");
      case "warning":
        return translate("settings_inline_completedWithWarnings");
      case "unknown":
        return translate("settings_inline_unresolved");
      case "failed":
        return translate("settings_inline_failed");
      default:
        return status;
    }
  }

  function backupRestoreButtonLabel(): string {
    if (backupRestoreTargetMode === "other-local-profile") {
      return otherLocalProfileMeta
        ? translate("settings_profile_continueIn", { profile: profileName(otherLocalProfileMeta.label) })
        : translate("settings_inline_continueInOtherProfile");
    }
    if (backupRestoring) {
      return backupImportKind === "manga" ? translate("settings_inline_restoringManga") : translate("settings_inline_restoring");
    }
    if (backupImportKind === "novels-lnreader") return translate("ui_lnreaderNovelsRestore");
    return backupImportKind === "manga" ? translate("settings_inline_restoreMangaBackup") : translate("settings_inline_restoreSelectedPayloads");
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
    backupDependencyPreview = null;
    backupDependenciesConfirmed = false;
    backupRestorePage = "main";
    resetLegacyBackupState();
    resetUnifiedBackupState();
  }

  async function loadNovelRuntimeState(): Promise<EpigraphNovelRuntimeState> {
    const storageRuntime = await getStorageRuntime();
    const state = await storageRuntime.loadNovelRepositoryState({
      profileId: currentRuntimeProfileId,
      serverUrl: currentRuntimeServerUrl,
    });

    return novelRestoreRuntimeState(state);
  }

  async function loadEpigraphRestoreRuntime(): Promise<EpigraphRestorePlannerRuntime> {
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
        repositoryUrls: inventory.repoUrls,
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
    return file || `epigraph-backup-${new Date().toISOString().slice(0, 10)}.tachibk`;
  }

  function defaultExportFilename(): string {
    const stamp = new Date().toISOString().slice(0, 10);
    if (backupExportMode === "manga") return `epigraph-manga-${stamp}.tachibk`;
    const parts = [
      backupUnifiedIncludeManga && "manga",
      backupUnifiedIncludeBooks && "books",
      backupUnifiedIncludeNovels && "novels",
      backupUnifiedIncludeApp && "profile",
    ].filter(Boolean);
    return `epigraph-${parts.length === 1 ? parts[0] : "unified"}-${stamp}${SETTINGS_EPIGRAPH_BACKUP_EXTENSION}`;
  }

  async function saveBytesToPath(path: string, bytes: Uint8Array | ArrayBuffer): Promise<string> {
    return invoke<string>("write_file_base64", {
      path,
      bytesBase64: bytesToBase64(bytes),
    });
  }

  async function fetchCurrentMangaBackup(): Promise<{ bytes: Uint8Array; sourceFilename: string }> {
    await getMangaProgressForScope(store.runtimeResolvedLocalProfileId
      ? `profile:${store.runtimeResolvedLocalProfileId}` : `server:${getServerUrl()}`).flushAll();
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

    if (backupExportMode === "unified" && backupUnifiedIncludeBooks) {
      await flushBookLibraryPersistence();
    }

    if (backupExportMode === "manga") {
      const manga = await fetchCurrentMangaBackup();
      const mangaRuntime = await getManagedSourceRuntime();
      const stores = await mangaRuntime.listStores();
      return {
        bytes: storageRuntime.embedMihonExtensionStores(manga.bytes, stores.map((store) => ({
          indexUrl: store.indexUrl,
          name: store.name,
          badgeLabel: store.badgeLabel,
          signingKey: store.signingFingerprint,
          contactWebsite: store.contactWebsite,
        }))),
        defaultPath: defaultExportFilename(),
      };
    }

    const payloads: EpigraphBackupPayloadBuildInput[] = [];
    if (backupUnifiedIncludeManga) {
      const manga = await fetchCurrentMangaBackup();
      const mangaRuntime = await getManagedSourceRuntime();
      const repositoryUrls = (await mangaRuntime.listStores()).map((entry) => entry.indexUrl);
      payloads.push(await storageRuntime.buildEpigraphMangaPayload(manga.bytes, {
        sourceFilename: manga.sourceFilename,
        repositoryUrls,
      }));
    }
    if (backupUnifiedIncludeBooks) {
      const booksLibraryState = await storageRuntime.loadBookLibraryState({ profileId: currentRuntimeProfileId });
      payloads.push(await storageRuntime.buildEpigraphBooksPayload(
        storageRuntime.buildEpigraphBooksSnapshotFromLibraryState(booksLibraryState),
        {
          exportMode: backupBooksOnlyMetadataOnly ? "metadata-only" : "full",
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
        await storageRuntime.buildEpigraphNovelsPayload(
          storageRuntime.buildEpigraphNovelsSnapshotFromAuthoritativeState({
            libraryState: novelLibraryState,
            repositoryState: novelRepositoryState,
          }),
        ),
      );
    }
    if (backupUnifiedIncludeApp) {
      payloads.push(storageRuntime.buildEpigraphAppPayload({
        defaultLocalProfileId: persistedDefaultProfileId,
        history: store.history,
        readLog: store.readLog,
        readingStats: store.readingStats,
      }));
    }

    if (payloads.length === 0) {
      throw new Error("Select at least one payload to export.");
    }

    const built = await storageRuntime.buildEpigraphBackupContainer({
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
        { name: translate("settings_backup_fileTypeEpigraphWithLegacy"), extensions: ["epigraphbk", "aethonbk"] },
        { name: translate("settings_backup_fileTypeManga"), extensions: ["tachibk", "proto", "gz"] },
        { name: translate("settings_backup_fileTypeLnreader"), extensions: ["zip"] },
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
    await loadUnifiedBackupPlanBytes(bytes);
  }

  async function loadUnifiedBackupPlanBytes(bytes: ArrayBuffer) {
    const storageRuntime = await getStorageRuntime();
    const runtime = await loadEpigraphRestoreRuntime();
    const plan = await storageRuntime.buildEpigraphRestorePlan(bytes, runtime);
    backupUnifiedPlan = plan;
    backupUnifiedSelection = defaultExecutionSelection(plan);
    const repositories: Array<{ url: string; name?: string | null }> = [];
    const plugins: Array<{ id: string; name?: string | null; repositoryUrl?: string | null }> = [];
    try {
      const manga = await storageRuntime.parseEpigraphMangaPayload(bytes);
      repositories.push(...(manga.payloadManifest.requiresRepositories ?? []).map((url) => ({ url })));
    } catch {
      // The container may intentionally omit the manga payload.
    }
    try {
      const novels = await storageRuntime.parseEpigraphNovelsPayload(bytes);
      repositories.push(...(novels.snapshot.repositories ?? []));
      plugins.push(...(novels.snapshot.plugins ?? []));
    } catch {
      // The container may intentionally omit the novels payload.
    }
    const titleCount = plan.payloads.reduce((sum, payload) => {
      const count = payload.metadata.mangaCount ?? payload.metadata.bookCount ?? payload.metadata.entryCount;
      return sum + (typeof count === "number" ? count : 0);
    }, 0);
    const chapterCount = plan.payloads.reduce((sum, payload) => {
      const count = payload.metadata.chapterCount;
      return sum + (typeof count === "number" ? count : 0);
    }, 0);
    backupDependencyPreview = buildBackupDependencyPreview({
      titleCount,
      chapterCount,
      repositories,
      plugins,
    });
  }

  function backupPayloadIcon(kind: string) {
    if (kind === "manga") return Image;
    if (kind === "books" || kind === "novels") return Book;
    return Gear;
  }

  // The restore list follows the same order as the create list.
  const BACKUP_PAYLOAD_ORDER = ["manga", "books", "novels", "app"];
  function backupPayloadsInCreateOrder<T extends { kind: string }>(payloads: T[]): T[] {
    const rank = (kind: string) => { const index = BACKUP_PAYLOAD_ORDER.indexOf(kind); return index < 0 ? BACKUP_PAYLOAD_ORDER.length : index; };
    return [...payloads].sort((a, b) => rank(a.kind) - rank(b.kind));
  }

  function backupPayloadCount(payload: EpigraphPayloadRestorePlan): string | null {
    const count = payload.metadata.mangaCount
      ?? payload.metadata.bookCount
      ?? payload.metadata.entryCount;
    return typeof count === "number"
      ? (count === 1 ? translate("settings_backup_titleCountOne") : translate("settings_backup_titleCount", { count }))
      : null;
  }

  function isZipContainer(bytes: ArrayBuffer): boolean {
    const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
    return header.length >= 4
      && header[0] === 0x50
      && header[1] === 0x4b
      && (header[2] === 0x03 || header[2] === 0x05 || header[2] === 0x07)
      && (header[3] === 0x04 || header[3] === 0x06 || header[3] === 0x08);
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
      : backupImportKind === "epigraph"
        ? "current-profile"
        : "current-profile";

    if (!backupImportKind) {
      backupError = operationFailure(null, "settings_inline_chooseBackupFileError");
      return;
    }

    // Android's native protobuf backup now uses the canonical .epigraphbk suffix too.
    // Classify by bytes so a mobile backup is still accepted by the desktop manga restore,
    // while the ZIP container keeps the richer cross-surface restore planner.
    if (!forcedKind && backupImportKind === "epigraph") {
      const storageRuntime = await getStorageRuntime();
      const bytes = await storageRuntime.readFileAsArrayBuffer(path);
      if (!isZipContainer(bytes)) backupImportKind = "manga";
    }

    if (backupImportKind === "epigraph") {
      await loadUnifiedBackupPlan(path);
      backupSelectedFile = await fileFromPath(path);
      return;
    }

    if (backupImportKind === "novels-lnreader") {
      backupValidating = true;
      try {
        const storageRuntime = await getStorageRuntime();
        const bytes = await storageRuntime.readFileAsArrayBuffer(path);
        if (!(await storageRuntime.isLnReaderBackupZip(bytes))) {
          throw new Error("This ZIP is not a supported LNReader backup.");
        }
        const snapshot = await storageRuntime.parseLnReaderNovelsBackup(bytes);
        backupDependencyPreview = buildBackupDependencyPreview({
          titleCount: snapshot.entries.length,
          chapterCount: snapshot.chapters.length,
          repositories: snapshot.repositories ?? [],
          plugins: snapshot.plugins ?? [],
        });
        backupSelectedFile = await fileFromPath(path);
      } finally {
        backupValidating = false;
      }
      return;
    }

    if (backupRestoreTargetMode === "current-profile") {
      await loadLegacyBackupPath(path);
    } else {
      backupSelectedFile = await fileFromPath(path);
    }
  }

  $effect(() => {
    const plan = backupAuditPlan;
    if (!plan) {
      backupAuditPlanKey = null;
      return;
    }
    const key = `${plan.summary.summaryLabel}|${plan.payloads.map((payload) => `${payload.kind}:${payload.status}:${restorePayloadSummary(payload, $_)}`).join("|")}`;
    if (key === backupAuditPlanKey) return;
    backupAuditPlanKey = key;
    backupUnifiedPlan = plan;
    backupUnifiedSelection = defaultExecutionSelection(plan);
    backupImportKind = "epigraph";
    backupViewMode = "restore";
    advStorageOpen = true;
    storageAdvancedSource = "backup";
  });

  $effect(() => {
    const intent = backupRestoreLaunchIntent;
    const key = intent ? `${intent.kind}:${intent.path}:${intent.handoff ? "handoff" : "direct"}` : null;
    if (!intent || !key || key === backupLaunchIntentKey) return;
    backupLaunchIntentKey = key;
    void loadSelectedBackupPath(intent.path, intent.kind, {
      handoff: intent.handoff,
      sourceProfileId: intent.sourceProfileId ?? null,
    }).catch((error) => {
      backupError = operationFailure(error, "firstRun.backup.restoreError");
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
      backupError = operationFailure(error, "settings_inline_prepareMangaRestoreFailed");
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
        backupExtensionLookupError = operationFailure(result.failedRepos, "outcomes.repositoryChecks", { count: result.failedRepos.length });
      }
    } catch (error) {
      backupExtensionLookupError = operationFailure(error, "settings_inline_couldNotInspectExtensionMatches");
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
          ? [{ name: translate("settings_backup_fileTypeManga"), extensions: ["tachibk"] }]
          : [{ name: translate("settings_backup_fileTypeEpigraph"), extensions: ["epigraphbk"] }],
      });
      if (typeof savePath !== "string" || !savePath.trim()) return;
      const normalizedPath = normalizeBackupSavePath(
        savePath,
        backupExportMode === "manga" ? ".tachibk" : SETTINGS_EPIGRAPH_BACKUP_EXTENSION,
      );
      const savedPath = await saveBytesToPath(normalizedPath, built.bytes);
      backupSavedPath = savedPath;
      addToast({
        kind: "success",
        title: translate("ui_backupSaved"),
        body: savedPath,
      });
    } catch (e: any) {
      backupError = operationFailure(e, "firstRun.backup.restoreError");
    } finally {
      backupExporting = false;
    }
  }

  async function onBackupFileSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;
    resetBackupImportState();
    backupImportKind = detectBackupImportKind(file.name);
    backupSelectedFile = file;
    backupSelectedFilePath = null;

    if (!backupImportKind) {
      backupError = operationFailure(null, "settings_inline_chooseBackupFileError");
      return;
    }

    const bytes = await file.arrayBuffer();
    if (backupImportKind === "epigraph") {
      if (isZipContainer(bytes)) {
        await loadUnifiedBackupPlanBytes(bytes);
        return;
      }
      backupImportKind = "manga";
    }

    if (backupImportKind === "novels-lnreader") {
      backupValidating = true;
      try {
        const storageRuntime = await getStorageRuntime();
        if (!(await storageRuntime.isLnReaderBackupZip(bytes))) {
          throw new Error("This ZIP is not a supported LNReader backup.");
        }
        const snapshot = await storageRuntime.parseLnReaderNovelsBackup(bytes);
        backupDependencyPreview = buildBackupDependencyPreview({
          titleCount: snapshot.entries.length,
          chapterCount: snapshot.chapters.length,
          repositories: snapshot.repositories ?? [],
          plugins: snapshot.plugins ?? [],
        });
      } finally {
        backupValidating = false;
      }
      return;
    }

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
      backupDependencyPreview = buildBackupDependencyPreview({
        titleCount: parsed.backupManga.length,
        chapterCount: parsed.backupManga.reduce((sum, manga) => sum + (manga.chapterCount ?? 0), 0),
        mangaStores: parsed.extensionStores,
      });
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
      backupError = operationFailure(e, "firstRun.backup.restoreError");
    } finally {
      backupValidating = false;
    }
  }

  async function refreshBackupReadiness() {
    if (!backupSelectedFile) return;
    backupError = null;
    await analyzeSelectedBackupFile(backupSelectedFile);
  }

  const backupNeedsConfirmPage = $derived(
    backupRestoreTargetMode === "current-profile"
      && (backupCurrentProfileGateRequired || backupDependencyPreview?.requiresConfirmation === true),
  );

  const backupShowsSourcesRow = $derived(
    Boolean(backupSelectedFile) && backupRestoreTargetMode === "current-profile" && (
      backupImportKind === "manga" || backupImportKind === "novels-lnreader"
      || Boolean(backupUnifiedPlan?.payloads.some(payload => payload.kind === "manga" || payload.kind === "novels"))
    ),
  );

  const backupSourcesStatus = $derived.by(() => {
    if (backupValidating) return translate("settings_inline_inspecting");
    if (!backupReadiness) return translate("settings_backup_sourcesReview");
    if (backupReadiness.requiresInstallCount > 0) return translate("settings_backup_sourcesNeedInstall", { count: backupReadiness.requiresInstallCount });
    if (backupReadiness.unresolvedCount > 0) return translate("settings_backup_sourcesUnmatched", { count: backupReadiness.unresolvedCount });
    return translate("settings_backup_sourcesReady");
  });

  async function startSelectedRestore() {
    if (backupNeedsConfirmPage) {
      backupRestorePage = "confirm";
      return;
    }
    await executeSelectedRestore();
  }

  async function confirmSelectedRestore() {
    backupRestoreCurrentProfileConfirmed = true;
    if (backupDependencyPreview?.requiresConfirmation) backupDependenciesConfirmed = true;
    backupRestorePage = "main";
    await tick();
    await executeSelectedRestore();
  }

  async function reviewMangaDependencies() {
    // Compatibility action opens the shared origin review; it cannot install.
    await mangaDependencyPanel?.review();
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

  // The "approve dependencies" consent adds the backup's own Mihon repositories before restoring,
  // through the same target-checked session the per-repository buttons use.
  async function addApprovedMangaRepositories(file: File): Promise<string[]> {
    const session = await createProductionMangaDependencySession(file, backupImportKind === "epigraph" ? "epigraph" : "native");
    const plan = await session.inspect();
    const present = new Set(plan.repositories.map((repository) => extensionStoreKey(repository.indexUrl)));
    const unavailable: string[] = [];
    for (const url of plan.requiredRepositories) {
      if (present.has(extensionStoreKey(url))) continue;
      try {
        await session.addRepository(url);
      } catch (error) {
        if (error instanceof Error && error.message === "RESTORE_TARGET_CHANGED") throw error;
        unavailable.push(url);
      }
    }
    return unavailable;
  }

  async function waitForInstalledRestoreSources(file: File, maxAttempts = 7) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await analyzeSelectedBackupFile(file);
      if (!backupReadiness || backupReadiness.requiresInstallCount === 0) return;
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
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
        ?? translate("settings_backup_chapterFallback");
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

  async function executeSelectedRestore() {
    if (backupRestoring || backupValidating) return;
    backupError = null;
    backupRestoreResults = null;
    backupRestoreStatus = null;

    if (backupResolvedExecutionBlockedReason) {
      backupError = operationFailure(null, backupUnifiedPlan?.executionBlockedReason ? "outcomes.dependencies" : "settings_inline_restoreExecutionProfileHint");
      return;
    }

    backupRestoring = true;
    try {
    if (backupRestoreTargetMode === "other-local-profile") {
      await relaunchRestoreIntoOtherProfile();
      return;
    }

    if (!backupRestoreHandoffSession && !backupRestoreCurrentProfileConfirmed) {
      backupError = operationFailure(null, "settings_inline_confirmAdvancedRestoreFirst");
      return;
    }

    if (backupDependencyConfirmationRequired) {
      backupError = operationFailure(null, "outcomes.approval");
      return;
    }

    if (!backupSelectedFilePath && !backupSelectedFile) throw Error(translate("settings_inline_chooseBackupFileError"));
    const runtime = await getStorageRuntime();
    const file = backupSelectedFilePath
      ? new File([await runtime.readFileAsArrayBuffer(backupSelectedFilePath)], backupPathLabel(backupSelectedFilePath) ?? "backup.epigraphbk")
      : backupSelectedFile!;
    const unavailableRepositories = backupDependenciesConfirmed && (backupImportKind === "manga" || backupUnifiedPlan?.payloads.some(payload => payload.kind === "manga"))
      ? await addApprovedMangaRepositories(file)
      : [];
    const candidate = createProductionRestoreWorkflow({
      selection: backupImportKind === "epigraph" ? backupUnifiedSelection : undefined,
      mangaChoices: backupReviewSelections,
    });
    const entries = await candidate.inspectFiles([file]);
    if (entries.some(entry => entry.status !== "ready")) throw Error(entries[0]?.error ?? "RESTORE_INPUT_INVALID");
    const key = JSON.stringify([entries.map(entry => entry.key), currentRuntimeProfileId, store.runtimeServerUrl, backupUnifiedSelection, backupReviewSelections]);
    const workflow = restoreWorkflows.get(key) ?? candidate;
    restoreWorkflows.set(key, workflow);
    activeRestoreWorkflow = workflow;
    restoreCancellationRequested = workflow.snapshot().cancelled;
    const unsubscribe = workflow.observe(snapshot => {
      const states = Object.values(snapshot.units);
      backupRestoreStatus = { state: "RESTORING", mangaProgress: states.filter(status => status === "succeeded").length, totalManga: states.length };
    });
    try {
      await workflow.restoreFiles(entries);
    } finally {
      unsubscribe();
      const warnings = workflow.warnings();
      backupRestoreResults = Object.entries(workflow.snapshot().units).map(([id, status]) => ({
        kind: id.slice(id.lastIndexOf(":") + 1),
        status: status === "succeeded" ? (warnings[id]?.length ? "warning" : "success") : status === "cancelled" ? "skipped" : "failed",
        outcome: status, warnings: warnings[id] ?? [],
        summary: status === "succeeded" ? (warnings[id]?.join("; ") || translate("outcomes_succeeded"))
          : status === "unknown" ? translate("settings_backup_resultUnresolved")
          : status === "cancelled" ? translate("settings_backup_resultCancelled") : translate("settings_backup_resultFailed"),
      }));
      if (unavailableRepositories.length > 0) {
        backupRestoreResults = [...backupRestoreResults, {
          kind: "repositories", status: "warning", outcome: "unavailable", warnings: unavailableRepositories,
          summary: translate("settings_backup_repositoriesUnavailable", { count: unavailableRepositories.length }),
        }];
      }
    }
    } catch (error) {
      backupError = operationFailure(error, "firstRun.backup.restoreError");
    } finally {
      backupRestoring = false;
      activeRestoreWorkflow = null;
      if (backupRestoreResults || backupError) {
        await tick();
        backupSectionEl?.querySelector("[data-backup-results], .backup-error")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  function setBackupClusterSelection(clusterId: string, choice: NativeSourceRestoreChoice) {
    backupReviewSelections = { ...backupReviewSelections, [clusterId]: choice };
  }

  function isBackupSourceMapped(clusterId: string, sourceId: string): boolean {
    const choice = backupReviewSelections[clusterId];
    return choice?.mode === "map" && choice.sourceId === sourceId;
  }

  function clusterConfidenceLabel(cluster: ReconciliationClusterResult): string {
    const confidence = cluster.selectedCandidate?.confidence ?? cluster.candidates[0]?.confidence ?? 0;
    return `${Math.round(confidence * 100)}%`;
  }

  function clusterReasonLabel(cluster: ReconciliationClusterResult): string {
    return translate(cluster.status === "exact_resolved" ? "outcomes.ready" : "restoreDeps.mangaPreserveHint");
  }

  function clusterReadinessLabel(cluster: ReconciliationClusterResult): string {
    const item = backupReadiness?.items.find((entry) => entry.orphanSourceId === cluster.orphanSourceId);
    switch (item?.status) {
      case "ready_now":
        return translate("settings_inline_readyNow");
      case "requires_install":
        return translate("settings_inline_requiresInstall");
      case "unavailable":
        return translate("settings_inline_unavailable");
      default:
        return translate("settings_inline_needsReviewStatus");
    }
  }

  function clusterReadinessDetail(cluster: ReconciliationClusterResult): string | null {
    const item = backupReadiness?.items.find((entry) => entry.orphanSourceId === cluster.orphanSourceId);
    if (!item) return null;
    const choice = backupReviewSelections[cluster.orphanSourceId];
    return translate(choice?.mode === "skip" ? "outcomes.skipped" : choice?.mode === "preserve" || item.status === "unresolved" ? "restoreDeps.mangaPreserveHint"
      : item.status === "ready_now" ? "outcomes.ready" : item.status === "requires_install" ? "outcomes.dependencies" : "outcomes.preservedSources");
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
    return formatRelativeTime(ts);
  }
  let storageLimitInput = $state(String(store.settings.storageLimitGb ?? ""));
  function applyStorageLimit() {
    const v = storageLimitInput.trim();
    if (v === "" || v === "0") { updateSettings({ storageLimitGb: null }); return; }
    const n = parseFloat(v);
    if (!isNaN(n) && n > 0) updateSettings({ storageLimitGb: n });
  }
  const BOOKS_TYPE_OPTIONS: { id: BooksLibraryTypeFilter; label: string }[] = [
    { id: "all", label: "library_books_types_all" },
    { id: "epub", label: "library_books_types_epub" },
    { id: "pdf", label: "library_books_types_pdf" },
    { id: "sources", label: "library_books_types_sources" },
  ];
  const LIBRARY_START_OPTIONS: { id: Settings["defaultLibrarySection"]; label: string }[] = [
    { id: "last-used", label: "ui_lastUsed" },
    { id: "comics", label: "common_comics" },
    { id: "books", label: "common_books" },
  ];
  const BOOKS_FILTER_LABEL_KEYS: Record<string, string> = {
    all: "library_filter_allBooks",
    unopened: "library_filter_unopened",
    in_progress: "library_filter_inProgress",
    finished: "library_filter_finished",
  };
  let catsLoading:    boolean      = $state(false);
  let catsError: OperationFailure | null  = $state(null);
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
  const booksUpdateExcludedCount = $derived(
    getBooksUpdateExcludedBookIds(
      store.settings.booksCategories,
      store.settings.booksCategoryAssignments,
    ).size,
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
      catsError = operationFailure(e, "outcomes.failed");
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
    } catch (e: any) { catsError = operationFailure(e, "outcomes.failed"); }
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
      } catch (e: any) { catsError = operationFailure(e, "outcomes.failed"); }
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
        title: nextIncludeInUpdate === "EXCLUDE" ? translate("ui_folderExcludedFromUpdates") : translate("ui_folderIncludedInUpdates"),
        body: nextIncludeInUpdate === "EXCLUDE"
          ? translate("settings_categories_comicsSkipped", { name: category.name })
          : translate("settings_categories_comicsChecked", { name: category.name }),
      });
    } catch (e: any) {
      catsError = operationFailure(e, "outcomes.failed");
      await loadCategories();
    }
  }
  function toggleBooksFolderUpdates(category: BooksCategory) {
    const nextCategories = toggleBooksCategoryUpdateRule(store.settings.booksCategories, category.id);
    const nextCategory = nextCategories.find((entry) => entry.id === category.id);
    const excluded = normalizeBooksCategoryUpdateRule(nextCategory?.includeInUpdate) === "EXCLUDE";
    updateSettings({ booksCategories: nextCategories });
    addToast({
      kind: "success",
      title: excluded ? translate("ui_booksFolderExcludedFromUpdates") : translate("ui_booksFolderIncludedInUpdates"),
      body: excluded
        ? translate("settings_categories_booksSkipped", { name: category.name })
        : translate("settings_categories_booksChecked", { name: category.name }),
    });
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
    } catch (e: any) { catsError = operationFailure(e, "outcomes.failed"); }
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
      catsError = operationFailure(e, "outcomes.failed");
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
  const KEYBIND_LABEL_KEYS: Record<keyof Keybinds, string> = {
    pageRight: "settings_keybind_pageRight",
    pageLeft: "settings_keybind_pageLeft",
    firstPage: "settings_keybind_firstPage",
    lastPage: "settings_keybind_lastPage",
    chapterRight: "settings_keybind_chapterRight",
    chapterLeft: "settings_keybind_chapterLeft",
    exitReader: "settings_keybind_exitReader",
    toggleReadingDirection: "settings_keybind_toggleReadingDirection",
    togglePageStyle: "settings_keybind_togglePageStyle",
    toggleFullscreen: "settings_keybind_toggleFullscreen",
    openSettings: "settings_keybind_openSettings",
    toggleBookmark: "settings_keybind_toggleBookmark",
  };
  // Each reader keeps its own options: novels use `proseReader*`, books `bookProseReader*`.
  type ProseReaderKind = keyof typeof PROSE_READER_SETTING_KEYS;
  type ProseSettingName = keyof typeof PROSE_READER_SETTING_KEYS.novel;
  type ProseSettingValue<N extends ProseSettingName> = (typeof store.settings)[(typeof PROSE_READER_SETTING_KEYS.novel)[N]];
  function proseSetting<N extends ProseSettingName>(kind: ProseReaderKind, name: N): ProseSettingValue<N> {
    return store.settings[PROSE_READER_SETTING_KEYS[kind][name]] as ProseSettingValue<N>;
  }
  function updateProseSettings(kind: ProseReaderKind, patch: { [N in ProseSettingName]?: ProseSettingValue<N> }) {
    const keys = PROSE_READER_SETTING_KEYS[kind];
    updateSettings(Object.fromEntries(
      Object.entries(patch).map(([name, value]) => [keys[name as ProseSettingName], value]),
    ) as Partial<typeof store.settings>);
  }
  const PROSE_THEME_LABEL_KEYS: Record<string, string> = {
    nocturne: "ui_nocturne", dark: "ui_dark", sepia: "ui_sepia", light: "ui_light", oled: "ui_oled",
    slate: "settings_reader_themeSlate", forest: "settings_reader_themeForest", nord: "Nord", warm: "settings_reader_themeWarm",
  };
  function proseThemeLabel(theme: string) {
    const key = PROSE_THEME_LABEL_KEYS[theme];
    return key?.includes("_") ? translate(key) : (key ?? theme);
  }
  const PDF_FIT_LABEL_KEYS: Record<string, string> = { width: "ui_width", page: "settings_reader_pdfFitPage", actual: "settings_reader_pdfFitActual" };
  function readerBrightness(kind: ReaderKind) {
    return store.settings[READER_BRIGHTNESS_SETTING_KEY[kind]] ?? 1;
  }
  function stepReaderBrightness(kind: ReaderKind, delta: number) {
    const next = Math.round(Math.min(1, Math.max(0.2, readerBrightness(kind) + delta)) * 100) / 100;
    updateSettings({ [READER_BRIGHTNESS_SETTING_KEY[kind]]: next });
  }
  function stepBookReaderZoom(delta: number) {
    const next = Math.round(Math.min(4, Math.max(0.5, (store.settings.bookReaderZoom ?? 1) + delta)) * 100) / 100;
    updateSettings({ bookReaderZoom: next });
  }
  function appLanguageOptionLabel(code: AppLanguageCode, systemLabel: string) {
    return appLanguageLabel(code, resolveAppLocale(store.settings.appLanguage), systemLabel);
  }
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
  let pinError = $state<OperationFailure | null>(null);
  let secLoading       = $state(false);
  let secError         = $state<OperationFailure | null>(null);
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
  let flareSession     = $state(store.settings.flareSolverrSessionName ?? "epigraph");
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
      secError = operationFailure(null, "settings_inline_usernamePasswordRequired"); return;
    }
    secLoading = true; secError = null;
    updateSettings({ serverAuthEnabled: true, serverAuthUser: authUsername, serverAuthPass: authPassword });
    try {
      await gql(SET_SERVER_AUTH, { authMode: "BASIC_AUTH", authUsername: authUsername.trim(), authPassword: authPassword.trim() });
      showSaved("auth");
    } catch (e: any) {
      updateSettings({ serverAuthEnabled: false });
      secError = operationFailure(e, "settings_inline_enableAuthFailed");
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
      secError = operationFailure(e, "settings_inline_disableAuthFailed");
    } finally { secLoading = false; }
  }
  async function saveSocksProxy() {
    secLoading = true; secError = null;
    try {
      const normalized = normalizeSocksProxyInput({
        enabled: socksEnabled,
        host: socksHost,
        port: socksPort,
        version: socksVersion,
        username: socksUsername,
        password: socksPassword,
      });
      await gql(SET_SOCKS_PROXY, {
        socksProxyEnabled: normalized.enabled, socksProxyHost: normalized.host,
        socksProxyPort: normalized.port, socksProxyVersion: normalized.version,
        socksProxyUsername: normalized.username, socksProxyPassword: normalized.password,
      });
      updateSettings({
        socksProxyEnabled: normalized.enabled, socksProxyHost: normalized.host,
        socksProxyPort: normalized.port, socksProxyVersion: normalized.version,
        socksProxyUsername: normalized.username, socksProxyPassword: normalized.password,
      });
      showSaved("socks");
    } catch (e: any) {
      secError = operationFailure(e, "settings_inline_saveSocksFailed");
    } finally { secLoading = false; }
  }
  async function saveFlareSolverr(): Promise<boolean> {
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
      return true;
    } catch (e: any) {
      secError = operationFailure(e, "settings_inline_saveFlareFailed");
      return false;
    } finally { secLoading = false; }
  }
  function flareStatusLabel(state = flareTestState) {
    if (state === "testing") return translate("settings_inline_testing");
    if (state === "ready") return translate("settings_inline_ready");
    if (state === "not-reachable") return translate("settings_inline_notReachable");
    if (state === "check-url") return translate("settings_inline_checkUrl");
    return "";
  }
  function flareLocalStateLabel() {
    if (flareLocalBusy) return translate("settings_inline_checking");
    if (!flareLocalStatus?.installed) return translate("settings_inline_notInstalled");
    return flareLocalStatus.running ? translate("settings_inline_running") : translate("settings_inline_installed");
  }
  function flareDockerStateLabel() {
    if (flareDockerBusy) return translate("settings_inline_checking");
    if (!flareDockerStatus?.installed) return translate("settings_inline_dockerNotFound");
    if (!flareDockerStatus.daemon) return translate("settings_inline_dockerUnavailable");
    return flareDockerStatus.running ? translate("settings_inline_running") : translate("settings_inline_available");
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
      flareLocalStatus = { installed: false, running: false, path: null, message: translate("settings_inline_notInstalled") };
    } finally {
      flareLocalBusy = false;
    }
  }
  async function startFlareLocal() {
    flareLocalBusy = true;
    try {
      await startLocalFlareSolverrAndEnable({
        timeout: flareTimeout,
        sessionName: flareSession,
        sessionTtl: flareTtl,
        fallback: flareFallback,
      });
      flareUrl = "http://localhost:8191";
      flareEnabled = true;
      flareTestState = "ready";
      await refreshFlareLocalStatus();
    } catch {
      flareTestState = "not-reachable";
      await refreshFlareLocalStatus();
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
        title: translate("ui_folderUnavailable"),
        body: translate("ui_couldNotOpenTheLocalFlaresolverrFolder"),
      });
    }
  }
  async function openFlareLocalLogs() {
    try {
      await invoke("open_flaresolverr_local_logs");
    } catch {
      addToast({
        kind: "error",
        title: translate("ui_logsUnavailable"),
        body: translate("ui_couldNotOpenTheLocalFlaresolverrLogs"),
      });
    }
  }
  async function refreshFlareDockerStatus() {
    flareDockerBusy = true;
    try {
      flareDockerStatus = await invoke<DockerFlareSolverrStatus>("get_flaresolverr_docker_status");
    } catch {
      flareDockerStatus = { installed: false, daemon: false, running: false, version: null, message: translate("settings_inline_dockerNotFound") };
    } finally {
      flareDockerBusy = false;
    }
  }
  async function startFlareDocker() {
    flareDockerBusy = true;
    try {
      await startDockerFlareSolverrAndEnable({
        timeout: flareTimeout,
        sessionName: flareSession,
        sessionTtl: flareTtl,
        fallback: flareFallback,
      });
      flareUrl = "http://localhost:8191";
      flareEnabled = true;
      flareTestState = "ready";
      await refreshFlareDockerStatus();
    } catch {
      flareTestState = "not-reachable";
      await refreshFlareDockerStatus();
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
      updateSettings({ appLockPin: cleaned }); pinError = null;
    } else if (cleaned.length > 0) {
      pinError = operationFailure(null, "settings_inline_pinHint");
    } else {
      updateSettings({ appLockPin: "" }); pinError = null;
    }
  }
  let trackers:        Tracker[]    = $state([]);
  let trackersLoading: boolean      = $state(false);
  let trackersLoadAttempted: boolean = $state(false);
  let trackersError: OperationFailure | null  = $state(null);
  let oauthTrackerId:  number|null  = $state(null);
  let oauthCallbackInput: string    = $state("");
  let oauthSubmitting: boolean      = $state(false);
  let oauthAutoCapturing: boolean   = $state(false);
  let oauthAutoUnlisten: (() => void) | null = null;
  let oauthWindowStateUnlisten: (() => void) | null = null;
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
  let hardcoverError: OperationFailure | null = $state(null);
  let hardcoverAuthOpen = $state(false);
  const activeTrackerDetail = $derived.by(
    () => trackers.find((candidate) => candidate.id === oauthTrackerId || candidate.id === credsTrackerId) ?? null,
  );
  const activeTrackerDetailMode = $derived.by(
    () => (oauthTrackerId !== null ? "oauth" : credsTrackerId !== null ? "credentials" : null),
  );
  async function loadTrackers() {
    trackersLoadAttempted = true;
    trackersLoading = true; trackersError = null;
    try {
      const res = await gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS);
      trackers = res.trackers.nodes;
      cache.set(CACHE_KEYS.TRACKERS, trackers);
    } catch (e: any) {
      trackersError = operationFailure(e, "firstRun.trackers.loadError");
    } finally {
      trackersLoading = false;
    }
  }
  $effect(() => {
    if (tab === "tracking" && !trackersLoadAttempted && !trackersLoading) {
      void loadTrackers();
    }
  });
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
      addToast({ kind: "success", title: translate("ui_hardcoverConnected"), body: hardcoverState.auth.username ?? translate("feedback.novelTrackingReady") });
    } catch (error: any) {
      hardcoverError = operationFailure(error, "settings_inline_couldNotConnectHardcover");
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
    addToast({ kind: "info", title: translate("ui_hardcoverDisconnected") });
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
    const authUrl = (await epigraphMyAnimeListAuthUrl(tracker)) ?? tracker.authUrl;
    trackersError = null;
    hardcoverAuthOpen = false;
    credsTrackerId = null;
    credsUsername = "";
    credsPassword = "";
    oauthTrackerId     = tracker.id;
    oauthCallbackInput = "";
    oauthAutoCapturing = true;
    oauthAutoUnlisten?.();
    // Only the login window opened here may complete it; other webviews can emit this event too.
    const sessionId = crypto.randomUUID();
    oauthAutoUnlisten = await listen<{ url: string; sessionId?: string }>("tracker-oauth-callback", async (event) => {
      if (oauthTrackerId !== tracker.id || event.payload?.sessionId !== sessionId) return;
      oauthCallbackInput = event.payload.url;
      await submitOAuth();
      oauthAutoUnlisten?.();
      oauthAutoUnlisten = null;
      oauthAutoCapturing = false;
    });

    try {
      await invoke("open_tracker_oauth_window", { url: authUrl, sessionId });
    } catch (error) {
      oauthAutoCapturing = false;
      oauthAutoUnlisten?.();
      oauthAutoUnlisten = null;
      await openUrl(authUrl);
      trackersError = operationFailure(null, "firstRun.trackers.automaticUnavailable");
    }
  }
  async function submitOAuth() {
    if (!oauthTrackerId || !oauthCallbackInput.trim()) return;
    oauthSubmitting = true;
    try {
      const tracker = trackers.find((candidate) => candidate.id === oauthTrackerId) ?? null;
      if (isEpigraphMyAnimeListCallback(oauthCallbackInput)) {
        const trackerId = oauthTrackerId;
        const confirmed = await completeEpigraphMyAnimeListLogin(oauthCallbackInput, async () => {
          const res = await gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS);
          return res.trackers.nodes.some((candidate) => candidate.id === trackerId && candidate.isLoggedIn);
        });
        cache.clear(CACHE_KEYS.TRACKERS);
        await loadTrackers();
        if (!confirmed) trackersError = operationFailure(null, "settings_inline_loginFailed");
        oauthTrackerId     = null;
        oauthCallbackInput = "";
        oauthAutoCapturing = false;
        oauthAutoUnlisten?.();
        oauthAutoUnlisten = null;
        return;
      }
      const callbackUrl = normalizeTrackerOAuthInput(tracker, oauthCallbackInput);
      if (!callbackUrl) {
        trackersError = operationFailure(null, "settings_inline_callbackUrlHint");
        return;
      }
      await gql(LOGIN_TRACKER_OAUTH, {
        trackerId:   oauthTrackerId,
        callbackUrl,
      });
      publishTrackerLogin({ id: oauthTrackerId, name: tracker?.name }, callbackUrl);
      await loadTrackers();
      oauthTrackerId     = null;
      oauthCallbackInput = "";
      oauthAutoCapturing = false;
      oauthAutoUnlisten?.();
      oauthAutoUnlisten = null;
    } catch (e: any) {
      trackersError = operationFailure(e, "settings_inline_loginFailed");
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
      trackersError = operationFailure(e, "settings_inline_loginFailed");
    } finally {
      credsSubmitting = false;
    }
  }
  function cancelCredentials() { credsTrackerId = null; credsUsername = ""; credsPassword = ""; }
  async function logoutTracker(trackerId: number) {
    loggingOut = trackerId;
    try {
      await gql(LOGOUT_TRACKER, { trackerId });
      publishTrackerLogout({ id: trackerId, name: trackers.find((candidate) => candidate.id === trackerId)?.name });
      await loadTrackers();
    } catch (e: any) {
      trackersError = operationFailure(e, "firstRun.trackers.disconnectError");
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
  type ReleaseInfo = EpigraphReleaseInfo;
  type UpdatePhase =
    | "idle"
    | "downloading"
    | "ready"      // downloaded, awaiting restart
    | "error";
  const IS_WINDOWS = navigator.userAgent.includes("Windows");
  let appVersion      = $state("...");
  let releases        = $state<ReleaseInfo[]>([]);
  let releasesLoading = $state(false);
  let releasesError   = $state<OperationFailure | null>(null);
  let updateCheck     = $state<EpigraphUpdateStatus | null>(null);
  let updateCheckError = $state<OperationFailure | null>(null);
  let expandedTag     = $state<string | null>(null);
  let updatePhase     = $state<UpdatePhase>("idle");
  let updateError     = $state<OperationFailure | null>(null);
  let dlBytes         = $state(0);
  let dlTotal         = $state<number | null>(null);
  let targetTag       = $state<string | null>(null); // tag being installed
  let releasesLoaded = false; // plain var, not $state, so effect does not re-run on change
  onMount(() => {
    getVersion().then(v => appVersion = v).catch(() => appVersion = "unknown");
    if (firstRunPane === "backup") openStorageRestore();
  });
  $effect(() => {
    if (tab !== "about") return;
    getVersion().then(v => appVersion = v).catch(() => appVersion = "unknown");
    if (!releasesLoaded) { releasesLoaded = true; loadReleases(); }
  });
  function openUpdatesPanel() {
    openTab("about");
    aboutReleasesOpen = true;
    releasesError = null;
    void loadReleases();
  }
  async function openProjectGithub() {
    await openUrl(EPIGRAPH_GITHUB_URL);
  }
  onMount(() => {
    let disposed = false;
    void listen<boolean>("tracker-oauth-window-state", (event) => {
      if (event.payload !== false) return;
      if (oauthAutoCapturing) {
        oauthAutoCapturing = false;
        oauthAutoUnlisten?.();
        oauthAutoUnlisten = null;
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      oauthWindowStateUnlisten = unlisten;
    });

    return () => {
      disposed = true;
      oauthAutoUnlisten?.();
      oauthAutoUnlisten = null;
      oauthWindowStateUnlisten?.();
      oauthWindowStateUnlisten = null;
    };
  });
  async function loadReleases() {
    releasesLoading = true; releasesError = null; updateCheckError = null;
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out after 10s")), 10_000)
      );
      const [historyResult, updateResult] = await Promise.race([
        Promise.allSettled([
          invoke<ReleaseInfo[]>("list_releases"),
          invoke<EpigraphUpdateStatus>("check_epigraph_update"),
        ]),
        timeout,
      ]);
      if (historyResult.status === "fulfilled") {
        releases = sortEpigraphReleaseHistory(historyResult.value);
      } else {
        releasesError = operationFailure(historyResult.reason, "settings_inline_couldNotFetchReleases");
      }
      if (updateResult.status === "fulfilled") {
        updateCheck = updateResult.value;
      } else {
        updateCheck = null;
        updateCheckError = operationFailure(updateResult.reason, "settings_inline_couldNotFetchReleases");
      }
    } catch (e: any) {
      releasesError = operationFailure(e, "settings_inline_couldNotFetchReleases");
      updateCheckError = releasesError;
    } finally {
      releasesLoading = false;
    }
  }
  function stripV(v: string) { return v.replace(/^v/, ""); }
  function isCurrentVersion(tag: string) { return stripV(tag) === appVersion; }
  let onLatestVersion = $derived(updateCheck !== null && !updateCheck.update_available);
  let availableUpdateRelease = $derived(
    releases.find((release) => isAuthorizedEpigraphUpdate(release, updateCheck)) ?? null
  );
  function fmtDate(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  $effect(() => {
    // The listener registers asynchronously; a teardown that wins the race must still release it.
    let disposed = false;
    let unlistenProgress: (() => void) | undefined;
    void listen<{ downloaded: number; total: number | null }>("update-progress", (e) => {
      dlBytes = e.payload.downloaded;
      dlTotal = e.payload.total ?? null;
    }).then((fn) => {
      if (disposed) fn();
      else unlistenProgress = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlistenProgress?.();
    };
  });
  async function installUpdate(release: ReleaseInfo) {
    if (updatePhase === "downloading") return;
    if (IS_WINDOWS && !isAuthorizedEpigraphUpdate(release, updateCheck)) {
      await openUrl(release.html_url);
      return;
    }
    targetTag   = release.tag_name;
    updatePhase = "downloading";
    updateError = null;
    dlBytes     = 0;
    dlTotal     = null;
    try {
      if (IS_WINDOWS) {
        // The native handoff stops the runtime itself, only after the signed download succeeded.
        await invoke("download_and_install_update", { expectedVersion: updateCheck?.version ?? release.tag_name });
        updatePhase = "ready";
      } else {
        await openUrl(release.html_url);
        updatePhase = "idle";
        targetTag   = null;
      }
    } catch (e: any) {
      updateError = operationFailure(e, "settings_inline_updateFailed");
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
    (window as any).__epigraphShowSplash?.();
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
<main class="settings-page n-shell epigraph-port--settings" class:settings-page--first-run={firstRunPane !== null} out:leaveView|global>
  {#if firstRunPane === null}<AppTopbar className="n-topbar--settings">
    {#snippet center()}
      <form
        class="n-search n-search--settings"
        role="search"
        aria-label={$_("settings_inline_searchSettings")}
        onsubmit={submitSettingsSearch}
        onfocusin={handleSettingsSearchFocusIn}
        onfocusout={handleSettingsSearchFocusOut}
      >
        <span class="n-search__icon material-symbols-outlined" aria-hidden="true">search</span>
        <input
          class="n-search__input"
          role="combobox"
          aria-expanded={store.searchOpen}
          aria-controls="epigraph-search-results"
          aria-activedescendant={store.searchOpen ? store.searchActiveResultId ?? undefined : undefined}
          aria-autocomplete="list"
          aria-label={$_("settings_inline_searchSettings")}
          placeholder={$_("settings_inline_searchSettingsPlaceholder")}
          bind:this={settingsSearchInputEl}
          value={settingsSearchQuery}
          autocomplete="off"
          spellcheck="false"
          onclick={handleSettingsSearchFocusIn}
          oninput={(event) => {
            settingsSearchQuery = (event.currentTarget as HTMLInputElement).value;
            setSearchQuery(settingsSearchQuery);
            handleSettingsSearchInput();
            if (settingsSearchQuery.trim()) openSearchPalette("settings", settingsSearchQuery);
          }}
          onkeydown={handleSettingsSearchKeydown}
        />
      </form>
      <span class="settings-search-live" aria-live="polite">{settingsSearchAnnouncement}</span>
    {/snippet}
    {#snippet right()}
      <ActivityButton />
      <button class="n-icon-btn" aria-label={$_("settings_inline_openAboutSettings")} type="button" onclick={() => openTab("about")}>
        <Info size={16} weight="light" />
      </button>
      <WindowControlsInline />
    {/snippet}
  </AppTopbar>{/if}
  {#if firstRunPane === null}<aside class="settings-group-rail" id="settingsGroupRail">
    <nav class="settings-group-rail__nav" aria-label={$_("settings.nav.groupsAria")}>
      {#each SETTINGS_GROUPS as group}
        <button
          class="cat-btn"
          class:is-active={activeGroup === group.id}
          type="button"
          data-settings-group={group.id}
          onclick={() => openGroup(group.id)}
        >
          <span class="cat-btn__icon"><group.icon size={16} weight="light" /></span>
          <span class="cat-btn__label">{$_(group.labelKey)}</span>
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
            <p class="settings-brand-card__title">Epigraph Nocturne</p>
            <p class="settings-brand-card__meta">v{appVersion}</p>
          </div>
        </div>
        <div class="settings-brand-card__actions">
          <button class="settings-rail-action" type="button" onclick={openUpdatesPanel}>{$_("settings.brand.updates")}</button>
          <button class="settings-rail-action" type="button" onclick={openProjectGithub}>GitHub</button>
        </div>
      </div>
    </div>
  </aside>{/if}

  <div class="settings-workbench" class:settings-workbench--first-run={firstRunPane !== null}>
    {#if firstRunPane === null}<aside class="settings-subnav" aria-label={$_("settings.nav.sectionsAria", { group: currentGroupLabel })}>
      <p class="settings-subnav__eyebrow">{currentGroupLabel}</p>
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
            <span class="settings-subnav-btn__label">{$_(t.labelKey)}</span>
          </button>
        {/each}
      </div>
    </aside>{/if}

    <section class="settings-pane-shell">
      {#if firstRunPane === null}<header class="settings-pane-header" use:enterOnChange={tab}>
        <div>
          <p class="settings-pane-header__eyebrow" id="settingsPaneGroupLabel">{currentGroupLabel}</p>
          <h2 class="settings-pane-header__title" id="settingsPaneTitle">{currentTabMeta.label}</h2>
          <p class="settings-pane-header__desc" id="settingsPaneDesc">{currentTabMeta.desc}</p>
        </div>
      </header>{/if}

      <div class="settings-pane-body content-body" bind:this={contentBodyEl} onscroll={rememberPaneScroll} use:enterOnChange={tab}>
        <section
          class="settings-pane"
          class:is-active={tab === "general"}
          data-settings-pane="general"
          hidden={tab !== "general"}
          aria-hidden={tab !== "general"}
        >
          <div class="settings-grid">
            <div class="settings-card">
              <p class="settings-card__title">{$_("settings.general.startup.title")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.launchLibrary")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.launchLibraryHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.launchIntoLibrary}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.launchIntoLibrary}
                    aria-label={$_("settings.general.startup.launchLibrary")}
                    onclick={() => updateSettings({ launchIntoLibrary: !store.settings.launchIntoLibrary })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.autoStartServer")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.autoStartServerHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.autoStartServer}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.autoStartServer}
                    aria-label={$_("settings.general.startup.autoStartServer")}
                    onclick={() => updateSettings({ autoStartServer: !store.settings.autoStartServer })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.serverStandby")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.serverStandbyHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.localServerStandbyEnabled}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.localServerStandbyEnabled}
                    aria-label={$_("settings.general.startup.serverStandby")}
                    onclick={() => updateSettings({ localServerStandbyEnabled: !store.settings.localServerStandbyEnabled })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.standbyAfter")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.standbyAfterHint")}</p>
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
                    <p class="settings-mini-row__label">{$_("settings.general.startup.idleTimeout")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.idleTimeoutHint")}</p>
                  </div>
                  <div class="select-wrap" id="general-idle-timeout">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("general-idle-timeout")}>
                      <span>{idleTimeoutLabel(store.settings.idleTimeoutMin)}</span>
                      <svg class="select-caret" class:open={selectOpen === "general-idle-timeout"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "general-idle-timeout"}
                      <div class="select-menu">
                        {#each [0, 1, 2, 5, 10, 15, 30] as value}
                          <button
                            class="select-option"
                            class:active={Number(store.settings.idleTimeoutMin ?? 5) === value}
                            type="button"
                            onclick={() => {
                              updateSettings({ idleTimeoutMin: value });
                              selectOpen = null;
                            }}
                          >
                            {idleTimeoutLabel(value)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.redoSetup")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.redoSetupHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={redoFirstRun}>
                    {$_("settings.general.startup.redoSetupAction")}
                  </button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.discord")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.discordHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.discordRpc}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.discordRpc}
                    aria-label={$_("settings.general.startup.discord")}
                    onclick={() => updateSettings({ discordRpc: !store.settings.discordRpc })}
                  ></button>
                </div>
                <div class="settings-subgroup" class:is-disabled={!store.settings.discordRpc} aria-label={$_("settings.general.startup.discord")} role="group">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.discordPrivateMode")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.discordPrivateModeHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.discordRpcPrivateMode}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.discordRpcPrivateMode}
                    aria-label={$_("settings.general.startup.discordPrivateMode")}
                    disabled={!store.settings.discordRpc}
                    onclick={() => updateSettings({ discordRpcPrivateMode: !store.settings.discordRpcPrivateMode })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.discordShowTitle")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.discordShowTitleHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.discordRpcShowTitle}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.discordRpcShowTitle}
                    aria-label={$_("settings.general.startup.discordShowTitle")}
                    disabled={!store.settings.discordRpc}
                    onclick={() => updateSettings({ discordRpcShowTitle: !store.settings.discordRpcShowTitle })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.discordShowCover")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.discordShowCoverHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.discordRpcShowCover}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.discordRpcShowCover}
                    aria-label={$_("settings.general.startup.discordShowCover")}
                    disabled={!store.settings.discordRpc}
                    onclick={() => updateSettings({ discordRpcShowCover: !store.settings.discordRpcShowCover })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.discordImproveCovers")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.discordImproveCoversHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.discordRpcImproveCovers}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.discordRpcImproveCovers}
                    aria-label={$_("settings.general.startup.discordImproveCovers")}
                    disabled={!store.settings.discordRpc}
                    onclick={() => updateSettings({ discordRpcImproveCovers: !store.settings.discordRpcImproveCovers })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.startup.discordShowProgress")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.startup.discordShowProgressHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.discordRpcShowProgress}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.discordRpcShowProgress}
                    aria-label={$_("settings.general.startup.discordShowProgress")}
                    disabled={!store.settings.discordRpc}
                    onclick={() => updateSettings({ discordRpcShowProgress: !store.settings.discordRpcShowProgress })}
                  ></button>
                </div>
                </div>
              </div>
            </div>
            <div class="settings-card">
              <p class="settings-card__title">{$_("settings.general.profiles.title")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.profiles.active")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.profiles.activeHint")}</p>
                  </div>
                  <div class="settings-input-line">
                    <div class="select-wrap" id="general-profile">
                      <button class="select-btn" type="button" onclick={() => toggleSelect("general-profile")}>
                        <span>{nextLaunchProfileSummary}</span>
                        <svg class="select-caret" class:open={selectOpen === "general-profile"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                      </button>
                      {#if selectOpen === "general-profile"}
                        <div class="select-menu">
                          {#each profileOptions as profile}
                            <button
                              class="select-option"
                              class:active={persistedDefaultProfileId === profile.id}
                              type="button"
                              onclick={() => {
                                setDefaultLocalProfile(profile.id);
                                selectOpen = null;
                              }}
                            >
                              {profileName(profile.label)} :{profile.port}
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <button
                      class="n-btn n-btn--sm n-btn-ghost n-btn-danger"
                      type="button"
                      disabled={profileDataDeleteBusy === persistedDefaultProfileId}
                      title={$_("settings.general.profiles.resetTitle")}
                      onclick={() => resetLocalProfileDataFromSettings(persistedDefaultProfileId)}
                    >
                      {profileDataDeleteBusy === persistedDefaultProfileId
                        ? $_("common.resetting")
                        : profileDataDeleteConfirmId === persistedDefaultProfileId
                          ? $_("common.confirmReset")
                          : $_("common.resetData")}
                    </button>
                  </div>
                </div>
                                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.appLanguage.label")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.appLanguage.hint")}</p>
                  </div>
                  <div class="select-wrap" id="general-app-language">
                    <button class="select-btn select-btn--wide" type="button" onclick={() => toggleSelect("general-app-language")}>
                      <span>{appLanguageOptionLabel(store.settings.appLanguage, $_("settings.general.appLanguage.system"))}</span>
                      <svg class="select-caret" class:open={selectOpen === "general-app-language"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "general-app-language"}
                      <div class="select-menu select-menu--scroll">
                        {#each APP_LANGUAGE_OPTIONS as option}
                          <button
                            class="select-option"
                            class:active={(store.settings.appLanguage ?? "system") === option.code}
                            type="button"
                            onclick={() => {
                              updateSettings({ appLanguage: option.code });
                              selectOpen = null;
                            }}
                          >
                            {appLanguageOptionLabel(option.code, $_("settings.general.appLanguage.system"))}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                {#if normalizeCustomLocalProfiles(store.settings.customLocalProfiles).length > 0}
                  <div class="settings-card__stack settings-profile-list" data-testid="custom-profile-list">
                    {#each normalizeCustomLocalProfiles(store.settings.customLocalProfiles) as profile}
                      {@const meta = getLocalProfileMeta(profile.id, store.settings.customLocalProfiles)}
                      {#if meta}
                        <div class="settings-row settings-mini-row">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">{meta.label}</p>
                            <p class="settings-mini-row__hint">{meta.serverUrl}</p>
                          </div>
                          <div class="settings-input-line">
                            <button
                              class="n-btn n-btn--sm n-btn-ghost"
                              type="button"
                              disabled={currentRuntimeProfileId === meta.id || profileDataDeleteBusy === meta.id}
                              title={currentRuntimeProfileId === meta.id ? $_("settings.general.profiles.deleteActiveTitle") : $_("settings.general.profiles.deleteTitle")}
                              onclick={() => deleteLocalProfileFromSettings(meta.id)}
                            >
                              {$_("common.delete")}
                            </button>
                            <button
                              class="n-btn n-btn--sm n-btn-ghost n-btn-danger"
                              type="button"
                              disabled={profileDataDeleteBusy === meta.id}
                              title={$_("settings.general.profiles.resetDiskTitle")}
                              onclick={() => resetLocalProfileDataFromSettings(meta.id)}
                            >
                              {profileDataDeleteBusy === meta.id
                                ? $_("common.resetting")
                                : profileDataDeleteConfirmId === meta.id
                                  ? $_("common.confirmReset")
                                  : $_("common.resetData")}
                            </button>
                          </div>
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}

                <div class="settings-row settings-mini-row settings-row--stacked" data-testid="create-local-profile">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.general.profiles.create")}</p>
                    <p class="settings-mini-row__hint">{$_("settings.general.profiles.createHint")}</p>
                  </div>
                  <div class="settings-input-line">
                    <input
                      class="settings-text-input settings-input-line__grow"
                      bind:value={profileCreateLabel}
                      placeholder={$_("settings.general.profiles.namePlaceholder")}
                      spellcheck="false"
                      onkeydown={(event) => event.key === "Enter" && createLocalProfileFromSettings()}
                    />
                    <input
                      class="settings-text-input settings-text-input--short"
                      bind:value={profileCreatePort}
                      inputmode="numeric"
                      placeholder="4867"
                      oninput={(event) => (profileCreatePort = event.currentTarget.value.replace(/\D/g, "").slice(0, 5))}
                      onkeydown={(event) => event.key === "Enter" && createLocalProfileFromSettings()}
                    />
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={createLocalProfileFromSettings} disabled={!profileCreatePort.trim()}>
                      {$_("common.create")}
                    </button>
                  </div>
                  {#if profileCreateError}
                    <p class="settings-mini-row__hint settings-error-text">{presentOperationFailure(profileCreateError, $_)}</p>
                  {/if}
                </div>

              </div>
            </div>
            <div class="settings-card settings-card--wide settings-desktop-defaults">
              <p class="settings-card__title">{$_("settings.general.desktop.title")}</p>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings.general.desktop.serverUrl")}</p>
                      <p class="settings-mini-row__hint">
                        {serverUrlManagedByProfile
                          ? $_("settings.general.desktop.serverManagedHint")
                          : $_("settings.general.desktop.serverBaseHint")}
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
                      <p class="settings-mini-row__label">{$_("settings.general.desktop.sourceLanguage")}</p>
                      <p class="settings-mini-row__hint">{$_("settings.general.desktop.sourceLanguageHint")}</p>
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
                    <span class="settings-meta-card__label">{$_("settings.general.desktop.currentSession")}</span>
                    <span class="settings-meta-card__value">{currentSessionProfileSummary}</span>
                    <span class="settings-meta-card__hint">{currentRuntimeServerUrl}</span>
                  </div>
                  <div class="settings-meta-card">
                    <span class="settings-meta-card__label">{$_("settings.general.desktop.nextLaunch")}</span>
                    <span class="settings-meta-card__value">{nextLaunchProfileSummary}</span>
                    <span class="settings-meta-card__hint">{nextLaunchProfileMeta?.serverUrl ?? currentRuntimeServerUrl}</span>
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
              <p class="settings-card__title">{$_("settings_inline_theme")}</p>
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
                    <p class="settings-mini-row__label">{$_("settings_inline_themePreset")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_themePresetHint")}</p>
                  </div>
                  <div class="select-wrap" id="appearance-theme">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("appearance-theme")}>
                      <span>{themeLabel(store.settings.theme)}</span>
                      <svg class="select-caret" class:open={selectOpen === "appearance-theme"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "appearance-theme"}
                      <div class="select-menu">
                        {#each BUILTIN_THEMES as theme}
                          <button
                            class="select-option"
                            class:active={(store.settings.theme ?? "nocturne") === theme.id}
                            type="button"
                            onclick={() => {
                              updateSettings({ theme: theme.id });
                              selectOpen = null;
                            }}
                          >
                            {builtinThemeLabel(theme, $_)}
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
                    <p class="settings-mini-row__label">{$_("settings_inline_customThemeEditor")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_customThemeEditorHint")}</p>
                  </div>
                  <div class="settings-section-actions settings-inline-actions">
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" title={$_("settings_inline_createCustomTheme")} onclick={() => onOpenThemeEditor?.(null)}>
                      {$_("settings_inline_newTheme")}
                    </button>
                    {#if (store.settings.customThemes ?? []).some((theme) => theme.id === store.settings.theme)}
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" title={$_("settings_inline_editCurrentTheme")} onclick={() => onOpenThemeEditor?.(store.settings.theme)}>
                        {$_("settings_inline_editCurrent")}
                      </button>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_oledDarkMode")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_oledDarkModeHint")}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={store.settings.theme === "amoled"}
                    aria-label={$_("settings_inline_oledDarkMode")}
                    class="settings-toggle"
                    class:is-on={store.settings.theme === "amoled"}
                    type="button"
                    onclick={toggleAmoledTheme}
                  ></button>
                </div>
              </div>
            </div>
            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_windowChrome")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_compactSidebar")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_compactSidebarHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.compactSidebar} aria-label={$_("settings_inline_compactSidebar")} class="settings-toggle" class:is-on={store.settings.compactSidebar} type="button" onclick={() => updateSettings({ compactSidebar: !store.settings.compactSidebar })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_animations")}</p>
                    <p class="settings-mini-row__hint">
                      {$_("settings_inline_animationsHint")}
                      {#if typeof store.settings.uiAnimations !== "boolean"}
                        {" "}{$_("settings_inline_animationsSystem")}.
                      {/if}
                    </p>
                  </div>
                  <button role="switch" aria-checked={animationsOn} aria-label={$_("settings_inline_animations")} class="settings-toggle" class:is-on={animationsOn} type="button" onclick={() => updateSettings({ uiAnimations: !animationsOn })}></button>
                </div>
              </div>
            </div>
            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_uiDensity")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_interfaceScale")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_interfaceScaleHint")}</p>
                  </div>
                  <div class="n-inline-segmented">
                    <button class="n-inline-segment" class:is-selected={uiDensityMode(store.settings.uiZoom) === "compact"} type="button" onclick={() => applyUiDensity("compact")}>{$_("settings_inline_compact")}</button>
                    <button class="n-inline-segment" class:is-selected={uiDensityMode(store.settings.uiZoom) === "default"} type="button" onclick={() => applyUiDensity("default")}>{$_("settings_inline_default")}</button>
                    <button class="n-inline-segment" class:is-selected={uiDensityMode(store.settings.uiZoom) === "comfort"} type="button" onclick={() => applyUiDensity("comfort")}>{$_("settings_inline_comfort")}</button>
                  </div>
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
            <h3 class="settings-reader-group">{$_("settings_reader_groupManga")}</h3>
            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_layout")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_pageStyle")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_pageStyleHint")}</p>
                  </div>
                  <div class="n-inline-segmented">
                    <button class="n-inline-segment" class:is-selected={store.settings.pageStyle === "single"} type="button" onclick={() => updateSettings({ pageStyle: "single" })}>{$_("settings_inline_single")}</button>
                    <button class="n-inline-segment" class:is-selected={store.settings.pageStyle === "double"} type="button" onclick={() => updateSettings({ pageStyle: "double" })}>{$_("settings_inline_double")}</button>
                    <button class="n-inline-segment" class:is-selected={store.settings.pageStyle === "longstrip"} type="button" onclick={() => updateSettings({ pageStyle: "longstrip" })}>{$_("settings_inline_longstrip")}</button>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_readingDirection")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_readingDirectionHint")}</p>
                  </div>
                  <div class="n-inline-segmented">
                    <button class="n-inline-segment" class:is-selected={store.settings.readingDirection === "ltr"} type="button" onclick={() => updateSettings({ readingDirection: "ltr" })} title={$_("settings_reader_leftToRight")}>{$_("settings_reader_ltrShort")}</button>
                    <button class="n-inline-segment" class:is-selected={store.settings.readingDirection === "rtl"} type="button" onclick={() => updateSettings({ readingDirection: "rtl" })} title={$_("settings_reader_rightToLeft")}>{$_("settings_reader_rtlShort")}</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_behavior")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_pageGap")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_pageGapHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.pageGap} aria-label={$_("settings_inline_pageGap")} class="settings-toggle" class:is-on={store.settings.pageGap} type="button" onclick={() => updateSettings({ pageGap: !store.settings.pageGap })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_overlayBars")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_overlayBarsHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.overlayBars ?? false} aria-label={$_("settings_inline_overlayBars")} class="settings-toggle" class:is-on={store.settings.overlayBars ?? false} type="button" onclick={() => updateSettings({ overlayBars: !(store.settings.overlayBars ?? false) })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_autoNextChapter")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_autoNextChapterHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.autoNextChapter ?? false} aria-label={$_("settings_inline_autoNextChapter")} class="settings-toggle" class:is-on={store.settings.autoNextChapter ?? false} type="button" onclick={() => updateSettings({ autoNextChapter: !(store.settings.autoNextChapter ?? false) })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_markReadOnNext")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_markReadOnNextHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.markReadOnNext ?? true} aria-label={$_("settings_inline_markReadOnNext")} class="settings-toggle" class:is-on={store.settings.markReadOnNext ?? true} type="button" disabled={store.settings.autoNextChapter ?? false} onclick={() => updateSettings({ markReadOnNext: !(store.settings.markReadOnNext ?? true) })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_autoBookmark")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_autoBookmarkHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.autoBookmark ?? true} aria-label={$_("settings_inline_autoBookmark")} class="settings-toggle" class:is-on={store.settings.autoBookmark ?? true} type="button" onclick={() => updateSettings({ autoBookmark: !(store.settings.autoBookmark ?? true) })}></button>
                </div>
              </div>
            </div>

            <div class="settings-card settings-card--wide">
              <p class="settings-card__title">{$_("ui_fitZoom")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_defaultFitMode")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_defaultFitModeHint")}</p>
                  </div>
                  <div class="select-wrap" id="fit-mode">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("fit-mode")}>
                      <span>{fitModeLabel(store.settings.fitMode)}</span>
                      <svg class="select-caret" class:open={selectOpen === "fit-mode"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "fit-mode"}
                      <div class="select-menu">
                        {#each [["width","ui_fitWidth"],["height","ui_fitHeight"],["screen","ui_fitScreen"],["original","ui_original11"]] as [v, l]}
                          <button class="select-option" class:active={(store.settings.fitMode ?? "width") === v} onclick={() => { updateSettings({ fitMode: v as FitMode }); selectOpen = null; }}>{$_(l)}</button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row settings-mini-row--stretch">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_defaultZoom")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_defaultZoomHint")}</p>
                  </div>
                  <div class="settings-zoom-controls">
                    <div class="scale-row">
                      <input type="range" min={10} max={100} step={5}
                        value={Math.round((store.settings.readerZoom ?? 1) * 100)}
                        oninput={(e) => updateSettings({ readerZoom: Number(e.currentTarget.value) / 100 })}
                        class="scale-slider" />
                      <input
                        type="number" min={10} max={100} step={5}
                        class="scale-val-input"
                        value={Math.round((store.settings.readerZoom ?? 1) * 100)}
                        oninput={(e) => {
                          const n = parseInt(e.currentTarget.value, 10);
                          if (!isNaN(n) && n >= 10 && n <= 100) updateSettings({ readerZoom: n / 100 });
                        }}
                        onblur={(e) => {
                          const n = parseInt(e.currentTarget.value, 10);
                          if (isNaN(n) || n < 10) { updateSettings({ readerZoom: 0.1 }); e.currentTarget.value = "10"; }
                          else if (n > 100) { updateSettings({ readerZoom: 1.0 }); e.currentTarget.value = "100"; }
                        }}
                      />
                      <span class="scale-pct">%</span>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => updateSettings({ readerZoom: 1.0 })} disabled={(store.settings.readerZoom ?? 1) === 1} title={$_("settings_inline_resetTo100")}>100%</button>
                    </div>
                    <div class="settings-chip-list settings-chip-list--presets">
                      {#each [25, 50, 75, 100] as v}
                        <button class="settings-chip" class:is-active={Math.round((store.settings.readerZoom ?? 1) * 100) === v} type="button" onclick={() => updateSettings({ readerZoom: v / 100 })}>{v}%</button>
                      {/each}
                    </div>
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_optimizeContrast")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_optimizeContrastHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.optimizeContrast} aria-label={$_("settings_inline_optimizeContrast")} class="settings-toggle" class:is-on={store.settings.optimizeContrast} type="button" onclick={() => updateSettings({ optimizeContrast: !store.settings.optimizeContrast })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_pagesToPreload")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_pagesToPreloadHint")}</p>
                  </div>
                  <div class="step-controls">
                    <button class="step-btn" type="button" onclick={() => updateSettings({ preloadPages: Math.max(0, store.settings.preloadPages - 1) })} disabled={store.settings.preloadPages <= 0}>-</button>
                    <span class="step-val">{store.settings.preloadPages}</span>
                    <button class="step-btn" type="button" onclick={() => updateSettings({ preloadPages: Math.min(10, store.settings.preloadPages + 1) })} disabled={store.settings.preloadPages >= 10}>+</button>
                  </div>
                </div>
                {@render readerBrightnessRow("manga")}
              </div>
            </div>

            {#snippet readerBrightnessRow(kind: ReaderKind)}
              <div class="settings-row settings-mini-row">
                <div class="settings-mini-row__body">
                  <p class="settings-mini-row__label">{$_("ui_brightness")}</p>
                  <p class="settings-mini-row__hint">{$_("settings_reader_brightnessHint")}</p>
                </div>
                <div class="step-controls">
                  <button class="step-btn" type="button" aria-label={$_("ui_decreaseBrightness")} onclick={() => stepReaderBrightness(kind, -0.05)} disabled={readerBrightness(kind) <= 0.2}>-</button>
                  <span class="step-val">{Math.round(readerBrightness(kind) * 100)}%</span>
                  <button class="step-btn" type="button" aria-label={$_("ui_increaseBrightness")} onclick={() => stepReaderBrightness(kind, 0.05)} disabled={readerBrightness(kind) >= 1}>+</button>
                </div>
              </div>
            {/snippet}

            {#snippet proseDefaultsCard(kind: ProseReaderKind)}
              <div class="settings-card settings-card--wide" data-reader-settings={kind}>
                <p class="settings-card__title">{$_(kind === "novel" ? "settings_reader_novelTypography" : "settings_reader_bookTypography")}</p>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_defaultFontFamily")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_defaultFontFamilyHint")}</p>
                    </div>
                    <div class="select-wrap" id={`prose-font-${kind}`}>
                      <button class="select-btn" type="button" onclick={() => toggleSelect(`prose-font-${kind}`)}>
                        <span>{proseSetting(kind, "fontFamily") ? (proseSetting(kind, "fontFamily").split(",")[0].replace(/"/g, "")) : "Georgia"}</span>
                        <svg class="select-caret" class:open={selectOpen === `prose-font-${kind}`} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                      </button>
                      {#if selectOpen === `prose-font-${kind}`}
                        <div class="select-menu">
                          {#each [["Georgia, serif", "Georgia"], ["Merriweather, Georgia, serif", "Merriweather"], ["'EB Garamond', serif", "EB Garamond"], ["Lora, serif", "Lora"], ["Literata, serif", "Literata"], ["Inter, sans-serif", "Inter"], ["Atkinson Hyperlegible, Inter, sans-serif", "Atkinson"], ['"Segoe UI", sans-serif', "Segoe UI"]] as [v, l]}
                            <button class="select-option" class:active={(proseSetting(kind, "fontFamily") ?? "Georgia, serif") === v} onclick={() => { updateProseSettings(kind, { fontFamily: v }); selectOpen = null; }}>{l}</button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_defaultFontSize")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_defaultFontSizeHint")}</p>
                    </div>
                    <div class="step-controls">
                      <button class="step-btn" type="button" onclick={() => updateProseSettings(kind, { fontSize: Math.max(12, (proseSetting(kind, "fontSize") ?? 18) - 1) })} disabled={(proseSetting(kind, "fontSize") ?? 18) <= 12}>-</button>
                      <span class="step-val">{proseSetting(kind, "fontSize") ?? 18}px</span>
                      <button class="step-btn" type="button" onclick={() => updateProseSettings(kind, { fontSize: Math.min(32, (proseSetting(kind, "fontSize") ?? 18) + 1) })} disabled={(proseSetting(kind, "fontSize") ?? 18) >= 32}>+</button>
                    </div>
                  </div>
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_defaultLineHeight")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_defaultLineHeightHint")}</p>
                    </div>
                    <div class="step-controls">
                      <button class="step-btn" type="button" onclick={() => updateProseSettings(kind, { lineHeight: Math.round(Math.max(1.2, (proseSetting(kind, "lineHeight") ?? 1.75) - 0.05) * 100) / 100 })} disabled={(proseSetting(kind, "lineHeight") ?? 1.75) <= 1.2}>-</button>
                      <span class="step-val">{(proseSetting(kind, "lineHeight") ?? 1.75).toFixed(2)}</span>
                      <button class="step-btn" type="button" onclick={() => updateProseSettings(kind, { lineHeight: Math.round(Math.min(2.4, (proseSetting(kind, "lineHeight") ?? 1.75) + 0.05) * 100) / 100 })} disabled={(proseSetting(kind, "lineHeight") ?? 1.75) >= 2.4}>+</button>
                    </div>
                  </div>
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_defaultColumnWidth")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_defaultColumnWidthHint")}</p>
                    </div>
                    <div class="step-controls">
                      <button class="step-btn" type="button" onclick={() => updateProseSettings(kind, { contentWidth: Math.max(520, (proseSetting(kind, "contentWidth") ?? 760) - 40) })} disabled={(proseSetting(kind, "contentWidth") ?? 760) <= 520}>-</button>
                      <span class="step-val">{proseSetting(kind, "contentWidth") ?? 760}px</span>
                      <button class="step-btn" type="button" onclick={() => updateProseSettings(kind, { contentWidth: Math.min(1600, (proseSetting(kind, "contentWidth") ?? 760) + 40) })} disabled={(proseSetting(kind, "contentWidth") ?? 760) >= 1600}>+</button>
                    </div>
                  </div>
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_textAlignment")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_textAlignmentHint")}</p>
                    </div>
                    <div class="n-inline-segmented">
                      <button class="n-inline-segment" class:is-selected={(proseSetting(kind, "textAlign") ?? "left") === "left"} type="button" onclick={() => updateProseSettings(kind, { textAlign: "left" })}>{$_("settings_inline_left")}</button>
                      <button class="n-inline-segment" class:is-selected={(proseSetting(kind, "textAlign") ?? "left") === "justify"} type="button" onclick={() => updateProseSettings(kind, { textAlign: "justify" })}>{$_("settings_inline_justify")}</button>
                    </div>
                  </div>
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_proseReaderTheme")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_proseReaderThemeHint")}</p>
                    </div>
                    <div class="select-wrap" id={`prose-theme-${kind}`}>
                      <button class="select-btn" type="button" onclick={() => toggleSelect(`prose-theme-${kind}`)}>
                        <span>{proseThemeLabel(proseSetting(kind, "theme") ?? "nocturne")}</span>
                        <svg class="select-caret" class:open={selectOpen === `prose-theme-${kind}`} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                      </button>
                      {#if selectOpen === `prose-theme-${kind}`}
                        <div class="select-menu">
                          {#each [["nocturne","ui_nocturne"], ["dark","ui_dark"], ["sepia","ui_sepia"], ["light","ui_light"], ["oled","ui_oled"], ["slate","settings_reader_themeSlate"], ["forest","settings_reader_themeForest"], ["nord","Nord"], ["warm","settings_reader_themeWarm"]] as [v, l]}
                            <button class="select-option" class:active={(proseSetting(kind, "theme") ?? "nocturne") === v} onclick={() => { updateProseSettings(kind, { theme: v as any }); selectOpen = null; }}>{l.includes("_") ? $_(l) : l}</button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_customPaletteColors")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_customPaletteColorsHint")}</p>
                    </div>
                    <div class="prose-color-pickers">
                      <input
                        type="color"
                        value={proseSetting(kind, "textColor") || DEFAULT_PROSE_READER_TEXT_COLOR}
                        onchange={(e) => updateProseSettings(kind, { theme: "nocturne", textColor: e.currentTarget.value })}
                        class="prose-color-picker"
                        title={$_("settings_inline_customTextColor")}
                      />
                      <input
                        type="color"
                        value={proseSetting(kind, "backgroundColor") || DEFAULT_PROSE_READER_BACKGROUND_COLOR}
                        onchange={(e) => updateProseSettings(kind, { theme: "nocturne", backgroundColor: e.currentTarget.value })}
                        class="prose-color-picker"
                        title={$_("settings_inline_customPaperColor")}
                      />
                    </div>
                  </div>
                  {#if kind === "book"}
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_bookReaderFlow")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_bookReaderFlowHint")}</p>
                    </div>
                    <div class="n-inline-segmented">
                      <button class="n-inline-segment" class:is-selected={(store.settings.bookReaderFlow ?? "paginated") === "paginated"} type="button" onclick={() => updateSettings({ bookReaderFlow: "paginated" })}>{$_("settings_inline_paginated")}</button>
                      <button class="n-inline-segment" class:is-selected={(store.settings.bookReaderFlow ?? "paginated") === "scrolled"} type="button" onclick={() => updateSettings({ bookReaderFlow: "scrolled" })}>{$_("settings_inline_continuous")}</button>
                    </div>
                  </div>
                  {/if}
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_fullWidthReadingPanel")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_fullWidthReadingPanelHint")}</p>
                    </div>
                    <button role="switch" aria-checked={proseSetting(kind, "fullWidth") ?? false} aria-label={$_("settings_inline_fullWidthReadingPanel")} class="settings-toggle" class:is-on={proseSetting(kind, "fullWidth") ?? false} type="button" onclick={() => updateProseSettings(kind, { fullWidth: !(proseSetting(kind, "fullWidth") ?? false) })}></button>
                  </div>
                  {@render readerBrightnessRow(kind)}
                </div>
              </div>
            {/snippet}

            <h3 class="settings-reader-group">{$_("settings_reader_groupNovel")}</h3>
            {@render proseDefaultsCard("novel")}

            <h3 class="settings-reader-group">{$_("settings_reader_groupBook")}</h3>
            {@render proseDefaultsCard("book")}

            <div class="settings-card settings-card--wide">
              <p class="settings-card__title">{$_("settings_inline_pdfDefaults")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_defaultPdfFitMode")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_defaultPdfFitModeHint")}</p>
                  </div>
                  <div class="select-wrap" id="pdf-fit">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("pdf-fit")}>
                      <span>{$_(PDF_FIT_LABEL_KEYS[store.settings.pdfFitMode ?? "width"] ?? "ui_width")}</span>
                      <svg class="select-caret" class:open={selectOpen === "pdf-fit"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "pdf-fit"}
                      <div class="select-menu">
                        {#each [["width","ui_width"], ["page","settings_reader_pdfFitPage"], ["actual","settings_reader_pdfFitActual"]] as [v, l]}
                          <button class="select-option" class:active={(store.settings.pdfFitMode ?? "width") === v} onclick={() => { updateSettings({ pdfFitMode: v as any }); selectOpen = null; }}>{$_(l)}</button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_pdfDarkMode")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_pdfDarkModeHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.pdfDarkMode ?? false} aria-label={$_("settings_inline_pdfDarkMode")} class="settings-toggle" class:is-on={store.settings.pdfDarkMode ?? false} type="button" onclick={() => updateSettings({ pdfDarkMode: !(store.settings.pdfDarkMode ?? false) })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_reader_bookZoom")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_reader_bookZoomHint")}</p>
                  </div>
                  <div class="step-controls">
                    <button class="step-btn" type="button" onclick={() => stepBookReaderZoom(-0.1)} disabled={(store.settings.bookReaderZoom ?? 1) <= 0.5}>-</button>
                    <span class="step-val">{Math.round((store.settings.bookReaderZoom ?? 1) * 100)}%</span>
                    <button class="step-btn" type="button" onclick={() => stepBookReaderZoom(0.1)} disabled={(store.settings.bookReaderZoom ?? 1) >= 4}>+</button>
                  </div>
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
              <p class="settings-card__title">{$_("settings_inline_display")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_defaultLayout")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_defaultLayoutHint")}</p>
                  </div>
                  <div class="n-inline-segmented">
                    {#each [["grid", "library_display_grid"], ["compact_grid", "library_display_compact"], ["list", "library_display_list"]] as [mode, label]}
                      <button class="n-inline-segment" class:is-selected={store.settings.libraryViewMode === mode} type="button" onclick={() => updateSettings({ libraryViewMode: mode as Settings["libraryViewMode"] })}>{$_(label)}</button>
                    {/each}
                  </div>
                </div>
                <div class="settings-row settings-mini-row settings-mini-row--stretch settings-mini-row--density">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_density")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_densityHint")}</p>
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
                          aria-label={$_("settings_inline_preferredItemsPerRow")}
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
                    <p class="settings-mini-row__label">{$_("settings_inline_libraryStart")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_libraryStartHint")}</p>
                  </div>
                  <div class="n-inline-segmented">
                    {#each LIBRARY_START_OPTIONS as option}
                      <button class="n-inline-segment" class:is-selected={store.settings.defaultLibrarySection === option.id} type="button" onclick={() => updateSettings({ defaultLibrarySection: option.id })}>{$_(option.label)}</button>
                    {/each}
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_libraryUpdates")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_automaticUpdates")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_automaticUpdatesHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.autoLibraryUpdatesEnabled}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.autoLibraryUpdatesEnabled}
                    aria-label={$_("settings_inline_automaticLibraryUpdates")}
                    onclick={() => updateSettings({ autoLibraryUpdatesEnabled: !store.settings.autoLibraryUpdatesEnabled })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_updateInterval")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_updateIntervalHint")}</p>
                  </div>
                  <div class="select-wrap" id="library-update-interval">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("library-update-interval")}>
                      <span>{libraryUpdateIntervalLabel(store.settings.libraryUpdateIntervalHours)}</span>
                      <svg class="select-caret" class:open={selectOpen === "library-update-interval"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "library-update-interval"}
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
                    <p class="settings-mini-row__label">{$_("settings_inline_comicsIntensity")}</p>
                    <p class="settings-mini-row__hint">{libraryUpdateIntensityHint(store.settings.libraryUpdateIntensity)}</p>
                  </div>
                  <div class="select-wrap" id="library-update-intensity">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("library-update-intensity")}>
                      <span>{libraryUpdateIntensityLabel(store.settings.libraryUpdateIntensity)}</span>
                      <svg class="select-caret" class:open={selectOpen === "library-update-intensity"} width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6" fill="currentColor"/></svg>
                    </button>
                    {#if selectOpen === "library-update-intensity"}
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
                    <p class="settings-mini-row__label">{$_("settings_inline_onlyUpdateOngoingNovels")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_onlyUpdateOngoingNovelsHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.onlyUpdateOngoingNovels}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.onlyUpdateOngoingNovels}
                    aria-label={$_("settings_inline_onlyUpdateOngoingNovels")}
                    onclick={() => updateSettings({ onlyUpdateOngoingNovels: !store.settings.onlyUpdateOngoingNovels })}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_downloadNewNovelChapters")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_downloadNewNovelChaptersHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.downloadNewNovelChapters}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.downloadNewNovelChapters}
                    aria-label={$_("settings_inline_downloadNewNovelChapters")}
                    onclick={() => updateSettings({ downloadNewNovelChapters: !store.settings.downloadNewNovelChapters })}
                  ></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_metadataOverlays")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_showProgress")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_showProgressHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.libraryShowProgress} aria-label={$_("settings_inline_showProgress")} class="settings-toggle" class:is-on={store.settings.libraryShowProgress} type="button" onclick={() => updateSettings({ libraryShowProgress: !store.settings.libraryShowProgress })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_showOutlines")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_showOutlinesHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.libraryShowCardOutline} aria-label={$_("settings_inline_showOutlines")} class="settings-toggle" class:is-on={store.settings.libraryShowCardOutline} type="button" onclick={() => updateSettings({ libraryShowCardOutline: !store.settings.libraryShowCardOutline })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_cropCovers")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_cropCoversHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.libraryCropCovers} aria-label={$_("settings_inline_cropCoverImages")} class="settings-toggle" class:is-on={store.settings.libraryCropCovers} type="button" onclick={() => updateSettings({ libraryCropCovers: !store.settings.libraryCropCovers })}></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_booksDefaults")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_defaultBooksTypeFilter")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_defaultBooksTypeFilterHint")}</p>
                  </div>
                  <div class="n-inline-segmented">
                    {#each BOOKS_TYPE_OPTIONS as option}
                      <button class="n-inline-segment" class:is-selected={store.settings.booksLibraryUi.typeFilter === option.id} type="button" onclick={() => updateSettings({ booksLibraryUi: { ...store.settings.booksLibraryUi, typeFilter: option.id as BooksLibraryTypeFilter } })}>{$_(option.label)}</button>
                    {/each}
                  </div>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_defaultBooksReadingStatus")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_defaultBooksReadingStatusHint")}</p>
                  </div>
                  <div class="select-wrap" id="books-status-filter">
                    <button class="select-btn" type="button" onclick={() => toggleSelect("books-status-filter")}>
                      <span>{$_(BOOKS_FILTER_LABEL_KEYS[store.settings.booksLibraryUi.statusFilter] ?? "library_filter_allBooks")}</span>
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
                            {$_(BOOKS_FILTER_LABEL_KEYS[option.id] ?? option.label)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_history")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_readingHistory")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_historyEntriesHint", { count: store.history.length })}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={clearHistory} disabled={store.history.length === 0}>{$_("settings_inline_clear")}</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_wipeAllData")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_wipeAllDataHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={wipeAllData}>{$_("settings_inline_wipe")}</button>
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
              <p class="settings-card__title">{$_("settings_inline_rendering")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_gpuAcceleration")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_gpuAccelerationHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.gpuAcceleration} aria-label={$_("settings_inline_gpuAcceleration")} class="settings-toggle" class:is-on={store.settings.gpuAcceleration} type="button" onclick={() => updateSettings({ gpuAcceleration: !store.settings.gpuAcceleration })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_renderLimit")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_renderLimitHint")}</p>
                  </div>
                  <div class="settings-stat-pill"><span>{renderLimitLabel(store.settings.renderLimit)}</span></div>
                </div>
                <div class="settings-chip-list settings-chip-list--presets">
                  {#each [12, 24, 48, 96, 200] as v}
                    <button class="settings-chip" class:is-active={(store.settings.renderLimit ?? 48) === v} type="button" onclick={() => updateSettings({ renderLimit: v })}>{v}</button>
                  {/each}
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_animatedSplashCards")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_animatedSplashCardsHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.splashCards ?? true} aria-label={$_("settings_inline_animatedSplashCards")} class="settings-toggle" class:is-on={store.settings.splashCards ?? true} type="button" onclick={() => updateSettings({ splashCards: !(store.settings.splashCards ?? true) })}></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_diagnostics")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_refreshMetrics")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_refreshMetricsHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={refreshPerfMetrics}>{$_("common_refresh")}</button>
                </div>
              </div>
              <div class="settings-card__surface" style="margin-top:16px" data-testid="settings-session-cache">
                <div class="settings-card__head">
                  <p class="settings-card__title">{$_("settings_inline_sessionCache")}</p>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_cacheEntries")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_cacheEntriesHint")}</p>
                    </div>
                    <div class="settings-stat-pill">
                      <span>{$_("settings_inline_cacheEntriesCount", { count: perfSnapshot?.cacheEntries ?? 0 })}</span>
                    </div>
                  </div>
                  {#if perfSnapshot && perfSnapshot.cacheEntries > 0}
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_oldestEntry")}</p>
                      </div>
                      <span class="perf-stat">{fmtAge(perfSnapshot.oldestEntryMs)}</span>
                    </div>
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_newestEntry")}</p>
                      </div>
                      <span class="perf-stat">{fmtAge(perfSnapshot.newestEntryMs)}</span>
                    </div>
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_cachedKeys")}</p>
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
                <p class="settings-card__title">{$_("settings_inline_keybinds")}</p>
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={resetKeybinds}>{$_("settings_inline_resetAll")}</button>
              </div>
              <p class="settings-card__intro">{$_("settings_inline_keybindsHint")}</p>
              <div class="settings-card__stack">
                {#each Object.keys(KEYBIND_LABELS) as key}
                  {@const k = key as keyof Keybinds}
                  {@const isListening = listeningKey === k}
                  {@const isDefault   = store.settings.keybinds[k] === DEFAULT_KEYBINDS[k]}
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_(KEYBIND_LABEL_KEYS[k])}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_desktopShortcut")}</p>
                    </div>
                    <div class="settings-keybind-actions">
                      <button class="n-btn n-btn--sm n-btn-ghost settings-value-pill" class:listening={isListening} type="button" onclick={() => startListen(k)}>
                        {isListening ? $_("ui_pressKey") : store.settings.keybinds[k]}
                      </button>
                      <button class="n-btn n-btn--sm n-btn-ghost settings-mini-action" type="button" onclick={() => updateSettings({ keybinds: { ...store.settings.keybinds, [k]: DEFAULT_KEYBINDS[k] } })} disabled={isDefault} title={$_("settings_inline_reset")}>{$_("settings_inline_reset")}</button>
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
          <div class="settings-grid" style="align-items: start;">

            <!-- Ã¢â€â‚¬Ã¢â€â‚¬ Migration banner Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ -->
            <!-- Ã¢â€â‚¬Ã¢â€â‚¬ Disk Usage Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ -->
            <div class="settings-card">
              <div class="settings-card__head">
                <p class="settings-card__title">{$_("settings.storage.usage")}</p>
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={fetchStorage} disabled={storageLoading}>
                  {storageLoading ? $_("common.refreshing") : $_("common.refresh")}
                </button>
              </div>
              {#if storageError}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("settings.nav.storage")} title={$_("settings.storage.loadError")} body={presentOperationFailure(storageError, $_)} />
                </div>
              {:else if isExternalServer}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="info" icon="info" eyebrow={$_("settings.nav.storage")} title={$_("settings.storage.unavailable")} body={$_("settings.storage.externalUnavailableBody")} />
                </div>
              {:else}
                <div class="settings-storage-meter">
                  <div class="settings-storage-meter__text">
                    <span class="settings-mini-row__label">{$_("settings.storage.usageLabel")}</span>
                    <span class="settings-mini-row__hint">{$_("settings.storage.usageHint")}</span>
                  </div>
                  <span
                    class="settings-storage-meter__value"
                    class:is-empty={storageUsageSummary.usageLabel === "No storage path configured."}
                  >
                    {storageUsageSummary.usageLabel === "No storage path configured." ? $_("settings.storage.noPath") : storageUsageSummary.usageLabel}
                  </span>
                </div>
                <div class="storage-bar">
                  <div class="storage-bar-fill" class:critical={storageUsageSummary.pct > 90} class:warn={storageUsageSummary.pct > 75 && storageUsageSummary.pct <= 90} style="width:{storageUsageSummary.pct}%"></div>
                </div>
                <p class="settings-card__intro" style="margin-top:16px">
                  {store.settings.storageLimitGb === null
                    ? $_("settings.storage.noLimit")
                    : $_("settings.storage.warnAt", { gb: store.settings.storageLimitGb })}
                </p>
                
              {#if advStorageOpen && storageAdvancedSource === "limit"}
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">{$_("settings.storage.usageGuardrails")}</p>
                  </div>
                  <div class="settings-card__stack">
                    <div class="settings-row settings-mini-row">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings.storage.warnWhenReached")}</p>
                        <p class="settings-mini-row__hint">{$_("settings.storage.warnWhenReachedHint")}</p>
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
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={applyStorageLimit}>{$_("common.save")}</button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">{$_("settings.storage.extraScanPaths")}</p>
                  </div>
                  {#if extraScanDirs.length > 0}
                    <div class="settings-card__stack">
                      {#each extraScanDirs as dir}
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label" style="font-family:var(--font-mono)">{dir}</p>
                            <p class="settings-mini-row__hint">{$_("settings.storage.extraScanDirectory")}</p>
                          </div>
                          <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={() => removeExtraScanDir(dir)}>{$_("common.remove")}</button>
                        </div>
                      {/each}
                    </div>
                  {/if}
                  <div class="settings-field-block" style="margin-top:16px">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings.storage.additionalScanPath")}</p>
                        <p class="settings-mini-row__hint">{$_("settings.storage.additionalScanPathHint")}</p>
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
                        {$_("common.add")}
                      </button>
                    </div>
                  </div>
                </div>
              {/if}
                <div class="settings-card__footer settings-card__footer--actions settings-storage-footer">
                  {#if storageUsageSummary.freeLabel}
                    <span class="settings-card__footer-status">{storageUsageSummary.freeLabel}</span>
                  {/if}
                  <div class="settings-storage-action-group">
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openStorageLimit}>
                      {advStorageOpen && storageAdvancedSource === "limit" ? $_("common.close") : store.settings.storageLimitGb === null ? $_("settings.storage.setLimit") : $_("settings.storage.editLimit")}
                    </button>
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={handleClearCache} disabled={clearing}>
                      {cleared ? $_("settings.storage.cleared") : clearing ? $_("settings.storage.clearing") : $_("settings.storage.cleanCache")}
                    </button>
                  </div>
                </div>
              {/if}
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings.storage.paths")}</p>
              {#if isExternalServer}
                <p class="settings-card__intro">{$_("settings.storage.externalPathsHint")}</p>
              {/if}
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.storage.downloadsPath")}</p>
                    <p class="settings-mini-row__hint" style={(confirmedDownloadsPath || defaultDownloadsPath) ? "font-family:var(--font-mono)" : ""}>{confirmedDownloadsPath || defaultDownloadsPath || $_("settings.storage.notConfigured")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => browseSettingsPath("downloads")} disabled={isExternalServer}>{$_("common.browse")}</button>
                </div>

                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings.storage.localSourcePath")}</p>
                    <p class="settings-mini-row__hint" style={confirmedLocalSourcePath ? "font-family:var(--font-mono)" : ""}>{confirmedLocalSourcePath || $_("common.optional")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => browseSettingsPath("local")} disabled={isExternalServer}>{$_("common.browse")}</button>
                </div>
              </div>
              
              {#if advStorageOpen && storageAdvancedSource === "paths"}
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">{$_("settings.storage.pathEditor")}</p>
                  </div>
                  <div class="settings-card__stack">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings.storage.downloadsPath")}</p>
                        <p class="settings-mini-row__hint">{$_("settings.storage.downloadsPathEditHint")}</p>
                      </div>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => browseSettingsPath("downloads")} disabled={isExternalServer}>{$_("common.browse")}</button>
                    </div>
                    <div class="settings-input-line settings-input-line--stack">
                      <div class="settings-input-line">
                        <input
                          class="settings-text-input settings-input-line__grow"
                          class:path-input-error={!!pathsFieldError.dl}
                          bind:value={downloadsPathInput}
                          placeholder={isExternalServer ? $_("settings.storage.serverDefault") : (defaultDownloadsPath || $_("settings.storage.defaultLocation"))}
                          spellcheck="false"
                          onkeydown={(event) => event.key === "Enter" && savePaths()}
                          oninput={() => { pathsFieldError = { ...pathsFieldError, dl: undefined }; }}
                        />
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={savePaths} disabled={pathsSaving}>
                          {pathsSaved ? $_("common.saved") : pathsSaving ? $_("common.saving") : $_("common.save")}
                        </button>
                      </div>
                      {#if pathsFieldError.dl}
                        <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("settings.storage.path")} title={$_("settings.storage.downloadPathAttention")} body={presentOperationFailure(pathsFieldError.dl, $_)} />
                      {/if}
                    </div>
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings.storage.localSourcePath")}</p>
                        <p class="settings-mini-row__hint">{$_("settings.storage.localSourcePathHint")}</p>
                      </div>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => browseSettingsPath("local")} disabled={isExternalServer}>{$_("common.browse")}</button>
                    </div>
                    <div class="settings-input-line settings-input-line--stack">
                      <div class="settings-input-line">
                        <input
                          class="settings-text-input settings-input-line__grow"
                          class:path-input-error={!!pathsFieldError.loc}
                          bind:value={localSourcePathInput}
                          placeholder={$_("common.optional")}
                          spellcheck="false"
                          onkeydown={(event) => event.key === "Enter" && savePaths()}
                          oninput={() => { pathsFieldError = { ...pathsFieldError, loc: undefined }; }}
                        />
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={savePaths} disabled={pathsSaving}>
                          {pathsSaved ? $_("common.saved") : pathsSaving ? $_("common.saving") : $_("common.save")}
                        </button>
                      </div>
                      {#if pathsFieldError.loc}
                        <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("settings.storage.path")} title={$_("settings.storage.localSourcePathAttention")} body={presentOperationFailure(pathsFieldError.loc, $_)} />
                      {/if}
                      {#if pathsError}
                        <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("settings.storage.path")} title={$_("settings.storage.pathSaveError")} body={presentOperationFailure(pathsError, $_)} />
                      {/if}
                    </div>
                  </div>
                </div>
                {#if migrateFrom && !isExternalServer}
                  <div class="settings-card__surface" style="margin-top:16px">
                    <div class="settings-card__head">
                      <p class="settings-card__title">{$_("settings_inline_migration")}</p>
                      <div class="settings-section-actions settings-inline-actions">
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={startMigration} disabled={migrating}>
                          {migrating ? (migrateProgress ? $_("settings_storage_moving", { done: migrateProgress.done, total: migrateProgress.total }) : $_("settings_storage_starting")) : $_("ui_moveFiles")}
                        </button>
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={dismissMigration} disabled={migrating}>{$_("settings_inline_migrationKeep")}</button>
                      </div>
                    </div>
                    <p class="settings-card__intro">{$_("settings_inline_migrationHint")}</p>
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_pathChange")}</p>
                        <p class="settings-mini-row__hint" style="font-family:var(--font-mono)">{migrateFrom} → {migrateTo}</p>
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
                        <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_migration")} title={$_("settings_inline_pathMigrationFailed")} body={presentOperationFailure(migrateError, $_)} />
                      </div>
                    {/if}
                  </div>
                {/if}
              {/if}
<div class="settings-card__footer settings-card__footer--actions" style="margin-top:16px">
                <span class="settings-card__footer-status">
                {#if pathsError}
                  <span class="settings-mini-row__hint" style="color:var(--color-error)">{presentOperationFailure(pathsError, $_)}</span>
                {:else if pathsSaved}
                  <span class="settings-mini-row__hint" style="color:var(--accent-fg)">{$_("settings.storage.pathsSaved")}</span>
                {:else}
                  <span class="settings-mini-row__hint">{$_("settings.storage.verifyFolders")}</span>
                {/if}
                </span>
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openStoragePaths}>
                  {advStorageOpen && storageAdvancedSource === "paths" ? $_("common.close") : $_("settings.storage.editPaths")}
                </button>
              </div>
            </div>

                        <div class="settings-card settings-card--wide">
              <p class="settings-card__title">{$_("settings.storage.backups")}</p>
              <p class="settings-card__intro">
                {$_("settings.storage.backupsIntro")}
              </p>
              <div class="settings-card__footer settings-card__footer--actions" style="margin-top:16px; justify-content: flex-end;">
                <div class="settings-storage-action-group">
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openStorageBackupPanel}>
                    {$_("settings.storage.createBackup")}
                  </button>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openStorageRestore}>
                    {$_("settings.storage.restoreBackup")}
                  </button>
                </div>
              </div>
            </div></div>
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
              <p class="settings-card__title">{$_("settings_inline_categories")}</p>
              <div class="settings-chip-list">
                {#each categoryPreviewChips as category}
                  <span class="settings-chip">{category}</span>
                {/each}
                {#if categoryPreviewChips.length === 0}
                  <span class="settings-chip settings-chip--empty">{$_("settings_inline_noCategoriesYet")}</span>
                {/if}
              </div>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_comicsCategories")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_comicsCategoriesHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => openCategoryManager("comics")}>{$_("settings_inline_manage")}</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_booksCategories")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_booksCategoriesHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => openCategoryManager("books")}>{$_("settings_inline_manage")}</button>
                </div>
              </div>
              {#if categoriesDetailsPane}
                <div class="settings-card__surface" style="margin-top:16px">
                <div class="settings-card__head">
                  <p class="settings-card__title">{categoriesDetailsPane === "comics" ? $_("settings_categories_manageComics") : $_("settings_categories_manageBooks")}</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={closeCategoryManager}>{$_("common_close")}</button>
                </div>
                <div class="n-inline-segmented">
                  {#each [
                    { id: "comics", label: $_("common_comics") },
                    { id: "books", label: $_("common_books") },
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
                    ? $_("settings_categories_comicsIntro")
                    : booksUpdateExcludedCount > 0
                      ? $_("settings_categories_booksIntroSkipped", { count: booksUpdateExcludedCount })
                      : $_("settings_categories_booksIntro")}
                </p>
                {#if categoryDomain === "comics" && catsError}
                  <div class="settings-state">
                    <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("ui_categories")} title={$_("settings_inline_couldNotLoadComicFolders")} body={presentOperationFailure(catsError, $_)} />
                  </div>
                {/if}
                <div class="settings-card__footer settings-card__footer--editor">
                  <div class="settings-input-line settings-input-line__grow">
                    <input class="settings-text-input settings-input-line__grow" placeholder={$_("settings_inline_newCategoryName")} bind:value={newFolderName} onkeydown={(e) => e.key === "Enter" && createFolder()} />
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={createFolder} disabled={!newFolderName.trim()}><Plus size={13} weight="bold" /> {$_("common_create")}</button>
                </div>
                {#if categoryDomain === "comics"}
                  {#if catsLoading}
                    <NocturneState layout="compact" tone="info" icon="folder" eyebrow={$_("ui_categories")} title={$_("settings_inline_loadingCategories")} />
                  {:else if store.categories.filter((c) => c.id !== 0).length === 0}
                    <NocturneState layout="compact" tone="info" icon="folder" eyebrow={$_("ui_categories")} title={$_("settings_inline_noCategoriesYet")} body={$_("feedback.createCategoryAbove")} />
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
                            <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={commitEdit} title={$_("common_save")}>{$_("common_save")}</button>
                          {:else}
                            <div class="settings-mini-row__body">
                              <p class="settings-mini-row__label">{cat.name}</p>
                              <p class="settings-mini-row__hint">{cat.mangas?.nodes.filter((manga) => manga.inLibrary).length ?? 0} manga{(store.settings.defaultLibraryCategoryId ?? null) === cat.id ? " / default" : ""}{(store.settings.hiddenCategoryIds ?? []).includes(cat.id) ? " / hidden from Saved" : ""}{cat.includeInUpdate === "EXCLUDE" ? " / skipped by updates" : ""}</p>
                            </div>
                            <div class="settings-section-actions settings-inline-actions settings-inline-actions--dense">
                              <button
                                class="n-btn n-btn--sm n-btn-ghost settings-folder-action"
                                class:folder-update-excluded={cat.includeInUpdate === "EXCLUDE"}
                                type="button"
                                onclick={() => toggleComicFolderUpdates(cat)}
                                title={cat.includeInUpdate === "EXCLUDE" ? $_("settings_inline_includeFolderLibraryUpdates") : $_("settings_inline_excludeFolderLibraryUpdates")}
                              >
                                {cat.includeInUpdate === "EXCLUDE" ? $_("settings_inline_skipUpdates") : $_("settings_inline_update")}
                              </button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" class:folder-default-active={(store.settings.defaultLibraryCategoryId ?? null) === cat.id} type="button" onclick={() => updateSettings({ defaultLibraryCategoryId: (store.settings.defaultLibraryCategoryId ?? null) === cat.id ? null : cat.id })} title={(store.settings.defaultLibraryCategoryId ?? null) === cat.id ? $_("settings_inline_removeDefaultCategory") : $_("settings_inline_setDefaultCategory")}><Star size={13} weight={(store.settings.defaultLibraryCategoryId ?? null) === cat.id ? "fill" : "light"} /></button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" class:folder-hidden={(store.settings.hiddenCategoryIds ?? []).includes(cat.id)} type="button" onclick={() => toggleHiddenCategory(cat.id)} title={(store.settings.hiddenCategoryIds ?? []).includes(cat.id) ? $_("settings_inline_showInSavedTab") : $_("settings_inline_hideFromSavedTab")}>{#if (store.settings.hiddenCategoryIds ?? []).includes(cat.id)}<EyeSlash size={13} weight="light" />{:else}<Eye size={13} weight="light" />{/if}</button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => moveCategory(cat.id, -1)} disabled={i === 0} title={$_("settings_inline_moveUp")}>{$_("settings_inline_up")}</button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => moveCategory(cat.id, 1)} disabled={i === displayCats.length - 1} title={$_("settings_inline_moveDown")}>{$_("settings_inline_down")}</button>
                              <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => startEdit(cat.id, cat.name)} title={$_("settings_inline_rename")}><Pencil size={12} weight="light" /></button>
                              <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger settings-folder-action folder-delete" type="button" onclick={() => deleteFolder(cat.id)} title={$_("common_delete")}><Trash size={12} weight="light" /></button>
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                {:else if sortedBooksCategories.length === 0}
                  <NocturneState layout="compact" tone="info" icon="folder" eyebrow={$_("settings_inline_booksCategories")} title={$_("settings_inline_noCategoriesYet")} body={$_("settings_inline_createCategoryAboveBooks")} />
                {:else}
                  <div class="settings-card__stack" style="margin-top:16px">
                    {#each sortedBooksCategories as cat, i}
                      <div class="settings-row settings-mini-row settings-mini-row--stretch settings-mini-row--category">
                        {#if editingId === cat.id}
                          <div class="settings-input-line settings-input-line__grow">
                            <input class="settings-text-input settings-input-line__grow" bind:value={editingName} onkeydown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") editingId = null; }} onblur={commitEdit} use:focusInput />
                          </div>
                          <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={commitEdit} title={$_("common_save")}>{$_("common_save")}</button>
                        {:else}
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">{cat.name}</p>
                            <p class="settings-mini-row__hint">{(booksCategoryCounts[cat.id] ?? 0) === 1 ? translate("library_count_titleOne") : translate("library_count_titles", { count: booksCategoryCounts[cat.id] ?? 0 })}{normalizeBooksCategoryUpdateRule(cat.includeInUpdate) === "EXCLUDE" ? ` ${translate("ui_skippedByUpdates").trim()}` : ""}</p>
                          </div>
                          <div class="settings-section-actions settings-inline-actions settings-inline-actions--dense">
                            <button
                              class="n-btn n-btn--sm n-btn-ghost settings-folder-action"
                              class:folder-update-excluded={normalizeBooksCategoryUpdateRule(cat.includeInUpdate) === "EXCLUDE"}
                              type="button"
                              onclick={() => toggleBooksFolderUpdates(cat)}
                              title={normalizeBooksCategoryUpdateRule(cat.includeInUpdate) === "EXCLUDE" ? $_("settings_inline_includeFolderBooksUpdates") : $_("settings_inline_excludeFolderBooksUpdates")}
                            >
                              {normalizeBooksCategoryUpdateRule(cat.includeInUpdate) === "EXCLUDE" ? $_("settings_inline_skipUpdates") : $_("settings_inline_update")}
                            </button>
                            <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => moveCategory(cat.id, -1)} disabled={i === 0} title={$_("settings_inline_moveUp")}>{$_("settings_inline_up")}</button>
                            <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => moveCategory(cat.id, 1)} disabled={i === sortedBooksCategories.length - 1} title={$_("settings_inline_moveDown")}>{$_("settings_inline_down")}</button>
                            <button class="n-btn n-btn--sm n-btn-ghost settings-folder-action" type="button" onclick={() => startEdit(cat.id, cat.name)} title={$_("settings_inline_rename")}><Pencil size={12} weight="light" /></button>
                            <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger settings-folder-action folder-delete" type="button" onclick={() => deleteFolder(cat.id)} title={$_("common_delete")}><Trash size={12} weight="light" /></button>
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
              <p class="settings-card__title">{$_("settings_inline_connectedServices")}</p>
              {#if trackersError}
                <div class="settings-state">
                  <NocturneState
                    layout="compact"
                    tone="danger"
                    icon="warning"
                    eyebrow={$_("feedback.trackers")}
                    title={$_("settings_inline_couldNotLoadTrackers")}
                    body={presentOperationFailure(trackersError, $_)}
                    actions={[{
                      label: $_("library_error_retry"),
                      icon: "retry",
                      onClick: () => void loadTrackers(),
                    }]}
                  />
                </div>
              {/if}
              {#if trackersLoading}
                <NocturneState layout="compact" tone="info" icon="retry" eyebrow={$_("feedback.trackers")} title={$_("settings_inline_loadingTrackers")} />
              {:else}
                <div class="settings-card__stack">
                  {#each trackers as tracker}
                    <div class="settings-row settings-mini-row settings-mini-row--tracker" class:tracker-row-active={tracker.isLoggedIn}>
                      <div class="tracker-identity">
                        <img src={resolveServiceIconUrl(tracker, { kind: "tracker" })} alt={tracker.name} class="tracker-logo" onerror={(event) => applyServiceIconFallback(event, "tracker")} />
                        <div class="tracker-name-block">
                          <span class="tracker-label">{tracker.name}</span>
                          <span class="tracker-status-pill" class:pill-on={tracker.isLoggedIn}>
                            {tracker.isLoggedIn ? $_("settings_inline_connected") : $_("settings_inline_notConnected")}
                          </span>
                        </div>
                      </div>
                      <div class="tracker-action">
                        {#if tracker.isLoggedIn}
                          <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={() => logoutTracker(tracker.id)} disabled={loggingOut === tracker.id}>
                            {loggingOut === tracker.id ? $_("settings_inline_disconnecting") : $_("settings_inline_disconnect")}
                          </button>
                        {:else}
                          <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => usesOAuth(tracker) ? startOAuth(tracker) : startCredentials(tracker)}>
                            {usesOAuth(tracker) ? $_("settings_inline_login") : $_("settings_inline_connect")}
                          </button>
                        {/if}
                      </div>
                    </div>
                  {/each}
                  <div class="settings-row settings-mini-row settings-mini-row--tracker" class:tracker-row-active={hardcoverState.auth.connected}>
                    <div class="tracker-identity">
                      <img src={hardcoverLogo} alt="Hardcover" class="tracker-logo" />
                      <div class="tracker-name-block">
                        <span class="tracker-label">Hardcover</span>
                        <span class="tracker-status-pill" class:pill-on={hardcoverState.auth.connected}>
                          {hardcoverState.auth.connected ? $_("settings_inline_connected") : $_("settings_inline_notConnected")}
                        </span>
                      </div>
                    </div>
                    <div class="tracker-action">
                      {#if hardcoverState.auth.connected}
                        <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={disconnectHardcoverAccount}>
                          {$_("settings_inline_disconnect")}
                        </button>
                      {:else}
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={startHardcoverAuth}>
                          {$_("settings_inline_login")}
                        </button>
                      {/if}
                    </div>
                  </div>
                </div>
                {#if activeTrackerDetail}
                  <div class="settings-card__surface" style="margin-top:16px">
                    <div class="settings-card__head">
                      <p class="settings-card__title">{activeTrackerDetail.name}</p>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={closeTrackerDetail}>{$_("common_close")}</button>
                    </div>
                    {#if activeTrackerDetailMode === "oauth"}
                      <p class="settings-card__intro">
                        {oauthAutoCapturing
                          ? $_("settings_inline_finishTrackerLogin")
                          : $_("settings_inline_trackerOauthWindowHint")}
                      </p>
                      <div class="settings-card__stack">
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">{$_("settings_inline_callbackUrl")}</p>
                            <p class="settings-mini-row__hint">{$_("settings_inline_callbackUrlHint")}</p>
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
                          {oauthSubmitting ? $_("settings_inline_connecting") : $_("settings_inline_connect")}
                        </button>
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={cancelOAuth}>{$_("settings_inline_cancel")}</button>
                      </div>
                    {:else if activeTrackerDetailMode === "credentials"}
                      <p class="settings-card__intro">{$_("settings_inline_credentialsHint")}</p>
                      <div class="settings-card__stack">
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">{$_("settings_inline_usernameOrEmail")}</p>
                          </div>
                        </div>
                        <input
                          class="settings-text-input"
                          placeholder={$_("settings_inline_usernameEmail")}
                          bind:value={credsUsername}
                          onkeydown={(e) => e.key === "Escape" && cancelCredentials()}
                          use:focusEl
                        />
                        <div class="settings-row settings-mini-row settings-mini-row--stretch">
                          <div class="settings-mini-row__body">
                            <p class="settings-mini-row__label">{$_("settings_inline_password")}</p>
                          </div>
                        </div>
                        <input
                          class="settings-text-input"
                          type="password"
                          placeholder={$_("settings_inline_password")}
                          bind:value={credsPassword}
                          onkeydown={(e) => { if (e.key === "Enter") submitCredentials(); if (e.key === "Escape") cancelCredentials(); }}
                        />
                      </div>
                      <div class="settings-card__footer">
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={submitCredentials} disabled={credsSubmitting || !credsUsername.trim() || !credsPassword.trim()}>
                          {credsSubmitting ? $_("settings_inline_connecting") : $_("settings_inline_connect")}
                        </button>
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={cancelCredentials}>{$_("settings_inline_cancel")}</button>
                      </div>
                    {/if}
                  </div>
                {:else if hardcoverAuthOpen}
                  <div class="settings-card__surface" style="margin-top:16px">
                    <div class="settings-card__head">
                      <p class="settings-card__title">Hardcover</p>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={cancelHardcoverAuth}>{$_("common_close")}</button>
                    </div>
                    <p class="settings-card__intro">
                      {$_("settings_inline_hardcoverAuthIntro")}
                    </p>
                    {#if hardcoverError}
                      <div class="settings-state">
                        <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Hardcover" title={$_("settings_inline_couldNotConnectHardcover")} body={presentOperationFailure(hardcoverError, $_)} />
                      </div>
                    {/if}
                    <div class="settings-card__stack">
                      <div class="settings-row settings-mini-row settings-mini-row--stretch">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">{$_("settings_inline_hardcoverApiKey")}</p>
                          <p class="settings-mini-row__hint">{$_("settings_inline_hardcoverApiKeyHint")}</p>
                        </div>
                      </div>
                      <input
                        class="settings-text-input"
                        type="password"
                        placeholder={$_("settings_inline_hardcoverApiKey")}
                        bind:value={hardcoverTokenInput}
                        onkeydown={(e) => { if (e.key === "Enter") submitHardcoverToken(); if (e.key === "Escape") cancelHardcoverAuth(); }}
                        use:focusEl
                      />
                    </div>
                    <div class="settings-card__footer">
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={submitHardcoverToken} disabled={hardcoverSubmitting || !hardcoverTokenInput.trim()}>
                        {hardcoverSubmitting ? $_("settings_inline_connecting") : $_("settings_inline_connect")}
                      </button>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => openUrl("https://hardcover.app/account/api")}>
                        {$_("settings_inline_getApiKey")}
                      </button>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={cancelHardcoverAuth}>{$_("settings_inline_cancel")}</button>
                    </div>
                  </div>
                {/if}
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
                <p class="settings-card__title">{$_("settings_inline_securityStatus")}</p>
                <div class="settings-state">
                  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_security")} title={$_("settings_inline_securitySettingFailed")} body={presentOperationFailure(secError, $_)} />
                </div>
              </div>
            {/if}

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_security")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_requirePinOnOpen")}</p>
                    <p class="settings-mini-row__hint">
                      {store.settings.appLockEnabled ? ((store.settings.appLockPin?.length ?? 0) >= 4 ? $_("settings_security_pinActiveHint") : $_("settings_security_pinMissingHint")) : $_("settings_security_pinInactiveHint")}
                    </p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.appLockEnabled ?? false}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.appLockEnabled ?? false}
                    aria-label={$_("settings_inline_requirePinOnOpen")}
                    onclick={() => {
                      updateSettings({ appLockEnabled: !(store.settings.appLockEnabled ?? false) });
                      securityDetailPane = "pin";
                    }}
                  ></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("ui_socksProxy")}</p>
                    <p class="settings-mini-row__hint">
                      {socksEnabled ? `${socksHost || translate("ui_unsetHost")}:${socksPort || "1080"}` : $_("settings_inline_disabled")}
                    </p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = securityDetailPane === "socks" ? null : "socks")}>{$_("settings_inline_edit")}</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">FlareSolverr</p>
                    <p class="settings-mini-row__hint">{flareEnabled ? (flareStatusLabel() || $_("ui_enabled")) : $_("settings_inline_disabled")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={flareEnabled}
                    type="button"
                    role="switch"
                    aria-checked={flareEnabled}
                    aria-label={$_("settings_inline_enableFlareSolverr")}
                    disabled={secLoading}
                    onclick={async () => {
                      const next = !flareEnabled;
                      flareEnabled = next;
                      if (next) securityDetailPane = "flare";
                      if (!(await saveFlareSolverr())) flareEnabled = !next;
                    }}
                  ></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_authentication")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_serverAuth")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_serverAuthHint")}</p>
                  </div>
                  <div class="settings-section-actions settings-inline-actions">
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = securityDetailPane === "auth" ? null : "auth")}>{$_("settings_inline_edit")}</button>
                    <button
                      class="settings-toggle"
                      class:is-on={store.settings.serverAuthEnabled}
                      type="button"
                      role="switch"
                      aria-checked={store.settings.serverAuthEnabled}
                      aria-label={$_("settings_inline_enableServerAuthentication")}
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
                    <p class="settings-mini-row__label">{$_("settings_inline_proxyMode")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_proxyModeHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = securityDetailPane === "flare" ? null : "flare")}>
                    {!flareEnabled ? $_("common_off") : flareDockerStatus?.running ? $_("settings_security_flareDocker") : flareLocalStatus?.running ? $_("settings_security_flareLocal") : $_("settings_security_flareCustom")}
                  </button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_desktopSyncPairing")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_desktopSyncTrustHint")}</p>
                  </div>
                  <button
                    class="n-btn n-btn--sm n-btn-ghost"
                    type="button"
                    data-testid="settings-security-syncd-manage"
                    onclick={() => (securityDetailPane = securityDetailPane === "syncd" ? null : "syncd")}
                  >
                    {securityDetailPane === "syncd" ? $_("common_close") : $_("ui_manage")}
                  </button>
                </div>
              </div>
              {#if store.settings.serverAuthEnabled}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="info" icon="info" eyebrow={$_("ui_security")} title={$_("settings_inline_imageProxyEnabled")} body={$_("feedback.imageProxyBody")} />
                </div>
              {/if}
            </div>

            {#if securityDetailPane === "syncd"}
              <SyncdConnectionPanel
                profileId={currentRuntimeProfileId}
                scopeLabel={currentSessionProfileSummary}
                onClose={() => (securityDetailPane = null)}
              />
            {/if}

            {#if securityDetailPane === "auth"}
              <div class="settings-card settings-card--wide">
                <div class="settings-card__head">
                  <p class="settings-card__title">{$_("settings_inline_serverAuthentication")}</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = null)}>{$_("common_close")}</button>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_username")}</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_usernameHint")}</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <input class="settings-text-input settings-input-line__grow" bind:value={authUsername} placeholder="admin" spellcheck="false" onkeydown={(event) => event.key === "Enter" && enableAuth()} />
                    </div>
                  </div>
                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_password")}</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_passwordHint")}</p>
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
                        <button class="sec-eye-btn" type="button" onclick={() => (showAuthPass = !showAuthPass)} title={showAuthPass ? $_("settings_security_hidePassword") : $_("settings_security_showPassword")} aria-label={showAuthPass ? $_("settings_security_hidePassword") : $_("settings_security_showPassword")}>
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
                    <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={disableAuth} disabled={secLoading}>{secLoading ? $_("common_saving") : $_("sources_actions_disable")}</button>
                  {/if}
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={enableAuth} disabled={secLoading || !authUsername.trim() || !authPassword.trim()}>{secLoading ? $_("common_saving") : secSaved === "auth" ? $_("common_saved") : store.settings.serverAuthEnabled ? $_("settings_inline_update") : $_("sources_actions_enable")}</button>
                </div>
              </div>
            {/if}

            {#if securityDetailPane === "pin"}
              <div class="settings-card settings-card--wide">
                <div class="settings-card__head">
                  <p class="settings-card__title">{$_("settings_inline_pinLock")}</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = null)}>{$_("common_close")}</button>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_requirePinOnLaunch")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_requirePinOnLaunchHint")}</p>
                    </div>
                    <button
                      class="settings-toggle"
                      class:is-on={store.settings.appLockEnabled ?? false}
                      type="button"
                      role="switch"
                      aria-checked={store.settings.appLockEnabled ?? false}
                      aria-label={$_("settings_inline_enablePinLock")}
                      onclick={() => updateSettings({ appLockEnabled: !(store.settings.appLockEnabled ?? false) })}
                    ></button>
                  </div>
                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">PIN</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_pinHint")}</p>
                      </div>
                    </div>
                    <div class="settings-input-line settings-input-line--stack">
                      <div class="settings-input-line">
                        <input class="settings-text-input sec-pin-input" type="password" inputmode="numeric" maxlength={8} value={pinInput} placeholder="••••" autocomplete="off" oninput={(event) => { pinInput = event.currentTarget.value.replace(/\D/g, "").slice(0, 8); pinError = null; }} onkeydown={(event) => event.key === "Enter" && commitPin()} />
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={commitPin} disabled={pinInput.length > 0 && pinInput.length < 4}>{store.settings.appLockPin && pinInput === store.settings.appLockPin ? $_("common_saved") : $_("common_save")}</button>
                      </div>
                      {#if pinError}
                        <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("ui_pin")} title={$_("settings_inline_pinNeedsAttention")} body={presentOperationFailure(pinError, $_)} />
                      {/if}
                    </div>
                  </div>
                </div>
              </div>
            {/if}
            {#if securityDetailPane === "socks"}
              <div class="settings-card settings-card--wide">
                <div class="settings-card__head">
                  <p class="settings-card__title">{$_("ui_socksProxy")}</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = null)}>{$_("common_close")}</button>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_enableProxy")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_enableProxyHint")}</p>
                    </div>
                    <button
                      class="settings-toggle"
                      class:is-on={socksEnabled}
                      type="button"
                      role="switch"
                      aria-checked={socksEnabled}
                      aria-label={$_("settings_inline_enableSocksProxy")}
                      onclick={() => (socksEnabled = !socksEnabled)}
                    ></button>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_version")}</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_proxyVersionHint")}</p>
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
                        <p class="settings-mini-row__label">{$_("settings_inline_host")}</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_hostHint")}</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <input class="settings-text-input settings-input-line__grow" bind:value={socksHost} placeholder="127.0.0.1" spellcheck="false" onkeydown={(event) => event.key === "Enter" && saveSocksProxy()} />
                    </div>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_port")}</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_portHint")}</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <input class="settings-text-input settings-input-line__grow" bind:value={socksPort} inputmode="numeric" placeholder="1080" onkeydown={(event) => event.key === "Enter" && saveSocksProxy()} />
                    </div>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_username")}</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_proxyOptionalAuthHint")}</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                      <input class="settings-text-input settings-input-line__grow" bind:value={socksUsername} placeholder={$_("common_optional")} spellcheck="false" onkeydown={(event) => event.key === "Enter" && saveSocksProxy()} />
                    </div>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_password")}</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_storedLocallyOnSave")}</p>
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
                        <button class="sec-eye-btn" type="button" onclick={() => (showSocksPass = !showSocksPass)} title={showSocksPass ? $_("settings_security_hidePassword") : $_("settings_security_showPassword")} aria-label={showSocksPass ? $_("settings_security_hideSocksPassword") : $_("settings_security_showSocksPassword")}>
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
                    {secLoading ? $_("common_saving") : secSaved === "socks" ? $_("common_saved") : $_("settings_security_saveProxy")}
                  </button>
                </div>
              </div>
            {/if}
            {#if securityDetailPane === "flare"}
              <div class="settings-card settings-card--wide">
                <div class="settings-card__head">
                  <p class="settings-card__title">FlareSolverr</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (securityDetailPane = null)}>{$_("common_close")}</button>
                </div>
                <div class="settings-card__stack">
                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_enableFlareSolverr")}</p>
                      <p class="settings-mini-row__hint">{$_("settings_inline_flareSolverrHint")}</p>
                    </div>
                    <button
                      class="settings-toggle"
                      class:is-on={flareEnabled}
                      type="button"
                      role="switch"
                      aria-checked={flareEnabled}
                      aria-label={$_("settings_inline_enableFlareSolverr")}
                      onclick={() => (flareEnabled = !flareEnabled)}
                    ></button>
                  </div>

                  <div class="settings-field-block">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">URL</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_flareSolverrUrlHint")}</p>
                      </div>
                    </div>
                    <div class="settings-input-line">
                  <input class="settings-text-input settings-input-line__grow" bind:value={flareUrl} placeholder="http://127.0.0.1:8191" spellcheck="false" onkeydown={(event) => event.key === "Enter" && saveFlareSolverr()} />
                    </div>
                  </div>

                  <div class="settings-row settings-mini-row">
                    <div class="settings-mini-row__body">
                      <p class="settings-mini-row__label">{$_("settings_inline_connection")}</p>
                      <p class="settings-mini-row__hint">{flareStatusLabel() || $_("ui_checkTheInstanceStatusBeforeSaving")}</p>
                    </div>
                    <div class="settings-section-actions settings-inline-actions">
                      <span class="sec-status-pill" class:sec-pill-on={flareTestState === "ready"}>{flareStatusLabel() || $_("downloads_summary_idle")}</span>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => testFlareSolverr()} disabled={flareTestState === "testing" || secLoading}>
                        {flareTestState === "testing" ? $_("settings_inline_testing") : $_("settings_inline_test")}
                      </button>
                    </div>
                  </div>

                  <div class="settings-card__surface">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_localInstance")}</p>
                        <p class="settings-mini-row__hint">{flareLocalStateLabel()}</p>
                      </div>
                      <div class="settings-section-actions settings-inline-actions">
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={refreshFlareLocalStatus} disabled={flareLocalBusy}>{$_("common_refresh")}</button>
                        {#if flareLocalStatus?.installed}
                          {#if flareLocalStatus.running}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={stopFlareLocal} disabled={flareLocalBusy}>{$_("settings_inline_stop")}</button>
                          {:else}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={startFlareLocal} disabled={flareLocalBusy}>{$_("settings_inline_start")}</button>
                          {/if}
                        {/if}
                      </div>
                    </div>
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_startOnAppLaunch")}</p>
                        <p class="settings-mini-row__hint">{flareLocalStatus?.path ?? $_("settings_security_flareInstallHint")}</p>
                      </div>
                      <button
                        class="settings-toggle"
                        class:is-on={flareLocalAutoStart}
                        type="button"
                        role="switch"
                        aria-checked={flareLocalAutoStart}
                        aria-label={$_("settings_inline_startFlareSolverrOnLaunch")}
                        onclick={() => setFlareLocalAutoStart(!flareLocalAutoStart)}
                        disabled={!flareLocalStatus?.installed}
                      ></button>
                    </div>
                  </div>

                  <div class="settings-card__surface">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_dockerInstance")}</p>
                        <p class="settings-mini-row__hint">{flareDockerStateLabel()}</p>
                      </div>
                      <div class="settings-section-actions settings-inline-actions">
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={refreshFlareDockerStatus} disabled={flareDockerBusy}>{$_("common_refresh")}</button>
                        {#if flareDockerStatus?.installed && flareDockerStatus?.daemon}
                          {#if flareDockerStatus.running}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={stopFlareDocker} disabled={flareDockerBusy}>{$_("settings_inline_stop")}</button>
                          {:else}
                            <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={startFlareDocker} disabled={flareDockerBusy}>{$_("settings_inline_start")}</button>
                          {/if}
                        {/if}
                      </div>
                    </div>
                  </div>

                  <div class="settings-card__surface">
                    <div class="settings-row settings-mini-row settings-mini-row--stretch">
                      <div class="settings-mini-row__body">
                        <p class="settings-mini-row__label">{$_("settings_inline_advanced")}</p>
                        <p class="settings-mini-row__hint">{$_("settings_inline_flareAdvancedHint")}</p>
                      </div>
                    </div>
                    <div class="settings-card__stack">
                      <div class="settings-row settings-mini-row">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">{$_("settings_inline_timeout")}</p>
                          <p class="settings-mini-row__hint">{$_("settings_inline_timeoutHint")}</p>
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
                            <p class="settings-mini-row__label">{$_("settings_inline_sessionName")}</p>
                            <p class="settings-mini-row__hint">{$_("settings_inline_sessionNameHint")}</p>
                          </div>
                        </div>
                        <div class="settings-input-line">
                  <input class="settings-text-input settings-input-line__grow" bind:value={flareSession} placeholder="epigraph" spellcheck="false" onkeydown={(event) => event.key === "Enter" && saveFlareSolverr()} />
                        </div>
                      </div>
                      <div class="settings-row settings-mini-row">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">{$_("settings_inline_sessionTtl")}</p>
                          <p class="settings-mini-row__hint">{$_("settings_inline_sessionTtlHint")}</p>
                        </div>
                        <div class="step-controls">
                          <button class="step-btn" type="button" onclick={() => (flareTtl = Math.max(1, flareTtl - 1))}>-</button>
                          <span class="step-val">{flareTtl}m</span>
                          <button class="step-btn" type="button" onclick={() => (flareTtl = Math.min(60, flareTtl + 1))}>+</button>
                        </div>
                      </div>
                      <div class="settings-row settings-mini-row">
                        <div class="settings-mini-row__body">
                          <p class="settings-mini-row__label">{$_("settings_inline_responseFallback")}</p>
                          <p class="settings-mini-row__hint">{$_("settings_inline_responseFallbackHint")}</p>
                        </div>
                        <button
                          class="settings-toggle"
                          class:is-on={flareFallback}
                          type="button"
                          role="switch"
                          aria-checked={flareFallback}
                          aria-label={$_("settings_inline_useFlareResponseFallback")}
                          onclick={() => (flareFallback = !flareFallback)}
                        ></button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="settings-card__footer">
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={saveFlareSolverr} disabled={secLoading}>
                    {secLoading ? $_("common_saving") : secSaved === "flare" ? $_("common_saved") : $_("settings_security_saveFlaresolverr")}
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
              <p class="settings-card__title">{$_("settings_inline_contentFilters")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_showAdultContent")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_showAdultContentHint")}</p>
                  </div>
                  <button role="switch" aria-checked={store.settings.showNsfw} aria-label={$_("settings_inline_showAdultContent")} class="settings-toggle" class:is-on={store.settings.showNsfw} type="button" onclick={() => updateSettings({ showNsfw: !store.settings.showNsfw })}></button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_filterByBlockedTags")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_filterByBlockedTagsHint")}</p>
                  </div>
                  <button
                    class="settings-toggle"
                    class:is-on={store.settings.filterBlockedTags}
                    type="button"
                    role="switch"
                    aria-checked={store.settings.filterBlockedTags}
                    aria-label={$_("settings_inline_filterByBlockedTags")}
                    onclick={() => updateSettings({ filterBlockedTags: !store.settings.filterBlockedTags })}
                  ></button>
                </div>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_blockedTags")}</p>
              <div class="settings-chip-list">
                {#each (store.settings.nsfwFilteredTags ?? []) as tag}
                  <span class="settings-chip settings-chip--removable">
                    <Tag size={10} weight="light" />
                    {tag}
                    <button class="content-tag-remove" type="button" onclick={() => removeTag(tag)} title={$_("settings_inline_removeTag")}>×</button>
                  </span>
                {/each}
                {#if (store.settings.nsfwFilteredTags ?? []).length === 0}
                  <span class="settings-chip settings-chip--empty">{$_("settings_inline_noBlockedTags")}</span>
                {/if}
              </div>
              <div class="settings-card__footer">
                <input
                  class="settings-text-input"
                  placeholder={$_("settings_inline_addTagSubstring")}
                  bind:value={newTagInput}
                  onkeydown={(e) => { if (e.key === "Enter") addTag(); }}
                />
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={addTag} disabled={!newTagInput.trim()}>{$_("common_add")}</button>
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={resetTags}>{$_("settings_inline_reset")}</button>
              </div>
            </div>

            <div class="settings-card">
              <p class="settings-card__title">{$_("settings_inline_sourceRules")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_allowedSources")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_allowedSourcesHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => { contentSourceRulesMode = "allowed"; contentSourceRulesOpen = true; }}>{$_("settings_inline_manage")}</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_blockedSources")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_blockedSourcesHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => { contentSourceRulesMode = "blocked"; contentSourceRulesOpen = true; }}>{$_("settings_inline_manage")}</button>
                </div>
              </div>
              {#if contentSourceRulesOpen}
                <div class="settings-card__surface" style="margin-top:16px">
                  <div class="settings-card__head">
                    <p class="settings-card__title">{contentSourceRulesMode === "allowed" ? $_("settings_inline_allowedSources") : $_("settings_inline_blockedSources")}</p>
                    <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (contentSourceRulesOpen = false)}>{$_("common_close")}</button>
                  </div>
                  <p class="settings-card__intro">{$_("settings_inline_sourceRulesHint")}</p>
                  <div class="content-source-search-wrap">
                    <input class="settings-text-input" placeholder={$_("settings_inline_filterSources")} bind:value={sourceSearch} />
                  </div>
                  {#if contentSourcesLoading}
                    <NocturneState layout="compact" tone="info" icon="retry" eyebrow={$_("sources.eyebrow")} title={$_("settings_inline_loadingSources")} />
                  {:else if contentSources.length === 0}
                    <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("sources.eyebrow")} title={$_("settings_inline_noSourcesFound")} body={$_("feedback.checkSourceConnection")} />
                  {:else}
                    <div class="content-source-list">
                      {#each contentSourcesFiltered as group (group.name)}
                        {@const ids = group.sources.map((source) => source.id)}
                        {@const allowed = store.settings.nsfwAllowedSourceIds ?? []}
                        {@const blocked = store.settings.nsfwBlockedSourceIds ?? []}
                        {@const isAllowed = ids.every((id) => allowed.includes(id))}
                        {@const isBlocked = ids.every((id) => blocked.includes(id))}
                        <div class="content-source-row" class:content-source-allowed={isAllowed} class:content-source-blocked={isBlocked}>
                          <img src={resolveServiceIconUrl(group.iconUrl, { kind: "source" })} alt="" class="content-source-icon" loading="lazy" decoding="async" onerror={(event) => applyServiceIconFallback(event, "source")} />
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
                              title={isAllowed ? $_("settings_security_removeAllowOverride") : $_("settings_security_allowOverride")}
                            >{$_("settings_inline_allow")}</button>
                            <button
                              class="content-action-btn"
                              class:content-action-active-block={isBlocked}
                              type="button"
                              onclick={() => toggleSourceBlocked(ids)}
                              title={isBlocked ? $_("settings_security_removeBlockOverride") : $_("settings_security_blockOverride")}
                            >{$_("settings_inline_block")}</button>
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
              <p class="settings-card__title">{$_("settings_inline_about")}</p>
              <p class="settings-card__intro settings-card__intro--body">{$_("settings_inline_aboutBody")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_currentBuild")}</p>
                    <p class="settings-mini-row__hint">v{appVersion}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => { releasesError = null; loadReleases(); }} disabled={releasesLoading}>
                    {releasesLoading ? $_("ui_loading") : $_("ui_checkUpdates")}
                  </button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_releaseHistory")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_releaseHistoryHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => { aboutReleasesOpen = !aboutReleasesOpen; if (aboutReleasesOpen) loadReleases(); }}>
                    {aboutReleasesOpen ? $_("settings_about_hide") : $_("common_browse")}
                  </button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">GitHub</p>
                    <p class="settings-mini-row__hint">{EPIGRAPH_GITHUB_REPO}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openProjectGithub}>{$_("settings_inline_open")}</button>
                </div>
              </div>
              {#if availableUpdateRelease && updatePhase === "idle"}
                <div class="update-ready-row update-ready-row--available" data-testid="epigraph-update-available">
                  <span class="update-ready-label">{$_("settings_about_updateAvailable", { version: availableUpdateRelease.tag_name })}</span>
                  <button class="update-action-btn primary" type="button" onclick={() => installUpdate(availableUpdateRelease)}>
                    {IS_WINDOWS ? $_("settings_inline_install") : $_("settings_inline_openOnGithub")}
                  </button>
                </div>
              {/if}
              {#if onLatestVersion}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="success" icon="info" eyebrow={$_("settings_brand_updates")} title={$_("settings_inline_latestVersion")} />
                </div>
              {/if}
              {#if updateCheckError && !releasesLoading}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("settings_brand_updates")} title={$_("feedback.signedUpdatesTitle")} body={$_("feedback.signedUpdatesBody")} />
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
                  <button class="update-action-btn primary" type="button" onclick={restartNow}>{$_("settings_inline_restartNow")}</button>
                  <button class="n-btn n-btn--sm n-btn-ghost settings-mini-action" type="button" onclick={cancelUpdate} title={$_("settings_inline_dismiss")}>{$_("settings_inline_dismiss")}</button>
                </div>
              {/if}
              {#if updatePhase === "error"}
                <div class="settings-state">
                  <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("settings_brand_updates")} title={$_("settings_inline_updateFailed")} body={presentOperationFailure(updateError, $_)} />
                </div>
                <div class="update-error-row">
                  <button class="n-btn n-btn--sm n-btn-ghost settings-mini-action" type="button" onclick={cancelUpdate}>{$_("settings_inline_dismiss")}</button>
                </div>
              {/if}
              {#if aboutReleasesOpen}
              <div class="settings-card__surface" style="margin-top:16px" data-testid="epigraph-release-history">
                <div class="settings-card__head">
                  <p class="settings-card__title">{$_("settings_inline_releases")}</p>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={() => (aboutReleasesOpen = false)}>{$_("common_close")}</button>
                </div>
                {#if releasesError}
                  <div class="settings-state">
                    <NocturneState layout="compact" tone="warning" icon="warning" eyebrow={$_("ui_releases")} title={$_("settings_inline_couldNotFetchReleases")} body={presentOperationFailure(releasesError, $_)} />
                  </div>
                {:else if releasesLoading}
                  <NocturneState layout="compact" tone="info" icon="retry" eyebrow={$_("ui_releases")} title={$_("settings_inline_fetchingReleases")} />
                {:else if releases.length === 0}
                  <NocturneState layout="compact" tone="info" icon="info" eyebrow={$_("ui_releases")} title={$_("settings_inline_noReleasesFound")} />
                {:else}
                  <div class="release-list-scroll">
                    <div class="release-list">
                      {#each releases as release}
                        {@const isCurrent = isCurrentVersion(release.tag_name)}
                        {@const isExpanded = expandedTag === release.tag_name}
                        {@const notes = desktopReleaseNotes(release.body)}
                        <div class="release-row" class:current={isCurrent}>
                          <div class="release-header">
                            <div class="release-meta">
                              <span class="release-tag">{release.tag_name}</span>
                              {#if isCurrent}
                                <span class="release-badge current-badge">{$_("ui_installed")}</span>
                              {/if}
                              {#if release.published_at}
                                <span class="release-date">{fmtDate(release.published_at)}</span>
                              {/if}
                            </div>
                            <div class="release-actions">
                              {#if notes}
                                <button class="release-changelog-btn" type="button" onclick={() => expandedTag = isExpanded ? null : release.tag_name}>{isExpanded ? $_("settings_about_hide") : $_("settings_about_changelog")}</button>
                              {/if}
                            </div>
                          </div>
                          {#if isExpanded && notes}
                            <div class="release-body">
                              <pre class="release-body-pre">{notes}</pre>
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
            <SuwayomiUpdatePanel />
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
              <p class="settings-card__title">{$_("settings_inline_devTools")}</p>
              <div class="settings-card__stack">
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_previewIdleScreen")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_previewIdleScreenHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" onclick={triggerSplash} style={splashTriggered ? "background:var(--accent-fg);color:var(--bg-base);border-color:var(--accent-fg);transition:all 0.15s ease" : ""}>
                    {$_("settings_inline_showIdle")}
                  </button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_openLogs")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_openLogsHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" onclick={openAppLogs}>{$_("settings_inline_open")}</button>
                </div>
                <div class="settings-row settings-mini-row">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_buildMode")}</p>
                    <p class="settings-mini-row__hint settings-mini-row__hint--mono">{import.meta.env.MODE}</p>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-card settings-reset-card">
              <p class="settings-card__title">{$_("settings_inline_resetSettings")}</p>
              <p class="settings-card__intro settings-card__intro--body">{$_("settings_inline_resetSettingsHint")}</p>
              <div class="settings-card__surface settings-reset-card__surface">
                <div class="settings-row settings-mini-row settings-mini-row--stretch">
                  <div class="settings-mini-row__body">
                    <p class="settings-mini-row__label">{$_("settings_inline_resetAllConfigsToDefault")}</p>
                    <p class="settings-mini-row__hint">{$_("settings_inline_resetAllConfigsHint")}</p>
                  </div>
                  <button class="n-btn n-btn--sm settings-reset-all-btn" type="button" onclick={resetAllSettingsToDefaults}>
                    {$_("settings_inline_resetAllSettings")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </section>
  </div>
  {#if advStorageOpen && storageAdvancedSource === "backup"}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="mg-overlay backup-modal-overlay"
      class:backup-modal-overlay--first-run={firstRunPane === "backup"}
      onclick={(e) => { if (firstRunPane !== "backup" && e.target === e.currentTarget && !backupRestoring) closeStorageBackupPanel(); }}
    >
      <div class="mg-modal backup-modal" role="dialog" aria-modal="true" aria-labelledby="backup-modal-title" tabindex="-1" bind:this={backupSectionEl}>
        <header class="mg-header">
          <div class="mg-heading backup-heading">
            {#if backupViewMode === "restore" && backupRestorePage !== "main"}
              <button class="mg-close" type="button" disabled={backupRestoring} onclick={() => (backupRestorePage = "main")}>
                <CaretLeft size={16} weight="bold" /><span class="mg-sr-only">{$_("ui_back")}</span>
              </button>
            {/if}
            <h2 id="backup-modal-title" class="mg-title">
              {#if backupViewMode === "create"}
                {$_("settings_backup_createTitle")}
              {:else if backupRestorePage === "sources"}
                {$_("settings_backup_sourcesTitle")}
              {:else if backupRestorePage === "confirm"}
                {$_("settings_backup_confirmTitle")}
              {:else}
                {$_("settings_backup_restoreTitle")}
              {/if}
            </h2>
          </div>
          {#if firstRunPane !== "backup"}
            <button class="mg-close" type="button" onclick={closeStorageBackupPanel}>
              <X size={16} weight="bold" /><span class="mg-sr-only">{$_("common_close")}</span>
            </button>
          {/if}
        </header>
        <div class="mg-body">
          {#if backupViewMode === "create"}
            <p class="mg-note">{$_("settings_backup_createIntro")}</p>
            <div class="mg-list">
              <div class="mg-row backup-switch-row">
                <span class="mg-row-copy"><strong>{$_("settings_backup_includeComics")}</strong><small>{$_("settings_backup_includeComicsHint")}</small></span>
                <button role="switch" aria-checked={backupUnifiedIncludeManga} aria-label={$_("settings_backup_includeComics")}
                  class="mg-check" class:is-checked={backupUnifiedIncludeManga} type="button"
                  onclick={() => { backupUnifiedIncludeManga = !backupUnifiedIncludeManga; backupSavedPath = null; }}>
                  {#if backupUnifiedIncludeManga}<Check size={13} weight="bold" />{/if}
                </button>
              </div>
              {#if backupOnlyMangaSelected}
                <div class="mg-row backup-switch-row backup-sub-row">
                  <span class="mg-row-copy"><strong>{$_("settings_backup_mihonFormat")}</strong><small>{$_("settings_backup_mihonFormatHint")}</small></span>
                  <button role="switch" aria-checked={backupMangaNativeFormat} aria-label={$_("settings_backup_mihonFormat")}
                    class="mg-check" class:is-checked={backupMangaNativeFormat} type="button"
                    onclick={() => { backupMangaNativeFormat = !backupMangaNativeFormat; backupSavedPath = null; }}>
                    {#if backupMangaNativeFormat}<Check size={13} weight="bold" />{/if}
                  </button>
                </div>
              {/if}
              <div class="mg-row backup-switch-row">
                <span class="mg-row-copy"><strong>{$_("settings_backup_includeBooks")}</strong><small>{$_("settings_backup_includeBooksHint")}</small></span>
                <button role="switch" aria-checked={backupUnifiedIncludeBooks} aria-label={$_("settings_backup_includeBooks")}
                  class="mg-check" class:is-checked={backupUnifiedIncludeBooks} type="button"
                  onclick={() => { backupUnifiedIncludeBooks = !backupUnifiedIncludeBooks; backupSavedPath = null; }}>
                  {#if backupUnifiedIncludeBooks}<Check size={13} weight="bold" />{/if}
                </button>
              </div>
              {#if backupUnifiedIncludeBooks}
                <div class="mg-row backup-switch-row backup-sub-row">
                  <span class="mg-row-copy"><strong>{$_("settings_backup_booksWithoutFiles")}</strong><small>{$_("settings_backup_booksWithoutFilesHint")}</small></span>
                  <button role="switch" aria-checked={backupBooksOnlyMetadataOnly} aria-label={$_("settings_backup_booksWithoutFiles")}
                    class="mg-check" class:is-checked={backupBooksOnlyMetadataOnly} type="button"
                    onclick={() => { backupBooksOnlyMetadataOnly = !backupBooksOnlyMetadataOnly; backupSavedPath = null; }}>
                    {#if backupBooksOnlyMetadataOnly}<Check size={13} weight="bold" />{/if}
                  </button>
                </div>
              {/if}
              <div class="mg-row backup-switch-row">
                <span class="mg-row-copy"><strong>{$_("settings_backup_includeNovels")}</strong><small>{$_("settings_backup_includeNovelsHint")}</small></span>
                <button role="switch" aria-checked={backupUnifiedIncludeNovels} aria-label={$_("settings_backup_includeNovels")}
                  class="mg-check" class:is-checked={backupUnifiedIncludeNovels} type="button"
                  onclick={() => { backupUnifiedIncludeNovels = !backupUnifiedIncludeNovels; backupSavedPath = null; }}>
                  {#if backupUnifiedIncludeNovels}<Check size={13} weight="bold" />{/if}
                </button>
              </div>
              <div class="mg-row backup-switch-row">
                <span class="mg-row-copy"><strong>{$_("settings_backup_includeHistory")}</strong><small>{$_("settings_backup_includeHistoryHint")}</small></span>
                <button role="switch" aria-checked={backupUnifiedIncludeApp} aria-label={$_("settings_backup_includeHistory")}
                  class="mg-check" class:is-checked={backupUnifiedIncludeApp} type="button"
                  onclick={() => { backupUnifiedIncludeApp = !backupUnifiedIncludeApp; backupSavedPath = null; }}>
                  {#if backupUnifiedIncludeApp}<Check size={13} weight="bold" />{/if}
                </button>
              </div>
            </div>
            {#if backupSavedPath}
              <p class="mg-note backup-saved-path">{backupSavedPath}</p>
            {:else if backupError}
              <div class="mg-note is-warn backup-error" role="alert">
                <strong>{$_("settings_inline_backupActionFailed")}</strong>
                <span>{presentOperationFailure(backupError, $_)}</span>
              </div>
            {/if}
          {:else if backupViewMode === "restore"}
            <div class="backup-restore">
              <input bind:this={backupFileInput} type="file" accept=".epigraphbk,.aethonbk,.tachibk,.proto.gz,.proto,.zip,*/*" style="display:none" onchange={onBackupFileSelected} />
              {#if backupRestorePage === "sources"}
                <div class="backup-page">
                    {#if backupSelectedFile && (backupImportKind === "manga" || backupUnifiedPlan?.payloads.some(payload => payload.kind === "manga"))}
                      {#key backupSelectedFile}
                        <RestoreMangaDependencies bind:this={mangaDependencyPanel} file={backupSelectedFile}
                          format={backupImportKind === "epigraph" ? "epigraph" : "native"} choices={backupReviewSelections}
                          disabled={backupRestoring || backupValidating || backupDependenciesWorking || backupRestoreTargetMode !== "current-profile"}
                          onBusy={busy => backupDependenciesWorking = busy}
                          onChoices={choices => backupReviewSelections = choices}
                          onChanged={async () => {
                            if (backupImportKind === "manga") await refreshBackupReadiness();
                            else if (backupSelectedFile) {
                              const selection = { ...backupUnifiedSelection };
                              await loadUnifiedBackupPlanBytes(await backupSelectedFile.arrayBuffer());
                              backupUnifiedSelection = selection;
                            }
                          }} />
                      {/key}
                    {/if}
                    {#if backupSelectedFile && (backupImportKind === "novels-lnreader" || backupUnifiedPlan?.payloads.some(payload => payload.kind === "novels"))}
                      {#key backupSelectedFile}
                        <RestoreNovelDependencies file={backupSelectedFile} format={backupImportKind === "novels-lnreader" ? "lnreader" : "epigraph"}
                          disabled={backupRestoring || backupValidating || backupRestoreTargetMode !== "current-profile"}
                          onBusy={busy => backupDependenciesWorking = busy}
                          onChanged={async () => {
                            if (backupImportKind === "epigraph" && backupSelectedFile) {
                              const selection = { ...backupUnifiedSelection };
                              await loadUnifiedBackupPlanBytes(await backupSelectedFile.arrayBuffer());
                              backupUnifiedSelection = selection;
                            }
                          }} />
                      {/key}
                    {/if}
                </div>
              {:else if backupRestorePage === "confirm"}
                <div class="backup-page backup-confirm">
                  <p>{$_("settings_backup_confirmTarget", { target: backupCurrentTargetSummary })}</p>
                  {#if backupDependencyPreview?.requiresConfirmation}
                    <p class="mg-note">{$_("settings_backup_confirmRepositories")}</p>
                  {/if}
                </div>
              {:else if backupRestoreResults && !backupRestoring && !backupError}
                <div class="backup-page">
                  <section data-backup-results>
                    <div class="mg-list">
                      {#each backupRestoreResults as result}
                        <div class="mg-row backup-result-row">
                          <span class="mg-row-copy">
                            <strong>{backupPayloadKindLabel(result.kind)} - {backupPayloadStatusLabel(result.outcome === "unknown" ? "unknown" : result.status)}</strong>
                            {#if result.kind === "repositories"}
                              <small>{result.summary}</small>
                              <ul class="backup-names backup-skipped-repos">
                                {#each result.warnings as url}
                                  <li title={url}><span>{backupRepositoryShortName(url)}</span></li>
                                {/each}
                              </ul>
                            {:else}
                              <small>{restoreNote(result.outcome, $_)}{#each [...new Set(result.warnings.map(warning => restoreNote(warning, $_)))] as note}<br />{note}{/each}{#if result.detail}<br />{restoreNote(result.detail, $_)}{/if}</small>
                            {/if}
                          </span>
                        </div>
                      {/each}
                    </div>
                  </section>
                </div>
              {:else}
                <div class="backup-page">
                  {#if backupSelectedFile}
                    <div class="mg-row backup-file-row">
                      <span class="mg-row-copy">
                        <strong>{backupSelectedFileLabel ?? $_("settings_inline_noBackupSelectedYet")}</strong>
                        <small>{#if backupDependencyPreview?.titleCount != null}{backupDependencyPreview.titleCount} {$_("ui_titles")}{#if backupDependencyPreview.chapterCount != null}{" · "}{backupDependencyPreview.chapterCount} {$_("ui_chapters")}{/if}{:else if backupValidating}{$_("settings_inline_inspecting")}{:else if backupImportKind === "epigraph"}.epigraphbk{/if}</small>
                      </span>
                      <button class="mg-btn" type="button" onclick={triggerBackupImport} disabled={backupExporting || backupValidating || backupRestoring}>
                        {$_("settings_backup_change")}
                      </button>
                    </div>
                  {:else}
                    <button class="backup-pick" type="button" onclick={triggerBackupImport} disabled={backupExporting || backupValidating || backupRestoring}>
                      <FileArrowUp size={28} weight="duotone" />
                      <strong>{backupValidating ? $_("settings_inline_inspecting") : $_("settings_backup_pickTitle")}</strong>
                      <small>.tachibk · .epigraphbk · LNReader .zip</small>
                    </button>
                  {/if}
                  {#if backupRestoreHandoffSession}
                    <p class="mg-note">{$_("settings_inline_restoreHandoffActive")}</p>
                  {:else if backupRestoreSourceProfileId}
                    <p class="mg-note">{$_("settings_inline_originSession", { session: getLocalProfileMeta(backupRestoreSourceProfileId)?.label ?? backupRestoreSourceProfileId.toUpperCase() })}</p>
                  {/if}
                  {#if backupImportKind === "epigraph" && backupUnifiedPlan}
                    <div class="backup-page" data-backup-review>
                      {#if backupUnifiedPlan.executionBlockedReason}
                        <p class="mg-note is-warn" role="alert"><Warning size={14} weight="bold" /> {$_("settings_inline_restoreBlocked")}</p>
                      {/if}
                      <div class="mg-list">
                        {#each backupPayloadsInCreateOrder(backupUnifiedPlan.payloads) as payload}
                          <div class="mg-row backup-switch-row">
                            <span class="mg-row-copy">
                              <strong>{backupPayloadKindLabel(payload.kind)}</strong>
                              <small>{backupPayloadCount(payload) ?? (payload.kind === "app" ? $_("settings_backup_includeHistoryHint") : restorePayloadSummary(payload, $_))}</small>
                            </span>
                            {#if isPayloadExecutable(payload)}
                              <button role="switch" aria-checked={Boolean(backupUnifiedSelection[payload.kind])} aria-label={backupPayloadKindLabel(payload.kind)}
                                class="mg-check" class:is-checked={Boolean(backupUnifiedSelection[payload.kind])} type="button"
                                disabled={!payload.canExecuteRestore || !payload.canRestoreNow || backupRestoring}
                                onclick={() => { backupUnifiedSelection = { ...backupUnifiedSelection, [payload.kind]: !Boolean(backupUnifiedSelection[payload.kind]) }; }}>
                                {#if backupUnifiedSelection[payload.kind]}<Check size={13} weight="bold" />{/if}
                              </button>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    </div>
                  {:else if backupImportKind === "manga"}
                    {#if backupRestoreTargetMode === "other-local-profile" && otherLocalProfileMeta}
                      <p class="mg-note">{$_("outcomes.restoreHandoff", { profile: profileName(otherLocalProfileMeta.label) })}</p>
                    {/if}
                  {/if}
                  {#if backupShowsSourcesRow}
                    <div class="mg-list">
                      <button class="mg-row backup-nav-row" type="button" onclick={() => (backupRestorePage = "sources")} disabled={backupRestoring}>
                        <span class="mg-row-copy">
                          <strong>{$_("settings_backup_sourcesTitle")}</strong>
                          <small>{backupSourcesStatus}</small>
                        </span>
                        <CaretRight size={14} weight="bold" />
                      </button>
                    </div>
                  {/if}
                  {#if backupImportKind && backupCanUseOtherProfileTarget}
                    <p class="mg-note backup-target-label">{$_("settings_inline_restoreTarget")}</p>
                    <div class="mg-segmented" role="group" aria-label={$_("settings_inline_restoreTarget")}>
                      <button type="button" aria-pressed={backupRestoreTargetMode === "other-local-profile"}
                        onclick={() => {
                          backupRestoreTargetMode = "other-local-profile";
                          backupRestoreCurrentProfileConfirmed = false;
                        }}>
                        {otherLocalProfileMeta ? $_("settings_inline_restoreIntoProfile", { profile: profileName(otherLocalProfileMeta.label) }) : $_("settings_inline_otherLocalProfile")}
                      </button>
                      <button type="button" aria-pressed={backupRestoreTargetMode === "current-profile"}
                        onclick={() => (backupRestoreTargetMode = "current-profile")}>
                        {$_("settings_inline_currentProfile")}
                      </button>
                    </div>
                  {/if}
                  {#if backupImportKind && backupResolvedExecutionBlockedReason}
                    <p class="mg-note is-warn" role="alert"><Warning size={14} weight="bold" /> {$_("settings_inline_restoreTargetNeedsAttention")}</p>
                  {/if}
                  {#if backupValidating || backupRestoring}
                    <div class="backup-progress" role="status" aria-live="polite">
                      <div class="backup-progress__line">
                        <span
                          class:is-determinate={Boolean(backupRestoring && backupRestoreStatus?.totalManga)}
                          style={backupRestoring && backupRestoreStatus?.totalManga
                            ? `width:${Math.min(100, Math.round((backupRestoreStatus.mangaProgress / backupRestoreStatus.totalManga) * 100))}%`
                            : undefined}
                        ></span>
                      </div>
                      <p>
                        {backupValidating ? $_("settings_inline_inspecting") : $_("settings_inline_restoring")}
                        {#if backupRestoring && backupRestoreStatus?.totalManga}
                          · {backupRestoreStatus.mangaProgress}/{backupRestoreStatus.totalManga}
                        {/if}
                      </p>
                      {#if backupRestoring && activeRestoreWorkflow}
                        <button class="n-btn n-btn--sm n-btn-ghost" type="button" disabled={restoreCancellationRequested} onclick={cancelRestore}>{$_("ui_cancel")}</button>
                      {/if}
                    </div>
                  {/if}
                  {#if backupError}
                    <div class="mg-note is-warn backup-error" role="alert">
                      <strong>{$_("settings_inline_backupActionFailed")}</strong>
                      <span>{presentOperationFailure(backupError, $_)}</span>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
        {#if backupViewMode === "create"}
          <footer class="mg-footer">
            <span class="mg-spacer"></span>
            <button class="mg-btn mg-btn--primary" type="button" onclick={exportBackup} disabled={backupExporting || backupValidating || backupRestoring || backupNothingSelected}>
              {backupExporting ? $_("settings_inline_exporting") : $_("settings_inline_exportBackup")}
            </button>
          </footer>
        {:else if backupViewMode === "restore" && !(firstRunPane === "backup" && backupRestoreResults && !backupRestoring && !backupError && backupRestorePage === "main")}
          <footer class="mg-footer">
            {#if backupRestorePage === "confirm"}
              <button class="mg-btn" type="button" onclick={() => (backupRestorePage = "main")}>
                {$_("ui_back")}
              </button>
              <span class="mg-spacer"></span>
              <button class="mg-btn mg-btn--primary" type="button" onclick={confirmSelectedRestore} disabled={backupStartDisabled}>
                {backupRestoreButtonLabel()}
              </button>
            {:else if backupRestorePage === "sources"}
              <span class="mg-spacer"></span>
              <button class="mg-btn mg-btn--primary" type="button" disabled={backupDependenciesWorking} onclick={() => (backupRestorePage = "main")}>
                {$_("settings_backup_done")}
              </button>
            {:else if backupRestoreResults && !backupRestoring && !backupError}
              <span class="mg-spacer"></span>
              <button class="mg-btn mg-btn--primary" type="button" onclick={closeStorageBackupPanel}>
                {$_("settings_backup_done")}
              </button>
            {:else}
              {#if backupImportKind}
                <span class="mg-spacer"></span>
                <button class="mg-btn mg-btn--primary" type="button" onclick={startSelectedRestore} disabled={backupStartDisabled}>
                  {backupRestoreButtonLabel()}
                </button>
              {/if}
            {/if}
          </footer>
        {/if}
      </div>
    </div>
  {/if}
</main>
<script module lang="ts">
  function focusInput(node: HTMLElement) { node.focus(); }
  function focusEl(node: HTMLElement) { setTimeout(() => node.focus(), 0); }
</script>
<style>
  .step-controls { display: flex; align-items: center; gap: var(--sp-1); flex-shrink: 0; }
  .step-btn { font-family: var(--font-ui); font-size: 12px; font-weight: 700; width: 30px; height: 30px; border-radius: var(--component-settings-step-button-radius); border: 1px solid var(--component-settings-input-border); background: var(--component-settings-button-bg); color: var(--component-settings-text-secondary); cursor: pointer; transition: color var(--t-base), border-color var(--t-base), background var(--t-base), transform 100ms ease; display: flex; align-items: center; justify-content: center; }
  .step-btn:hover:not(:disabled) { color: var(--component-settings-text-primary); border-color: var(--component-settings-border-strong); background: var(--component-settings-button-bg-hover); }
  .step-btn:active:not(:disabled) { transform: scale(0.97); }
  .step-btn:disabled { opacity: 0.3; cursor: default; }
  .step-val { font-family: var(--font-ui); font-size: 11px; color: var(--component-settings-text-muted); letter-spacing: 0; min-width: 40px; text-align: center; text-transform: none; }
  .select-wrap { position: relative; flex-shrink: 0; }
  /* Reader pane: one heading per reader so manga, novel and book options never read as shared. */
  .settings-reader-group { grid-column: 1 / -1; margin: 10px 0 -4px; padding: 0 2px; font-family: var(--font-ui); font-size: 13px; font-weight: 700; letter-spacing: 0.02em; color: var(--component-settings-text-secondary); }
  .settings-reader-group:first-child { margin-top: 0; }
  .settings-subgroup { display: grid; margin-left: 14px; padding-left: 12px; border-left: 2px solid var(--component-settings-border-dim); transition: opacity 120ms ease; }
  .settings-subgroup.is-disabled { opacity: 0.55; }

  .prose-color-pickers {
    display: flex;
    gap: var(--component-settings-color-picker-group-gap);
  }

  .prose-color-picker {
    width: var(--component-settings-color-picker-size);
    height: var(--component-settings-color-picker-size);
    padding: 0;
    border: var(--component-settings-color-picker-border);
    border-radius: var(--component-settings-color-picker-radius);
    overflow: hidden;
    background: var(--component-settings-color-picker-bg);
    cursor: pointer;
  }
  .select-btn { display: flex; align-items: center; gap: var(--sp-2); min-height: 32px; font-size: 12px; font-weight: 600; color: var(--component-settings-text-primary); background: var(--component-settings-input-bg); border: 1px solid var(--component-settings-input-border); border-radius: var(--component-settings-select-button-radius); padding: 0 12px; cursor: pointer; min-width: 130px; transition: background 250ms ease, transform 450ms var(--ui-spring); }
  .select-btn:hover { background: var(--component-settings-surface-overlay); }
  .select-btn:active { transform: scale(0.97); }
  .select-btn--wide { min-width: 190px; }
  .select-menu--scroll { max-height: min(320px, calc(var(--visual-vh, 100vh) - 160px)); overflow-y: auto; overscroll-behavior: contain; }
  .select-caret { color: var(--text-faint); transition: transform var(--t-base); flex-shrink: 0; margin-left: auto; }
  .select-caret.open { transform: rotate(180deg); }
  .select-menu { position: absolute; top: calc(100% + 4px); right: 0; min-width: 100%; background: var(--component-settings-select-menu-bg); border: 1px solid var(--component-settings-select-menu-border); border-radius: var(--radius-md); padding: var(--sp-1); z-index: var(--component-settings-select-menu-z-index); box-shadow: var(--component-settings-select-menu-shadow); animation: scaleIn 320ms var(--ui-spring) both; transform-origin: top right; }
  .select-option { display: block; width: 100%; padding: 6px var(--sp-3); border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--text-secondary); background: none; border: none; cursor: pointer; text-align: left; transition: background var(--t-fast), color var(--t-fast); }
  .select-option:hover { background: var(--bg-overlay); color: var(--text-primary); }
  .select-option.active { color: var(--accent-fg); background: var(--accent-muted); }
  .scale-row { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); }
  .scale-slider { flex: 1; }
  .scale-val-input {
    font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-secondary);
    width: 42px; text-align: center; padding: 3px 4px;
    background: var(--component-settings-input-bg); border: 1px solid transparent;
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
    border-radius: var(--component-settings-mini-action-radius);
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
  .settings-storage-meter {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--sp-4);
    margin-top: 20px;
  }
  .settings-storage-meter__text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .settings-storage-meter__value {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--text-muted);
    line-height: var(--leading-snug);
    white-space: nowrap;
    text-align: right;
  }
  .settings-storage-meter__value.is-empty {
    font-family: var(--font-ui);
    color: var(--text-faint);
  }
  .storage-bar {
    width: 100%;
    height: 5px;
    margin-top: 14px;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--component-settings-meter-track-bg);
    box-shadow: var(--component-settings-meter-track-shadow);
  }
  .storage-bar-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--component-settings-meter-fill-bg);
    transition: width 220ms ease;
  }
  .storage-bar-fill.warn {
    background: var(--component-settings-meter-warn-bg);
  }
  .storage-bar-fill.critical {
    background: var(--component-settings-meter-critical-bg);
  }
  .settings-storage-footer {
    margin-top: 18px;
    justify-content: space-between;
    gap: var(--sp-3);
  }
  .settings-storage-footer .settings-card__footer-status {
    min-width: 0;
    white-space: nowrap;
  }
  .settings-storage-action-group {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--sp-2);
    flex-wrap: wrap;
    margin-left: auto;
  }
  .path-input-error {
    border-color: var(--component-settings-border-focus) !important;
    box-shadow: var(--component-focus-ring);
  }
  .release-list-scroll { max-height: 336px; overflow-y: auto; padding: 0 var(--sp-1); scrollbar-width: thin; scrollbar-color: var(--border-base) transparent; }
  .release-list-scroll::-webkit-scrollbar { width: 4px; }
  .release-list-scroll::-webkit-scrollbar-track { background: transparent; }
  .release-list-scroll::-webkit-scrollbar-thumb { background: var(--border-base); border-radius: var(--component-settings-scrollbar-radius); }
  .folder-delete:hover:not(:disabled) { color: var(--color-error) !important; }
  .folder-hidden { opacity: 0.35; }
  .folder-default-active { color: var(--accent-fg) !important; }
  .folder-update-excluded {
    color: var(--color-warning) !important;
    border-color: var(--color-warning-bg) !important;
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
  .update-ready-row--available { margin-top: var(--sp-3); }
  .update-ready-label { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--accent-fg); letter-spacing: var(--tracking-wide); flex: 1; }
  .update-error-row { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); padding: var(--sp-2) 0 0; }
  .tracker-identity { display: flex; align-items: center; gap: var(--sp-3); flex-shrink: 0; }
  .tracker-logo { width: 28px; height: 28px; border-radius: var(--radius-sm); object-fit: contain; flex-shrink: 0; }
  .tracker-name-block { display: flex; flex-direction: column; gap: 3px; }
  .tracker-label { font-size: var(--text-sm); color: var(--text-secondary); font-weight: var(--weight-medium); }
  .tracker-status-pill { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: 0; text-transform: none; padding: 2px 8px; border-radius: var(--radius-full); border: 0; color: var(--text-faint); background: var(--ui-surface); width: fit-content; }
  .tracker-status-pill.pill-on { color: var(--accent-fg); background: var(--accent-muted); }
  .tracker-action { display: flex; flex-direction: column; align-items: flex-end; gap: var(--sp-2); flex: 1; min-width: 0; }
  .sec-status-pill { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: 0; text-transform: none; padding: 2px 8px; border-radius: var(--radius-full); border: 0; color: var(--text-faint); background: var(--ui-surface); flex-shrink: 0; cursor: default; }
  .sec-pill-on { color: var(--accent-fg); background: var(--accent-muted); }
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

  .backup-modal-overlay { z-index: var(--component-settings-storage-overlay-z-index); }
  .backup-modal { width: min(640px, calc(100vw - 48px)); max-height: min(86vh, 820px); }
  .backup-modal-overlay--first-run {
    position: absolute;
    inset: 0;
    z-index: auto;
    align-items: stretch;
    background: transparent;
    backdrop-filter: none;
    animation: none;
  }
  .backup-modal-overlay--first-run .backup-modal {
    width: 100%;
    max-height: none;
    border: 0;
    border-radius: inherit;
    background: transparent;
    box-shadow: none;
    animation: none;
  }
  .backup-switch-row { cursor: default; }
  .backup-sub-row { padding-left: 28px; }
  .backup-target-label { margin: 4px 0 -4px; }
  .backup-saved-path { color: var(--accent-fg); overflow-wrap: anywhere; }
  .backup-progress { display: grid; gap: 7px; margin-top: 12px; }
  .backup-progress p { margin: 0; color: var(--text-muted); font-size: var(--text-xs); }
  .backup-progress__line { height: 3px; overflow: hidden; border-radius: var(--radius-full); background: var(--bg-overlay); }
  .backup-progress__line span { display: block; width: 38%; height: 100%; border-radius: inherit; background: var(--accent-fg); animation: backupProgress 1.2s ease-in-out infinite; }
  .backup-progress__line span.is-determinate { animation: none; transition: width var(--t-base); }
  .backup-restore { display: grid; gap: 14px; }
  .backup-file-row .mg-row-copy small,
  .backup-result-row .mg-row-copy small { white-space: normal; overflow-wrap: anywhere; }
  .backup-file-row, .backup-result-row { cursor: default; }
  .backup-names { margin: 8px 0 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px 12px; }
  .backup-names li { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--text-secondary); font-size: var(--text-xs); }
  .backup-names li span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .backup-skipped-repos { margin-top: 6px; }
  .backup-error { display: grid; gap: 4px; }
  .backup-error strong { color: var(--text-primary); font-size: var(--text-sm); }
  .backup-error span { color: var(--text-muted); font-size: var(--text-xs); overflow-wrap: anywhere; }
  @keyframes backupProgress { from { transform: translateX(-110%); } to { transform: translateX(290%); } }
  .backup-page { display: grid; gap: 14px; }
  .backup-heading { display: flex; align-items: center; gap: 8px; }
  .backup-pick { display: grid; justify-items: center; gap: 6px; width: 100%; padding: 36px 16px; border: 1px dashed var(--border-base); border-radius: var(--radius-md); background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; }
  .backup-pick:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
  .backup-pick strong { color: var(--text-primary); font-size: var(--text-sm); }
  .backup-pick small { color: var(--text-muted); font-size: var(--text-xs); }
  .backup-nav-row { width: 100%; border: 0; background: transparent; font: inherit; color: inherit; text-align: left; cursor: pointer; }
  .backup-nav-row:disabled { cursor: default; opacity: .6; }
  .backup-confirm p { margin: 0; color: var(--text-primary); }
  .backup-file-row .mg-row-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>




