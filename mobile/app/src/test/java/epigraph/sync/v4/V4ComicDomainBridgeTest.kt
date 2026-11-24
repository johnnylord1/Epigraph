package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter
import java.nio.file.Files
import java.nio.file.Path
import kotlin.time.measureTimedValue

class V4ComicDomainBridgeTest {
    @Test
    fun `restored comics library projects into a fresh Android database`(@TempDir temp: Path) = runTest {
        val fixture = System.getenv("EPIGRAPH_V4_RESTORED_COMICS_DB")
        assumeTrue(!fixture.isNullOrBlank(), "Set EPIGRAPH_V4_RESTORED_COMICS_DB to a restored v66 database")
        val copy = Files.copy(Path.of(fixture), temp.resolve("source.db"))
        val json = V4CoreHttpClient.DEFAULT_JSON
        val (export, exportTime) = measureTimedValue {
            JdbcSqliteDriver("jdbc:sqlite:$copy").use { driver ->
                Database.Schema.migrate(driver, oldVersion = 66, newVersion = 67)
                val source = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
                V4ComicDomainBridge(handler(source, driver)).exportLocalSnapshot("core", "main", V4HlcClock("source"))
            }
        }
        assertTrue(export.count { it.entityType == "comic.work" } >= 600)
        assertTrue(export.count { it.entityType == "comic.chapter" } >= 30_000)

        val fixtureOutput = System.getenv("EPIGRAPH_V4_BATCH_FIXTURE_DIR")
        if (!fixtureOutput.isNullOrBlank()) {
            val output = Files.createDirectories(Path.of(fixtureOutput))
            export.chunked(20_000).forEachIndexed { index, items ->
                Files.writeString(output.resolve("bulk-$index.json"), json.encodeToString(V4BatchRequest(items)))
            }
        }

        val coreSnapshot = System.getenv("EPIGRAPH_V4_SNAPSHOT_FIXTURE")
        val records = if (coreSnapshot.isNullOrBlank()) {
            export.mapIndexed { index, item ->
                V4WireRecord(index.toLong() + 1, item.domain, item.entityType, item.entityKey, item.deleted,
                    item.hlc, "source", item.payload)
            }
        } else {
            json.decodeFromString<V4SnapshotResponse>(Files.readString(Path.of(coreSnapshot))).records
        }
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            val dest = database(driver)
            driver.execute(null, "PRAGMA foreign_keys = ON", 0)
            val bridge = V4ComicDomainBridge(handler(dest, driver))
            val (_, applyTime) = measureTimedValue { bridge.applyRemoteRecords("core", "main", records) }
            val restored = bridge.exportLocalSnapshot("core", "main", V4HlcClock("destination"))
            val expected = export.groupBy { it.entityType }.mapValues { (_, items) -> items.map { it.entityKey }.toSet() }
            val actual = restored.groupBy { it.entityType }.mapValues { (_, items) -> items.map { it.entityKey }.toSet() }
            for ((type, keys) in expected) {
                assertEquals(keys.size, actual[type]?.size, type)
                assertTrue(actual[type]?.containsAll(keys) == true, type)
            }
            println("V4 real comics fixture counts=${expected.mapValues { it.value.size }} export=$exportTime apply=$applyTime")
        }
    }

    @Test
    fun `real library tables export and reapply a comic with progress categories history and tracking`() = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { sourceDriver ->
            val source = database(sourceDriver)
            sourceDriver.execute(null, """
                INSERT INTO mangas (_id, source, url, title, status, favorite, initialized, viewer, hide_title, chapter_flags)
                VALUES (42, 123, 'https://mirror-one.example/manga/a?style=list', 'Example', 1, 1, 1, 0, 0, 0),
                       (43, 0, '/local/book', 'Local only', 1, 1, 1, 0, 0, 0)
            """.trimIndent(), 0)
            sourceDriver.execute(null, """
                INSERT INTO chapters (_id, manga_id, url, name, read, bookmark, last_page_read, pages_left,
                    chapter_number, source_order, date_fetch, date_upload)
                VALUES (7, 42, 'https://mirror-one.example/ch/1/?style=list', 'Chapter 1', 1, 1, 8, 0, 1, 1, 20, 10)
            """.trimIndent(), 0)
            source.categoriesQueries.insert("Reading", 1, 0, "")
            val category = source.categoriesQueries.selectLastInsertedRowId().executeAsOne()
            source.mangas_categoriesQueries.insert(42, category)
            source.historyQueries.upsertSyncedLastRead(7, 100)
            source.manga_syncQueries.insert(42, 1, 99, null, "Example", 1.0, 16, 1, 8.0, "", 0, 0)

            val export = V4ComicDomainBridge(handler(source, sourceDriver))
                .exportLocalSnapshot("core", "main", V4HlcClock("source", wallClockMs = { 200L }))
            assertEquals(
                setOf("comic.work", "comic.chapter", "comic.category", "comic.category_assignment", "comic.history", "comic.tracking"),
                export.map { it.entityType }.toSet(),
            )
            assertEquals(6, export.size)
            assertEquals("123:/manga/a|/ch/1", export.single { it.entityType == "comic.chapter" }.entityKey)

            JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { destDriver ->
                val dest = database(destDriver)
                val bridge = V4ComicDomainBridge(handler(dest, destDriver))
                val records = export.mapIndexed { index, item ->
                    V4WireRecord(index.toLong() + 1, item.domain, item.entityType, item.entityKey, item.deleted,
                        item.hlc, "source", item.payload)
                }
                bridge.applyRemoteRecords("core", "main", records.reversed())
                bridge.applyRemoteRecords("core", "main", records)

                val manga = dest.mangasQueries.findFavorites().executeAsOne()
                val chapter = dest.chaptersQueries.getBackupChaptersByMangaId(manga._id).executeAsOne()
                assertEquals("Example", manga.title)
                assertTrue(chapter.read)
                assertTrue(chapter.bookmark)
                assertEquals(8L, chapter.last_page_read)
                assertEquals("Reading", dest.categoriesQueries.findAllByMangaId(manga._id).executeAsOne().name)
                assertEquals(100L, dest.historyQueries.getBackupByMangaId(manga._id).executeAsOne().history_last_read)
                assertEquals(99L, dest.manga_syncQueries.getAllByMangaId(manga._id).executeAsOne().remote_id)
            }
        }
    }

    @Test
    fun `a deleted category does not block snapshot replay of other comics`() = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            val db = database(driver)
            val bridge = V4ComicDomainBridge(handler(db, driver))
            val work = V4WireRecord(
                1, "comics", "comic.work", "123:/manga/a", false, V4Hlc(1, 0, "desktop"), "desktop",
                Json.parseToJsonElement("""{"sourceId":"123","url":"/manga/a","title":"A"}"""),
            )
            val assignment = V4WireRecord(
                2, "comics", "comic.category_assignment", "123:/manga/a|reading", false, V4Hlc(2, 0, "desktop"),
                "desktop", Json.parseToJsonElement("""{"workKey":"123:/manga/a","categoryKey":"reading"}"""),
            )
            val category = V4WireRecord(
                3, "comics", "comic.category", "reading", true, V4Hlc(3, 0, "desktop"), "desktop",
                kotlinx.serialization.json.JsonNull,
            )

            bridge.applyRemoteRecords("core", "main", listOf(work, assignment, category))

            val mangaId = db.mangasQueries.findFavorites().executeAsOne()._id
            assertTrue(db.categoriesQueries.findAllByMangaId(mangaId).executeAsList().isEmpty())
        }
    }

    @Test
    fun `chapters retained under a work tombstone do not block recovery of other comics`() = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            val db = database(driver)
            val bridge = V4ComicDomainBridge(handler(db, driver))
            val removed = V4WireRecord(
                3, "comics", "comic.work", "123:/removed", true, V4Hlc(3, 0, "desktop"), "desktop",
                kotlinx.serialization.json.JsonNull,
            )
            val chapter = V4WireRecord(
                2, "comics", "comic.chapter", "123:/removed|/ch/1", false, V4Hlc(2, 0, "desktop"), "desktop",
                Json.parseToJsonElement("""{"workKey":"123:/removed","url":"/ch/1","isRead":true}"""),
            )
            val remaining = V4WireRecord(
                1, "comics", "comic.work", "123:/kept", false, V4Hlc(1, 0, "desktop"), "desktop",
                Json.parseToJsonElement("""{"sourceId":"123","url":"/kept","title":"Kept"}"""),
            )
            bridge.applyRemoteRecords("core", "main", listOf(remaining, chapter, removed))
            assertEquals("Kept", db.mangasQueries.findFavorites().executeAsOne().title)
        }
    }

    @Test
    fun `newer chapter reset updates the existing local identity and stale replay stays ignored`() = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            val db = database(driver)
            val bridge = V4ComicDomainBridge(handler(db, driver))
            fun record(type: String, key: String, seq: Long, payload: String) = V4WireRecord(
                seq, "comics", type, key, false, V4Hlc(seq, 0, "desktop"), "desktop", Json.parseToJsonElement(payload),
            )
            val work = record("comic.work", "123:/manga/a", 1, """{"sourceId":"123","url":"/manga/a","title":"A","favorite":true}""")
            val read = record("comic.chapter", "123:/manga/a|/ch/1", 2,
                """{"workKey":"123:/manga/a","url":"https://mirror-one.example/ch/1?style=list","name":"Chapter 1","isRead":true,"isBookmarked":true,"lastPageRead":8}""")
            bridge.applyRemoteRecords("core", "main", listOf(work, read))
            val mangaId = db.mangasQueries.findFavorites().executeAsOne()._id
            val id = db.chaptersQueries.getBackupChaptersByMangaId(mangaId).executeAsOne()._id
            val reset = record("comic.chapter", "123:/manga/a|/ch/1", 3,
                """{"workKey":"123:/manga/a","url":"/ch/1/","name":"Chapter 1","isRead":false,"isBookmarked":true,"lastPageRead":0}""")
            bridge.applyRemoteRecords("core", "main", listOf(reset, read))
            val updated = db.chaptersQueries.getBackupChaptersByMangaId(mangaId).executeAsOne()
            assertEquals(id, updated._id)
            assertFalse(updated.read)
            assertTrue(updated.bookmark)
            assertEquals(0L, updated.last_page_read)
        }
    }

    @Test
    fun `reserved Completed category and assignments are ignored`() = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            val db = database(driver)
            val bridge = V4ComicDomainBridge(handler(db, driver))
            val work = V4WireRecord(
                1, "comics", "comic.work", "123:/manga/a", false, V4Hlc(1, 0, "desktop"), "desktop",
                Json.parseToJsonElement("""{"sourceId":"123","url":"/manga/a","title":"A","favorite":true}"""),
            )
            val completedCategory = V4WireRecord(
                2, "comics", "comic.category", "Completed", false, V4Hlc(2, 0, "desktop"), "desktop",
                Json.parseToJsonElement("""{"name":"Completed","order":0,"flags":0}"""),
            )
            val assignment = V4WireRecord(
                3, "comics", "comic.category_assignment", "123:/manga/a|completed", false, V4Hlc(3, 0, "desktop"), "desktop",
                Json.parseToJsonElement("""{"workKey":"123:/manga/a","categoryKey":"Completed"}"""),
            )

            bridge.applyRemoteRecords("core", "main", listOf(work, completedCategory, assignment))

            assertTrue(db.categoriesQueries.findAllComics().executeAsList().isEmpty())
            val mangaId = db.mangasQueries.findFavorites().executeAsOne()._id
            assertTrue(db.categoriesQueries.findAllByMangaId(mangaId).executeAsList().isEmpty())
        }
    }

    @Test
    fun `unbound local favorite comic is preserved against remote work tombstone`() = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            val db = database(driver)
            driver.execute(null, """
                INSERT INTO mangas (_id, source, url, title, status, favorite, initialized, viewer, hide_title, chapter_flags)
                VALUES (42, 123, '/manga/local-fav', 'Local Fav', 1, 1, 1, 0, 0, 0)
            """.trimIndent(), 0)
            val bridge = V4ComicDomainBridge(handler(db, driver))
            val tombstone = V4WireRecord(
                1, "comics", "comic.work", "123:/manga/local-fav", true, V4Hlc(10, 0, "desktop"), "desktop",
                kotlinx.serialization.json.JsonNull,
            )

            bridge.applyRemoteRecords("core", "main", listOf(tombstone))

            val favorites = db.mangasQueries.findFavorites().executeAsList()
            assertEquals(1, favorites.size)
            assertEquals(42L, favorites.single()._id)
        }
    }

    private fun database(driver: JdbcSqliteDriver): Database {
        Database.Schema.create(driver)
        return Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    }

    private fun handler(database: Database, driver: JdbcSqliteDriver) =
        AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
}
