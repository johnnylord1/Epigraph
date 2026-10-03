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
import { createNovelChapterId, createNovelLibraryId } from "../novels/domain";
import type { PersistedNovelRepositoryState } from "../novels/repositoryState";
import type { BooksCategory } from "../../store/state.svelte";
import { createBooksCategory } from "../library/domainCategories";

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
  return mergeRestoredNovelsSnapshot(input).state;
}

export interface NovelMergeWarning { novelId: string; field: string; code: string }
export interface NovelMergeResult {
  state: PersistedNovelLibraryState;
  novelIdMap: Map<string, string>;
  warnings: NovelMergeWarning[];
}

/** Desktop Novel folders already use the shared Books/Novels category store. */
export function mergeNovelCategories(input: {
  categories: readonly BooksCategory[];
  assignments: Record<string, string[]>;
  backupCategories: readonly { id: string; name: string; order: number; novelIds: readonly string[] }[];
  novelIdMap: ReadonlyMap<string, string>;
}) {
  const categories = input.categories.map(c => ({ ...c }));
  const assignments = Object.fromEntries(Object.entries(input.assignments).map(([id, values]) => [id, [...values]]));
  const warnings: string[] = [];
  for (const incoming of [...input.backupCategories].sort((a, b) => a.order - b.order)) {
    const name = incoming.name.trim();
    const matches = categories.filter(c => c.name.trim() === name);
    if (!name || matches.length > 1 || input.backupCategories.filter(c => c.id === incoming.id).length !== 1) {
      warnings.push(`CATEGORY_IDENTITY_AMBIGUOUS:${incoming.id}`); continue;
    }
    const category = matches[0] ?? createBooksCategory(categories, name);
    if (!matches.length) categories.push(category);
    for (const backupId of incoming.novelIds) {
      const novelId = input.novelIdMap.get(backupId);
      if (!novelId) { warnings.push(`CATEGORY_NOVEL_UNRESOLVED:${backupId}`); continue; }
      // UI toggles are deliberately not used: replay must only add missing edges.
      assignments[novelId] = [...new Set([...(assignments[novelId] ?? []), category.id])];
    }
  }
  return { categories, assignments, warnings: [...new Set(warnings)] };
}

function novelIdentity(entry: EpigraphNovelEntry): string | null {
  const plugin = entry.source?.pluginId;
  if (!plugin?.trim() || !entry.path?.trim() || !entry.id
    || (entry.source?.sourceId && entry.source.sourceId !== plugin)) return null;
  return JSON.stringify([plugin, entry.path]);
}
function timestamp(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** EPIGRAPH_PRODUCT_EXTENSION: LNReader identity, conservative merge, no snapshot deletion.
 * The caller commits the returned candidate through the domain persistence service.
 */
export function mergeRestoredNovelsSnapshot(input: {
  currentState: PersistedNovelLibraryState;
  restored: RestoredEpigraphNovelsSnapshot;
}): NovelMergeResult {
  let state = structuredClone(input.currentState);
  const novelIdMap = new Map<string, string>();
  const warnings: NovelMergeWarning[] = [];
  const warn = (novelId: string, field: string, code = "CURRENT_STATE_PRESERVED") => {
    if (!warnings.some(w => w.novelId === novelId && w.field === field && w.code === code)) warnings.push({ novelId, field, code });
  };
  for (const incoming of input.restored.entries) {
    const identity = novelIdentity(incoming);
    const matches = state.entries.filter(e => novelIdentity(e) === identity);
    const siblings = input.restored.entries.filter(e => e.id === incoming.id || novelIdentity(e) === identity);
    if (!identity || matches.length > 1 || siblings.length > 1) {
      warn(incoming.id, "identity", "NOVEL_IDENTITY_AMBIGUOUS"); continue;
    }
    const existing = matches[0];
    const id = existing?.id ?? createNovelLibraryId(incoming.source!.pluginId!, incoming.path);
    if (!existing && state.entries.some(e => e.id === id)) {
      warn(incoming.id, "identity", "DESTINATION_ID_COLLISION"); continue;
    }
    const incomingChapters = input.restored.chapters.filter(c => c.novelId === incoming.id);
    const currentChapters = state.chapters.filter(c => c.novelId === id);
    if ([incomingChapters, currentChapters].some(chapters =>
      chapters.some(c => !c.path || !c.id || !Number.isFinite(c.order))
      || new Set(chapters.map(c => c.path)).size !== chapters.length
      || new Set(chapters.map(c => c.id)).size !== chapters.length)) {
      warn(incoming.id, "chapters", "CHAPTER_IDENTITY_AMBIGUOUS"); continue;
    }
    const candidate = structuredClone(state);
    const chapterIds = new Map<string, string>();
    let invalidChapter = false;
    for (const chapter of [...incomingChapters].sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))) {
      const current = currentChapters.find(c => c.path === chapter.path);
      const chapterId = current?.id ?? createNovelChapterId(id, chapter.path);
      if (!current && candidate.chapters.some(c => c.id === chapterId)) { invalidChapter = true; break; }
      chapterIds.set(chapter.id, chapterId);
      if (current) {
        if (chapter.unread !== current.unread) warn(incoming.id, `unread:${chapter.path}`);
        // Source updatedAt is not evidence for a manual read/unread decision.
        const index = candidate.chapters.findIndex(c => c.id === current.id);
        candidate.chapters[index] = { ...current, title: current.title || chapter.title,
          releaseTime: current.releaseTime ?? chapter.releaseTime };
      } else {
        candidate.chapters.push({ ...chapter, id: chapterId, novelId: id, updatedAt: chapter.updatedAt ?? null });
      }
    }
    if (invalidChapter) { warn(incoming.id, "chapters", "DESTINATION_ID_COLLISION"); continue; }
    const mapReference = <T extends { novelId: string; chapterId?: string | null; locator?: string | null }>(entry: T): T | null => {
      const chapterId = entry.chapterId ? chapterIds.get(entry.chapterId) : null;
      if (entry.chapterId && !chapterId) { warn(incoming.id, "reference", "CHAPTER_REFERENCE_UNRESOLVED"); return null; }
      let locator = entry.locator;
      if (entry.chapterId && chapterId && locator) {
        if (locator === entry.chapterId) locator = chapterId;
        else if (locator.startsWith(`scroll:${encodeURIComponent(entry.chapterId)}:`)) {
          locator = `scroll:${encodeURIComponent(chapterId)}:${locator.slice(`scroll:${encodeURIComponent(entry.chapterId)}:`.length)}`;
        } else if (entry.chapterId !== chapterId) {
          // Opaque foreign locators (LNReader "1", "p:45") mean nothing to the desktop reader:
          // keep the chapter and percentage, and open the chapter from its start.
          locator = chapterId;
        }
      }
      return { ...entry, novelId: id, chapterId, ...(locator !== undefined ? { locator } : {}) };
    };
    for (const raw of input.restored.progress.filter(p => p.novelId === incoming.id)) {
      const next = mapReference(raw);
      if (!next || !Number.isFinite(next.progressPercent) || next.progressPercent < 0 || next.progressPercent > 1) continue;
      const previous = candidate.progress.find(p => p.novelId === id);
      if (previous && !(timestamp(previous.updatedAt) && timestamp(next.updatedAt) && next.updatedAt > previous.updatedAt)) {
        if (previous.locator !== next.locator || previous.chapterId !== next.chapterId) warn(incoming.id, "progress");
        continue;
      }
      // Percentage is derived against the destination catalog, not compared as a clock.
      const chapters = candidate.chapters.filter(c => c.novelId === id).sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
      const index = chapters.findIndex(c => c.id === next.chapterId);
      const fraction = next.locator?.match(/^scroll:.*:([0-9.]+)$/)?.[1];
      if (index >= 0 && fraction !== undefined && Number.isFinite(Number(fraction)) && Number(fraction) <= 1) {
        next.progressPercent = (index + Number(fraction)) / chapters.length;
      }
      candidate.progress = [...candidate.progress.filter(p => p.novelId !== id), next];
    }
    for (const raw of input.restored.bookmarks.filter(b => b.novelId === incoming.id)) {
      const next = mapReference(raw);
      if (!next) continue;
      const previous = candidate.bookmarks.find(b => b.novelId === id && (next.chapterId ? b.chapterId === next.chapterId : b.locator === next.locator));
      if (!previous) candidate.bookmarks.push(next);
      else if (previous.label !== next.label || previous.locator !== next.locator) warn(incoming.id, "bookmark");
    }
    for (const raw of input.restored.history.filter(h => h.novelId === incoming.id)) {
      const next = mapReference(raw);
      if (!next) continue;
      const index = candidate.history.findIndex(h => h.novelId === id && h.chapterId === next.chapterId);
      if (index < 0) candidate.history.push(next);
      else if (timestamp(next.readAt) && timestamp(candidate.history[index].readAt) && next.readAt > candidate.history[index].readAt) candidate.history[index] = next;
    }
    const entry = existing ? { ...existing,
      title: existing.title || incoming.title, author: existing.author ?? incoming.author ?? null,
      description: existing.description ?? incoming.description ?? null, coverUrl: existing.coverUrl ?? incoming.coverUrl ?? null,
      status: existing.status ?? incoming.status ?? null, tags: existing.tags.length ? existing.tags : [...(incoming.tags ?? [])],
    } : { id, path: incoming.path, source: incoming.source!, title: incoming.title,
      author: incoming.author ?? null, description: incoming.description ?? null, coverUrl: incoming.coverUrl ?? null,
      status: incoming.status ?? null, tags: [...(incoming.tags ?? [])], addedAt: incoming.addedAt, updatedAt: incoming.updatedAt };
    candidate.entries = candidate.entries.filter(e => e.id !== id);
    candidate.entries.push({ ...entry, chapterCount: candidate.chapters.filter(c => c.novelId === id).length });
    state = candidate;
    novelIdMap.set(incoming.id, id);
  }
  return { state, novelIdMap, warnings };
}
