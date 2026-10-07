package epigraph.sync.core.novels

import epigraph.novel.plugin.model.NovelPluginIndex
import java.security.MessageDigest
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class LnReaderDependencyActionCoordinatorTest {
    @Test
    fun `repository is added only after explicit approval action`() = runTest {
        val store = inventoryStore(repositoryInstalled = false)
        val gateway = RecordingActionGateway()
        val coordinator = LnReaderDependencyActionCoordinator(store, gateway)

        assertEquals(0, gateway.repositoryApprovals)

        val result = coordinator.approveRepository(SERVER, PROFILE, REPOSITORY)

        assertEquals(LnReaderRepositoryApprovalResult.Approved(REPOSITORY_URL), result)
        assertEquals(1, gateway.repositoryApprovals)
        assertEquals(0, gateway.pluginInstalls)
    }

    @Test
    fun `plugin installation is blocked until repository was approved`() = runTest {
        val gateway = RecordingActionGateway()
        val coordinator = LnReaderDependencyActionCoordinator(
            inventories = inventoryStore(repositoryInstalled = false),
            gateway = gateway,
        )

        val result = coordinator.installPlugin(SERVER, PROFILE, PLUGIN)

        assertEquals(LnReaderPluginInstallResult.RepositoryApprovalRequired, result)
        assertEquals(0, gateway.pluginInstalls)
    }

    @Test
    fun `explicit install passes only declared identity hash and size to official action gateway`() = runTest {
        val gateway = RecordingActionGateway()
        val coordinator = LnReaderDependencyActionCoordinator(
            inventories = inventoryStore(repositoryInstalled = true),
            gateway = gateway,
        )

        val result = coordinator.installPlugin(SERVER, PROFILE, PLUGIN)

        assertEquals(LnReaderPluginInstallResult.Installed, result)
        assertEquals(1, gateway.pluginInstalls)
        assertEquals(REPOSITORY_URL, gateway.lastRepositoryUrl)
        assertEquals(HASH, gateway.lastPlugin?.artifactSha256)
        assertEquals(BYTES.size.toLong(), gateway.lastPlugin?.artifactByteLength)
    }

    @Test
    fun `identity mismatch cannot reach installer`() = runTest {
        val store = InMemoryLnReaderDependencyInventoryStore()
        store.replace(inventory(repositoryInstalled = true, LnReaderPluginParityStatus.IDENTITY_MISMATCH))
        val gateway = RecordingActionGateway()
        val coordinator = LnReaderDependencyActionCoordinator(store, gateway)

        val result = coordinator.installPlugin(SERVER, PROFILE, PLUGIN)

        assertEquals(LnReaderPluginInstallResult.IdentityMismatch, result)
        assertEquals(0, gateway.pluginInstalls)
    }

    @Test
    fun `desktop artifact installs a plugin whose repository was not added`() = runTest {
        val gateway = RecordingActionGateway()
        var coreInstalls = 0
        val coordinator = LnReaderDependencyActionCoordinator(
            inventories = inventoryStore(repositoryInstalled = false),
            gateway = gateway,
            coreArtifacts = { _, _, _ ->
                coreInstalls += 1
                LnReaderPluginInstallResult.Installed
            },
        )

        val result = coordinator.installPlugin(SERVER, PROFILE, PLUGIN)

        assertEquals(LnReaderPluginInstallResult.Installed, result)
        assertEquals(1, coreInstalls)
        assertEquals(0, gateway.pluginInstalls)
    }

    @Test
    fun `desktop artifact replaces a plugin installed at another version`() = runTest {
        val store = InMemoryLnReaderDependencyInventoryStore()
        store.replace(inventory(repositoryInstalled = true, LnReaderPluginParityStatus.IDENTITY_MISMATCH))
        val gateway = RecordingActionGateway()
        var coreInstalls = 0
        val coordinator = LnReaderDependencyActionCoordinator(
            inventories = store,
            gateway = gateway,
            coreArtifacts = { _, _, _ ->
                coreInstalls += 1
                LnReaderPluginInstallResult.Installed
            },
        )

        val result = coordinator.installPlugin(SERVER, PROFILE, PLUGIN)

        assertEquals(LnReaderPluginInstallResult.Installed, result)
        assertEquals(1, coreInstalls)
        assertEquals(0, gateway.pluginInstalls)
        assertEquals(
            LnReaderPluginParityStatus.INSTALLED,
            store.get(SERVER, PROFILE)?.plugins?.single()?.status,
        )
    }

    @Test
    fun `source id never substitutes the canonical plugin identity`() {
        val requirement = CoreNovelPluginRequirement(
            repositoryId = REPOSITORY,
            pluginId = PLUGIN,
            sourceId = "source.test",
            version = "1.0.0",
            enabled = true,
            artifactSha256 = HASH,
            artifactByteLength = BYTES.size.toLong(),
        )

        assertEquals(
            null,
            listOf(NovelPluginIndex(id = requirement.sourceId, name = "Wrong plugin")).singleMatching(requirement),
        )
    }

    private suspend fun inventoryStore(repositoryInstalled: Boolean): LnReaderDependencyInventoryStore =
        InMemoryLnReaderDependencyInventoryStore().also {
            it.replace(inventory(repositoryInstalled, LnReaderPluginParityStatus.MISSING_AVAILABLE))
        }

    private fun inventory(
        repositoryInstalled: Boolean,
        pluginStatus: LnReaderPluginParityStatus,
    ): LnReaderDependencyInventory {
        val repository = CoreNovelRepositoryRequirement(REPOSITORY, REPOSITORY_URL, "LNReader", true)
        val plugin = CoreNovelPluginRequirement(
            repositoryId = REPOSITORY,
            pluginId = PLUGIN,
            sourceId = "source.test",
            version = "1.0.0",
            enabled = true,
            artifactSha256 = HASH,
            artifactByteLength = BYTES.size.toLong(),
        )
        return LnReaderDependencyInventory(
            serverId = SERVER,
            profileId = PROFILE,
            generatedAtMs = 1,
            fingerprint = "f".repeat(64),
            repositories = listOf(
                LnReaderRepositoryInventoryItem(
                    requirement = repository,
                    status = if (repositoryInstalled) {
                        LnReaderRepositoryParityStatus.INSTALLED
                    } else {
                        LnReaderRepositoryParityStatus.APPROVAL_REQUIRED
                    },
                    configuredIndexUrl = REPOSITORY_URL.takeIf { repositoryInstalled },
                ),
            ),
            plugins = listOf(
                LnReaderPluginInventoryItem(plugin, pluginStatus, null, plugin.version),
            ),
        )
    }

    private class RecordingActionGateway : LnReaderDependencyActionGateway {
        var repositoryApprovals = 0
        var pluginInstalls = 0
        var lastRepositoryUrl: String? = null
        var lastPlugin: CoreNovelPluginRequirement? = null

        override suspend fun approveRepository(
            requirement: CoreNovelRepositoryRequirement,
        ): LnReaderRepositoryApprovalResult {
            repositoryApprovals += 1
            return LnReaderRepositoryApprovalResult.Approved(requirement.canonicalUrl)
        }

        override suspend fun installPlugin(
            repositoryIndexUrl: String,
            requirement: CoreNovelPluginRequirement,
        ): LnReaderPluginInstallResult {
            pluginInstalls += 1
            lastRepositoryUrl = repositoryIndexUrl
            lastPlugin = requirement
            return LnReaderPluginInstallResult.Installed
        }
    }

    private companion object {
        val BYTES = "plugin-code".encodeToByteArray()
        val HASH = MessageDigest.getInstance("SHA-256")
            .digest(BYTES)
            .joinToString("") { "%02x".format(it) }
        const val SERVER = "server"
        const val PROFILE = "main"
        const val REPOSITORY = "repo"
        const val REPOSITORY_URL = "https://lnreader.test/plugins.min.json"
        const val PLUGIN = "plugin.test"
    }
}
