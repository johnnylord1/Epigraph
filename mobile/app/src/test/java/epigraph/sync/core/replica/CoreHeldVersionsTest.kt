package epigraph.sync.core.replica

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CoreHeldVersionsTest {
    @Test
    fun `runs of applied versions become ranges`() {
        assertEquals("", CoreHeldVersions.encode(emptyList()))
        assertEquals("5", CoreHeldVersions.encode(listOf(5)))
        assertEquals("3-6,9,11-12", CoreHeldVersions.encode(listOf(3, 4, 5, 6, 9, 11, 12)))
    }

    @Test
    fun `only the first ranges are sent`() {
        assertEquals("1,3-4", CoreHeldVersions.encode(listOf(1, 3, 4, 6, 8, 9), maxRanges = 2))
    }
}
