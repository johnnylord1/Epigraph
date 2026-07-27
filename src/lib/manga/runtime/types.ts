export type CompatibilityProfileId = "suwayomi-v21" | "suwayomi-v23";

export type RuntimeCapability =
  | "extensionStoresV2"
  | "directJarInstall"
  | "extensionApi16"
  | "sourcePreferences";

export interface RuntimeCapabilities {
  extensionStoresV2: boolean;
  directJarInstall: boolean;
  extensionApi16: boolean;
  sourcePreferences: boolean;
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

export type SourceSearchMode = "SEARCH" | "POPULAR" | "LATEST";

export interface SourceSearchInput {
  sourceId: string;
  mode: SourceSearchMode;
  page: number;
  query?: string;
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
}

export interface ExtensionUpdateInput {
  packageName: string;
  signal?: AbortSignal;
}

export interface SourceRuntime {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  listStores(signal?: AbortSignal): Promise<readonly ExtensionStore[]>;
  addStore(input: ExtensionStoreInput): Promise<ExtensionStore>;
  removeStore(indexUrl: string, signal?: AbortSignal): Promise<ExtensionStore | null>;
  listExtensions(signal?: AbortSignal): Promise<readonly ExtensionRef[]>;
  refreshExtensions(signal?: AbortSignal): Promise<readonly ExtensionRef[]>;
  listSources(signal?: AbortSignal): Promise<readonly SourceRef[]>;
  installExtension(input: ExtensionInstallInput): Promise<void>;
  updateExtension(input: ExtensionUpdateInput): Promise<void>;
  uninstallExtension(packageName: string, signal?: AbortSignal): Promise<void>;
  search(input: SourceSearchInput): Promise<SourceSearchResult>;
  getDetails(input: SourceItemRef, signal?: AbortSignal): Promise<SourceItemDetails>;
  getChapters(input: SourceItemRef, signal?: AbortSignal): Promise<readonly SourceChapter[]>;
  getPages(input: SourceChapterRef, signal?: AbortSignal): Promise<readonly SourcePage[]>;
}
