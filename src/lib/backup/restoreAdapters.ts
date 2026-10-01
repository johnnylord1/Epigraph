import { mergeRestoredNovelsSnapshot, mergeNovelCategories } from "./novelsStateBridge";
import { novelRestoreRuntimeState, planNovelRestoreDependencies } from "./novelsRestoreProvisioning";
import { loadSettingsStorageRuntime } from "./storageRuntime";
import type { RestoredEpigraphNovelsSnapshot } from "./novelsBackup";
import type { PersistedNovelLibraryState } from "../novels/domain";
import { prepareNovelReaderForRestore, type ReaderPreparationResult } from "../reader/restorePreparation";
import type { BooksCategory } from "../../store/state.svelte";

export function preserveNovelCategoriesForBooksRestore<T extends {
  booksCategories: BooksCategory[]; booksCategoryAssignments: Record<string, string[]>;
}>(current: { categories: BooksCategory[]; assignments: Record<string, string[]> }, restored: T, novelIds: readonly string[]): T {
  const merged = mergeNovelCategories({ categories: restored.booksCategories, assignments: restored.booksCategoryAssignments,
    novelIdMap: new Map(novelIds.map(id => [id, id])),
    backupCategories: current.categories.map(category => ({ ...category,
      novelIds: novelIds.filter(id => current.assignments[id]?.includes(category.id)),
    })),
  });
  if (merged.warnings.length) throw Error("RESTORE_NOVEL_CATEGORIES_UNRESOLVED");
  return { ...restored, booksCategories: merged.categories, booksCategoryAssignments: merged.assignments };
}

export function createNovelRestoreAdapter(deps: {
  prepareReader(): Promise<ReaderPreparationResult>;
  validateTarget(): void;
  load(): Promise<PersistedNovelLibraryState>;
  save(state: PersistedNovelLibraryState): Promise<unknown>;
  saveCategories?(categories: NonNullable<RestoredEpigraphNovelsSnapshot["categories"]>, ids: ReadonlyMap<string, string>): Promise<void>;
}) {
  return {
    async restore(restored: RestoredEpigraphNovelsSnapshot) {
      deps.validateTarget();
      if (restored.categories?.length && !deps.saveCategories) throw Error("RESTORE_CATEGORY_PERSISTENCE_UNAVAILABLE");
      const preparation = await deps.prepareReader();
      if (!preparation.ok) throw Error(preparation.code);
      deps.validateTarget();
      const currentState = await deps.load();
      deps.validateTarget();
      const merged = mergeRestoredNovelsSnapshot({ currentState, restored });
      await deps.save(merged.state);
      if (restored.categories?.length) {
        deps.validateTarget();
        await deps.saveCategories!(restored.categories, merged.novelIdMap);
      }
      return merged;
    },
  };
}

/** Both presentation surfaces use this same Novel service and readiness policy. */
export async function prepareProductionNovels(bytes: ArrayBuffer, format: "epigraph" | "lnreader", assertOperationTarget = () => {}) {
  const { store } = await import("../../store/state.svelte");
  assertOperationTarget();
  const scope = { profileId: store.runtimeResolvedLocalProfileId, serverUrl: store.runtimeServerUrl };
  const validateTarget = () => {
    assertOperationTarget();
    if (store.runtimeResolvedLocalProfileId !== scope.profileId || store.runtimeServerUrl !== scope.serverUrl) throw Error("RESTORE_TARGET_CHANGED");
  };
  const runtime = await loadSettingsStorageRuntime();
  const repositories = await runtime.loadNovelRepositoryState(scope);
  validateTarget();
  const available = novelRestoreRuntimeState(repositories);
  const restored = format === "lnreader" ? await runtime.restoreLnReaderNovelsBackup(bytes, available) : await runtime.restoreEpigraphNovelsPayload(bytes, available);
  validateTarget();
  const usedPluginIds = new Set(restored.entries.map(entry => entry.source?.pluginId).filter(Boolean));
  const required = { ...restored, plugins: restored.plugins?.filter(plugin => usedPluginIds.has(plugin.id)) };
  if (restored.summary.restoredNeedsPluginCount || restored.summary.restoredNeedsRepositoryCount
    || planNovelRestoreDependencies(required, repositories).plugins.some(plugin => plugin.status !== "ready")) throw Error("RESTORE_WAITING_FOR_DEPENDENCIES");
  return { restored, scope, validateTarget, runtime };
}

export async function restoreProductionNovels(bytes: ArrayBuffer, format: "epigraph" | "lnreader", assertOperationTarget = () => {}) {
  const { restored, scope, validateTarget, runtime } = await prepareProductionNovels(bytes, format, assertOperationTarget);
  const { loadNovelLibraryStateForRestore } = await import("../novels/libraryState");
  const { bumpContentSetupVersion, store } = await import("../../store/state.svelte");
  validateTarget();
  if (restored.categories?.length) {
    await store.prepareBooksForRestore();
    validateTarget();
  }
  const categoryWarnings: string[] = [];
  const adapter = createNovelRestoreAdapter({ prepareReader: prepareNovelReaderForRestore, validateTarget,
    load: () => loadNovelLibraryStateForRestore(scope), save: state => runtime.saveNovelLibraryState(state, scope),
    saveCategories: async (categories, novelIdMap) => {
      validateTarget();
      const merged = mergeNovelCategories({ categories: store.settings.booksCategories,
        assignments: store.settings.booksCategoryAssignments, backupCategories: categories, novelIdMap });
      store.updateSettings({ booksCategories: merged.categories, booksCategoryAssignments: merged.assignments });
      await store.persistRestoredBooks();
      categoryWarnings.push(...merged.warnings);
    },
  });
  const merged = await adapter.restore(restored);
  bumpContentSetupVersion();
  return { ...restored, mergeWarnings: [...merged.warnings, ...categoryWarnings.map(code => ({ code, novelId: "", field: "categories" }))],
    // Compatibility presentation only; dependency installation belongs to B3.
    provisioning: { warnings: merged.warnings.map(w => w.code), addedRepositories: 0, installedPlugins: 0 } };
}
