import type {
  EpigraphNovelBookmarkEntry,
  EpigraphNovelChapterEntry,
  EpigraphNovelEntry,
  EpigraphNovelHistoryEntry,
  EpigraphNovelPluginReference,
  EpigraphNovelProgressEntry,
  EpigraphNovelRepositoryReference,
  EpigraphNovelSourceIdentity,
  EpigraphNovelsSnapshot,
  RestoredEpigraphNovelsSnapshot,
} from "./novelsBackup";
import type { PersistedNovelLibraryState } from "../novels/domain";
import type { PersistedNovelRepositoryState } from "../novels/repositoryState";

const UNKNOWN_NOVEL_SOURCE: EpigraphNovelSourceIdentity = {
  repositoryUrl: null,
  pluginId: null,
  sourceId: null,
};

function mapEntry(
  entry: PersistedNovelLibraryState["entries"][number],
): EpigraphNovelEntry {
  return {
    id: entry.id,
    title: entry.title,
    path: entry.path,
    author: entry.author,
    description: entry.description,
    coverUrl: entry.coverUrl,
    coverPath: null,
    externalNovelId: null,
    externalUrl: null,
    status: entry.status,
    tags: [...entry.tags],
    source: entry.source,
    addedAt: entry.addedAt,
    updatedAt: entry.updatedAt,
  };
}

function mapChapter(
  chapter: PersistedNovelLibraryState["chapters"][number],
): EpigraphNovelChapterEntry {
  return {
    id: chapter.id,
    novelId: chapter.novelId,
    path: chapter.path,
    title: chapter.title,
    order: chapter.order,
    releaseTime: chapter.releaseTime,
    unread: chapter.unread,
    updatedAt: chapter.updatedAt ?? null,
  };
}

function mapRepository(
  repository: PersistedNovelRepositoryState["repositories"][number],
): EpigraphNovelRepositoryReference {
  return {
    url: repository.normalizedUrl,
    name: null,
  };
}

function mapPlugin(
  plugin: PersistedNovelRepositoryState["installedPlugins"][number],
): EpigraphNovelPluginReference {
  return {
    id: plugin.pluginId,
    name: null,
    version: plugin.version,
    repositoryUrl: null,
  };
}

export function buildEpigraphNovelsSnapshotFromAuthoritativeState(input: {
  libraryState: Pick<PersistedNovelLibraryState, "entries" | "chapters" | "progress" | "bookmarks" | "history">;
  repositoryState?: Pick<PersistedNovelRepositoryState, "repositories" | "installedPlugins"> | null;
}): EpigraphNovelsSnapshot {
  const repositories = input.repositoryState?.repositories ?? [];
  const installedPlugins = input.repositoryState?.installedPlugins ?? [];
  const repositoryUrlById = new Map(repositories.map((repository) => [repository.id, repository.normalizedUrl]));

  return {
    entries: input.libraryState.entries.map((entry) => mapEntry(entry)),
    chapters: input.libraryState.chapters.map((chapter) => mapChapter(chapter)),
    progress: input.libraryState.progress.map((entry): EpigraphNovelProgressEntry => ({ ...entry })),
    bookmarks: input.libraryState.bookmarks.map((entry): EpigraphNovelBookmarkEntry => ({ ...entry })),
    history: input.libraryState.history.map((entry): EpigraphNovelHistoryEntry => ({ ...entry })),
    repositories: repositories.map((repository) => mapRepository(repository)),
    plugins: installedPlugins.map((plugin) => ({
      ...mapPlugin(plugin),
      repositoryUrl: repositoryUrlById.get(plugin.repositoryId) ?? null,
    })),
  };
}

export function applyRestoredNovelsSnapshotToLibraryState(input: {
  currentState: PersistedNovelLibraryState;
  restored: RestoredEpigraphNovelsSnapshot;
}): PersistedNovelLibraryState {
  return {
    version: input.currentState.version,
    scopeKey: input.currentState.scopeKey,
    entries: input.restored.entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      author: entry.author ?? null,
      description: entry.description ?? null,
      coverUrl: entry.coverUrl ?? null,
      path: entry.path,
      status: entry.status ?? null,
      tags: [...(entry.tags ?? [])],
      source: entry.source ?? { ...UNKNOWN_NOVEL_SOURCE },
      chapterCount: input.restored.chapters.filter((chapter) => chapter.novelId === entry.id).length,
      addedAt: entry.addedAt,
      updatedAt: entry.updatedAt,
    })),
    chapters: input.restored.chapters.map((chapter) => ({
      id: chapter.id,
      novelId: chapter.novelId,
      path: chapter.path,
      title: chapter.title,
      order: chapter.order,
      releaseTime: chapter.releaseTime,
      unread: chapter.unread,
      updatedAt: chapter.updatedAt ?? null,
    })),
    progress: input.restored.progress.map((entry) => ({ ...entry })),
    bookmarks: input.restored.bookmarks.map((entry) => ({ ...entry })),
    history: input.restored.history.map((entry) => ({ ...entry })),
    updatedAtMs: Date.now(),
  };
}
