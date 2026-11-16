package epigraph.sync.core.portable

import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiCatalogResponse
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.suwayomi.CoreChapterNodes
import epigraph.sync.core.suwayomi.SuwayomiMutationGateway
import eu.kanade.tachiyomi.source.model.SChapter
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/** A comic as the paired desktop's Suwayomi lists it: exact source ID and manga key. */
data class CoreWorkKey(val sourceId: Long, val url: String)

/**
 * A desktop chapter list: [chapters] newest first, keyed by source URLs, without read state, and
 * the catalog [nodes] they came from, which carry the desktop read state.
 */
class CoreChapterList(val chapters: List<SChapter>, val nodes: CoreChapterNodes)

/** A desktop title's chapter count and how many of them are unread. */
data class CoreChapterCounts(val total: Long, val unread: Long)

/** The chapter counts of a desktop library, by Suwayomi manga ID, read in one Core session. */
class CoreLibraryChapterCounts(
    private val serverId: String,
    private val profileId: String,
    private val byMangaId: Map<Long, CoreChapterCounts>,
) {
    /** The counts of [manga] when this desktop library lists it. */
    fun of(manga: SuwayomiCoreContentReference.Manga): CoreChapterCounts? =
        if ((manga.serverId == null || manga.serverId == serverId) && manga.profileId == profileId) {
            byMangaId[manga.mangaId]
        } else {
            null
        }
}

/** Reads, within one authorized Core session, the chapter lists the desktop already holds. */
interface CoreChapterCatalogReader {
    /** The desktop library by exact source key. Suwayomi IDs are used for this session only. */
    suspend fun libraryIds(): Map<CoreWorkKey, Long>

    suspend fun chapters(suwayomiMangaId: Long): CoreChapterList

    /** Chapter counts of the whole desktop library; null when this reader cannot read them. */
    suspend fun libraryChapterCounts(): CoreLibraryChapterCounts? = null
}

interface CoreChapterCatalog {
    /** Runs [block] in one Core session; null when no paired, authorized and reachable Core exists. */
    suspend fun <T> withReader(block: suspend (CoreChapterCatalogReader) -> T): T?
}

/**
 * Opens the paired Core once per run: one credential load, one endpoint probe and one TLS client
 * serve every catalog page, so hundreds of chapter lists cost a few seconds on the LAN.
 */
class SessionCoreChapterCatalog(
    private val credentials: CoreCredentialStore,
    private val transports: CoreSessionTransportFactory,
    private val endpoints: CoreEndpointResolver,
) : CoreChapterCatalog {
    override suspend fun <T> withReader(block: suspend (CoreChapterCatalogReader) -> T): T? {
        val session = try {
            credentials.load()
        } catch (_: CoreCredentialException) {
            null
        } ?: return null
        return session.use {
            if ("comics:profile:${session.profileId}" !in session.scopes) return null
            val endpoint = try {
                endpoints.resolve(session).origin
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                return null
            }
            block(GatewayCoreChapterCatalogReader(transports.create(session, endpoint).suwayomi, session))
        }
    }
}

internal class GatewayCoreChapterCatalogReader(
    private val gateway: SuwayomiMutationGateway,
    private val session: CoreCredentialSession,
) : CoreChapterCatalogReader {
    override suspend fun libraryIds(): Map<CoreWorkKey, Long> =
        pages(SuwayomiCatalogOperation.LIBRARY, mangaId = null).mapNotNull { node ->
            val id = node.long("id")?.takeIf { it > 0 } ?: return@mapNotNull null
            val sourceId = node.string("sourceId")?.toLongOrNull() ?: return@mapNotNull null
            val url = node.string("url")?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
            CoreWorkKey(sourceId, url) to id
        }.toMap()

    override suspend fun libraryChapterCounts(): CoreLibraryChapterCounts {
        val counts = pages(SuwayomiCatalogOperation.LIBRARY, mangaId = null, withCounts = true).mapNotNull { node ->
            val id = node.long("id")?.takeIf { it > 0 } ?: return@mapNotNull null
            // A Core that predates the counts sends none; such a title is checked by its chapter list.
            val total = ((node["chapters"] as? JsonObject)?.get("totalCount") as? JsonPrimitive)?.longOrNull
                ?: return@mapNotNull null
            val unread = node.long("unreadCount") ?: return@mapNotNull null
            id to CoreChapterCounts(total, unread)
        }.toMap()
        return CoreLibraryChapterCounts(session.serverId, session.profileId, counts)
    }

    override suspend fun chapters(suwayomiMangaId: Long): CoreChapterList {
        val nodes = pages(SuwayomiCatalogOperation.CHAPTERS, suwayomiMangaId)
        // Suwayomi numbers chapters oldest first; the library expects the newest at position 0.
        val ordered = if (nodes.all { it.long("sourceOrder") != null }) {
            nodes.sortedByDescending { it.long("sourceOrder") }
        } else {
            nodes.asReversed()
        }
        val chapters = ordered.mapNotNull { node ->
            val url = node.string("url")?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
            SChapter.create().apply {
                this.url = url
                name = node.string("name") ?: "Chapter ${node.double("chapterNumber") ?: 0.0}"
                chapter_number = (node.double("chapterNumber") ?: 0.0).toFloat()
                scanlator = node.string("scanlator")
                date_upload = node.timestamp("uploadDate")
            }
        }
        // A desktop older than the url field cannot name the source's chapters.
        if (chapters.size != nodes.size) throw CoreChapterCatalogException("Core chapters carry no source URL")
        return CoreChapterList(chapters, CoreChapterNodes(session.serverId, session.profileId, suwayomiMangaId, nodes))
    }

    private suspend fun pages(
        operation: SuwayomiCatalogOperation,
        mangaId: Long?,
        withCounts: Boolean = false,
    ): List<JsonObject> {
        val nodes = ArrayList<JsonObject>()
        var offset = 0L
        var expectedTotal: Long? = null
        repeat(MAX_PAGES) {
            val read = if (withCounts) {
                gateway.libraryWithCounts(session, PAGE_SIZE, offset)
            } else {
                gateway.catalog(session, operation, PAGE_SIZE, offset, mangaId)
            }
            val page = when (val result = read) {
                is CoreHttpResult.Success -> result.value
                is CoreHttpResult.Failure ->
                    throw CoreChapterCatalogException("Core catalog failed with HTTP ${result.statusCode}")
            }
            val pageNodes = page.nodes(operation)
            val total = page.page.totalCount
            if (
                page.operation != operation.wireName ||
                page.page.offset != offset ||
                total == null ||
                (expectedTotal != null && expectedTotal != total) ||
                pageNodes.size.toLong() > page.page.pageSize ||
                (page.page.hasNextPage && pageNodes.isEmpty())
            ) {
                throw CoreChapterCatalogException("Core catalog page is inconsistent")
            }
            expectedTotal = total
            nodes += pageNodes
            if (!page.page.hasNextPage) {
                if (nodes.size.toLong() != total) throw CoreChapterCatalogException("Core catalog is incomplete")
                return nodes
            }
            offset += page.page.pageSize
        }
        throw CoreChapterCatalogException("Core catalog is larger than a run reads")
    }

    private fun SuwayomiCatalogResponse.nodes(operation: SuwayomiCatalogOperation): List<JsonObject> {
        val key = when (operation) {
            SuwayomiCatalogOperation.LIBRARY -> "mangas"
            SuwayomiCatalogOperation.CATEGORIES -> "categories"
            SuwayomiCatalogOperation.CHAPTERS -> "chapters"
        }
        val connection = data[key] as? JsonObject ?: throw CoreChapterCatalogException("Core catalog is incomplete")
        return (connection["nodes"] as? JsonArray)?.mapNotNull { it as? JsonObject }
            ?: throw CoreChapterCatalogException("Core catalog is incomplete")
    }

    private fun JsonObject.string(field: String): String? = (this[field] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.long(field: String): Long? = (this[field] as? JsonPrimitive)?.longOrNull
    private fun JsonObject.double(field: String): Double? = (this[field] as? JsonPrimitive)?.doubleOrNull
    private fun JsonObject.timestamp(field: String): Long {
        val primitive = this[field] as? JsonPrimitive ?: return 0L
        primitive.longOrNull?.let { return it }
        return primitive.contentOrNull?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L
    }

    private companion object {
        const val PAGE_SIZE = 250L
        const val MAX_PAGES = 200
    }
}

class CoreChapterCatalogException(message: String) : Exception(message)
