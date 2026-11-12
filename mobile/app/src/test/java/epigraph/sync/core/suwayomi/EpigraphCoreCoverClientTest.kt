package epigraph.sync.core.suwayomi

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import epigraph.sync.core.session.CoreEndpointResolver
import io.mockk.mockk
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EpigraphCoreCoverClientTest {
    @Test
    fun `covers waiting in line share the failed attempt to reach the desktop`() = runTest {
        val unreachable = CompletableDeferred<Unit>()
        var attempts = 0
        val client = client {
            attempts += 1
            unreachable.await()
            throw IOException("desktop unreachable")
        }

        val covers = (1L..5L).map { mangaId -> async { client.fetch(cover(mangaId)) } }
        runCurrent()
        unreachable.complete(Unit)

        val results = covers.awaitAll()

        assertEquals(1, attempts)
        assertEquals(List(5) { 503 }, results.map { (it as CoreHttpResult.Failure).statusCode })
    }

    @Test
    fun `a later cover tries the desktop again`() = runTest {
        var attempts = 0
        val client = client {
            attempts += 1
            throw IOException("desktop unreachable")
        }

        client.fetch(cover(1))
        client.fetch(cover(2))

        assertEquals(2, attempts)
    }

    private fun client(resolve: suspend () -> Nothing) = EpigraphCoreCoverClient(
        credentials = FreshSessionStore,
        transports = mockk(),
        endpoints = CoreEndpointResolver { resolve() },
    )

    private fun cover(mangaId: Long) = SuwayomiCoreThumbnailReference.forManga(SERVER, PROFILE, mangaId)

    /** The client closes the session it loads, so each cover gets its own. */
    private object FreshSessionStore : CoreCredentialStore {
        override fun replace(session: CoreCredentialSession) = Unit

        override fun load() = CoreCredentialSession(
            origin = "https://desktop.test/",
            tlsCertSha256 = "pin",
            pairingSessionId = "pairing",
            profileId = PROFILE,
            tokenId = "token",
            scopes = listOf("comics:profile:$PROFILE"),
            inactivityExpiresAtMs = Long.MAX_VALUE,
            serverId = SERVER,
            accessTokenUtf8 = "secret".toByteArray(),
        )

        override fun delete() = Unit
    }

    private companion object {
        const val SERVER = "server"
        const val PROFILE = "profile"
    }
}
