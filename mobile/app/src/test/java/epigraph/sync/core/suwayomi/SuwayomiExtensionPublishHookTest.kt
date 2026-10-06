package epigraph.sync.core.suwayomi

import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.outbox.CoreOutboxAuthorization
import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiCommandResponse
import epigraph.sync.core.protocol.SuwayomiMutationOperation
import epigraph.sync.core.work.CoreOutboxSyncConnection
import epigraph.sync.core.work.SuwayomiCommandChannel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SuwayomiExtensionPublishHookTest {

    private val ledger = MemoryLedger()
    private val repo = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"

    @Test
    fun `publishes repositories before packages and only once per desktop`() = runTest {
        val channel = FakeChannel()
        val hook = hook(listOf("eu.kanade.tachiyomi.extension.en.a", "eu.kanade.tachiyomi.extension.en.b"), listOf(repo))

        hook.onNegotiated(capabilities(), FakeConnection(channel))

        assertEquals(
            listOf(
                SuwayomiMutationOperation.ADD_EXTENSION_REPOS,
                SuwayomiMutationOperation.INSTALL_EXTENSION,
                SuwayomiMutationOperation.INSTALL_EXTENSION,
            ),
            channel.requests.map { it.operation },
        )
        assertEquals(listOf(repo), channel.requests[0].variables.getValue("repos").jsonArray.map { it.jsonPrimitive.content })
        assertEquals("eu.kanade.tachiyomi.extension.en.b", channel.requests[2].variables.getValue("pkgName").jsonPrimitive.content)

        // A later sync must not reinstall what the desktop may have removed since.
        channel.requests.clear()
        hook.onNegotiated(capabilities(), FakeConnection(channel))
        assertTrue(channel.requests.isEmpty())

        // Another desktop gets its own publish.
        val other = FakeChannel(serverId = "other")
        hook.onNegotiated(capabilities(), FakeConnection(other))
        assertEquals(3, other.requests.size)
    }

    @Test
    fun `retries later when the Core is unreachable but settles rejected packages`() = runTest {
        val packages = listOf("eu.kanade.tachiyomi.extension.en.a", "eu.kanade.tachiyomi.extension.en.b")
        val down = FakeChannel(answers = mutableListOf(CoreHttpResult.Failure(503, null)))
        hook(packages, emptyList()).onNegotiated(capabilities(), FakeConnection(down))
        assertEquals(1, down.requests.size)
        assertTrue(ledger.published("desk:main").isEmpty())

        val rejecting = FakeChannel(answers = mutableListOf(CoreHttpResult.Failure(400, null)))
        hook(packages, emptyList()).onNegotiated(capabilities(), FakeConnection(rejecting))
        assertEquals(2, rejecting.requests.size)
        assertEquals(packages.map { "pkg:$it" }.toSet(), ledger.published("desk:main"))
    }

    @Test
    fun `does nothing without the capability or for a legacy session`() = runTest {
        val channel = FakeChannel()
        val legacy = FakeChannel(serverId = LEGACY_UNBOUND_SERVER_ID)

        hook(listOf("a.b"), listOf(repo)).onNegotiated(capabilities(install = false), FakeConnection(channel))
        hook(listOf("a.b"), listOf(repo)).onNegotiated(capabilities(), FakeConnection(legacy))
        hook(listOf("a.b"), listOf(repo)).onNegotiated(capabilities(), FakeConnection(null))

        assertTrue(channel.requests.isEmpty())
        assertTrue(legacy.requests.isEmpty())
    }

    @Test
    fun `skips repository urls the desktop cannot use`() = runTest {
        val channel = FakeChannel()

        hook(emptyList(), listOf("http://x/index.min.json", "https://x/repo", "https://x/a b.json"))
            .onNegotiated(capabilities(), FakeConnection(channel))

        assertTrue(channel.requests.isEmpty())
    }

    private fun hook(packages: List<String>, repos: List<String>) =
        SuwayomiExtensionPublishHook({ PhoneExtensionState(packages, repos) }, ledger)

    private fun capabilities(install: Boolean = true) = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("comics:profile:main"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = false,
        supportsSnapshot = true,
        supportsAssets = false,
        supportsNovelChapterAssets = false,
        supportsNovelPluginSync = false,
        supportsSuwayomiProxy = true,
        supportsSuwayomiWebsocketProxy = false,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = 1,
        snapshotEntityTypes = emptySet(),
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
        supportsSuwayomiExtensionInstall = install,
    )

    private class MemoryLedger : PublishedExtensionLedger {
        private val entries = mutableMapOf<String, MutableSet<String>>()
        override fun published(desktopKey: String): Set<String> = entries[desktopKey].orEmpty().toSet()
        override fun markPublished(desktopKey: String, entries: Collection<String>) {
            this.entries.getOrPut(desktopKey) { mutableSetOf() } += entries
        }
    }

    private class FakeConnection(private val channel: SuwayomiCommandChannel?) : CoreOutboxSyncConnection {
        override val openedOrigin: String = "https://core.local"
        override suspend fun capabilities(): CoreHttpResult<CoreCapabilities> = error("unused")
        override suspend fun drainSuwayomi(nowEpochMillis: Long, canonicalProjectionEnabled: Boolean) =
            error("unused")
        override suspend fun drain(
            authorization: CoreOutboxAuthorization,
            capabilities: CoreCapabilities,
            nowEpochMillis: Long,
        ): CoreOutboxDrainReport = error("unused")
        override fun suwayomiCommands(): SuwayomiCommandChannel? = channel
    }

    private class FakeChannel(
        override val serverId: String = "desk",
        override val profileId: String = "main",
        private val answers: MutableList<CoreHttpResult<SuwayomiCommandResponse>> = mutableListOf(),
    ) : SuwayomiCommandChannel {
        val requests = mutableListOf<SuwayomiCommandRequest>()

        override suspend fun command(request: SuwayomiCommandRequest): CoreHttpResult<SuwayomiCommandResponse> {
            requests += request
            return answers.removeFirstOrNull() ?: CoreHttpResult.Success(
                SuwayomiCommandResponse(1, "comics:profile:main", request.operation, 1, JsonObject(emptyMap())),
            )
        }
    }
}
