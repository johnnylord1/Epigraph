package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import eu.kanade.tachiyomi.data.backup.lnreader.LnReaderBackupConverter
import eu.kanade.tachiyomi.data.backup.models.Backup
import epigraph.novel.source.NovelSource
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter
import java.io.File
import java.time.ZoneOffset
import java.util.zip.ZipFile
import kotlin.time.measureTime

class V4NovelDomainBridgeTest {
    @Test
    fun `novel category tombstone keeps a folder with a book assignment and deletes it when empty`(@TempDir root: File) = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            val db = database(driver)
            val handler = AndroidDatabaseHandler(db, driver)
            val books = V4BookDomainBridge(handler, root)
            val novels = V4NovelDomainBridge(handler) { emptyMap() }
            val hash = "d".repeat(64)
            val setup = listOf(
                V4WireRecord(1, "books", "book.category", "reference", false, V4Hlc(1, 0, "desktop"), "desktop",
                    buildJsonObject { put("name", "Reference"); put("order", 0) }, 1),
                V4WireRecord(2, "books", "book.work", hash, false, V4Hlc(2, 0, "desktop"), "desktop",
                    buildJsonObject { put("fileSha256", hash); put("subtype", "epub"); put("title", "Book") }, 2),
                V4WireRecord(3, "books", "book.category_assignment", "$hash|reference", false, V4Hlc(3, 0, "desktop"), "desktop",
                    buildJsonObject { put("categoryKey", "reference") }, 3),
            )
            books.applyRemoteRecords("core", "main", setup)

            val tombstone = V4WireRecord(4, "novels", "novel.category", "reference", true, V4Hlc(4, 0, "desktop"), "desktop", JsonNull, 4)
            novels.applyRemoteRecords("core", "main", listOf(tombstone))
            val folder = db.categoriesQueries.findAllBooks().executeAsList().single { it.name == "Reference" }
            assertNotNull(folder)

            books.applyRemoteRecords("core", "main", listOf(setup.last().copy(serverSeq = 5, deleted = true, hlc = V4Hlc(5, 0, "desktop"), payload = JsonNull)))
            novels.applyRemoteRecords("core", "main", listOf(tombstone.copy(serverSeq = 6, hlc = V4Hlc(6, 0, "desktop"))))
            assertNull(db.categoriesQueries.findAllBooks().executeAsList().firstOrNull { it.name == "Reference" })
        }
    }

    @Test
    fun `unbound local favorite novel is preserved against remote work tombstone`() = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            val db = database(driver)
            val plugin = "novel-plugin"
            val sourceId = NovelSource.sourceIdFor(plugin, "en")
            db.mangasQueries.insert(
                sourceId, "/novel/local-fav", null, "Author", null, null,
                "Local Novel", 0, null, true, null,
                true, 0, false, 0, 1L, null, 0, 0, 0, 0, JsonObject(emptyMap()),
            )
            val bridge = V4NovelDomainBridge(AndroidDatabaseHandler(db, driver)) { mapOf(plugin to "en") }
            val tombstone = V4WireRecord(
                1, "novels", "novel.work", "$plugin:/novel/local-fav", true, V4Hlc(10, 0, "desktop"), "desktop", JsonNull, 10,
            )

            bridge.applyRemoteRecords("core", "main", listOf(tombstone))

            val favorites = db.mangasQueries.findFavorites().executeAsList()
            assertEquals(1, favorites.size)
            assertEquals("Local Novel", favorites.single().title)
        }
    }

    @Test
    fun `two exports with different clocks give equal digests`() = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            val db = database(driver)
            val plugin = "novel-plugin"
            db.mangasQueries.insert(
                NovelSource.sourceIdFor(plugin, "en"), "/novel/digest", null, "Author", null, null,
                "Digest Novel", 0, null, true, null,
                true, 0, false, 0, 1L, null, 0, 0, 0, 0, JsonObject(emptyMap()),
            )
            val bridge = V4NovelDomainBridge(AndroidDatabaseHandler(db, driver)) { mapOf(plugin to "en") }

            val digestsBefore = bridge.digestSnapshot("core", "main")
            val early = bridge.exportLocalSnapshot("core", "main", V4HlcClock("phone", wallClockMs = { 100L }))
            val late = bridge.exportLocalSnapshot("core", "main", V4HlcClock("phone", wallClockMs = { 9_000_000L }))

            assertTrue(digestsBefore.isNotEmpty())
            assertTrue(early.map { it.hlc } != late.map { it.hlc }, "Test clocks must actually differ")
            assertEquals(early.map { it.payload }, late.map { it.payload })
            assertEquals(digestsBefore, bridge.digestSnapshot("core", "main"))
        }
    }

    @Test
    fun `real LNReader backup survives V4 export and application`(@TempDir root: File) = runTest {
        val path = System.getenv("EPIGRAPH_TEST_LNREADER_BACKUP")
        assumeTrue(!path.isNullOrBlank(), "Set EPIGRAPH_TEST_LNREADER_BACKUP to an LNReader export")
        val (backup, languages) = loadV4NovelFixture(File(requireNotNull(path)), root)
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { sourceDriver ->
            val source = database(sourceDriver)
            source.seedV4NovelFixture(backup, languages)
            val sourceBridge = V4NovelDomainBridge(AndroidDatabaseHandler(source, sourceDriver)) { languages }
            val baseline = sourceBridge.exportLocalSnapshot("core", "main", V4HlcClock("phone"))
            val records = baseline.mapIndexed { index, item ->
                V4WireRecord(index + 1L, item.domain, item.entityType, item.entityKey, item.deleted, item.hlc, "phone", item.payload)
            }
            assertEquals(backup.backupManga.size, records.count { it.entityType == "novel.work" })
            assertTrue(records.count { it.entityType == "novel.chapter" } > 6_000)
            val read = records.count { it.entityType == "novel.chapter" && it.payload.jsonObject["isRead"] == JsonPrimitive(true) }
            val history = records.filter { it.entityType == "novel.history" }
                .sumOf { it.payload.jsonObject.getValue("historyEntries").jsonArray.size }
            JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { destDriver ->
                val destination = database(destDriver)
                val destBridge = V4NovelDomainBridge(AndroidDatabaseHandler(destination, destDriver)) { languages }
                val elapsed = measureTime { destBridge.applyRemoteRecords("core", "main", records.reversed()) }
                val completed = destBridge.exportLocalSnapshot("core", "main", V4HlcClock("dest"))
                val before = baseline.associate { (it.entityType to it.entityKey) to it.payload }
                val after = completed.associate { (it.entityType to it.entityKey) to it.payload }
                assertEquals(before.size, after.size)
                assertTrue(before == after, "V4 novel state differs after applying the restored backup")
                println("V4 LNReader fixture: works=${backup.backupManga.size} chapters=${records.count { it.entityType == "novel.chapter" }} read=$read history=$history applied=$elapsed")
            }
        }
    }

    private fun database(driver: JdbcSqliteDriver): Database {
        Database.Schema.create(driver)
        return Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    }
}

internal fun loadV4NovelFixture(file: File, root: File): Pair<Backup, Map<String, String>> {
    val json = V4CoreHttpClient.DEFAULT_JSON
    fun fromArchive(archive: ZipFile) = archive.entries().asSequence()
        .filter { it.name.startsWith("NovelAndChapters/") && it.name.endsWith(".json") }
        .mapNotNull { entry ->
            val raw = archive.getInputStream(entry).bufferedReader().use { it.readText() }
            (json.parseToJsonElement(raw).jsonObject["pluginId"] as? JsonPrimitive)?.content
        }.toSet()
    val languages = ZipFile(file).use { archive ->
        val nested = archive.getEntry("data.zip") ?: return@use fromArchive(archive)
        val copy = root.resolve("fixture-data.zip")
        archive.getInputStream(nested).use { input -> copy.outputStream().use(input::copyTo) }
        ZipFile(copy).use(::fromArchive)
    }.associateWith { "en" }
    return LnReaderBackupConverter(languages, zone = ZoneOffset.UTC).convert(file, root) to languages
}

internal fun Database.seedV4NovelFixture(backup: Backup, languages: Map<String, String>) = transaction {
    val plugins = languages.entries.associate { (plugin, lang) -> NovelSource.sourceIdFor(plugin, lang) to plugin }
    for (work in backup.backupManga) {
        mangasQueries.insert(
            work.source, work.url, work.artist, work.author, work.description, work.genre.joinToString(", "),
            work.title, work.status.toLong(), work.thumbnailUrl, work.favorite, null, true,
            0, false, work.chapterFlags.toLong(), work.dateAdded, null, 0, 0, 0, 0, JsonObject(emptyMap()),
        )
        val id = mangasQueries.selectLastInsertedRowId().executeAsOne()
        val ref = epigraph.contract.PortableWorkRef.Novel(plugins.getValue(work.source), epigraph.contract.ProviderOwnedKey(work.url))
        aethon_syncQueries.upsertIdentity(epigraph.contract.PortableIdentityV3.workId(ref), "NOVEL", id.toString(), 0, 0)
        val chapterIds = mutableMapOf<String, Long>()
        for (chapter in work.chapters) {
            chaptersQueries.insert(
                id, chapter.url, chapter.name, chapter.scanlator, chapter.read, chapter.bookmark,
                chapter.lastPageRead.toLong(), chapter.pagesLeft.toLong(), chapter.chapterNumber.toDouble(),
                chapter.sourceOrder.toLong(), chapter.dateFetch, chapter.dateUpload, JsonObject(emptyMap()),
            )
            chapterIds[chapter.url] = chaptersQueries.selectLastInsertedRowId().executeAsOne()
        }
        for (entry in work.history) {
            chapterIds[entry.url]?.let { historyQueries.upsertSyncedLastRead(it, entry.lastRead) }
        }
    }
}
