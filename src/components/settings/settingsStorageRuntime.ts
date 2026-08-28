export const SETTINGS_EPIGRAPH_BACKUP_EXTENSION = ".epigraphbk" as const;

export type SettingsStorageRuntime = {
  parseMihonBackup: typeof import("../../lib/backup/mihonBackup").parseMihonBackup;
  buildEpigraphBackupContainer: typeof import("../../lib/backup/epigraphBackup").buildEpigraphBackupContainer;
  buildEpigraphRestorePlan: typeof import("../../lib/backup/epigraphRestorePlanner").buildEpigraphRestorePlan;
  buildEpigraphAppPayload: typeof import("../../lib/backup/appBackup").buildEpigraphAppPayload;
  parseEpigraphAppPayload: typeof import("../../lib/backup/appBackup").parseEpigraphAppPayload;
  buildEpigraphBooksSnapshotFromLibraryState: typeof import("../../lib/backup/booksBackup").buildEpigraphBooksSnapshotFromLibraryState;
  buildEpigraphBooksPayload: typeof import("../../lib/backup/booksBackup").buildEpigraphBooksPayload;
  restoreEpigraphBooksPayload: typeof import("../../lib/backup/booksBackup").restoreEpigraphBooksPayload;
  extractEpigraphMangaPayloadFile: typeof import("../../lib/backup/mangaBackup").extractEpigraphMangaPayloadFile;
  buildEpigraphMangaPayload: typeof import("../../lib/backup/mangaBackup").buildEpigraphMangaPayload;
  buildEpigraphNovelsPayload: typeof import("../../lib/backup/novelsBackup").buildEpigraphNovelsPayload;
  restoreEpigraphNovelsPayload: typeof import("../../lib/backup/novelsBackup").restoreEpigraphNovelsPayload;
  buildLnReaderNovelsBackupZip: typeof import("../../lib/backup/lnreaderBackup").buildLnReaderNovelsBackupZip;
  restoreLnReaderNovelsBackup: typeof import("../../lib/backup/lnreaderBackup").restoreLnReaderNovelsBackup;
  isLnReaderBackupZip: typeof import("../../lib/backup/lnreaderBackup").isLnReaderBackupZip;
  extractLnReaderBackupPluginIds: typeof import("../../lib/backup/lnreaderBackup").extractLnReaderBackupPluginIds;
  normalizeNativeMangaBackupBytes: typeof import("../../lib/backup/mangaNativeFormat").normalizeNativeMangaBackupBytes;
  buildEpigraphNovelsSnapshotFromAuthoritativeState: typeof import("../../lib/backup/novelsStateBridge").buildEpigraphNovelsSnapshotFromAuthoritativeState;
  applyRestoredNovelsSnapshotToLibraryState: typeof import("../../lib/backup/novelsStateBridge").applyRestoredNovelsSnapshotToLibraryState;
  loadNovelsProfileSnapshot: typeof import("../../lib/backup/novelsProfileState").loadNovelsProfileSnapshot;
  applyRestoredNovelsProfileSnapshot: typeof import("../../lib/backup/novelsProfileState").applyRestoredNovelsProfileSnapshot;
  loadSourceInventory: typeof import("../../lib/reconciliation/sourceInventory").loadSourceInventory;
  readOverlayFile: typeof import("../../lib/reconciliation/overlay").readOverlayFile;
  upsertOverlayEntry: typeof import("../../lib/reconciliation/overlay").upsertOverlayEntry;
  analyzeBackupReconciliation: typeof import("../../lib/reconciliation/analyze").analyzeBackupReconciliation;
  overlayEntryFromAnalysis: typeof import("../../lib/reconciliation/analyze").overlayEntryFromAnalysis;
  buildReconciledBackupFile: typeof import("../../lib/reconciliation/restore").buildReconciledBackupFile;
  readFileAsArrayBuffer: typeof import("../../lib/books/storage").readFileAsArrayBuffer;
  loadBookLibraryState: typeof import("../../lib/books/libraryState").loadBookLibraryState;
  loadNovelRepositoryState: typeof import("../../lib/novels/repositoryState").loadNovelRepositoryState;
  saveNovelRepositoryState: typeof import("../../lib/novels/repositoryState").saveNovelRepositoryState;
  addNovelRepositoryToState: typeof import("../../lib/novels/repositoryState").addNovelRepositoryToState;
  setNovelRepositoryTrustState: typeof import("../../lib/novels/repositoryState").setNovelRepositoryTrustState;
  refreshNovelRepositoryCatalog: typeof import("../../lib/novels/repositoryState").refreshNovelRepositoryCatalog;
  installNovelCatalogPlugin: typeof import("../../lib/novels/packages").installNovelCatalogPlugin;
  loadNovelLibraryState: typeof import("../../lib/novels/libraryState").loadNovelLibraryState;
  saveNovelLibraryState: typeof import("../../lib/novels/libraryState").saveNovelLibraryState;
};

let settingsStorageRuntimePromise: Promise<SettingsStorageRuntime> | null = null;

export function loadSettingsStorageRuntime(): Promise<SettingsStorageRuntime> {
  settingsStorageRuntimePromise ??= Promise.all([
    import("../../lib/backup/mihonBackup"),
    import("../../lib/backup/epigraphBackup"),
    import("../../lib/backup/epigraphRestorePlanner"),
    import("../../lib/backup/appBackup"),
    import("../../lib/backup/booksBackup"),
    import("../../lib/backup/mangaBackup"),
    import("../../lib/backup/novelsBackup"),
    import("../../lib/backup/lnreaderBackup"),
    import("../../lib/backup/mangaNativeFormat"),
    import("../../lib/backup/novelsStateBridge"),
    import("../../lib/backup/novelsProfileState"),
    import("../../lib/reconciliation/sourceInventory"),
    import("../../lib/reconciliation/overlay"),
    import("../../lib/reconciliation/analyze"),
    import("../../lib/reconciliation/restore"),
    import("../../lib/books/storage"),
    import("../../lib/books/libraryState"),
    import("../../lib/novels/repositoryState"),
    import("../../lib/novels/packages"),
    import("../../lib/novels/libraryState"),
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
      novelsStateBridge,
      novelsProfileState,
      sourceInventory,
      overlay,
      analyze,
      restore,
      booksStorage,
      booksLibraryState,
      novelRepositoryState,
      novelPackages,
      novelLibraryState,
    ]) => ({
      parseMihonBackup: mihonBackup.parseMihonBackup,
      buildEpigraphBackupContainer: epigraphBackup.buildEpigraphBackupContainer,
      buildEpigraphRestorePlan: restorePlanner.buildEpigraphRestorePlan,
      buildEpigraphAppPayload: appBackup.buildEpigraphAppPayload,
      parseEpigraphAppPayload: appBackup.parseEpigraphAppPayload,
      buildEpigraphBooksSnapshotFromLibraryState: booksBackup.buildEpigraphBooksSnapshotFromLibraryState,
      buildEpigraphBooksPayload: booksBackup.buildEpigraphBooksPayload,
      restoreEpigraphBooksPayload: booksBackup.restoreEpigraphBooksPayload,
      extractEpigraphMangaPayloadFile: mangaBackup.extractEpigraphMangaPayloadFile,
      buildEpigraphMangaPayload: mangaBackup.buildEpigraphMangaPayload,
      buildEpigraphNovelsPayload: novelsBackup.buildEpigraphNovelsPayload,
      restoreEpigraphNovelsPayload: novelsBackup.restoreEpigraphNovelsPayload,
      buildLnReaderNovelsBackupZip: lnreaderBackup.buildLnReaderNovelsBackupZip,
      restoreLnReaderNovelsBackup: lnreaderBackup.restoreLnReaderNovelsBackup,
      isLnReaderBackupZip: lnreaderBackup.isLnReaderBackupZip,
      extractLnReaderBackupPluginIds: lnreaderBackup.extractLnReaderBackupPluginIds,
      normalizeNativeMangaBackupBytes: mangaNativeFormat.normalizeNativeMangaBackupBytes,
      buildEpigraphNovelsSnapshotFromAuthoritativeState: novelsStateBridge.buildEpigraphNovelsSnapshotFromAuthoritativeState,
      applyRestoredNovelsSnapshotToLibraryState: novelsStateBridge.applyRestoredNovelsSnapshotToLibraryState,
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
