import type {
  AethonNovelBookmarkEntry,
  AethonNovelChapterEntry,
  AethonNovelEntry,
  AethonNovelHistoryEntry,
  AethonNovelPluginReference,
  AethonNovelProgressEntry,
  AethonNovelRepositoryReference,
  AethonNovelsSnapshot,
  RestoredAethonNovelsSnapshot,
} from "./novelsBackup";
import type { PersistedNovelLibraryState } from "../novels/domain";
import type { PersistedNovelRepositoryState } from "../novels/repositoryState";

function mapEntry(
  entry: PersistedNovelLibraryState["entries"][number],
): AethonNovelEntry {
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
): AethonNovelChapterEntry {
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
): AethonNovelRepositoryReference {
  return {
    url: repository.normalizedUrl,
    name: null,
  };
}

function mapPlugin(
  plugin: PersistedNovelRepositoryState["installedPlugins"][number],
): AethonNovelPluginReference {
  return {
    id: plugin.pluginId,
    name: null,
    version: plugin.version,
    repositoryUrl: null,
  };
}

export function buildAethonNovelsSnapshotFromAuthoritativeState(input: {
  libraryState: Pick<PersistedNovelLibraryState, "entries" | "chapters" | "progress" | "bookmarks" | "history">;
  repositoryState?: Pick<PersistedNovelRepositoryState, "repositories" | "installedPlugins"> | null;
}): AethonNovelsSnapshot {
  const repositories = input.repositoryState?.repositories ?? [];
  const installedPlugins = input.repositoryState?.installedPlugins ?? [];
  const repositoryUrlById = new Map(repositories.map((repository) => [repository.id, repository.normalizedUrl]));

  return {
    entries: input.libraryState.entries.map((entry) => mapEntry(entry)),
    chapters: input.libraryState.chapters.map((chapter) => mapChapter(chapter)),
    progress: input.libraryState.progress.map((entry): AethonNovelProgressEntry => ({ ...entry })),
    bookmarks: input.libraryState.bookmarks.map((entry): AethonNovelBookmarkEntry => ({ ...entry })),
    history: input.libraryState.history.map((entry): AethonNovelHistoryEntry => ({ ...entry })),
    repositories: repositories.map((repository) => mapRepository(repository)),
    plugins: installedPlugins.map((plugin) => ({
      ...mapPlugin(plugin),
      repositoryUrl: repositoryUrlById.get(plugin.repositoryId) ?? null,
    })),
  };
}

export function applyRestoredNovelsSnapshotToLibraryState(input: {
  currentState: PersistedNovelLibraryState;
  restored: RestoredAethonNovelsSnapshot;
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
      source: entry.source,
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
