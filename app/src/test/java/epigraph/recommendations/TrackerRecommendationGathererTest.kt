package epigraph.recommendations

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TrackerRecommendationGathererTest {

    @Test
    fun `trackerScoreTitles caps at 32 and dedupes`() {
        val titles = mutableListOf("Solo Leveling", "solo leveling!")
        for (i in 1..40) titles.add("Title $i")
        val result = trackerScoreTitles(titles)
        assertEquals(32, result.size)
        assertTrue(result.contains("Solo Leveling"))
        assertFalse(result.contains("solo leveling!"))
    }

    @Test
    fun `dedupeTrackSearches removes duplicate tracker and remote id`() {
        val item1 = TrackerCatalogInput(
            trackerId = 1L,
            trackerName = "AniList",
            remoteId = "123",
            title = "Test Title",
        )
        val item2 = TrackerCatalogInput(
            trackerId = 1L,
            trackerName = "AniList",
            remoteId = "123",
            title = "Test Title Duplicate",
        )
        val item3 = TrackerCatalogInput(
            trackerId = 1L,
            trackerName = "AniList",
            remoteId = "456",
            title = "Another Title",
        )
        val result = dedupeTrackSearches(listOf(item1, item2, item3))
        assertEquals(2, result.size)
        assertEquals("Test Title", result[0].title)
        assertEquals("Another Title", result[1].title)
    }

    @Test
    fun `MalTrackerPause blocks after pause and allows after cooldown`() {
        var currentTime = 0L
        val pause = MalTrackerPause { currentTime }

        assertFalse(pause.isPaused())

        pause.pause()
        assertTrue(pause.isPaused())

        currentTime = TRACKER_SCORE_MAL_RATE_LIMIT_COOLDOWN_MS + 1
        assertFalse(pause.isPaused())
    }

    @Test
    fun `capProviderResults caps at 120`() {
        val items = (1..150).toList()
        val result = capProviderResults(items)
        assertEquals(120, result.size)
        assertEquals((1..120).toList(), result)
    }

    @Test
    fun `trackerTitleMatchScore exact match after normalization`() {
        assertEquals(1.0, trackerTitleMatchScore("The Solo Leveling", "Solo Leveling"))
    }

    @Test
    fun `trackerTitleMatchScore short containment is zero`() {
        assertEquals(0.0, trackerTitleMatchScore("Berserk Deluxe Edition", "Berserk"))
    }

    @Test
    fun `trackerTitleMatchScore long containment is 0_82`() {
        assertEquals(0.82, trackerTitleMatchScore("Omniscient Reader's Viewpoint", "Omniscient Reader"))
    }

    @Test
    fun `trackerTitleMatchScore empty title is zero`() {
        assertEquals(0.0, trackerTitleMatchScore("", "Solo Leveling"))
    }
}
