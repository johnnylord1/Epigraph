package epigraph.sync.core.policy

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.protocol.CoreCapabilities
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SyncPolicyResolverTest {
    private val session = CoreCredentialSession(
        origin = "https://core.test/",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "pairing",
        profileId = "main",
        tokenId = "token",
        scopes = listOf("comics:profile:main", "novels:profile:main", "books:global"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        serverId = "server",
        accessTokenUtf8 = byteArrayOf(1),
    )

    @AfterEach
    fun close() = session.close()

    @Test
    fun `current server grants immediately constrain the local selection`() {
        val store = InMemorySelectionStore().apply {
            upsert(DeviceSyncSelectionV1.defaults("server", "main", "device"))
        }
        val policy = SyncPolicyResolver(store).resolve(
            credentials = session,
            capabilities = capabilities(),
            deviceId = "device",
            grantedScopes = listOf("novels:profile:main"),
        )

        assertEquals(setOf("novels:profile:main"), policy.selectedScopes)
        assertFalse(policy.syncComics)
        assertTrue(policy.syncNovels)
        assertFalse(policy.syncBooks)
        assertFalse(policy.reconcileComicRepositories)
        assertFalse(policy.reconcileComicExtensions)
        assertTrue(policy.reconcileNovelRepositories)
    }

    @Test
    fun `disabled inventory remains paused without disabling its domain`() {
        val store = InMemorySelectionStore().apply {
            upsert(
                DeviceSyncSelectionV1.defaults("server", "main", "device").copy(
                    comicExtensions = DependencyInventoryMode.DISABLED,
                ),
            )
        }
        val policy = SyncPolicyResolver(store).resolve(session, capabilities(), "device")

        assertTrue(policy.syncComics)
        assertTrue(policy.reconcileComicRepositories)
        assertFalse(policy.reconcileComicExtensions)
        assertTrue(policy.syncBooks)
    }

    @Test
    fun `comic repository refresh can be paused independently from extension parity`() {
        val store = InMemorySelectionStore().apply {
            upsert(
                DeviceSyncSelectionV1.defaults("server", "main", "device").copy(
                    comicRepositories = DependencyInventoryMode.DISABLED,
                ),
            )
        }
        val policy = SyncPolicyResolver(store).resolve(session, capabilities(), "device")

        assertTrue(policy.syncComics)
        assertFalse(policy.reconcileComicRepositories)
        assertTrue(policy.reconcileComicExtensions)
    }

    @Test
    fun `legacy selection is adopted when server id upgrades`() {
        val srv1Session = CoreCredentialSession(
            origin = "https://core.test/",
            tlsCertSha256 = "a".repeat(64),
            pairingSessionId = "pairing",
            profileId = "main",
            tokenId = "token",
            scopes = listOf("comics:profile:main", "novels:profile:main", "books:global"),
            inactivityExpiresAtMs = Long.MAX_VALUE,
            serverId = "srv1",
            accessTokenUtf8 = byteArrayOf(1),
        )
        try {
            val store = InMemorySelectionStore().apply {
                upsert(
                    DeviceSyncSelectionV1.defaults("legacy_unbound", "main", "device").copy(
                        enabledDomains = setOf(SyncDomain.NOVELS, SyncDomain.BOOKS),
                    ),
                )
            }
            val policy = SyncPolicyResolver(store).resolve(srv1Session, capabilities(), "device")

            assertFalse(policy.syncComics)
            assertTrue(policy.syncNovels)
            val adopted = store.load("srv1", "main", "device")
            org.junit.jupiter.api.Assertions.assertNotNull(adopted)
            assertEquals("srv1", adopted!!.serverId)
            assertFalse(SyncDomain.COMICS in adopted.enabledDomains)
        } finally {
            srv1Session.close()
        }
    }

    @Test
    fun `defaults are used when no selection exists at all`() {
        val srv1Session = CoreCredentialSession(
            origin = "https://core.test/",
            tlsCertSha256 = "a".repeat(64),
            pairingSessionId = "pairing",
            profileId = "main",
            tokenId = "token",
            scopes = listOf("comics:profile:main", "novels:profile:main", "books:global"),
            inactivityExpiresAtMs = Long.MAX_VALUE,
            serverId = "srv1",
            accessTokenUtf8 = byteArrayOf(1),
        )
        try {
            val store = InMemorySelectionStore()
            val policy = SyncPolicyResolver(store).resolve(srv1Session, capabilities(), "device")

            assertTrue(policy.syncComics)
            assertTrue(policy.syncNovels)
            assertTrue(policy.syncBooks)
            val persisted = store.load("srv1", "main", "device")
            org.junit.jupiter.api.Assertions.assertNotNull(persisted)
            assertEquals(SyncDomain.entries.toSet(), persisted!!.enabledDomains)
        } finally {
            srv1Session.close()
        }
    }

    private fun capabilities() = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("comics:profile:*", "novels:profile:*", "books:global"),
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
        snapshotEntityTypes = emptySet(),
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-sync._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
    )
}

private class InMemorySelectionStore : DeviceSyncSelectionStore {
    private var selection: DeviceSyncSelectionV1? = null

    override fun load(serverId: String, profileId: String, deviceId: String): DeviceSyncSelectionV1? =
        selection?.takeIf {
            it.serverId == serverId && it.profileId == profileId && it.deviceId == deviceId
        }

    override fun upsert(selection: DeviceSyncSelectionV1) {
        this.selection = selection
    }

    override fun delete(serverId: String, profileId: String, deviceId: String) {
        if (load(serverId, profileId, deviceId) != null) selection = null
    }
}
