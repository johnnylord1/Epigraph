package eu.kanade.tachiyomi.ui.reader

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ReadSessionDurationTest {
    @Test
    fun `running session reports elapsed milliseconds`() {
        assertEquals(4_500L, readSessionDuration(startTime = 10_000L, endTime = 14_500L))
    }

    @Test
    fun `no running session reports zero`() {
        assertEquals(0L, readSessionDuration(startTime = null, endTime = 14_500L))
    }

    @Test
    fun `clock going backwards never reports negative time`() {
        assertEquals(0L, readSessionDuration(startTime = 20_000L, endTime = 14_500L))
    }
}
