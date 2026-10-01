// Settings, Sources and the restore flows import these statically, so a lazy import could not split them out.
import * as novelsStateBridge from "../backup/novelsStateBridge";
import * as novelsRestoreProvisioning from "../backup/novelsRestoreProvisioning";
import * as novelPackages from "../novels/packages";

export const SETTINGS_EPIGRAPH_BACKUP_EXTENSION = ".epigraphbk" as const;

export type SettingsStorageRuntime = {
  parseMihonBackup: typeof import("../backup/mihonBackup").parseMihonBackup;
  embedMihonExtensionStores: typeof import("../backup/mihonBackup").embedMihonExtensionStores;
  buildEpigraphBackupContainer: typeof import("../backup/epigraphBackup").buildEpigraphBackupContainer;
  buildEpigraphRestorePlan: typeof import("../backup/epigraphRestorePlanner").buildEpigraphRestorePlan;
  buildEpigraphAppPayload: typeof import("../backup/appBackup").buildEpigraphAppPayload;
  parseEpigraphAppPayload: typeof import("../backup/appBackup").parseEpigraphAppPayload;
  buildEpigraphBooksSnapshotFromLibraryState: typeof import("../backup/booksBackup").buildEpigraphBooksSnapshotFromLibraryState;
  buildEpigraphBooksPayload: typeof import("../backup/booksBackup").buildEpigraphBooksPayload;
  parseEpigraphBooksPayload: typeof import("../backup/booksBackup").parseEpigraphBooksPayload;
  restoreEpigraphBooksPayload: typeof import("../backup/booksBackup").restoreEpigraphBooksPayload;
  extractEpigraphMangaPayloadFile: typeof import("../backup/mangaBackup").extractEpigraphMangaPayloadFile;
  parseEpigraphMangaPayload: typeof import("../backup/mangaBackup").parseEpigraphMangaPayload;
  buildEpigraphMangaPayload: typeof import("../backup/mangaBackup").buildEpigraphMangaPayload;
  buildEpigraphNovelsPayload: typeof import("../backup/novelsBackup").buildEpigraphNovelsPayload;
  parseEpigraphNovelsPayload: typeof import("../backup/novelsBackup").parseEpigraphNovelsPayload;
  restoreEpigraphNovelsPayload: typeof import("../backup/novelsBackup").restoreEpigraphNovelsPayload;
  buildLnReaderNovelsBackupZip: typeof import("../backup/lnreaderBackup").buildLnReaderNovelsBackupZip;
  restoreLnReaderNovelsBackup: typeof import("../backup/lnreaderBackup").restoreLnReaderNovelsBackup;
  parseLnReaderNovelsBackup: typeof import("../backup/lnreaderBackup").parseLnReaderNovelsBackup;
  isLnReaderBackupZip: typeof import("../backup/lnreaderBackup").isLnReaderBackupZip;
  extractLnReaderBackupPluginIds: typeof import("../backup/lnreaderBackup").extractLnReaderBackupPluginIds;
  normalizeNativeMangaBackupBytes: typeof import("../backup/mangaNativeFormat").normalizeNativeMangaBackupBytes;
  buildEpigraphNovelsSnapshotFromAuthoritativeState: typeof import("../backup/novelsStateBridge").buildEpigraphNovelsSnapshotFromAuthoritativeState;
  applyRestoredNovelsSnapshotToLibraryState: typeof import("../backup/novelsStateBridge").applyRestoredNovelsSnapshotToLibraryState;
  provisionEpigraphNovelDependencies: typeof import("../backup/novelsRestoreProvisioning").provisionEpigraphNovelDependencies;
  loadNovelsProfileSnapshot: typeof import("../backup/novelsProfileState").loadNovelsProfileSnapshot;
  applyRestoredNovelsProfileSnapshot: typeof import("../backup/novelsProfileState").applyRestoredNovelsProfileSnapshot;
  loadSourceInventory: typeof import("../reconciliation/sourceInventory").loadSourceInventory;
  readOverlayFile: typeof import("../reconciliation/overlay").readOverlayFile;
  upsertOverlayEntry: typeof import("../reconciliation/overlay").upsertOverlayEntry;
  analyzeBackupReconciliation: typeof import("../reconciliation/analyze").analyzeBackupReconciliation;
  overlayEntryFromAnalysis: typeof import("../reconciliation/analyze").overlayEntryFromAnalysis;
  buildReconciledBackupFile: typeof import("../reconciliation/restore").buildReconciledBackupFile;
  readFileAsArrayBuffer: typeof import("../books/storage").readFileAsArrayBuffer;
  loadBookLibraryState: typeof import("../books/libraryState").loadBookLibraryState;
  loadNovelRepositoryState: typeof import("../novels/repositoryState").loadNovelRepositoryState;
  saveNovelRepositoryState: typeof import("../novels/repositoryState").saveNovelRepositoryState;
  addNovelRepositoryToState: typeof import("../novels/repositoryState").addNovelRepositoryToState;
  setNovelRepositoryTrustState: typeof import("../novels/repositoryState").setNovelRepositoryTrustState;
  refreshNovelRepositoryCatalog: typeof import("../novels/repositoryState").refreshNovelRepositoryCatalog;
  installNovelCatalogPlugin: typeof import("../novels/packages").installNovelCatalogPlugin;
  loadNovelLibraryState: typeof import("../novels/libraryState").loadNovelLibraryState;
  saveNovelLibraryState: typeof import("../novels/libraryState").saveNovelLibraryState;
};

let settingsStorageRuntimePromise: Promise<SettingsStorageRuntime> | null = null;

export function loadSettingsStorageRuntime(): Promise<SettingsStorageRuntime> {
  settingsStorageRuntimePromise ??= Promise.all([
    import("../backup/mihonBackup"),
    import("../backup/epigraphBackup"),
    import("../backup/epigraphRestorePlanner"),
    import("../backup/appBackup"),
    import("../backup/booksBackup"),
    import("../backup/mangaBackup"),
    import("../backup/novelsBackup"),
    import("../backup/lnreaderBackup"),
    import("../backup/mangaNativeFormat"),
    import("../backup/novelsProfileState"),
    import("../reconciliation/sourceInventory"),
    import("../reconciliation/overlay"),
    import("../reconciliation/analyze"),
    import("../reconciliation/restore"),
    import("../books/storage"),
    import("../books/libraryState"),
    import("../novels/repositoryState"),
    import("../novels/libraryState"),
  ]).then(
    ([
      mihonBackup,
      epigraphBackup,
      restorePlanner,
      appBackup,
      booksBackup,
      mangaBackup,
      novelsBackup,
      lnreaderBackup,
      mangaNativeFormat,
      novelsProfileState,
      sourceInventory,
      overlay,
      analyze,
      restore,
      booksStorage,
      booksLibraryState,
      novelRepositoryState,
      novelLibraryState,
    ]) => ({
      parseMihonBackup: mihonBackup.parseMihonBackup,
      embedMihonExtensionStores: mihonBackup.embedMihonExtensionStores,
      buildEpigraphBackupContainer: epigraphBackup.buildEpigraphBackupContainer,
      buildEpigraphRestorePlan: restorePlanner.buildEpigraphRestorePlan,
      buildEpigraphAppPayload: appBackup.buildEpigraphAppPayload,
      parseEpigraphAppPayload: appBackup.parseEpigraphAppPayload,
      buildEpigraphBooksSnapshotFromLibraryState: booksBackup.buildEpigraphBooksSnapshotFromLibraryState,
      buildEpigraphBooksPayload: booksBackup.buildEpigraphBooksPayload,
      parseEpigraphBooksPayload: booksBackup.parseEpigraphBooksPayload,
      restoreEpigraphBooksPayload: booksBackup.restoreEpigraphBooksPayload,
      extractEpigraphMangaPayloadFile: mangaBackup.extractEpigraphMangaPayloadFile,
      parseEpigraphMangaPayload: mangaBackup.parseEpigraphMangaPayload,
      buildEpigraphMangaPayload: mangaBackup.buildEpigraphMangaPayload,
      buildEpigraphNovelsPayload: novelsBackup.buildEpigraphNovelsPayload,
      parseEpigraphNovelsPayload: novelsBackup.parseEpigraphNovelsPayload,
      restoreEpigraphNovelsPayload: novelsBackup.restoreEpigraphNovelsPayload,
      buildLnReaderNovelsBackupZip: lnreaderBackup.buildLnReaderNovelsBackupZip,
      restoreLnReaderNovelsBackup: lnreaderBackup.restoreLnReaderNovelsBackup,
      parseLnReaderNovelsBackup: lnreaderBackup.parseLnReaderNovelsBackup,
      isLnReaderBackupZip: lnreaderBackup.isLnReaderBackupZip,
      extractLnReaderBackupPluginIds: lnreaderBackup.extractLnReaderBackupPluginIds,
      normalizeNativeMangaBackupBytes: mangaNativeFormat.normalizeNativeMangaBackupBytes,
      buildEpigraphNovelsSnapshotFromAuthoritativeState: novelsStateBridge.buildEpigraphNovelsSnapshotFromAuthoritativeState,
      applyRestoredNovelsSnapshotToLibraryState: novelsStateBridge.applyRestoredNovelsSnapshotToLibraryState,
      provisionEpigraphNovelDependencies: novelsRestoreProvisioning.provisionEpigraphNovelDependencies,
      loadNovelsProfileSnapshot: novelsProfileState.loadNovelsProfileSnapshot,
      applyRestoredNovelsProfileSnapshot: novelsProfileState.applyRestoredNovelsProfileSnapshot,
      loadSourceInventory: sourceInventory.loadSourceInventory,
      readOverlayFile: overlay.readOverlayFile,
      upsertOverlayEntry: overlay.upsertOverlayEntry,
      analyzeBackupReconciliation: analyze.analyzeBackupReconciliation,
      overlayEntryFromAnalysis: analyze.overlayEntryFromAnalysis,
      buildReconciledBackupFile: restore.buildReconciledBackupFile,
      readFileAsArrayBuffer: booksStorage.readFileAsArrayBuffer,
      loadBookLibraryState: booksLibraryState.loadBookLibraryState,
      loadNovelRepositoryState: novelRepositoryState.loadNovelRepositoryState,
      saveNovelRepositoryState: novelRepositoryState.saveNovelRepositoryState,
      addNovelRepositoryToState: novelRepositoryState.addNovelRepositoryToState,
      setNovelRepositoryTrustState: novelRepositoryState.setNovelRepositoryTrustState,
      refreshNovelRepositoryCatalog: novelRepositoryState.refreshNovelRepositoryCatalog,
      installNovelCatalogPlugin: novelPackages.installNovelCatalogPlugin,
      loadNovelLibraryState: novelLibraryState.loadNovelLibraryState,
      saveNovelLibraryState: novelLibraryState.saveNovelLibraryState,
    }),
  );

  return settingsStorageRuntimePromise;
}
