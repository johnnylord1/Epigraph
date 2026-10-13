package eu.kanade.tachiyomi.smartsearch

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TitleMatcherTest {

    @Test
    fun `punctuation, dashes and case do not keep the same title apart`() {
        assertEquals(
            1.0,
            TitleMatcher.score(
                "A Pig-Slaughtering Knife Cutting Through All Realms — Makes Sense, Right",
                "A pig-slaughtering knife cutting through all realms — makes sense, right?",
            ),
        )
        assertEquals(1.0, TitleMatcher.score("Doctor’s Rebirth", "Doctor's Rebirth"))
        assertEquals(1.0, TitleMatcher.score("Pokémon Adventures", "Pokemon Adventures"))
    }

    @Test
    fun `the exact title beats a similar one`() {
        val wanted = "After Rebirth, I Used Mirror Reversal For Vengeance"
        val exact = TitleMatcher.bestScore(wanted, "After Rebirth, I Used Mirror Reversal for Vengeance")
        val other = TitleMatcher.bestScore(wanted, "After Rebirth, I Married My Scumbag Ex's Arch-Enemy")
        assertEquals(1.0, exact)
        assertTrue(other < TitleMatcher.MIN_MATCH_SCORE, "unrelated title scored $other")
        assertTrue(TitleMatcher.bestScore(wanted, "Touken Ranbu - Reversal Mirror") < TitleMatcher.MIN_MATCH_SCORE)
    }

    @Test
    fun `a title with or without its subtitle still matches, below the full title`() {
        val partial = TitleMatcher.score("Apotheosis", "Apotheosis – Ascension To Godhood")
        assertTrue(partial >= TitleMatcher.MIN_MATCH_SCORE, "subtitle match scored $partial")
        assertTrue(partial < 1.0)
        assertTrue(TitleMatcher.score("Apotheosis", "The Spring-Autumn Apotheosis") < TitleMatcher.MIN_MATCH_SCORE)
    }

    @Test
    fun `fallback queries are plain text and shorter forms of the title`() {
        val queries = TitleMatcher.searchQueries("A Pig-Slaughtering Knife Cutting Through All Realms — Makes Sense, Right")
        assertEquals("A Pig-Slaughtering Knife Cutting Through All Realms — Makes Sense, Right", queries.first())
        assertTrue("a pig slaughtering knife cutting through all realms makes sense right" in queries)
        assertTrue("a pig slaughtering knife cutting through all realms" in queries)
        assertEquals(1, TitleMatcher.searchQueries("Apotheosis").size)
    }

    @Test
    fun `main title drops brackets and subtitles`() {
        assertEquals("Solo Leveling", TitleMatcher.mainTitle("Solo Leveling: Ragnarok"))
        assertEquals("Berserk", TitleMatcher.mainTitle("Berserk (Official)"))
        assertNull(TitleMatcher.mainTitle("Pig-Slaughtering"))
    }
}
