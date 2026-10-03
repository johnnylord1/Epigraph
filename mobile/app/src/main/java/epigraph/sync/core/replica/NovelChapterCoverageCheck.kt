package epigraph.sync.core.replica

import epigraph.sync.core.protocol.EpigraphCoreEntityType
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import yokai.data.DatabaseHandler

/**
 * Flags novels the desktop sent without a single chapter.
 *
 * After a completed snapshot, a `novel.entry` with no `novel.chapter` almost always means the
 * desktop failed to ingest that novel's chapter list; the mobile library would otherwise show an
 * empty novel with no hint of why. Only the confirmed replica is inspected, so local-only novels
 * are never reported.
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
        findNovelsWithoutChapters(entries, chapters)
    }

    internal companion object {
        /** [entries] pairs each entry's entity id with its record JSON. */
        fun findNovelsWithoutChapters(entries: List<Pair<String, String>>, chapterRecords: List<String>): List<String> {
            val novelsWithChapters = chapterRecords.mapNotNullTo(HashSet()) { parse(it)?.string("novelId") }
            return entries.mapNotNull { (entityId, json) ->
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
