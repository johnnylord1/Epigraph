package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.data.backup.models.Backup
import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import eu.kanade.tachiyomi.data.backup.models.BackupExtensionRepo
import eu.kanade.tachiyomi.data.backup.models.BackupLocalBook
import eu.kanade.tachiyomi.data.backup.models.BackupNovelRepository
import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.IntPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringSetPreferenceValue
import eu.kanade.tachiyomi.util.BackupUtil
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.protobuf.ProtoBuf
import kotlinx.serialization.protobuf.ProtoNumber
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ExtensionRepoBackupTest {

    private fun <T> gzipped(serializer: KSerializer<T>, value: T): ByteArray = ByteArrayOutputStream().also { output ->
        GZIPOutputStream(output).use { it.write(ProtoBuf.encodeToByteArray(serializer, value)) }
    }.toByteArray()

    @Test
    fun `a repository that failed to be added is told apart as gone, unsigned or unreachable`() {
        // A deleted GitHub repository: neither file exists.
        assertEquals(ExtensionRepoBackup.Problem.GONE, ExtensionRepoBackup.problem(404, 404))
        // An index without repo.json (tachiyomiorg/extensions): no signing key to verify with.
        assertEquals(ExtensionRepoBackup.Problem.UNVERIFIED, ExtensionRepoBackup.problem(200, 404))
        // repo.json is there but was rejected (no signing key).
        assertEquals(ExtensionRepoBackup.Problem.UNVERIFIED, ExtensionRepoBackup.problem(200, 200))
        // Offline, a server error or a rate limit may work later.
        assertEquals(ExtensionRepoBackup.Problem.UNREACHABLE, ExtensionRepoBackup.problem(null, null))
        assertEquals(ExtensionRepoBackup.Problem.UNREACHABLE, ExtensionRepoBackup.problem(503, 503))
        assertEquals(ExtensionRepoBackup.Problem.UNREACHABLE, ExtensionRepoBackup.problem(null, 404))
        assertEquals(ExtensionRepoBackup.Problem.UNREACHABLE, ExtensionRepoBackup.problem(429, 404))
    }

    @Test
    fun `every address form older apps stored maps to the repository base URL`() {
        val expected = mapOf(
            "https://github.com/keiyoushi/extensions/raw/repo/index.pb" to
                "https://raw.githubusercontent.com/keiyoushi/extensions/repo",
            "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json" to
                "https://raw.githubusercontent.com/keiyoushi/extensions/repo",
            "https://raw.githubusercontent.com/yuzono/tachiyomi-extensions/repo" to
                "https://raw.githubusercontent.com/yuzono/tachiyomi-extensions/repo",
            "https://github.com/yuzono/cursed-manga-repo/raw/refs/heads/repo/index.json" to
                "https://raw.githubusercontent.com/yuzono/cursed-manga-repo/repo",
            "https://example.org/ext/repo.json" to "https://example.org/ext",
            " https://example.org/ext/ " to "https://example.org/ext",
        )
        expected.forEach { (stored, base) -> assertEquals(base, ExtensionRepoBackup.baseUrl(stored), stored) }

        assertNull(ExtensionRepoBackup.baseUrl("http://example.org/ext"))
        assertNull(ExtensionRepoBackup.baseUrl("not a url"))
    }

    @Test
    fun `a J2K backup brings its repositories from the preference, which is not restored itself`() {
        val keiyoushi = "https://github.com/keiyoushi/extensions/raw/repo/index.pb"
        val yuzono = "https://raw.githubusercontent.com/yuzono/tachiyomi-extensions/repo"
        val metadata = """{"$keiyoushi":{"name":"Keiyoushi","website":"https://keiyoushi.github.io"}}"""
        val preferences = listOf(
            BackupPreference(ExtensionRepoBackup.LEGACY_REPOS_KEY, StringSetPreferenceValue(setOf(keiyoushi, yuzono))),
            BackupPreference("extension_repo_metadata", StringPreferenceValue(metadata)),
            BackupPreference("backup_interval", IntPreferenceValue(12)),
        )
        val j2k = Backup(backupManga = emptyList(), backupPreferences = preferences)

        val decoded = BackupUtil.decodeBackupBytes(gzipped(Backup.serializer(), j2k))

        assertEquals(
            listOf(
                BackupExtensionRepo(baseUrl = keiyoushi, name = "Keiyoushi", website = "https://keiyoushi.github.io"),
                BackupExtensionRepo(baseUrl = yuzono),
            ),
            decoded.backupExtensionRepos,
        )
        assertEquals(
            listOf("backup_interval"),
            BackupPreferencePolicy.restorableAppPreferences(decoded.backupPreferences) { emptySet() }.map { it.key },
        )
    }

    @Test
    fun `a Mihon backup restores, and its repositories are not read as local books`() {
        val mihon = MihonBackup(
            backupCategories = listOf(BackupCategory(name = "Reading", order = 1)),
            backupExtensionRepo = listOf(
                MihonRepo(
                    baseUrl = "https://raw.githubusercontent.com/keiyoushi/extensions/repo",
                    name = "Keiyoushi",
                    shortName = null,
                    website = "https://keiyoushi.github.io",
                    signingKeyFingerprint = "9add655a78e96c4ec7a53ef89dccb557cb5d767489fac5e785d671a5a75d4da2",
                ),
            ),
        )

        val decoded = BackupUtil.decodeBackupBytes(gzipped(MihonBackup.serializer(), mihon))

        assertTrue(decoded.backupLocalBooks.isEmpty())
        assertEquals(listOf("Reading"), decoded.backupCategories.map { it.name })
        assertEquals(
            listOf("https://raw.githubusercontent.com/keiyoushi/extensions/repo" to "Keiyoushi"),
            decoded.backupExtensionRepos.map { it.baseUrl to it.name },
        )
    }

    @Test
    fun `an Epigraph backup keeps its local books and both kinds of repositories`() {
        val book = BackupLocalBook(
            bookId = "epub:sha256:" + "a".repeat(64),
            contentType = "EPUB",
            sha256 = "a".repeat(64),
            displayName = "Offline book",
            mimeType = "application/epub+zip",
            byteSize = 42,
            importedAt = 10,
            updatedAt = 11,
        )
        val extensionRepo = BackupExtensionRepo(
            baseUrl = "https://raw.githubusercontent.com/keiyoushi/extensions/repo",
            name = "Keiyoushi",
            website = "https://keiyoushi.github.io",
            signingKeyFingerprint = "abc",
        )
        val novelRepo = BackupNovelRepository(
            url = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
            name = "LNReader plugins",
        )
        val epigraph = Backup(
            backupManga = emptyList(),
            backupLocalBooks = listOf(book),
            backupExtensionRepos = listOf(extensionRepo),
            novelRepositories = listOf(novelRepo),
        )

        val decoded = BackupUtil.decodeBackupBytes(gzipped(Backup.serializer(), epigraph))

        assertEquals(listOf(book), decoded.backupLocalBooks)
        assertEquals(listOf(extensionRepo), decoded.backupExtensionRepos)
        assertEquals(listOf(novelRepo), decoded.novelRepositories)
    }

    @Test
    fun `the same repository from several places is listed once`() {
        val repos = listOf(
            BackupExtensionRepo(baseUrl = "https://raw.githubusercontent.com/keiyoushi/extensions/repo", name = "Keiyoushi"),
            BackupExtensionRepo(baseUrl = "https://github.com/keiyoushi/extensions/raw/repo/index.pb"),
            // GitHub owner and repository names ignore case.
            BackupExtensionRepo(baseUrl = "https://raw.githubusercontent.com/Keiyoushi/Extensions/repo/"),
        )

        assertEquals(listOf("Keiyoushi"), ExtensionRepoBackup.distinct(repos).map { it.name })
    }
}

/** The top-level fields of a Mihon backup that matter here. */
@Serializable
private class MihonBackup(
    @ProtoNumber(1) val backupManga: List<String> = emptyList(),
    @ProtoNumber(2) val backupCategories: List<BackupCategory> = emptyList(),
    @ProtoNumber(106) val backupExtensionRepo: List<MihonRepo> = emptyList(),
)

/** Mihon's `BackupExtensionRepos`. */
@Serializable
private class MihonRepo(
    @ProtoNumber(1) val baseUrl: String,
    @ProtoNumber(2) val name: String,
    @ProtoNumber(3) val shortName: String?,
    @ProtoNumber(4) val website: String,
    @ProtoNumber(5) val signingKeyFingerprint: String,
)
