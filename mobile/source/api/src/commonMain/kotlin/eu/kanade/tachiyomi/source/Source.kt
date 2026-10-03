package eu.kanade.tachiyomi.source

import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.model.SMangaUpdate
import eu.kanade.tachiyomi.util.awaitSingle
import rx.Observable

/**
 * A basic interface for creating a source. It could be an online source, a local source, etc.
 */
interface Source {

    /**
     * ID for the source. Must be unique.
     */
    val id: Long

    /**
     * Name of the source.
     */
    val name: String

    val lang: String
        get() = ""

    /**
     * Base URL used for opening a source in web view.
     */
    val webViewUrl: String?
        get() = null

    /**
     * Whether this source provides novel (text-based) content instead of manga (image-based).
     *
     * Novel sources should override [fetchPageText] to return the chapter text/HTML for a
     * placeholder [Page]. Keeping this flag on [Source] lets extension classloaders dispatch it
     * directly without reflection.
     */
    val isNovelSource: Boolean
        get() = false

    /**
     * Returns the URL for a manga when available.
     */
    fun getMangaUrl(manga: SManga): String? = null

    /**
     * Returns the URL for a chapter when available.
     */
    fun getChapterUrl(chapter: SChapter): String? = null

    /**
     * Returns the URL for a chapter with manga context when available.
     */
    fun getChapterUrl(manga: SManga?, chapter: SChapter): String? {
        return getChapterUrl(chapter)
    }

    /**
     * Get the updated details for a manga.
     *
     * Routes through [getMangaUpdate] so lib 1.6 sources that implement the combined
     * API are honored; sources that only implement the legacy per-call API fall back
     * to [fetchMangaDetails].
     *
     * @since extensions-lib 1.5
     * @param manga the manga to update.
     * @return the updated manga.
     */
    suspend fun getMangaDetails(manga: SManga): SManga {
        return getMangaUpdate(manga, emptyList(), fetchDetails = true, fetchChapters = false).manga
    }

    /**
     * Get all the available chapters for a manga.
     *
     * Routes through [getMangaUpdate] so lib 1.6 sources that implement the combined
     * API are honored; sources that only implement the legacy per-call API fall back
     * to [fetchChapterList].
     *
     * @since extensions-lib 1.5
     * @param manga the manga to update.
     * @return the chapters for the manga.
     */
    suspend fun getChapterList(manga: SManga): List<SChapter> {
        return getMangaUpdate(manga, emptyList(), fetchDetails = false, fetchChapters = true).chapters
    }

    /**
     * Fetches updated information for a manga (metadata and/or chapters).
     *
     * lib 1.6 sources override this method directly. The default implementation keeps
     * legacy sources working by delegating to the classic per-call API.
     *
     * @since extensions-lib 1.6
     * @param manga the manga to fetch updates for.
     * @param chapters the chapters already known for the manga.
     * @param fetchDetails whether to fetch updated manga details.
     * @param fetchChapters whether to fetch the available chapters.
     */
    @Suppress("DEPRECATION")
    suspend fun getMangaUpdate(
        manga: SManga,
        chapters: List<SChapter>,
        fetchDetails: Boolean,
        fetchChapters: Boolean,
    ): SMangaUpdate {
        val updatedManga = if (fetchDetails) fetchMangaDetails(manga).awaitSingle() else manga
        val updatedChapters = if (fetchChapters) fetchChapterList(manga).awaitSingle() else chapters
        return SMangaUpdate(updatedManga, updatedChapters)
    }

    /**
     * Get the list of pages a chapter has. Pages should be returned
     * in the expected order; the index is ignored.
     *
     * @since extensions-lib 1.5
     * @param chapter the chapter.
     * @return the pages for the chapter.
     */
    @Suppress("DEPRECATION")
    suspend fun getPageList(chapter: SChapter): List<Page> {
        return fetchPageList(chapter).awaitSingle()
    }

    /**
     * Fetches the text content for a novel page.
     */
    suspend fun fetchPageText(page: Page): String =
        throw UnsupportedOperationException("Not a novel source")

    @Deprecated(
        "Use the non-RxJava API instead",
        ReplaceWith("getMangaDetails"),
    )
    fun fetchMangaDetails(manga: SManga): Observable<SManga> =
        throw IllegalStateException("Not used")

    @Deprecated(
        "Use the non-RxJava API instead",
        ReplaceWith("getChapterList"),
    )
    fun fetchChapterList(manga: SManga): Observable<List<SChapter>> =
        throw IllegalStateException("Not used")

    @Deprecated(
        "Use the non-RxJava API instead",
        ReplaceWith("getPageList"),
    )
    fun fetchPageList(chapter: SChapter): Observable<List<Page>> =
        throw IllegalStateException("Not used")
}

fun Source.preferenceKey(): String = "source_$id"
