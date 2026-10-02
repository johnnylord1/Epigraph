package epigraph.recommendations

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class DiscoverVisibleLimitTest {

    @Test
    fun `null current with 30 items gives 25`() {
        assertEquals(25, nextVisibleLimit(null, 30))
    }

    @Test
    fun `18 current with 18 items gives null`() {
        assertNull(nextVisibleLimit(18, 18))
    }

    @Test
    fun `22 current with 100 items gives 29`() {
        assertEquals(29, nextVisibleLimit(22, 100))
    }

    @Test
    fun `418 current with 1000 items gives 420`() {
        assertEquals(420, nextVisibleLimit(418, 1000))
    }

    @Test
    fun `420 current with 1000 items gives null`() {
        assertNull(nextVisibleLimit(420, 1000))
    }
}
