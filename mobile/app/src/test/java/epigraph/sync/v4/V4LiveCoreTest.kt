package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.sync.core.assets.CoreAssetFileMaterializer
import epigraph.sync.core.assets.CoreAssetId
import epigraph.sync.core.assets.CoreAssetSession
import epigraph.sync.core.assets.OkHttpCoreAssetHttpClient
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.pairing.transport.EpigraphCoreTlsClientFactory
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.time.measureTimedValue
import kotlin.time.measureTime

class V4LiveCoreTest {
    @Test
    fun `restored library crosses pinned TLS and converges into a fresh device`(@TempDir root: Path) = runBlocking {
        val core = System.getenv("EPIGRAPH_V4_LIVE_ORIGIN")
        assumeTrue(!core.isNullOrBlank(), "Requires the isolated V4 Core test runner")
        val fixture = Path.of(requireNotNull(System.getenv("EPIGRAPH_V4_RESTORED_COMICS_DB")))
        val pin = requireNotNull(System.getenv("EPIGRAPH_V4_LIVE_FINGERPRINT"))
        val sourceToken = requireNotNull(System.getenv("EPIGRAPH_V4_LIVE_WRITE_TOKEN"))
        val destToken = requireNotNull(System.getenv("EPIGRAPH_V4_LIVE_READ_TOKEN"))
        val origin = requireNotNull(core).toHttpUrl()
        val client = EpigraphCoreTlsClientFactory(
            OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS).build(),
        ).create(pin)
        val http = V4CoreHttpClient(client, origin, VERSION)
        val sse = V4SseClient(client, origin, VERSION)
        val pdf = root.resolve("source.pdf").toFile().apply { writeText(SAMPLE_PDF) }
        val epub = root.resolve("source.epub").toFile().apply { writeSampleEpub(this) }
        val files = listOf(pdf, epub).associateBy { file ->
            MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
        }
        val sourcePath = Files.copy(fixture, root.resolve("source.db"))
        val (novels, languages) = loadV4NovelFixture(File(requireNotNull(System.getenv("EPIGRAPH_TEST_LNREADER_BACKUP"))), root.toFile())

        fun engine(db: Database, driver: JdbcSqliteDriver, device: String): V4SyncEngine {
            val handler = AndroidDatabaseHandler(db, driver)
            return V4SyncEngine(
                "isolated-core", "main", device, SqlDelightV4SyncStore(db), http, sse,
                CompositeV4DomainBridge(
                    V4ComicDomainBridge(handler),
                    V4NovelDomainBridge(handler) { languages },
                    V4BookDomainBridge(handler, root.resolve(device).toFile()),
                ),
            )
        }

        JdbcSqliteDriver("jdbc:sqlite:$sourcePath").use { sourceDriver ->
            Database.Schema.migrate(sourceDriver, oldVersion = 66, newVersion = 67)
            val source = database(sourceDriver)
            source.seedV4NovelFixture(novels, languages)
            for ((sha, file) in files) {
                val subtype = file.extension.uppercase()
                val mime = if (subtype == "PDF") "application/pdf" else "application/epub+zip"
                source.local_booksQueries.insert(
                    "fixture-$subtype", subtype, sha, "Fixture $subtype", null, null, null, null, null, null,
                    file.absolutePath, mime, file.length(), 1, null, 1, 1,
                )
            }
            val upload = engine(source, sourceDriver, "fixture-phone")
            val (sent, sendTime) = measureTimedValue { upload.syncOnce(sourceToken) }
            assertTrue(sent is V4SyncRunResult.Synced, "Initial mobile-to-Core sync failed")
            assertTrue((sent as V4SyncRunResult.Synced).uploadedCount >= 30_000)

            val transfer = CoreAssetFileMaterializer(OkHttpCoreAssetHttpClient(client, origin), DEFAULT_ASSET_LIMIT)
            for ((sha, file) in files) {
                transfer.upload(CoreAssetId.parse(sha), "books:global", CoreAssetSession(sourceToken, VERSION, 4), file)
                val downloaded = root.resolve("downloaded.${file.extension}").toFile()
                transfer.download(
                    assetId = CoreAssetId.parse(sha), expectedSize = file.length(), scopeId = "books:global",
                    session = CoreAssetSession(destToken, VERSION, 4), destination = downloaded,
                )
                assertTrue(file.readBytes().contentEquals(downloaded.readBytes()), "Core did not round-trip the publication bytes")
            }

            JdbcSqliteDriver("jdbc:sqlite:${root.resolve("destination.db")}").use { destDriver ->
                Database.Schema.create(destDriver)
                val dest = database(destDriver)
                val pull = engine(dest, destDriver, "fixture-receiver")
                val (landed, pullTime) = measureTimedValue { pull.syncOnce(destToken) }
                assertTrue(landed is V4SyncRunResult.Synced, "Core-to-mobile sync failed")
                assertEquals(
                    source.mangasQueries.findFavorites().executeAsList().count { it.source != 0L },
                    dest.mangasQueries.findFavorites().executeAsList().size,
                )
                assertEquals(files.keys, dest.local_booksQueries.findAll().executeAsList().map { it.sha256 }.toSet())
                val restoredNovels = dest.mangasQueries.findFavorites().executeAsList().filter {
                    dest.aethon_syncQueries.selectIdentityByLocalReference("NOVEL", it._id.toString()).executeAsOneOrNull() != null
                }
                assertEquals(9, restoredNovels.size)
                assertEquals(6_936, restoredNovels.sumOf { dest.chaptersQueries.getBackupChaptersByMangaId(it._id).executeAsList().size })
                assertEquals(442, restoredNovels.sumOf { dest.historyQueries.getBackupByMangaId(it._id).executeAsList().size })
                assertTrue(http.capabilities(destToken) is CoreHttpResult.Success)
                val reconnect = List(30) {
                    measureTime {
                        val result = pull.syncOnce(destToken)
                        assertTrue(result is V4SyncRunResult.Synced && result.wasNoOpReconnect)
                    }.inWholeMilliseconds
                }.sorted()
                println("V4 pinned HTTPS gate: upload=$sendTime Android receive=$pullTime empty reconnect p95=${reconnect[28]}ms")
                assertTrue(reconnect[28] < 500, "V4 empty reconnect exceeded 500 ms p95")
            }
        }
    }

    private fun database(driver: JdbcSqliteDriver): Database =
        Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))

    private fun writeSampleEpub(file: File) {
        ZipOutputStream(file.outputStream()).use { zip ->
            fun entry(path: String, contents: String) {
                zip.putNextEntry(ZipEntry(path))
                zip.write(contents.toByteArray())
                zip.closeEntry()
            }
            entry("mimetype", "application/epub+zip")
            entry("META-INF/container.xml", """<container version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>""")
            entry("book.opf", """<package version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>""")
            entry("chapter.xhtml", """<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head><body><p>A test chapter.</p></body></html>""")
        }
    }

    private companion object {
        const val VERSION = "0.1.0"
        const val DEFAULT_ASSET_LIMIT = 8L * 1024 * 1024
        val SAMPLE_PDF = "%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n" +
            "2 0 obj\n<</Type/Pages/Count 1/Kids[3 0 R]>>\nendobj\n" +
            "3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>\nendobj\n" +
            "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000054 00000 n \n0000000106 00000 n \n" +
            "trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n172\n%%EOF\n"
    }
}
