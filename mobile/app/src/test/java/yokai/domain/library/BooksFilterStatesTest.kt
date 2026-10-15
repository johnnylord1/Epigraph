package yokai.domain.library

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class BooksFilterStatesTest {

    @Test
    fun `the saved states read back as they were`() {
        val states = mapOf('u' to 1, 'r' to 4, 'd' to 2, 't' to 1)
        val saved = LibraryPreferences.encodeBooksFilterStates(states)

        assertEquals(setOf("u1", "r4", "d2", "t1"), saved)
        assertEquals(states, LibraryPreferences.decodeBooksFilterStates(saved))
    }

    @Test
    fun `ignored states are not saved`() {
        assertEquals(setOf("c2"), LibraryPreferences.encodeBooksFilterStates(mapOf('c' to 2, 'b' to 0)))
    }

    @Test
    fun `entries that do not read are skipped`() {
        assertEquals(mapOf('s' to 1), LibraryPreferences.decodeBooksFilterStates(setOf("s1", "", "x", "d0", "bz")))
    }
}
