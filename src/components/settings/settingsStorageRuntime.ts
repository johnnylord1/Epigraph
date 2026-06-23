export const SETTINGS_AETHON_BACKUP_EXTENSION = ".aethonbk" as const;

export type SettingsStorageRuntime = {
  parseMihonBackup: typeof import("../../lib/backup/mihonBackup").parseMihonBackup;
  buildAethonBackupContainer: typeof import("../../lib/backup/aethonBackup").buildAethonBackupContainer;
  buildAethonRestorePlan: typeof import("../../lib/backup/aethonRestorePlanner").buildAethonRestorePlan;
  buildAethonAppPayload: typeof import("../../lib/backup/appBackup").buildAethonAppPayload;
  parseAethonAppPayload: typeof import("../../lib/backup/appBackup").parseAethonAppPayload;
  buildAethonBooksSnapshotFromLibraryState: typeof import("../../lib/backup/booksBackup").buildAethonBooksSnapshotFromLibraryState;
  buildAethonBooksPayload: typeof import("../../lib/backup/booksBackup").buildAethonBooksPayload;
  restoreAethonBooksPayload: typeof import("../../lib/backup/booksBackup").restoreAethonBooksPayload;
  extractAethonMangaPayloadFile: typeof import("../../lib/backup/mangaBackup").extractAethonMangaPayloadFile;
  buildAethonMangaPayload: typeof import("../../lib/backup/mangaBackup").buildAethonMangaPayload;
  buildAethonNovelsPayload: typeof import("../../lib/backup/novelsBackup").buildAethonNovelsPayload;
  restoreAethonNovelsPayload: typeof import("../../lib/backup/novelsBackup").restoreAethonNovelsPayload;
  buildLnReaderNovelsBackupZip: typeof import("../../lib/backup/lnreaderBackup").buildLnReaderNovelsBackupZip;
  restoreLnReaderNovelsBackup: typeof import("../../lib/backup/lnreaderBackup").restoreLnReaderNovelsBackup;
  isLnReaderBackupZip: typeof import("../../lib/backup/lnreaderBackup").isLnReaderBackupZip;
  extractLnReaderBackupPluginIds: typeof import("../../lib/backup/lnreaderBackup").extractLnReaderBackupPluginIds;
  normalizeNativeMangaBackupBytes: typeof import("../../lib/backup/mangaNativeFormat").normalizeNativeMangaBackupBytes;
  buildAethonNovelsSnapshotFromAuthoritativeState: typeof import("../../lib/backup/novelsStateBridge").buildAethonNovelsSnapshotFromAuthoritativeState;
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
    import("../../lib/backup/aethonBackup"),
    import("../../lib/backup/aethonRestorePlanner"),
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
      aethonBackup,
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
      buildAethonBackupContainer: aethonBackup.buildAethonBackupContainer,
      buildAethonRestorePlan: restorePlanner.buildAethonRestorePlan,
      buildAethonAppPayload: appBackup.buildAethonAppPayload,
      parseAethonAppPayload: appBackup.parseAethonAppPayload,
      buildAethonBooksSnapshotFromLibraryState: booksBackup.buildAethonBooksSnapshotFromLibraryState,
      buildAethonBooksPayload: booksBackup.buildAethonBooksPayload,
      restoreAethonBooksPayload: booksBackup.restoreAethonBooksPayload,
      extractAethonMangaPayloadFile: mangaBackup.extractAethonMangaPayloadFile,
      buildAethonMangaPayload: mangaBackup.buildAethonMangaPayload,
      buildAethonNovelsPayload: novelsBackup.buildAethonNovelsPayload,
      restoreAethonNovelsPayload: novelsBackup.restoreAethonNovelsPayload,
      buildLnReaderNovelsBackupZip: lnreaderBackup.buildLnReaderNovelsBackupZip,
      restoreLnReaderNovelsBackup: lnreaderBackup.restoreLnReaderNovelsBackup,
      isLnReaderBackupZip: lnreaderBackup.isLnReaderBackupZip,
      extractLnReaderBackupPluginIds: lnreaderBackup.extractLnReaderBackupPluginIds,
      normalizeNativeMangaBackupBytes: mangaNativeFormat.normalizeNativeMangaBackupBytes,
      buildAethonNovelsSnapshotFromAuthoritativeState: novelsStateBridge.buildAethonNovelsSnapshotFromAuthoritativeState,
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
