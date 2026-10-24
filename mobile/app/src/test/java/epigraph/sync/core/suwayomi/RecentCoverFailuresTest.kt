package epigraph.sync.core.suwayomi

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RecentCoverFailuresTest {
    @Test
    fun `a failed cover is skipped until the wait ends`() {
        var now = 0L
        val failures = RecentCoverFailures(ttlMillis = 1_000, nowMillis = { now })

        failures.remember(COVER)
        now = 999

        assertTrue(failures.isRecent(COVER))
        assertFalse(failures.isRecent(OTHER_COVER))
        now = 1_000
        assertFalse(failures.isRecent(COVER))
    }

    @Test
    fun `only the most recent failures are kept`() {
        val failures = RecentCoverFailures(ttlMillis = 1_000, maxEntries = 1, nowMillis = { 0L })

        failures.remember(COVER)
        failures.remember(OTHER_COVER)

        assertFalse(failures.isRecent(COVER))
        assertTrue(failures.isRecent(OTHER_COVER))
    }

    @Test
    fun `markup and empty answers are not images`() {
        assertFalse(ByteArray(0).couldBeImage())
        assertFalse("  \n<!DOCTYPE html>".encodeToByteArray().couldBeImage())
        assertFalse("{\"error\":1}".encodeToByteArray().couldBeImage())
        assertFalse(byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte(), '<'.code.toByte()).couldBeImage())
        assertTrue(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte()).couldBeImage())
        assertTrue("RIFF....WEBP".encodeToByteArray().couldBeImage())
    }

    private companion object {
        const val COVER = "aethon-core://suwayomi/server/main/manga/1"
        const val OTHER_COVER = "aethon-core://suwayomi/server/main/manga/2"
    }
}
