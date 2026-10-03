package epigraph.sync.core.setup

import epigraph.sync.core.extensions.ComicRepositoryRow
import epigraph.sync.core.extensions.ExtensionParityItem
import epigraph.sync.core.extensions.ExtensionParityReport
import epigraph.sync.core.extensions.ExtensionParityStatus
import epigraph.sync.core.novels.CoreNovelPluginRequirement
import epigraph.sync.core.novels.CoreNovelRepositoryRequirement
import epigraph.sync.core.novels.LnReaderDependencyInventory
import epigraph.sync.core.novels.LnReaderPluginInventoryItem
import epigraph.sync.core.novels.LnReaderPluginParityStatus
import epigraph.sync.core.novels.LnReaderRepositoryInventoryItem
import epigraph.sync.core.novels.LnReaderRepositoryParityStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreDependencySetupCountsTest {

    @Test
    fun `all null and empty gives zero counts`() {
        val counts = coreDependencySetupCounts(emptyList(), null, null)
        assertEquals(0, counts.repositoriesToAdd)
        assertEquals(0, counts.extensionsToInstall)
        assertFalse(counts.hasPending)
    }

    @Test
    fun `mixed comic report and novel inventory gives exact counts`() {
        val comicRepos = listOf(
            ComicRepositoryRow("https://repo1.example.com/index.json", "repo1", added = false),
            ComicRepositoryRow("https://repo2.example.com/index.json", "repo2", added = true),
            ComicRepositoryRow("https://repo3.example.com/index.json", "repo3", added = false),
        )

        val comicReport = ExtensionParityReport(
            serverId = "server1",
            profileId = "profile1",
            inventoryHash = "hash",
            generatedAtMs = 1000L,
            items = listOf(
                ExtensionParityItem("com.a", "A", "1.0", null, emptyList(), emptyList(), status = ExtensionParityStatus.MISSING_AVAILABLE),
                ExtensionParityItem("com.b", "B", "2.0", "1.0", emptyList(), emptyList(), status = ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE),
                ExtensionParityItem("com.c", "C", "3.0", null, emptyList(), emptyList(), status = ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED),
                ExtensionParityItem("com.d", "D", "4.0", null, emptyList(), emptyList(), status = ExtensionParityStatus.UNTRUSTED_OR_BLOCKED),
                ExtensionParityItem("com.e", "E", "5.0", "5.0", emptyList(), emptyList(), status = ExtensionParityStatus.INSTALLED),
                ExtensionParityItem("com.f", "F", "6.0", null, emptyList(), emptyList(), status = ExtensionParityStatus.MISSING_UNAVAILABLE),
                ExtensionParityItem("com.g", "G", "7.0", null, emptyList(), emptyList(), status = ExtensionParityStatus.SOURCE_ID_MISMATCH),
            ),
        )

        val novels = LnReaderDependencyInventory(
            serverId = "server1",
            profileId = "profile1",
            generatedAtMs = 1000L,
            fingerprint = "fp",
            repositories = listOf(
                LnReaderRepositoryInventoryItem(
                    requirement = CoreNovelRepositoryRequirement("repo-a", "https://novel-repo-a.example.com", "Repo A", true),
                    status = LnReaderRepositoryParityStatus.APPROVAL_REQUIRED,
                    configuredIndexUrl = null,
                ),
                LnReaderRepositoryInventoryItem(
                    requirement = CoreNovelRepositoryRequirement("repo-b", "https://novel-repo-b.example.com", "Repo B", true),
                    status = LnReaderRepositoryParityStatus.INSTALLED,
                    configuredIndexUrl = "https://novel-repo-b.example.com",
                ),
            ),
            plugins = listOf(
                LnReaderPluginInventoryItem(
                    requirement = CoreNovelPluginRequirement("repo-a", "plugin-1", "src-1", "1.0", true, "sha", 100L),
                    status = LnReaderPluginParityStatus.MISSING_AVAILABLE,
                    installedVersion = null,
                    availableVersion = "1.0",
                ),
                LnReaderPluginInventoryItem(
                    requirement = CoreNovelPluginRequirement("repo-a", "plugin-2", "src-2", "2.0", true, "sha", 200L),
                    status = LnReaderPluginParityStatus.UPDATE_AVAILABLE,
                    installedVersion = "1.0",
                    availableVersion = "2.0",
                ),
                LnReaderPluginInventoryItem(
                    requirement = CoreNovelPluginRequirement("repo-a", "plugin-3", "src-3", "3.0", true, "sha", 300L),
                    status = LnReaderPluginParityStatus.MISSING_UNAVAILABLE,
                    installedVersion = null,
                    availableVersion = null,
                ),
                LnReaderPluginInventoryItem(
                    requirement = CoreNovelPluginRequirement("repo-a", "plugin-4", "src-4", "4.0", true, "sha", 400L),
                    status = LnReaderPluginParityStatus.INSTALLED,
                    installedVersion = "4.0",
                    availableVersion = null,
                ),
                LnReaderPluginInventoryItem(
                    requirement = CoreNovelPluginRequirement("repo-a", "plugin-5", "src-5", "5.0", true, "sha", 500L),
                    status = LnReaderPluginParityStatus.IDENTITY_MISMATCH,
                    installedVersion = "5.0",
                    availableVersion = "5.0",
                ),
            ),
        )

        val counts = coreDependencySetupCounts(comicRepos, comicReport, novels)

        // Repositories: 2 comic (added=false) + 1 novel (APPROVAL_REQUIRED) = 3
        assertEquals(3, counts.repositoriesToAdd)
        // Extensions: 4 comic (MISSING_AVAILABLE, INSTALLED_UPDATE_AVAILABLE, REPOSITORY_APPROVAL_REQUIRED, UNTRUSTED_OR_BLOCKED)
        // + 3 novel (MISSING_AVAILABLE, UPDATE_AVAILABLE, MISSING_UNAVAILABLE) = 7
        assertEquals(7, counts.extensionsToInstall)
        assertTrue(counts.hasPending)
    }

    @Test
    fun `installed items and added rows are never counted`() {
        val comicRepos = listOf(
            ComicRepositoryRow("https://repo1.example.com/index.json", "repo1", added = true),
        )

        val comicReport = ExtensionParityReport(
            serverId = "server1",
            profileId = "profile1",
            inventoryHash = "hash",
            generatedAtMs = 1000L,
            items = listOf(
                ExtensionParityItem("com.a", "A", "1.0", "1.0", emptyList(), emptyList(), status = ExtensionParityStatus.INSTALLED),
            ),
        )

        val novels = LnReaderDependencyInventory(
            serverId = "server1",
            profileId = "profile1",
            generatedAtMs = 1000L,
            fingerprint = "fp",
            repositories = listOf(
                LnReaderRepositoryInventoryItem(
                    requirement = CoreNovelRepositoryRequirement("repo-a", "https://novel-repo-a.example.com", "Repo A", true),
                    status = LnReaderRepositoryParityStatus.INSTALLED,
                    configuredIndexUrl = "https://novel-repo-a.example.com",
                ),
            ),
            plugins = listOf(
                LnReaderPluginInventoryItem(
                    requirement = CoreNovelPluginRequirement("repo-a", "plugin-1", "src-1", "1.0", true, "sha", 100L),
                    status = LnReaderPluginParityStatus.INSTALLED,
                    installedVersion = "1.0",
                    availableVersion = null,
                ),
            ),
        )

        val counts = coreDependencySetupCounts(comicRepos, comicReport, novels)
        assertEquals(0, counts.repositoriesToAdd)
        assertEquals(0, counts.extensionsToInstall)
        assertFalse(counts.hasPending)
    }
}
