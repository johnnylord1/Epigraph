package epigraph.sync.core.suwayomi

import android.content.SharedPreferences
import epigraph.sync.ComicBackfillCandidate
import epigraph.sync.ComicProgressBackfillFilter
import epigraph.sync.core.portable.CoreChapterCatalog
import epigraph.sync.core.portable.CoreChapterCatalogReader
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import yokai.data.DatabaseHandler

/**
 * Holds back progress backfill the paired desktop's Suwayomi already holds.
 *
 * Suwayomi is the comic chapter-state authority, and the desktop mirrors to Core only what changes
 * there, so a chapter read on the desktop and imported here has no Core record. Publishing it would
 * send the desktop its own state back and queue one Suwayomi projection per chapter. Each candidate
 * title is checked against the desktop's chapter list within one Core session; a title whose
 * progress the desktop holds is remembered by its exact local state, so later runs need no request.
 * A chapter the desktop lacks, or holds behind this phone, is still published.
 *
 * Titles the desktop does not serve keep the plain backfill. A served title that cannot be checked
 * now waits, so nothing is published blind, unless its check keeps failing while the desktop
 * answers; it is then published as before.
 */
class CoreHeldChapterProgressFilter(
    private val database: DatabaseHandler,
    private val catalog: CoreChapterCatalog,
    private val preferences: SharedPreferences,
    private val checkBudgetMillis: Long = CHECK_BUDGET_MILLIS,
) : ComicProgressBackfillFilter {
    override suspend fun withheld(candidates: List<ComicBackfillCandidate>): Set<Long> =
        withheld(candidates, check = true)

    /** This filter without asking the desktop: titles not confirmed earlier wait for a checked run. */
    val cachedOnly = ComicProgressBackfillFilter { candidates -> withheld(candidates, check = false) }

    private suspend fun withheld(candidates: List<ComicBackfillCandidate>, check: Boolean): Set<Long> {
        val byManga = candidates.groupBy { it.mangaId }
        val served = database.await {
            byManga.keys.mapNotNull { mangaId ->
                val entityId = aethon_syncQueries
                    .selectIdentityByLocalReference(MANGA_CONTENT_TYPE, mangaId.toString())
                    .executeAsOneOrNull()
                    ?.entity_id
                    ?: return@mapNotNull null
                SuwayomiCoreContentReference.parseMangaEntityId(entityId)?.let { mangaId to ServedWork(entityId, it) }
            }.toMap()
        }
        val withheld = HashSet<Long>()
        val unchecked = ArrayList<Long>()
        served.forEach { (mangaId, work) ->
            val chapters = byManga.getValue(mangaId)
            chapters.mapTo(withheld) { it.chapterId }
            if (preferences.getString(heldKey(work), null) != fingerprint(chapters)) unchecked += mangaId
        }
        if (!check || unchecked.isEmpty()) return withheld

        val outcomes = ConcurrentHashMap<Long, Outcome>()
        catalog.withReader { reader ->
            // Titles not reached in time wait for the next run, which skips those already confirmed.
            withTimeoutOrNull(checkBudgetMillis) {
                val permits = Semaphore(PARALLEL_CHECKS)
                coroutineScope {
                    unchecked.forEach { mangaId ->
                        launch {
                            permits.withPermit {
                                outcomes[mangaId] = check(reader, served.getValue(mangaId).manga, byManga.getValue(mangaId))
                            }
                        }
                    }
                }
            }
        }

        val editor = preferences.edit()
        unchecked.forEach { mangaId ->
            val work = served.getValue(mangaId)
            val chapters = byManga.getValue(mangaId)
            when (val outcome = outcomes[mangaId]) {
                null -> Unit
                is Outcome.Checked -> {
                    editor.remove(failedKey(work))
                    val held = chapters.filter { it.chapterId in outcome.held }
                    // The rest is published now and leaves the candidates, so later runs match this.
                    if (held.isEmpty()) editor.remove(heldKey(work)) else editor.putString(heldKey(work), fingerprint(held))
                    chapters.forEach { if (it.chapterId !in outcome.held) withheld -= it.chapterId }
                }
                Outcome.NotServed -> chapters.forEach { withheld -= it.chapterId }
                Outcome.Failed -> {
                    val failures = preferences.getInt(failedKey(work), 0) + 1
                    if (failures >= MAX_FAILED_CHECKS) {
                        editor.remove(failedKey(work))
                        chapters.forEach { withheld -= it.chapterId }
                    } else {
                        editor.putInt(failedKey(work), failures)
                    }
                }
            }
        }
        editor.apply()
        return withheld
    }

    private suspend fun check(
        reader: CoreChapterCatalogReader,
        manga: SuwayomiCoreContentReference.Manga,
        chapters: List<ComicBackfillCandidate>,
    ): Outcome = try {
        val list = reader.chapters(manga.mangaId)
        if (list.nodes.serves(manga)) Outcome.Checked(held(list.nodes.nodes, chapters)) else Outcome.NotServed
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        Outcome.Failed
    }

    private fun held(nodes: List<JsonObject>, chapters: List<ComicBackfillCandidate>): Set<Long> {
        val byUrl = nodes.mapNotNull { node -> node.string("url")?.let { it to node } }.toMap()
        val byId = nodes.mapNotNull { node -> node.long("id")?.let { it to node } }.toMap()
        return chapters.filter { chapter ->
            // Extension chapters carry the source URL; chapters still served by the Core carry its reference.
            val node = byUrl[chapter.url]
                ?: SuwayomiCoreContentReference.parseChapter(chapter.url)?.let { byId[it.chapterId] }
                ?: return@filter false
            val read = node.boolean("isRead")
            (!chapter.read || read) &&
                (!chapter.bookmarked || node.boolean("isBookmarked")) &&
                (chapter.lastPageRead <= 0 || read || (node.long("lastPageRead") ?: 0) >= chapter.lastPageRead)
        }.mapTo(HashSet()) { it.chapterId }
    }

    private fun fingerprint(chapters: List<ComicBackfillCandidate>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        chapters.sortedBy { it.chapterId }.forEach {
            digest.update("${it.chapterId}:${it.read}:${it.bookmarked}:${it.lastPageRead};".toByteArray())
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun heldKey(work: ServedWork) = "held:${work.entityId}"
    private fun failedKey(work: ServedWork) = "failed:${work.entityId}"

    private fun JsonObject.string(field: String): String? =
        (this[field] as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotEmpty)
    private fun JsonObject.long(field: String): Long? = (this[field] as? JsonPrimitive)?.longOrNull
    private fun JsonObject.boolean(field: String): Boolean = (this[field] as? JsonPrimitive)?.booleanOrNull == true

    private class ServedWork(val entityId: String, val manga: SuwayomiCoreContentReference.Manga)

    private sealed interface Outcome {
        class Checked(val held: Set<Long>) : Outcome
        data object NotServed : Outcome
        data object Failed : Outcome
    }

    private companion object {
        const val MANGA_CONTENT_TYPE = "MANGA"
        const val PARALLEL_CHECKS = 4
        const val CHECK_BUDGET_MILLIS = 30_000L
        const val MAX_FAILED_CHECKS = 3
    }
}

/** Per Core work, the exact local progress its desktop was confirmed to hold. */
const val COMIC_PROGRESS_HELD_PREFERENCES = "epigraph_core_comic_progress_held"
