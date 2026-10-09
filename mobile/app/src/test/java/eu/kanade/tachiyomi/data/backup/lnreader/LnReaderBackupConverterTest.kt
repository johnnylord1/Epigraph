package eu.kanade.tachiyomi.data.backup.lnreader

import epigraph.novel.source.NovelSource
import eu.kanade.tachiyomi.data.backup.models.BackupNovelRepository
import eu.kanade.tachiyomi.source.model.SManga
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class LnReaderBackupConverterTest {
    private val workDir: File = Files.createTempDirectory("lnreader-test").toFile()

    @AfterEach
    fun cleanUp() {
        workDir.deleteRecursively()
    }

    @Test
    fun `library novels become Books and novels titles with progress folders and covers`() {
        val covers = mutableMapOf<String, ByteArray>()
        val backup = converter().convert(write(outerBackup()), workDir) { url, bytes -> covers[url] = bytes }

        val novel = backup.backupManga.single()
        assertEquals(NovelSource.sourceIdFor("plug", "pt"), novel.source)
        assertEquals("/novel/sample", novel.url)
        assertEquals("Sample Novel", novel.title)
        assertEquals("Writer", novel.author)
        assertEquals("About it", novel.description)
        assertEquals(listOf("Action", "Drama"), novel.genre)
        assertEquals(SManga.ONGOING, novel.status)
        assertTrue(novel.favorite)

        // The newest chapter comes first in the source order, like a source listing.
        val chapters = novel.chapters.associateBy { it.url }
        assertEquals(listOf(2, 1, 0), listOf("/c1", "/c2", "/c3").map { chapters.getValue(it).sourceOrder })
        assertTrue(chapters.getValue("/c1").read)
        assertEquals(0, chapters.getValue("/c1").lastPageRead)
        assertFalse(chapters.getValue("/c2").read)
        assertEquals(40, chapters.getValue("/c2").lastPageRead)
        assertEquals(60, chapters.getValue("/c2").pagesLeft)
        assertTrue(chapters.getValue("/c3").bookmark)
        assertEquals(3f, chapters.getValue("/c3").chapterNumber)

        val readAt = LocalDateTime.of(2024, 5, 1, 21, 3, 11).toInstant(ZoneOffset.UTC).toEpochMilli()
        assertEquals(readAt, novel.history.single { it.url == "/c2" }.lastRead)

        // LNReader's default and empty local categories are not user folders.
        assertEquals(listOf("Reading", "Favorites"), backup.backupCategories.map { it.name })
        assertTrue(backup.backupCategories.all { it.library == "BOOKS" })
        assertEquals(listOf(0, 1), novel.categories.sorted())

        val source = backup.backupSources.single()
        assertEquals("Plug Source", source.name)
        assertTrue(source.isNovel)

        val cover = novel.thumbnailUrl!!
        assertTrue(cover.startsWith("https://lnreader-backup.invalid/cover/plug/"))
        assertArrayEquals(PNG, covers.getValue(cover))
        assertTrue(workDir.listFiles().orEmpty().isEmpty(), "temporary files are removed")

        // Only the repositories of installed or used plugins come along, each once.
        assertEquals(
            listOf(BackupNovelRepository("$REPO/master/.dist/plugins.min.json", "LNReader plugins")),
            backup.novelRepositories,
        )
    }

    @Test
    fun `plugin script addresses lead to their repository index`() {
        assertEquals(
            "https://raw.githubusercontent.com/someone/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
            LnReaderBackupConverter.repositoryUrl(
                "https://raw.githubusercontent.com/someone/lnreader-plugins/plugins/v3.0.0/.js/src/plugins/english/x.js",
            ),
        )
        assertNull(LnReaderBackupConverter.repositoryUrl("http://raw.githubusercontent.com/lnreader/lnreader-plugins/master/.js/a.js"))
        assertNull(LnReaderBackupConverter.repositoryUrl("https://example.org/lnreader/lnreader-plugins/master/.js/a.js"))
        assertNull(LnReaderBackupConverter.repositoryUrl("https://raw.githubusercontent.com/lnreader/other/master/.js/a.js"))
        assertNull(LnReaderBackupConverter.repositoryUrl("https://raw.githubusercontent.com/lnreader/lnreader-plugins/.js/a.js"))
        assertNull(LnReaderBackupConverter.repositoryUrl("not a url"))
        assertNull(LnReaderBackupConverter.repositoryUrl(null))
    }

    @Test
    fun `a validation pass leaves covers alone and an installed plugin decides the language`() {
        val backup = converter(mapOf("plug" to "en")).convert(write(outerBackup()), workDir)

        val novel = backup.backupManga.single()
        assertEquals(NovelSource.sourceIdFor("plug", "en"), novel.source)
        assertNull(novel.thumbnailUrl)
    }

    @Test
    fun `the data archive alone is accepted and an online cover is kept`() {
        val file = write(dataZip(cover = "https://example.org/cover.jpg"))
        assertTrue(ZipFile(file).use(LnReaderBackupConverter::isLnReaderBackup))

        val novel = converter().convert(file, workDir).backupManga.single()
        assertEquals("https://example.org/cover.jpg", novel.thumbnailUrl)
    }

    @Test
    fun `other archives are not taken for LNReader backups`() {
        val file = write(zip("manifest.json" to "{}".toByteArray(), "payloads/manga/backup.tachibk" to byteArrayOf(1)))
        assertFalse(ZipFile(file).use(LnReaderBackupConverter::isLnReaderBackup))
    }

    @Test
    fun `a backup without library novels is refused`() {
        val file = write(dataZip(inLibrary = false))
        assertThrows(IllegalArgumentException::class.java) { converter().convert(file, workDir) }
    }

    private fun converter(langs: Map<String, String> = emptyMap()) =
        LnReaderBackupConverter(langs, now = { 1_000L }, zone = ZoneOffset.UTC)

    private fun outerBackup(): ByteArray = zip(
        "data.zip" to dataZip(cover = "/storage/emulated/0/Android/data/lnreader/files/Novels/plug/12/cover.png"),
        "download.zip" to zip("Novels/plug/12/cover.png" to PNG, "Novels/plug/12/1/index.html" to "<p>text</p>".toByteArray()),
    )

    private fun dataZip(cover: String? = null, inLibrary: Boolean = true): ByteArray {
        val novel = """
            {"id": 12, "pluginId": "plug", "path": "/novel/sample", "name": "Sample Novel", "author": "Writer",
             "summary": "About it", "genres": "Action, Drama", "status": "Ongoing", "inLibrary": ${if (inLibrary) 1 else 0},
             ${cover?.let { "\"cover\": \"$it\"," } ?: ""}
             "chapters": [
               {"path": "/c3", "name": "Three", "position": 3, "chapterNumber": 3, "unread": 1, "bookmark": 1},
               {"path": "/c1", "name": "One", "position": 1, "unread": 0, "readTime": "2024-04-30 10:00:00"},
               {"path": "/c2", "name": "Two", "position": 2, "unread": 1, "progress": 40, "readTime": "2024-05-01 21:03:11"}
             ]}
        """.trimIndent()
        val removed = """{"id": 13, "pluginId": "plug", "path": "/novel/gone", "name": "Gone", "inLibrary": 0, "chapters": []}"""
        val categories = """
            [{"id": 1, "name": "Default", "sort": 0, "novelIds": [12]},
             {"id": 2, "name": "Local", "sort": 1, "novelIds": []},
             {"id": 3, "name": "Favorites", "sort": 3, "novelIds": [12]},
             {"id": 4, "name": "Reading", "sort": 2, "novelIds": [12, 99]}]
        """.trimIndent()
        val plugins = """[{"id": "plug", "name": "Plug Source", "lang": "Português", "version": "1.0.0",
            "url": "$REPO/master/.js/src/plugins/portuguese/plug.js"}]"""
        // Plugins LNReader only listed as available bring no repository.
        val available = """[{"id": "plug", "name": "Old", "url": "$REPO/master/.js/plug.js"},
            {"id": "other", "name": "Other", "url": "https://raw.githubusercontent.com/else/lnreader-plugins/main/.js/o.js"}]"""
        return zip(
            "Version.json" to """{"version": "2.0.0"}""".toByteArray(),
            "Category.json" to categories.toByteArray(),
            "Setting.json" to """{"INSTALL_PLUGINS": ${quote(plugins)}, "AVAILABLE_PLUGINS": ${quote(available)}}""".toByteArray(),
            "NovelAndChapters/12.json" to novel.toByteArray(),
            "NovelAndChapters/13.json" to removed.toByteArray(),
        )
    }

    private fun quote(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun zip(vararg entries: Pair<String, ByteArray>): ByteArray = ByteArrayOutputStream().also { output ->
        ZipOutputStream(output).use { zip ->
            entries.forEach { (name, bytes) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                zip.closeEntry()
            }
        }
    }.toByteArray()

    private fun write(bytes: ByteArray): File =
        File.createTempFile("backup", ".zip").also {
            it.deleteOnExit()
            it.writeBytes(bytes)
        }

    private companion object {
        const val REPO = "https://raw.githubusercontent.com/lnreader/lnreader-plugins"
        val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
    }
}
