package epigraph.sync.core.novels

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import epigraph.sync.core.portable.canonicalRepositoryUrl
import epigraph.novel.plugin.model.NovelPluginIndex
import java.security.MessageDigest
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class LnReaderPluginReplicaSyncTest {
    private val session = CoreCredentialSession(
        origin = "https://core.test/",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "pairing",
        profileId = PROFILE,
        tokenId = "token",
        scopes = listOf("novels:profile:$PROFILE"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        serverId = SERVER,
        accessTokenUtf8 = byteArrayOf(1),
    )

    @AfterEach
    fun close() = session.close()

    @Test
    fun `sync reports repository approval without adding repository or installing plugin`() = runTest {
        val requirement = pluginRequirement("plugin-code".encodeToByteArray())
        val store = InMemoryLnReaderDependencyInventoryStore()
        val gateway = RecordingInventoryGateway()
        val sync = sync(requirement, gateway, store)

        val outcome = sync.synchronize(session, capabilities(), 10)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        val inventory = store.get(SERVER, PROFILE)!!
        assertEquals(LnReaderRepositoryParityStatus.APPROVAL_REQUIRED, inventory.repositories.single().status)
        assertEquals(LnReaderPluginParityStatus.MISSING_UNAVAILABLE, inventory.plugins.single().status)
        assertEquals(1, gateway.configuredRepositoryChecks)
        assertEquals(0, gateway.repositoryReads)
    }

    @Test
    fun `configured repository exposes missing plugin as available without installing it`() = runTest {
        val requirement = pluginRequirement("plugin-code".encodeToByteArray())
        val store = InMemoryLnReaderDependencyInventoryStore()
        val gateway = RecordingInventoryGateway(
            configuredUrl = REPOSITORY_URL,
            plugins = listOf(
                NovelPluginIndex(
                    id = requirement.pluginId,
                    name = "Novel source",
                    version = requirement.version,
                    url = "https://lnreader.test/plugin.js",
                ),
            ),
        )

        val outcome = sync(requirement, gateway, store).synchronize(session, capabilities(), 11)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        val inventory = store.get(SERVER, PROFILE)!!
        assertEquals(LnReaderRepositoryParityStatus.INSTALLED, inventory.repositories.single().status)
        assertEquals(LnReaderPluginParityStatus.MISSING_AVAILABLE, inventory.plugins.single().status)
        assertEquals(1, gateway.repositoryReads)
        assertNull(inventory.plugins.single().installedVersion)
    }

    @Test
    fun `validated index url remains associated with declared repository base url`() = runTest {
        assertEquals(
            true,
            "https://lnreader.test/repository/plugins.min.json"
                .matchesDeclaredRepository("https://lnreader.test/repository"),
        )
        assertEquals(
            false,
            "https://different.test/plugins.min.json"
                .matchesDeclaredRepository("https://lnreader.test/repository"),
        )
    }

    @Test
    fun `repository url trust comparison ignores harmless trailing slash and whitespace`() {
        assertEquals(
            canonicalRepositoryUrl(" https://lnreader.test/repository/ "),
            canonicalRepositoryUrl("https://lnreader.test/repository"),
        )
    }

    @Test
    fun `matching installed artifact is reported installed`() = runTest {
        val requirement = pluginRequirement("plugin-code".encodeToByteArray())
        val store = InMemoryLnReaderDependencyInventoryStore()
        val gateway = RecordingInventoryGateway(
            configuredUrl = REPOSITORY_URL,
            plugins = listOf(
                NovelPluginIndex(
                    id = requirement.pluginId,
                    name = "Novel source",
                    version = requirement.version,
                    url = "https://lnreader.test/plugin.js",
                ),
            ),
            installedVersion = requirement.version,
            artifactMatches = true,
        )

        sync(requirement, gateway, store).synchronize(session, capabilities(), 12)

        assertEquals(
            LnReaderPluginParityStatus.INSTALLED,
            store.get(SERVER, PROFILE)!!.plugins.single().status,
        )
    }

    @Test
    fun `comic scope never enters LNReader inventory`() = runTest {
        var reads = 0
        val comicSession = CoreCredentialSession(
            origin = "https://core.test/",
            tlsCertSha256 = "a".repeat(64),
            pairingSessionId = "pairing",
            profileId = PROFILE,
            tokenId = "token",
            scopes = listOf("comics:profile:$PROFILE"),
            inactivityExpiresAtMs = Long.MAX_VALUE,
            serverId = SERVER,
            accessTokenUtf8 = byteArrayOf(1),
        )
        try {
            val outcome = LnReaderPluginReplicaSync(
                dependencies = CoreNovelDependencyReader {
                    reads += 1
                    CoreNovelDependencyManifest(emptyList(), emptyList())
                },
                gateway = RecordingInventoryGateway(),
            ).synchronize(comicSession, capabilities(), 1)

            assertEquals(CoreReplicaSyncOutcome.DEFERRED, outcome)
            assertEquals(0, reads)
        } finally {
            comicSession.close()
        }
    }

    @Test
    fun `v4 requirement without hash is installed when local version is current or newer`() = runTest {
        val inventory = syncV4(installedVersion = "1.0.10", offered = "1.0.10", required = "1.0.9")
        assertEquals(LnReaderPluginParityStatus.INSTALLED, inventory.plugins.single().status)
    }

    @Test
    fun `v4 requirement without hash offers update when installed version is older`() = runTest {
        val inventory = syncV4(installedVersion = "1.0.2", offered = "1.0.4", required = "1.0.3")
        val item = inventory.plugins.single()
        assertEquals(LnReaderPluginParityStatus.UPDATE_AVAILABLE, item.status)
        assertEquals("1.0.4", item.requirement.version)
    }

    @Test
    fun `v4 requirement without hash is available when not installed`() = runTest {
        val inventory = syncV4(installedVersion = null, offered = "1.0.3", required = "1.0.3")
        assertEquals(LnReaderPluginParityStatus.MISSING_AVAILABLE, inventory.plugins.single().status)
    }

    @Test
    fun `v4 requirement without hash is unavailable when index only has an older version`() = runTest {
        val inventory = syncV4(installedVersion = "1.0.0", offered = "1.0.1", required = "1.0.3")
        assertEquals(LnReaderPluginParityStatus.MISSING_UNAVAILABLE, inventory.plugins.single().status)
    }

    @Test
    fun `v4 requirement without hash is unavailable when no index has the plugin`() = runTest {
        val inventory = syncV4(installedVersion = null, offered = null, required = "1.0.3")
        assertEquals(LnReaderPluginParityStatus.MISSING_UNAVAILABLE, inventory.plugins.single().status)
    }

    @Test
    fun `v4 requirement is found in a repository other than the declared site url`() = runTest {
        val requirement = v4Requirement("1.0.0").copy(repositoryId = "https://plugin-site.test")
        val store = InMemoryLnReaderDependencyInventoryStore()
        val gateway = RecordingInventoryGateway(
            configuredUrl = REPOSITORY_URL,
            plugins = listOf(pluginIndex("1.0.0")),
        )
        LnReaderPluginReplicaSync(
            dependencies = CoreNovelDependencyReader {
                CoreNovelDependencyManifest(listOf(repositoryRequirement()), listOf(requirement))
            },
            gateway = gateway,
            inventories = store,
        ).synchronize(session, capabilities(), 20)

        val item = store.get(SERVER, PROFILE)!!.plugins.single()
        assertEquals(LnReaderPluginParityStatus.MISSING_AVAILABLE, item.status)
        assertEquals("repo", item.requirement.repositoryId)
    }

    @Test
    fun `plugin versions compare numerically`() {
        assertEquals(true, compareNovelPluginVersions("1.0.10", "1.0.9") > 0)
        assertEquals(0, compareNovelPluginVersions("1.0", "1.0.0"))
        assertEquals(true, compareNovelPluginVersions("2.0.0", "10.0.0") < 0)
    }

    private suspend fun syncV4(
        installedVersion: String?,
        offered: String?,
        required: String,
    ): LnReaderDependencyInventory {
        val store = InMemoryLnReaderDependencyInventoryStore()
        val gateway = RecordingInventoryGateway(
            configuredUrl = REPOSITORY_URL,
            plugins = listOfNotNull(offered?.let(::pluginIndex)),
            installedVersion = installedVersion,
            // A V4 requirement must never consult the artifact hash check.
            artifactMatches = true,
        )
        sync(v4Requirement(required), gateway, store).synchronize(session, capabilities(), 20)
        return store.get(SERVER, PROFILE)!!
    }

    private fun v4Requirement(version: String) = CoreNovelPluginRequirement(
        repositoryId = "repo",
        pluginId = "plugin.test",
        sourceId = "plugin.test",
        version = version,
        enabled = true,
        artifactSha256 = "",
        artifactByteLength = 0L,
    )

    private fun pluginIndex(version: String) = NovelPluginIndex(
        id = "plugin.test",
        name = "Novel source",
        version = version,
        url = "https://lnreader.test/plugin.js",
    )

    private fun sync(
        requirement: CoreNovelPluginRequirement,
        gateway: LnReaderPluginGateway,
        store: LnReaderDependencyInventoryStore,
    ) = LnReaderPluginReplicaSync(
        dependencies = CoreNovelDependencyReader {
            CoreNovelDependencyManifest(listOf(repositoryRequirement()), listOf(requirement))
        },
        gateway = gateway,
        inventories = store,
    )

    private fun repositoryRequirement() = CoreNovelRepositoryRequirement(
        repositoryId = "repo",
        canonicalUrl = REPOSITORY_URL,
        displayName = "LNReader",
        enabled = true,
    )

    private fun pluginRequirement(bytes: ByteArray) = CoreNovelPluginRequirement(
        repositoryId = "repo",
        pluginId = "plugin.test",
        sourceId = "source.test",
        version = "1.0.0",
        enabled = true,
        artifactSha256 = bytes.sha256(),
        artifactByteLength = bytes.size.toLong(),
    )

    private fun capabilities() = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("novels:profile:$PROFILE"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = false,
        supportsSnapshot = true,
        supportsAssets = true,
        supportsNovelChapterAssets = true,
        supportsNovelPluginSync = true,
        supportsSuwayomiProxy = true,
        supportsCausalMutationsV3 = true,
        supportsSuwayomiCatalog = true,
        supportsSuwayomiContent = true,
        supportsSuwayomiExtensionInventory = true,
        supportsSuwayomiWebsocketProxy = false,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{profileId}/graphql",
        snapshotSchemaVersion = 3,
        snapshotEntityTypes = setOf("novel.repository", "novel.plugin"),
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-sync._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
    )

    private class RecordingInventoryGateway(
        private val configuredUrl: String? = null,
        private val plugins: List<NovelPluginIndex> = emptyList(),
        private val installedVersion: String? = null,
        private val artifactMatches: Boolean = false,
    ) : LnReaderPluginGateway {
        var configuredRepositoryChecks = 0
        var repositoryReads = 0

        override suspend fun configuredRepository(requirement: CoreNovelRepositoryRequirement): String? {
            configuredRepositoryChecks += 1
            return configuredUrl
        }

        override suspend fun repositoryPlugins(indexUrl: String): List<NovelPluginIndex> {
            repositoryReads += 1
            return plugins
        }

        override fun installedVersion(pluginId: String): String? = installedVersion

        override fun installedArtifactMatches(requirement: CoreNovelPluginRequirement): Boolean = artifactMatches
    }

    private fun ByteArray.sha256(): String = MessageDigest.getInstance("SHA-256")
        .digest(this)
        .joinToString("") { "%02x".format(it) }

    private companion object {
        const val PROFILE = "main"
        const val SERVER = "server"
        const val REPOSITORY_URL = "https://lnreader.test/plugins.min.json"
    }
}
