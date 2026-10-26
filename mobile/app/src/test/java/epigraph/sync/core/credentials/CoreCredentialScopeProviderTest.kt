package epigraph.sync.core.credentials

import java.nio.charset.StandardCharsets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class CoreCredentialScopeProviderTest {
    @Test
    fun `edits made after forgetting the connection keep the last paired profile scope`() = runTest {
        val credentials = MemoryCredentialStore()
        val lastProfile = MemoryLastProfileStore()
        val provider = CoreCredentialScopeProvider(credentials, lastProfile, Dispatchers.Unconfined)

        credentials.session = session()
        assertEquals("comics:profile:main", provider.current().comics.value)
        assertEquals("server-a", provider.current().serverId)

        credentials.session = null
        assertEquals("comics:profile:main", provider.current().comics.value)
        assertEquals("novels:profile:main", provider.current().novels.value)
        // The server is unknown until the next pairing.
        assertNull(provider.current().serverId)
    }

    @Test
    fun `a legacy session has no known server`() = runTest {
        val credentials = MemoryCredentialStore()
        val provider = CoreCredentialScopeProvider(credentials, MemoryLastProfileStore(), Dispatchers.Unconfined)

        credentials.session = session(serverId = LEGACY_UNBOUND_SERVER_ID)

        assertNull(provider.current().serverId)
    }

    @Test
    fun `a device that was never paired stays local only`() = runTest {
        val provider = CoreCredentialScopeProvider(MemoryCredentialStore(), MemoryLastProfileStore(), Dispatchers.Unconfined)

        assertThrows(CoreProfileNotPairedException::class.java) {
            kotlinx.coroutines.runBlocking { provider.current() }
        }
    }

    private class MemoryLastProfileStore : LastPairedProfileStore {
        private var value: String? = null
        override fun load(): String? = value
        override fun remember(profileId: String) {
            value = profileId
        }
    }

    private class MemoryCredentialStore : CoreCredentialStore {
        var session: CoreCredentialSession? = null
        override fun replace(session: CoreCredentialSession) {
            this.session = session
        }
        override fun load(): CoreCredentialSession? = session?.let {
            CoreCredentialSession(
                origin = it.origin,
                tlsCertSha256 = it.tlsCertSha256,
                pairingSessionId = it.pairingSessionId,
                profileId = it.profileId,
                tokenId = it.tokenId,
                scopes = it.scopes,
                inactivityExpiresAtMs = it.inactivityExpiresAtMs,
                serverId = it.serverId,
                accessTokenUtf8 = "secret-token".toByteArray(StandardCharsets.UTF_8),
            )
        }
        override fun delete() {
            session = null
        }
    }

    private fun session(serverId: String = "server-a") = CoreCredentialSession(
        origin = "https://desktop.local:4777",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "bootstrap-019f57b6-1c7b-7862-bc7b-15d17593f9d3",
        profileId = "main",
        tokenId = "token-1",
        scopes = listOf("books:global", "comics:profile:main"),
        inactivityExpiresAtMs = 1_900_000_000_000L,
        serverId = serverId,
        accessTokenUtf8 = "secret-token".toByteArray(StandardCharsets.UTF_8),
    )
}
