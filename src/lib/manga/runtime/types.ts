export type CompatibilityProfileId = "suwayomi-v21" | "suwayomi-v23";

export type RuntimeCapability =
  | "extensionStoresV2"
  | "directJarInstall"
  | "extensionApi16"
  | "sourcePreferences"
  | "sourcePreferenceWrite"
  | "sourceFilters";

export type SourcePreferenceAccess = "unsupported" | "read-only" | "read-write";

export interface RuntimeCapabilities {
  extensionStoresV2: boolean;
  directJarInstall: boolean;
  extensionApi16: boolean;
  sourcePreferences: boolean;
  sourcePreferenceWrite: boolean;
  sourcePreferenceAccess: SourcePreferenceAccess;
  /** Search can apply a source's own filters (genre, demographic, ...). */
  sourceFilters: boolean;
  supported: readonly RuntimeCapability[];
}

export interface RuntimeInfo {
  name: string;
  version: string;
  revision: string | null;
  buildType: string | null;
  buildTime: number | null;
  profileId: CompatibilityProfileId;
  schemaHash: string;
  compatible: boolean;
}

export interface RuntimeFingerprint {
  serverVersion: string;
  canonicalSchemaHash: string;
  capabilitiesHash: string;
  endpointIdentity: string;
  instanceNonce: string | null;
  localRuntimeGeneration: string | null;
}

export interface RuntimeContract {
  requiredQueries: readonly string[];
  requiredMutations: readonly string[];
  requiredFields: Readonly<Record<string, readonly string[]>>;
  optionalCapabilities: readonly RuntimeCapability[];
}

export interface RuntimeContractReport {
  compatible: boolean;
  missingQueries: readonly string[];
  missingMutations: readonly string[];
  missingFields: Readonly<Record<string, readonly string[]>>;
  capabilities: RuntimeCapabilities;
}

export interface ExtensionStore {
  id: string;
  name: string;
  indexUrl: string;
  badgeLabel: string | null;
  signingFingerprint: string | null;
  contactWebsite: string | null;
  contactDiscord: string | null;
  extensionListUrl: string | null;
  isLegacy: boolean;
}

export interface ExtensionStoreInput {
  indexUrl: string;
  signal?: AbortSignal;
  assertTarget?: () => void;
}

export type ExtensionArtifactType = "apk" | "jar";
export type ExtensionVerificationMethod =
  | "APK_CERTIFICATE"
  | "JAR_SIGNATURE"
  | "SIGNED_STORE_METADATA"
  | "NONE";

export interface ExtensionProvenance {
  packageName: string;
  versionCode: string;
  versionName: string;
  storeId: string | null;
  storeUrl: string | null;
  artifactType: ExtensionArtifactType | null;
  artifactDigest: string | null;
  declaredSigningFingerprint: string | null;
  observedSigningFingerprint: string | null;
  verificationMethod: ExtensionVerificationMethod;
  trustAnchor: string | null;
  runtimeVersion: string | null;
}

export interface ExtensionRef {
  packageName: string;
  name: string;
  language: string;
  versionName: string;
  versionCode: string;
  isInstalled: boolean;
  isObsolete: boolean;
  hasUpdate: boolean;
  isNsfw?: boolean;
  iconUrl: string | null;
  storeId: string | null;
  apkName: string | null;
  apkUrl: string | null;
  jarUrl: string | null;
}

export interface SourceRef {
  id: string;
  name: string;
  displayName: string;
  language: string;
  iconUrl: string | null;
  isNsfw: boolean;
  supportsLatest: boolean | null;
  isConfigurable: boolean | null;
  extensionPackageName: string | null;
}

interface SourcePreferenceBase {
  key: string;
  title: string;
  summary: string | null;
  enabled: boolean;
  visible: boolean;
}

export interface CheckboxSourcePreference extends SourcePreferenceBase {
  type: "CheckBoxPreference";
  defaultValue: boolean;
  currentValue: boolean | null;
}

export interface SwitchSourcePreference extends SourcePreferenceBase {
  type: "SwitchPreference";
  defaultValue: boolean;
  currentValue: boolean | null;
}

export interface ListSourcePreference extends SourcePreferenceBase {
  type: "ListPreference";
  defaultValue: string | null;
  currentValue: string | null;
  entries: readonly string[];
  entryValues: readonly string[];
}

export interface EditTextSourcePreference extends SourcePreferenceBase {
  type: "EditTextPreference";
  defaultValue: string | null;
  currentValue: string | null;
  text: string | null;
  dialogTitle: string | null;
  dialogMessage: string | null;
}

export interface MultiSelectSourcePreference extends SourcePreferenceBase {
  type: "MultiSelectListPreference";
  defaultValue: readonly string[] | null;
  currentValue: readonly string[] | null;
  entries: readonly string[];
  entryValues: readonly string[];
  dialogTitle: string | null;
  dialogMessage: string | null;
}

export interface UnsupportedSourcePreference extends SourcePreferenceBase {
  type: "UnsupportedPreference";
  upstreamType: string;
}

export type SourcePreference =
  | CheckboxSourcePreference
  | SwitchSourcePreference
  | ListSourcePreference
  | EditTextSourcePreference
  | MultiSelectSourcePreference
  | UnsupportedSourcePreference;

export interface SourcePreferenceUpdateInput {
  sourceId: string;
  position: number;
  expectedKey: string;
  expectedType: Exclude<SourcePreference["type"], "UnsupportedPreference">;
  value: boolean | string | readonly string[];
  signal?: AbortSignal;
}

export interface SourcePreferenceGroup {
  source: SourceRef;
  preferences: readonly SourcePreference[];
  status: "pending" | "loading" | "ready" | "error";
  error: string | null;
}

export type SourceSearchMode = "SEARCH" | "POPULAR" | "LATEST";

export type SourceFilterKind =
  | "checkbox"
  | "tristate"
  | "select"
  | "sort"
  | "text"
  | "group"
  | "header"
  | "separator";

/** A search filter a source offers, in the source's own words. Its position is its index. */
export interface SourceFilter {
  kind: SourceFilterKind;
  name: string;
  /** The options of a select or sort filter. */
  values: readonly string[];
  /** The filters inside a group, each at its own index. */
  filters: readonly SourceFilter[];
}

export type SourceFilterTriState = "IGNORE" | "INCLUDE" | "EXCLUDE";

/** A change to one filter, by position; a group's change names the filter inside it. */
export interface SourceFilterChange {
  position: number;
  checkBoxState?: boolean;
  triState?: SourceFilterTriState;
  selectState?: number;
  groupChange?: SourceFilterChange;
}

export interface SourceSearchInput {
  sourceId: string;
  mode: SourceSearchMode;
  page: number;
  query?: string;
  /** Source filters to apply; only a SEARCH reads them. */
  filters?: readonly SourceFilterChange[];
  signal?: AbortSignal;
}

export interface SourceItemRef {
  id: number;
  sourceId: string;
}

export interface SourceSearchItem extends SourceItemRef {
  title: string;
  thumbnailUrl: string | null;
  inLibrary: boolean;
  status: string | null;
  source: SourceRef | null;
}

export interface SourceSearchResult {
  items: readonly SourceSearchItem[];
  hasNextPage: boolean;
}

export interface SourceItemDetails extends SourceSearchItem {
  description: string | null;
  author: string | null;
  artist: string | null;
  genres: readonly string[];
  realUrl: string | null;
}

export interface SourceChapterRef {
  id: number;
  mangaId: number;
}

export interface SourceChapter extends SourceChapterRef {
  name: string;
  chapterNumber: number;
  sourceOrder: number;
  isRead: boolean;
  isDownloaded: boolean;
  isBookmarked: boolean;
  pageCount: number;
  uploadDate: string | null;
  realUrl: string | null;
  lastPageRead: number;
  scanlator: string | null;
}

export interface SourcePage {
  index: number;
  url: string;
}

export interface ExtensionInstallInput {
  packageName: string;
  signal?: AbortSignal;
  assertTarget?: () => void;
}

export interface ExtensionUpdateInput {
  packageName: string;
  signal?: AbortSignal;
}

export interface SourceRuntime {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  getRuntimeFingerprint(): Promise<RuntimeFingerprint>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  listStores(signal?: AbortSignal): Promise<readonly ExtensionStore[]>;
  addStore(input: ExtensionStoreInput): Promise<ExtensionStore>;
  removeStore(indexUrl: string, signal?: AbortSignal): Promise<ExtensionStore | null>;
  listExtensions(signal?: AbortSignal): Promise<readonly ExtensionRef[]>;
  refreshExtensions(signal?: AbortSignal, assertTarget?: () => void): Promise<readonly ExtensionRef[]>;
  listSources(signal?: AbortSignal): Promise<readonly SourceRef[]>;
  getSourcePreferences(sourceId: string, signal?: AbortSignal): Promise<readonly SourcePreference[]>;
  updateSourcePreference(input: SourcePreferenceUpdateInput): Promise<readonly SourcePreference[]>;
  getSourceFilters(sourceId: string, signal?: AbortSignal): Promise<readonly SourceFilter[]>;
  installExtension(input: ExtensionInstallInput): Promise<void>;
  updateExtension(input: ExtensionUpdateInput): Promise<void>;
  uninstallExtension(packageName: string, signal?: AbortSignal): Promise<void>;
  search(input: SourceSearchInput): Promise<SourceSearchResult>;
  getDetails(input: SourceItemRef, signal?: AbortSignal): Promise<SourceItemDetails>;
  getChapters(input: SourceItemRef, signal?: AbortSignal): Promise<readonly SourceChapter[]>;
  getPages(input: SourceChapterRef, signal?: AbortSignal): Promise<readonly SourcePage[]>;
}
