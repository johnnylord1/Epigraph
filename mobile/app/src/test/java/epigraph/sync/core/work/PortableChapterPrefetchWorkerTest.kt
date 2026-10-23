package epigraph.sync.core.work

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PortableChapterPrefetchWorkerTest {
    @Test
    fun `a run that finishes while sync stays connected returns its result`() = runTest {
        assertEquals(7, untilPaused(MutableStateFlow(false)) { 7 })
    }

    @Test
    fun `disconnecting sync cancels a running fetch`() = runTest {
        val paused = MutableStateFlow(false)
        val started = CompletableDeferred<Unit>()
        var cancelled = false
        val result = launch {
            val value = untilPaused(paused) {
                started.complete(Unit)
                try {
                    awaitCancellation()
                } finally {
                    cancelled = true
                }
            }
            assertNull(value)
        }
        started.await()
        paused.value = true
        result.join()

        assertTrue(cancelled)
    }

    @Test
    fun `stopping the worker still cancels the caller`() = runTest {
        val started = CompletableDeferred<Unit>()
        val run = launch {
            untilPaused(MutableStateFlow(false)) {
                started.complete(Unit)
                awaitCancellation()
            }
        }
        started.await()
        run.cancelAndJoin()

        assertTrue(run.isCancelled)
    }
}
