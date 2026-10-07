package epigraph.sync.core.suwayomi

import android.content.SharedPreferences
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import eu.kanade.tachiyomi.source.model.SChapter
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import yokai.data.DatabaseHandler

/**
 * The desktop's read state for a Core work's chapters, keyed by source chapter URL.
 *
 * A comic first lands on [EpigraphCoreSource], whose chapter list carries the desktop's read
 * flags. Once its extension is installed the work is relinked and the local source no longer
 * knows them. Each work reads it once, which also repairs works relinked before this existed,
 * and again whenever the source lists chapters the device has not stored yet.
 */
fun interface BridgedChapterReadState {
    suspend fun chapters(mangaId: Long, hasNewChapters: Boolean): Map<String, SChapter>
}

class CoreBridgedChapterReadState(
    private val database: DatabaseHandler,
    private val gateway: EpigraphCoreSourceGateway,
    private val baselines: SharedPreferences,
) : BridgedChapterReadState {
    override suspend fun chapters(mangaId: Long, hasNewChapters: Boolean): Map<String, SChapter> {
        val identity = database.awaitOneOrNull {
            aethon_syncQueries.selectIdentityByLocalReference(MANGA_CONTENT_TYPE, mangaId.toString())
        } ?: return emptyMap()
        val entityId = identity.entity_id
        if (!hasNewChapters && baselines.getBoolean(entityId, false)) return emptyMap()
        val manga = SuwayomiCoreContentReference.parseMangaEntityId(entityId) ?: return emptyMap()
        if (!gateway.hasActiveSession()) return emptyMap()
        val nodes = try {
            gateway.cachedChapters(manga.serverId, manga.profileId, manga.mangaId)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        } ?: return emptyMap()
        val states = nodes.mapNotNull(::readState)
        // A desktop older than the url field lists chapters without it; ask again once it updates.
        if (states.isNotEmpty() || nodes.isEmpty()) baselines.edit().putBoolean(entityId, true).apply()
        return states.associateBy { it.url }
    }

    private fun readState(node: JsonObject): SChapter? {
        val url = node.primitive("url")?.contentOrNull?.takeIf(String::isNotBlank) ?: return null
        return SChapter.create().apply {
            this.url = url
            name = ""
            read = node.primitive("isRead")?.booleanOrNull == true
            last_page_read = node.primitive("lastPageRead")?.longOrNull
                ?.coerceIn(0L, Int.MAX_VALUE.toLong())?.toInt() ?: 0
            last_read_at = node.primitive("lastReadAt")?.longOrNull?.takeIf { it > 0 }?.times(1000) ?: 0L
        }
    }

    private fun JsonObject.primitive(field: String): JsonPrimitive? = this[field] as? JsonPrimitive

    private companion object {
        const val MANGA_CONTENT_TYPE = "MANGA"
    }
}

/** Records, per Core work, that the desktop's read state has been read into its chapter rows. */
const val BRIDGED_READ_BASELINE_PREFERENCES = "epigraph_core_bridged_read_baseline"
