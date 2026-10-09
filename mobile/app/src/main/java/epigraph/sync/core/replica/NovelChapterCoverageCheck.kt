package epigraph.sync.core.replica

import epigraph.sync.core.protocol.EpigraphCoreEntityType
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import yokai.data.DatabaseHandler

/**
 * Flags synced novels that still have no chapters on this device.
 *
 * The desktop publishes novel membership and progress but not chapter lists: this device hydrates
 * chapters from the exact LNReader plugin. A `novel.entry` is covered when the replica carries a
 * `novel.chapter` for it or when its local row already has hydrated chapters; anything else is
 * usually waiting for a plugin or plugin repository to be approved here. Only the confirmed replica
 * is inspected, so local-only novels are never reported.
 */
class NovelChapterCoverageCheck(private val databaseHandler: DatabaseHandler) {

    /** Titles of confirmed novels without chapters, or empty before the first completed snapshot. */
    suspend fun novelsWithoutChapters(): List<String> = databaseHandler.await {
        val queries = aethon_syncQueries
        if (queries.countCoreReplicaCheckpoints().executeAsOne() == 0L) return@await emptyList()
        val entries = queries.selectCoreReplicaRecordsByType(EpigraphCoreEntityType.NOVEL_ENTRY)
            .executeAsList()
            .map { it.entity_id to it.record_json }
        if (entries.isEmpty()) return@await emptyList()
        val chapters = queries.selectCoreReplicaRecordsByType(EpigraphCoreEntityType.NOVEL_CHAPTER)
            .executeAsList()
            .map { it.record_json }
        val hydrated = entries.mapNotNullTo(HashSet()) { (entityId, _) ->
            val localId = queries.selectIdentityByEntityId(entityId).executeAsOneOrNull()
                ?.local_reference?.toLongOrNull()
                ?: return@mapNotNullTo null
            entityId.takeIf {
                chaptersQueries.getChaptersByMangaId(localId, 0).executeAsList().isNotEmpty()
            }
        }
        findNovelsWithoutChapters(entries, chapters, hydrated)
    }

    internal companion object {
        /**
         * [entries] pairs each entry's entity id with its record JSON; [hydratedEntityIds] are entry
         * entity ids whose local row already has chapters.
         */
        fun findNovelsWithoutChapters(
            entries: List<Pair<String, String>>,
            chapterRecords: List<String>,
            hydratedEntityIds: Set<String> = emptySet(),
        ): List<String> {
            val novelsWithChapters = chapterRecords.mapNotNullTo(HashSet()) { parse(it)?.string("novelId") }
            return entries.mapNotNull { (entityId, json) ->
                if (entityId in hydratedEntityIds) return@mapNotNull null
                val record = parse(json) ?: return@mapNotNull null
                val novelId = record.string("novelId") ?: entityId
                if (novelId in novelsWithChapters) return@mapNotNull null
                record.string("title")?.takeIf(String::isNotBlank) ?: novelId
            }.sorted()
        }

        private fun parse(json: String): JsonObject? =
            runCatching { CoreReplicaPayloadHasher.parse(json) as? JsonObject }.getOrNull()

        private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    }
}
