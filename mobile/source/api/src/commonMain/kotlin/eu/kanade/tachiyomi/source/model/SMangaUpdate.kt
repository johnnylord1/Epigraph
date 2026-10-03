package eu.kanade.tachiyomi.source.model

/**
 * Combined result of a manga update: updated metadata plus the chapter list.
 *
 * Part of the combined lib 1.6 source API ([eu.kanade.tachiyomi.source.Source.getMangaUpdate]).
 * Sources that only implement the legacy per-call API never construct this class
 * themselves; the default [eu.kanade.tachiyomi.source.Source.getMangaUpdate]
 * implementation builds it from the classic `fetchMangaDetails`/`fetchChapterList` calls.
 */
@Suppress("UNUSED")
class SMangaUpdate(val manga: SManga, val chapters: List<SChapter>)
