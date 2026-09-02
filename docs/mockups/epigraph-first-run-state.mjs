import { getFirstRunPageDepth } from "./epigraph-first-run-catalog.mjs";

const THEMES = new Set(["nocturne", "dark", "amoled", "high-contrast", "light", "light-contrast", "midnight", "warm"]);
const ENTRY_PATHS = new Set(["sync", "backup", "fresh"]);
const BACKUP_KINDS = new Set(["epigraph", "manga", "novels-lnreader"]);
const REPOSITORY_KINDS = new Set(["manga", "novels"]);
export function getFirstRunMotionDirection(currentPage, nextPage) {
  if (currentPage === nextPage) return "none";
  if (currentPage === "backup-review" && nextPage === "sources") return "forward";
  if (currentPage === "deferred") return "forward";
  const currentDepth = getFirstRunPageDepth(currentPage);
  const nextDepth = getFirstRunPageDepth(nextPage);
  if (currentDepth === null || nextDepth === null) return "forward";
  return nextDepth < currentDepth ? "back" : "forward";
}

export function createFirstRunState() {
  return {
    page: "theme",
    theme: "light",
    entryPath: null,
    syncStatus: "idle",
    syncError: null,
    backupFiles: [],
    backupStatus: "idle",
    backupError: null,
    repositories: [],
    installedExtensionIds: [],
    libraryWorkIds: [],
    connectedTrackerIds: [],
    connectingTrackerId: null,
    trackerError: null,
    trackerNextPage: null,
    trackerPreviousPage: null,
    pendingRepositoryKinds: [],
    pendingExtensionIds: [],
    restoredLibraryCount: 0,
    deferredFrom: null,
  };
}

export function restartFirstRun() {
  return createFirstRunState();
}

export function selectTheme(state, theme) {
  if (!THEMES.has(theme)) throw new Error(`Unknown theme: ${theme}`);
  return { ...state, theme };
}

export function continueFromTheme(state) {
  return state.page === "theme" ? { ...state, page: "entry" } : state;
}

export function chooseEntryPath(state, entryPath) {
  if (state.page !== "entry") return state;
  if (!ENTRY_PATHS.has(entryPath)) throw new Error(`Unknown entry path: ${entryPath}`);
  const page = entryPath === "sync" ? "sync" : entryPath === "backup" ? "backups" : "sources";
  return { ...state, page, entryPath };
}

export function completeSync(state, { hasLibrary }) {
  if (state.page !== "sync") return state;
  return routeThroughTrackers({ ...state, syncStatus: "connected", syncError: null }, hasLibrary ? "complete" : "discover", "sync");
}

export function failSync(state, message) {
  if (state.page !== "sync") return state;
  return { ...state, syncStatus: "error", syncError: message };
}

export function addBackup(state, file) {
  if (state.page !== "backups") return state;
  if (!BACKUP_KINDS.has(file.kind)) throw new Error(`Unsupported backup kind: ${file.kind}`);
  if (state.backupFiles.some((candidate) => candidate.id === file.id)) return state;
  return { ...state, backupFiles: [...state.backupFiles, { ...file }], backupStatus: "idle" };
}

export function removeBackup(state, fileId) {
  return { ...state, backupFiles: state.backupFiles.filter((file) => file.id !== fileId) };
}

export function reviewBackups(state) {
  if (state.page !== "backups" || state.backupFiles.length === 0) return state;
  return { ...state, page: "backup-review", backupStatus: "reviewing" };
}

export function completeBackupRestore(state, { hasLibrary }) {
  if (state.page !== "backup-review") return state;
  const restoredRepositories = state.backupFiles.flatMap((file) => Array.from({ length: file.repositoryCount ?? 0 }, (_, index) => ({
    id: `backup-repo-${file.id}-${index + 1}`,
    url: `backup://${file.id}/repository/${index + 1}`,
    kind: file.kind === "novels-lnreader" ? "novels" : "manga",
    status: "ready",
    extensions: [],
  })));
  const restoredExtensionIds = state.backupFiles.flatMap((file) => Array.from({ length: file.extensionCount ?? 0 }, (_, index) => `backup-extension-${file.id}-${index + 1}`));
  const pendingRepositoryKinds = [...new Set(state.backupFiles.flatMap((file) => file.requiredRepositoryKinds ?? []))];
  const pendingExtensionIds = [...new Set(state.backupFiles.flatMap((file) => file.requiredExtensionIds ?? []))];
  const restoredLibraryCount = state.backupFiles.reduce((total, file) => total + (file.workCount ?? 0), 0);
  const restoredState = {
    ...state,
    backupStatus: "restored",
    backupError: null,
    repositories: restoredRepositories,
    installedExtensionIds: [...new Set([...state.installedExtensionIds, ...restoredExtensionIds])],
    pendingRepositoryKinds,
    pendingExtensionIds,
    restoredLibraryCount,
  };
  return pendingRepositoryKinds.length
    ? { ...restoredState, page: "sources" }
    : routeThroughTrackers(restoredState, hasLibrary ? "complete" : "discover", "backup-review");
}

export function failBackupRestore(state, message) {
  if (state.page !== "backup-review") return state;
  return { ...state, backupStatus: "error", backupError: message };
}

export function retryBackupRestore(state) {
  if (state.page !== "backup-review" || state.backupStatus !== "error") return state;
  return { ...state, backupStatus: "reviewing", backupError: null };
}

export function summarizeBackups(state) {
  return state.backupFiles.reduce((summary, file) => ({
    workCount: summary.workCount + (file.workCount ?? 0),
    repositoryCount: summary.repositoryCount + (file.repositoryCount ?? 0),
    extensionCount: summary.extensionCount + Math.max(file.extensionCount ?? 0, file.requiredExtensionIds?.length ?? 0),
    conflictCount: summary.conflictCount + (file.conflictCount ?? 0),
    kinds: [...new Set([...summary.kinds, ...(file.libraryKinds ?? [])])],
  }), { workCount: 0, repositoryCount: 0, extensionCount: 0, conflictCount: 0, kinds: [] });
}

export function addRepository(state, repository) {
  if (state.page !== "sources") return state;
  if (!REPOSITORY_KINDS.has(repository.kind)) throw new Error(`Unsupported repository kind: ${repository.kind}`);
  const parsed = new URL(repository.url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Repository URL must use HTTP or HTTPS");
  if (state.repositories.some((candidate) => candidate.id === repository.id || candidate.url === repository.url)) return state;
  return {
    ...state,
    repositories: [...state.repositories, { ...repository, status: "loading", extensions: [] }],
  };
}

export function loadRepositoryCatalog(state, repositoryId, extensions) {
  return {
    ...state,
    repositories: state.repositories.map((repository) => repository.id === repositoryId
      ? { ...repository, status: "ready", extensions: extensions.map((extension) => ({ ...extension })) }
      : repository),
  };
}

export function failRepositoryCatalog(state, repositoryId, message) {
  return {
    ...state,
    repositories: state.repositories.map((repository) => repository.id === repositoryId
      ? { ...repository, status: "error", error: message, extensions: [] }
      : repository),
  };
}

export function retryRepositoryCatalog(state, repositoryId) {
  return {
    ...state,
    repositories: state.repositories.map((repository) => repository.id === repositoryId
      ? { ...repository, status: "loading", error: null }
      : repository),
  };
}

export function installExtension(state, extensionId) {
  if (state.page !== "sources") return state;
  const isAvailable = state.repositories.some((repository) => repository.status === "ready"
    && repository.extensions.some((extension) => extension.id === extensionId));
  if (!isAvailable) return state;
  if (state.installedExtensionIds.includes(extensionId)) return state;
  return { ...state, installedExtensionIds: [...state.installedExtensionIds, extensionId] };
}

export function getVisibleExtensions(state) {
  const available = state.repositories
    .filter((repository) => repository.status === "ready")
    .flatMap((repository) => repository.extensions)
    .filter((extension, index, extensions) => extensions.findIndex((candidate) => candidate.id === extension.id) === index);
  if (state.entryPath !== "backup") return available;
  const required = new Set(state.pendingExtensionIds);
  return available.filter((extension) => required.has(extension.id));
}

export function installVisibleExtensions(state) {
  return getVisibleExtensions(state).reduce((nextState, extension) => installExtension(nextState, extension.id), state);
}

export function continueFromSources(state) {
  if (state.page !== "sources" || state.installedExtensionIds.length === 0) return state;
  const missingExtensions = state.pendingExtensionIds.filter((extensionId) => !state.installedExtensionIds.includes(extensionId));
  if (missingExtensions.length) return state;
  const configuredKinds = state.repositories.filter((repository) => repository.status === "ready"
    && repository.extensions.some((extension) => state.installedExtensionIds.includes(extension.id)))
    .map((repository) => repository.kind);
  const remainingKinds = state.pendingRepositoryKinds.filter((kind) => !configuredKinds.includes(kind));
  if (remainingKinds.length) return state;
  return routeThroughTrackers({
    ...state,
    pendingRepositoryKinds: [],
    pendingExtensionIds: [],
  }, state.restoredLibraryCount > 0 ? "complete" : "discover", "sources");
}

function routeThroughTrackers(state, nextPage, previousPage) {
  return { ...state, page: "trackers", trackerNextPage: nextPage, trackerPreviousPage: previousPage };
}

export function startTrackerConnection(state, providerId) {
  if (state.page !== "trackers" || !providerId || state.connectingTrackerId) return state;
  return { ...state, connectingTrackerId: providerId, trackerError: null };
}

export function recoverInterruptedTrackerConnection(state) {
  if (state.page !== "trackers" || !state.connectingTrackerId) return state;
  return {
    ...state,
    connectingTrackerId: null,
    trackerError: "O login foi interrompido quando o app fechou. Tente conectar novamente.",
  };
}

export function completeTrackerConnection(state, providerId) {
  if (state.page !== "trackers" || state.connectingTrackerId !== providerId) return state;
  return {
    ...state,
    connectingTrackerId: null,
    trackerError: null,
    connectedTrackerIds: state.connectedTrackerIds.includes(providerId)
      ? state.connectedTrackerIds
      : [...state.connectedTrackerIds, providerId],
  };
}

export function failTrackerConnection(state, providerId, message) {
  if (state.page !== "trackers" || state.connectingTrackerId !== providerId) return state;
  return { ...state, connectingTrackerId: null, trackerError: message };
}

export function continueFromTrackers(state) {
  if (state.page !== "trackers") return state;
  return { ...state, page: state.trackerNextPage ?? "discover", trackerNextPage: null, trackerPreviousPage: null };
}

export function backFromTrackers(state) {
  if (state.page !== "trackers" || !state.trackerPreviousPage) return state;
  return { ...state, page: state.trackerPreviousPage };
}

export function addLibraryWork(state, workId) {
  if (state.libraryWorkIds.includes(workId)) return state;
  return { ...state, libraryWorkIds: [...state.libraryWorkIds, workId] };
}

export function deferFirstRun(state) {
  if (state.page === "deferred" || state.page === "complete") return state;
  return { ...state, page: "deferred", deferredFrom: state.page };
}

export function resumeFirstRun(state) {
  if (state.page !== "deferred" || !state.deferredFrom) return state;
  return { ...state, page: state.deferredFrom, deferredFrom: null };
}
