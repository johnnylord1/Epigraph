package epigraph.sync.core.suwayomi

import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import epigraph.sync.core.protocol.SuwayomiContentOperation
import epigraph.sync.core.protocol.SuwayomiContentRequest
import epigraph.sync.core.protocol.SuwayomiContentResponse
import kotlinx.serialization.json.JsonObject
import eu.kanade.tachiyomi.source.model.SManga
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Response
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test

class EpigraphCoreSourceTest {
    @Test
    fun `source remains registered while an unpaired gateway disables remote fetches`() {
        val source = EpigraphCoreSource(
            object : EpigraphCoreSourceGateway {
                override fun hasActiveSession(): Boolean = false
                override suspend fun content(
                    serverId: String?,
                    profileId: String,
                    request: SuwayomiContentRequest,
                ): SuwayomiContentResponse = error("not needed")

                override suspend fun image(
                    serverId: String?,
                    profileId: String,
                    upstreamPath: String,
                ): Response = error("not needed")
            },
        )

        assertEquals(EpigraphCoreSource.ID, source.id)
        assertFalse(source.hasActiveSession())
    }

    @Test
    fun `details chapters and pages keep opaque Core references`() = runTest {
        val gateway = RecordingGateway()
        val source = EpigraphCoreSource(gateway)
        val manga = SManga.create().apply {
            url = SuwayomiCoreContentReference.forManga("desktop-one", "main", 7)
            title = "Before"
        }

        val details = source.getMangaDetails(manga)
        val chapters = source.getChapterList(manga)
        val pages = source.getPageList(chapters.single())

        assertEquals(EpigraphCoreSource.ID, source.id)
        assertEquals("Core title", details.title)
        assertEquals("Core author", details.author)
        assertEquals("Core description", details.description)
        assertEquals(SManga.CANCELLED, details.status)
        assertEquals(12f, chapters.single().chapter_number)
        assertEquals("/api/v1/page/11", SuwayomiCoreContentReference.parsePage(pages.single().url)?.upstreamPath)
        assertEquals(
            listOf(
                SuwayomiContentOperation.FETCH_MANGA,
                SuwayomiContentOperation.FETCH_CHAPTERS,
                SuwayomiContentOperation.FETCH_CHAPTER_PAGES,
            ),
            gateway.operations,
        )
    }

    @Test
    fun `missing chapters collection is a protocol failure instead of an empty catalog`() = runTest {
        val gateway = RecordingGateway(includeChaptersCollection = false)
        val source = EpigraphCoreSource(gateway)
        val manga = SManga.create().apply {
            url = SuwayomiCoreContentReference.forManga("desktop-one", "main", 7)
            title = "Before"
        }

        val failure = runCatching { source.getChapterList(manga) }.exceptionOrNull()

        assertEquals(true, failure is EpigraphCoreSourceException)
    }

    @Test
    fun `persisted Core catalog supplies chapters when live extension refresh fails`() = runTest {
        val gateway = RecordingGateway(failLiveChapters = true, includeCachedChapters = true)
        val source = EpigraphCoreSource(gateway)
        val manga = SManga.create().apply {
            url = SuwayomiCoreContentReference.forManga("desktop-one", "main", 7)
            title = "Before"
        }

        val chapters = source.getChapterList(manga)

        assertEquals(1, chapters.size)
        assertEquals("Cached chapter 19", chapters.single().name)
        assertEquals(19f, chapters.single().chapter_number)
    }

    @Test
    fun `Suwayomi chapters arrive oldest first and are listed newest first`() = runTest {
        val gateway = RecordingGateway(
            liveChapters = listOf(1, 2, 3).map { order ->
                buildJsonObject {
                    put("id", 100 + order)
                    put("name", "Chapter $order")
                    put("chapterNumber", order.toDouble())
                    put("sourceOrder", order)
                }
            },
        )
        val source = EpigraphCoreSource(gateway)
        val manga = SManga.create().apply {
            url = SuwayomiCoreContentReference.forManga("desktop-one", "main", 7)
            title = "Before"
        }

        val chapters = source.getChapterList(manga)

        assertEquals(listOf("Chapter 3", "Chapter 2", "Chapter 1"), chapters.map { it.name })
    }

    @Test
    fun `chapters carry the desktop read state`() = runTest {
        val gateway = RecordingGateway(
            liveChapters = listOf(
                buildJsonObject {
                    put("id", 201)
                    put("name", "Chapter 1")
                    put("chapterNumber", 1.0)
                    put("isRead", true)
                    put("lastPageRead", 17)
                    // Suwayomi sends lastReadAt as a LongString in epoch seconds.
                    put("lastReadAt", "1791289794")
                },
                buildJsonObject {
                    put("id", 202)
                    put("name", "Chapter 2")
                    put("chapterNumber", 2.0)
                    put("isRead", false)
                    put("lastPageRead", 4)
                },
                buildJsonObject {
                    put("id", 203)
                    put("name", "Chapter 3")
                    put("chapterNumber", 3.0)
                },
            ),
        )
        val source = EpigraphCoreSource(gateway)
        val manga = SManga.create().apply {
            url = SuwayomiCoreContentReference.forManga("desktop-one", "main", 7)
            title = "Before"
        }

        val chapters = source.getChapterList(manga).associateBy { it.name }

        assertEquals(true, chapters.getValue("Chapter 1").read)
        assertEquals(17, chapters.getValue("Chapter 1").last_page_read)
        assertEquals(false, chapters.getValue("Chapter 2").read)
        assertEquals(4, chapters.getValue("Chapter 2").last_page_read)
        assertEquals(false, chapters.getValue("Chapter 3").read)
        assertEquals(0, chapters.getValue("Chapter 3").last_page_read)
        assertEquals(1_791_289_794_000L, chapters.getValue("Chapter 1").last_read_at)
        assertEquals(0L, chapters.getValue("Chapter 3").last_read_at)
    }

    private class RecordingGateway(
        val includeChaptersCollection: Boolean = true,
        val liveChapters: List<JsonObject>? = null,
        val failLiveChapters: Boolean = false,
        val includeCachedChapters: Boolean = false,
    ) : EpigraphCoreSourceGateway {
        val operations = mutableListOf<SuwayomiContentOperation>()

        override suspend fun content(
            serverId: String?,
            profileId: String,
            request: SuwayomiContentRequest,
        ): SuwayomiContentResponse {
            assertEquals("desktop-one", serverId)
            assertEquals("main", profileId)
            operations += request.operation
            val payload = when (request.operation) {
                SuwayomiContentOperation.FETCH_MANGA -> buildJsonObject {
                    put("fetchManga", buildJsonObject {
                        put("manga", buildJsonObject {
                            put("id", 7)
                            put("title", "Core title")
                            put("author", "Core author")
                            put("description", "Core description")
                            put("status", "CANCELLED")
                            put("genre", buildJsonArray { add(JsonPrimitive("Action")) })
                        })
                    })
                }
                SuwayomiContentOperation.FETCH_CHAPTERS -> buildJsonObject {
                    if (failLiveChapters) error("source extension unavailable")
                    put("fetchChapters", buildJsonObject {
                        if (includeChaptersCollection) {
                            put("chapters", buildJsonArray {
                                if (liveChapters != null) {
                                    liveChapters.forEach { add(it) }
                                } else {
                                    add(buildJsonObject {
                                        put("id", 11)
                                        put("name", "Chapter 12")
                                        put("chapterNumber", 12.0)
                                    })
                                }
                            })
                        }
                    })
                }
                SuwayomiContentOperation.FETCH_CHAPTER_PAGES -> buildJsonObject {
                    put("fetchChapterPages", buildJsonObject {
                        put("pages", buildJsonArray { add(JsonPrimitive("/api/v1/page/11")) })
                    })
                }
            }
            return SuwayomiContentResponse(
                schemaVersion = 1,
                scopeId = "comics:profile:main",
                operation = request.operation,
                fetchedAtMs = 1,
                data = payload,
            )
        }

        override suspend fun cachedChapters(
            serverId: String?,
            profileId: String,
            mangaId: Long,
        ): List<JsonObject>? = if (includeCachedChapters) {
            listOf(buildJsonObject {
                put("id", 19)
                put("name", "Cached chapter 19")
                put("chapterNumber", 19.0)
            })
        } else {
            null
        }

        override suspend fun image(serverId: String?, profileId: String, upstreamPath: String): Response =
            error("not needed")
    }
}
