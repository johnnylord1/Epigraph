package epigraph.sync.core.extensions

import eu.kanade.tachiyomi.extension.model.Extension
import eu.kanade.tachiyomi.source.CatalogueSource
import io.mockk.every
import io.mockk.mockk
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class InstalledExtensionRelinkObserverTest {
    @Test
    fun `extension emitted before registry retries when source becomes registered`() = runTest {
        val installed = MutableStateFlow(emptyList<Extension.Installed>())
        val registered = MutableStateFlow(emptyList<CatalogueSource>())
        val calls = Channel<Unit>(Channel.UNLIMITED)
        val callCount = AtomicInteger()
        val observer = observer(
            installed,
            registered,
            StandardTestDispatcher(testScheduler),
        ) {
            callCount.incrementAndGet()
            calls.send(Unit)
            EMPTY_RESULT
        }

        observer.start(backgroundScope)
        runCurrent()
        awaitCall(calls)

        val source = source(SOURCE_ID)
        installed.value = listOf(extension(versionCode = 1, source = source))
        runCurrent()
        awaitCall(calls)

        registered.value = listOf(source)
        runCurrent()
        awaitCall(calls)

        assertEquals(3, callCount.get())
    }

    @Test
    fun `initial installed registry is relinked after process restart`() = runTest {
        val source = source(SOURCE_ID)
        val installed = MutableStateFlow(listOf(extension(versionCode = 1, source = source)))
        val registered = MutableStateFlow(listOf(source))
        val calls = Channel<Unit>(Channel.UNLIMITED)
        val callCount = AtomicInteger()
        val observer = observer(
            installed,
            registered,
            StandardTestDispatcher(testScheduler),
        ) {
            callCount.incrementAndGet()
            calls.send(Unit)
            EMPTY_RESULT
        }

        observer.start(backgroundScope)
        runCurrent()
        awaitCall(calls)

        assertEquals(1, callCount.get())
    }

    @Test
    fun `bursts are conflated and relink executions stay serialized`() = runTest {
        val source = source(SOURCE_ID)
        val installed = MutableStateFlow(listOf(extension(versionCode = 1, source = source)))
        val registered = MutableStateFlow(listOf(source))
        val firstStarted = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        val secondFinished = CompletableDeferred<Unit>()
        val callCount = AtomicInteger()
        val activeCalls = AtomicInteger()
        val maxActiveCalls = AtomicInteger()
        val observer = observer(
            installed,
            registered,
            StandardTestDispatcher(testScheduler),
        ) {
            val call = callCount.incrementAndGet()
            val active = activeCalls.incrementAndGet()
            maxActiveCalls.accumulateAndGet(active, ::maxOf)
            try {
                if (call == 1) {
                    firstStarted.complete(Unit)
                    releaseFirst.await()
                }
            } finally {
                activeCalls.decrementAndGet()
            }
            if (call == 2) secondFinished.complete(Unit)
            EMPTY_RESULT
        }

        observer.start(backgroundScope)
        runCurrent()
        withTimeout(TIMEOUT_MS) { firstStarted.await() }

        installed.value = listOf(extension(versionCode = 2, source = source))
        installed.value = listOf(extension(versionCode = 3, source = source))
        installed.value = listOf(extension(versionCode = 4, source = source))
        releaseFirst.complete(Unit)
        runCurrent()

        withTimeout(TIMEOUT_MS) { secondFinished.await() }
        assertEquals(2, callCount.get())
        assertEquals(1, maxActiveCalls.get())
    }

    private fun observer(
        installed: MutableStateFlow<List<Extension.Installed>>,
        registered: MutableStateFlow<List<CatalogueSource>>,
        dispatcher: CoroutineDispatcher,
        relink: suspend () -> CoreSourceRelinkResult,
    ) = InstalledExtensionRelinkObserver(
        installedExtensions = installed.asStateFlow(),
        catalogueSources = registered.asStateFlow(),
        relink = relink,
        dispatcher = dispatcher,
    )

    private fun source(id: Long): CatalogueSource = mockk {
        every { this@mockk.id } returns id
    }

    private fun extension(versionCode: Long, source: CatalogueSource) = Extension.Installed(
        name = "Fixture",
        pkgName = "fixture.extension",
        versionName = versionCode.toString(),
        versionCode = versionCode,
        libVersion = 1.4,
        lang = "en",
        isNsfw = false,
        pkgFactory = null,
        sources = listOf(source),
        icon = null,
        isShared = false,
    )

    private suspend fun awaitCall(calls: Channel<Unit>) {
        withTimeout(TIMEOUT_MS) { calls.receive() }
    }

    private companion object {
        const val SOURCE_ID = 10L
        const val TIMEOUT_MS = 5_000L
        val EMPTY_RESULT = CoreSourceRelinkResult(observed = 0, relinked = 0, pending = 0)
    }
}
