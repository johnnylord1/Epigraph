package eu.kanade.tachiyomi.data.library

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SourceFailureBreakerTest {

    @Test
    fun `opens after the limit of failures in a row`() {
        val breaker = SourceFailureBreaker(3)
        breaker.record(failed = true)
        breaker.record(failed = true)
        assertFalse(breaker.isOpen)
        breaker.record(failed = true)
        assertTrue(breaker.isOpen)
    }

    @Test
    fun `a successful title resets the count`() {
        val breaker = SourceFailureBreaker(3)
        breaker.record(failed = true)
        breaker.record(failed = true)
        breaker.record(failed = false)
        breaker.record(failed = true)
        breaker.record(failed = true)
        assertFalse(breaker.isOpen)
    }

    @Test
    fun `successes alone never open it`() {
        val breaker = SourceFailureBreaker(1)
        repeat(10) { breaker.record(failed = false) }
        assertFalse(breaker.isOpen)
    }
}
