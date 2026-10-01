package epigraph.sync.core.suwayomi

import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiContentOperation
import epigraph.sync.core.protocol.SuwayomiContentRequest
import epigraph.sync.core.protocol.SuwayomiContentResponse
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.session.CoreEndpointResolver
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import java.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.Request
import okhttp3.Response

/**
 * Internal source for comics owned by a paired desktop Core.
 *
 * Persisted URLs are opaque Core references. Every network operation is authenticated through
 * [AuthenticatedEpigraphCoreSourceGateway], never through the extension network client.
 */
class EpigraphCoreSource(
    private val gateway: EpigraphCoreSourceGateway,
) : HttpSource() {
    override val id: Long = ID
    override val name: String = NAME
    override val lang: String = "all"
    override val supportsLatest: Boolean = false
    override val baseUrl: String = "https://aethon-core.invalid"

    fun hasActiveSession(): Boolean = gateway.hasActiveSession()

    override suspend fun getPopularManga(page: Int): MangasPage = MangasPage(emptyList(), false)

    override suspend fun getLatestUpdates(page: Int): MangasPage = MangasPage(emptyList(), false)

    override suspend fun getSearchManga(
        page: Int,
        query: String,
        filters: FilterList,
    ): MangasPage = MangasPage(emptyList(), false)

    override suspend fun getMangaDetails(manga: SManga): SManga {
        val reference = SuwayomiCoreContentReference.parseManga(manga.url)
            ?: throw EpigraphCoreSourceException("Invalid Core manga reference")
        val payload = gateway.content(
            reference.serverId,
            reference.profileId,
            SuwayomiContentRequest(SuwayomiContentOperation.FETCH_MANGA, reference.mangaId),
        ).data.objectField("fetchManga").objectField("manga")

        return SManga.create().apply {
            url = manga.url
            title = payload.string("title") ?: manga.title
            author = payload.string("author")
            artist = payload.string("artist")
            description = payload.string("description")
            genre = payload.array("genre").mapNotNull { it.primitiveContent() }.joinToString(", ")
                .ifBlank { manga.genre.orEmpty() }
                .ifBlank { null }
            status = status(payload.string("status"))
            thumbnail_url = reference.serverId?.let {
                SuwayomiCoreThumbnailReference.forManga(it, reference.profileId, reference.mangaId)
            } ?: SuwayomiCoreThumbnailReference.forManga(reference.profileId, reference.mangaId)
            initialized = true
        }
    }

    override suspend fun getChapterList(manga: SManga): List<SChapter> {
        val reference = SuwayomiCoreContentReference.parseManga(manga.url)
            ?: throw EpigraphCoreSourceException("Invalid Core manga reference")
        val chapters = try {
            gateway.content(
                reference.serverId,
                reference.profileId,
                SuwayomiContentRequest(SuwayomiContentOperation.FETCH_CHAPTERS, reference.mangaId),
            ).data.objectField("fetchChapters").requiredArray("chapters").mapNotNull { it as? JsonObject }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (liveFailure: Throwable) {
            // fetchChapters refreshes through the source extension. Old or temporarily missing
            // extensions can reject that refresh even though Suwayomi still owns a complete,
            // readable chapter catalog in its database. The read-only catalog bridge is the
            // truthful fallback for the details screen; it never fabricates an empty list.
            gateway.cachedChapters(
                reference.serverId,
                reference.profileId,
                reference.mangaId,
            ) ?: throw liveFailure
        }

        return newestFirst(chapters).mapNotNull { chapter ->
            val chapterId = chapter.long("id")?.takeIf { it > 0 } ?: return@mapNotNull null
            SChapter.create().apply {
                url = reference.serverId?.let {
                    SuwayomiCoreContentReference.forChapter(it, reference.profileId, chapterId)
                } ?: SuwayomiCoreContentReference.forChapter(reference.profileId, chapterId)
                name = chapter.string("name") ?: "Chapter ${chapter.double("chapterNumber") ?: 0.0}"
                chapter_number = (chapter.double("chapterNumber") ?: 0.0).toFloat()
                scanlator = chapter.string("scanlator")
                date_upload = chapter.timestamp("uploadDate")
            }
        }
    }

    override suspend fun getPageList(chapter: SChapter): List<Page> {
        val reference = SuwayomiCoreContentReference.parseChapter(chapter.url)
            ?: throw EpigraphCoreSourceException("Invalid Core chapter reference")
        val pages = gateway.content(
            reference.serverId,
            reference.profileId,
            SuwayomiContentRequest(SuwayomiContentOperation.FETCH_CHAPTER_PAGES, reference.chapterId),
        ).data.objectField("fetchChapterPages").array("pages")

        return pages.mapIndexedNotNull { index, element ->
            element.primitiveContent()?.let { upstreamPath ->
                val logical = reference.serverId?.let {
                    SuwayomiCoreContentReference.forPage(it, reference.profileId, upstreamPath)
                } ?: SuwayomiCoreContentReference.forPage(reference.profileId, upstreamPath)
                Page(index = index, url = logical, imageUrl = logical)
            }
        }
    }

    override suspend fun getImageUrl(page: Page): String = page.url

    override suspend fun getImage(page: Page): Response {
        val reference = SuwayomiCoreContentReference.parsePage(page.url)
            ?: throw EpigraphCoreSourceException("Invalid Core page reference")
        return gateway.image(reference.serverId, reference.profileId, reference.upstreamPath)
    }

    override fun getMangaUrl(manga: SManga): String = manga.url

    override fun getChapterUrl(chapter: SChapter): String = chapter.url

    override fun getFilterList(): FilterList = FilterList()

    override fun popularMangaRequest(page: Int): Request = unsupportedLegacyHttp()
    override fun popularMangaParse(response: Response): MangasPage = unsupportedLegacyHttp()
    override fun latestUpdatesRequest(page: Int): Request = unsupportedLegacyHttp()
    override fun latestUpdatesParse(response: Response): MangasPage = unsupportedLegacyHttp()
    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request =
        unsupportedLegacyHttp()
    override fun searchMangaParse(response: Response): MangasPage = unsupportedLegacyHttp()
    override fun mangaDetailsParse(response: Response): SManga = unsupportedLegacyHttp()
    override fun chapterListParse(response: Response): List<SChapter> = unsupportedLegacyHttp()
    override fun chapterPageParse(response: Response): SChapter = unsupportedLegacyHttp()
    override fun pageListParse(response: Response): List<Page> = unsupportedLegacyHttp()
    override fun imageUrlParse(response: Response): String = unsupportedLegacyHttp()

    private fun <T> unsupportedLegacyHttp(): T =
        throw UnsupportedOperationException("Epigraph Core source uses only its authenticated gateway")

    /**
     * Suwayomi numbers chapters oldest first (`sourceOrder` 1 is the first chapter) while the
     * library treats list position 0 as the newest chapter, the way extensions return them.
     * Without the reversal an unread series offers its latest chapter as "Start reading".
     */
    private fun newestFirst(chapters: List<JsonObject>): List<JsonObject> =
        if (chapters.all { it.long("sourceOrder") != null }) {
            chapters.sortedByDescending { it.long("sourceOrder") }
        } else {
            chapters.asReversed()
        }

    private fun JsonObject.objectField(field: String): JsonObject =
        this[field] as? JsonObject
            ?: throw EpigraphCoreSourceException("Core response is missing $field")

    private fun JsonObject.array(field: String): JsonArray = this[field] as? JsonArray ?: JsonArray(emptyList())

    /**
     * Unlike [array], a missing collection is a protocol violation rather than an empty result:
     * treating it as success would surface "zero chapters" without any error the reader could
     * retry against.
     */
    private fun JsonObject.requiredArray(field: String): JsonArray =
        this[field] as? JsonArray
            ?: throw EpigraphCoreSourceException("Core response is missing $field")
    private fun JsonObject.string(field: String): String? = this[field].primitiveContent()
    private fun JsonObject.long(field: String): Long? = (this[field] as? JsonPrimitive)?.longOrNull
    private fun JsonObject.double(field: String): Double? = (this[field] as? JsonPrimitive)?.doubleOrNull
    private fun JsonObject.timestamp(field: String): Long {
        val primitive = this[field] as? JsonPrimitive ?: return 0L
        primitive.longOrNull?.let { return it }
        return primitive.contentOrNull?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L
    }

    private fun kotlinx.serialization.json.JsonElement?.primitiveContent(): String? =
        (this as? JsonPrimitive)?.contentOrNull

    private fun status(value: String?): Int = when (value?.uppercase()) {
        "ONGOING" -> SManga.ONGOING
        "COMPLETED" -> SManga.COMPLETED
        "LICENSED" -> SManga.LICENSED
        "PUBLISHING_FINISHED" -> SManga.PUBLISHING_FINISHED
        "CANCELLED" -> SManga.CANCELLED
        "HIATUS", "ON_HIATUS" -> SManga.ON_HIATUS
        else -> SManga.UNKNOWN
    }

    companion object {
        const val ID: Long = 3_238_364_976_084_580_419L
        const val NAME = "Epigraph Core"

    }
}

fun interface EpigraphCoreContentGateway {
    suspend fun content(
        serverId: String?,
        profileId: String,
        request: SuwayomiContentRequest,
    ): SuwayomiContentResponse
}

interface EpigraphCoreSourceGateway : EpigraphCoreContentGateway {
    fun hasActiveSession(): Boolean = true

    /** Reads Suwayomi's persisted chapter catalog when a live source refresh is unavailable. */
    suspend fun cachedChapters(
        serverId: String?,
        profileId: String,
        mangaId: Long,
    ): List<JsonObject>? = null

    suspend fun image(serverId: String?, profileId: String, upstreamPath: String): Response
}

class AuthenticatedEpigraphCoreSourceGateway(
    private val credentials: CoreCredentialStore,
    private val transports: CoreSessionTransportFactory,
    private val endpoints: CoreEndpointResolver,
) : EpigraphCoreSourceGateway {
    override fun hasActiveSession(): Boolean = try {
        credentials.load()?.use { true } ?: false
    } catch (_: CoreCredentialException) {
        false
    }

    override suspend fun content(
        serverId: String?,
        profileId: String,
        request: SuwayomiContentRequest,
    ): SuwayomiContentResponse = withSession(serverId, profileId) { session, endpoint ->
        val result = session.withAccessTokenString { token ->
            transports.create(session, endpoint).http.suwayomiContent(token, profileId, request)
        }
        when (result) {
            is CoreHttpResult.Success -> result.value
            is CoreHttpResult.Failure -> throw result.asSourceException()
        }
    }

    override suspend fun cachedChapters(
        serverId: String?,
        profileId: String,
        mangaId: Long,
    ): List<JsonObject> = withSession(serverId, profileId) { session, endpoint ->
        val chapters = ArrayList<JsonObject>()
        var offset = 0L
        var expectedTotal: Long? = null
        var hasNext = true
        while (hasNext) {
            val result = transports.create(session, endpoint).suwayomi.catalog(
                session = session,
                operation = SuwayomiCatalogOperation.CHAPTERS,
                pageSize = 250,
                offset = offset,
                mangaId = mangaId,
            )
            val response = when (result) {
                is CoreHttpResult.Success -> result.value
                is CoreHttpResult.Failure -> throw result.asSourceException()
            }
            val connection = response.data[SuwayomiCatalogOperation.CHAPTERS.wireName] as? JsonObject
                ?: throw EpigraphCoreSourceException("Core chapter catalog is incomplete")
            val nodes = (connection["nodes"] as? JsonArray)
                ?.mapNotNull { it as? JsonObject }
                ?: throw EpigraphCoreSourceException("Core chapter catalog is incomplete")
            val total = response.page.totalCount
                ?: throw EpigraphCoreSourceException("Core chapter catalog has no total")
            if (
                response.operation != SuwayomiCatalogOperation.CHAPTERS.wireName ||
                response.page.offset != offset ||
                (expectedTotal != null && expectedTotal != total) ||
                nodes.size.toLong() > response.page.pageSize
            ) {
                throw EpigraphCoreSourceException("Core chapter catalog page is inconsistent")
            }
            expectedTotal = total
            chapters += nodes
            hasNext = response.page.hasNextPage
            if (hasNext && nodes.isEmpty()) {
                throw EpigraphCoreSourceException("Core chapter catalog did not advance")
            }
            offset += response.page.pageSize
        }
        if (chapters.size.toLong() != expectedTotal) {
            throw EpigraphCoreSourceException("Core chapter catalog is incomplete")
        }
        chapters
    }

    override suspend fun image(serverId: String?, profileId: String, upstreamPath: String): Response =
        withSession(serverId, profileId) { session, endpoint ->
            val result = session.withAccessTokenString { token ->
                transports.create(session, endpoint).http.suwayomiResource(
                    accessToken = token,
                    profileId = profileId,
                    upstreamPath = upstreamPath,
                )
            }
            when (result) {
                is CoreHttpResult.Success -> result.value
                is CoreHttpResult.Failure -> throw result.asSourceException()
            }
        }

    private suspend fun <T> withSession(
        serverId: String?,
        profileId: String,
        block: suspend (epigraph.sync.core.credentials.CoreCredentialSession, String) -> T,
    ): T {
        val session = try {
            credentials.load()
        } catch (failure: CoreCredentialException) {
            throw EpigraphCoreSourceException("Core credentials are unavailable", failure)
        } ?: throw EpigraphCoreSourceException("Core is not paired")
        session.use {
            if (serverId != null && session.serverId != serverId) {
                throw EpigraphCoreSourceException("Core server identity does not match this title")
            }
            if (session.profileId != profileId || "comics:profile:$profileId" !in session.scopes) {
                throw EpigraphCoreSourceException("Core profile is not authorized")
            }
            val endpoint = try {
                endpoints.resolve(session).origin
            } catch (failure: Throwable) {
                throw EpigraphCoreSourceException("Paired Core endpoint is unavailable", failure)
            }
            return block(session, endpoint)
        }
    }

    private fun CoreHttpResult.Failure.asSourceException() =
        EpigraphCoreSourceException("Core request failed with HTTP $statusCode")
}

class EpigraphCoreSourceException(message: String, cause: Throwable? = null) : Exception(message, cause)
