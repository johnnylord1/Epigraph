package epigraph.sync.core.replica

import epigraph.sync.core.replica.NovelChapterCoverageCheck.Companion.findNovelsWithoutChapters
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class NovelChapterCoverageCheckTest {
    @Test
    fun `reports only entries without any chapter`() {
        val entries = listOf(
            "novel:a" to """{"novelId":"novel:a","title":"Alpha"}""",
            "novel:b" to """{"novelId":"novel:b","title":"Beta"}""",
            "novel:c" to """{"title":"Gamma"}""",
        )
        val chapters = listOf(
            """{"novelId":"novel:a","path":"/a/1"}""",
            """{"novelId":"novel:c","path":"/c/1"}""",
        )

        assertEquals(listOf("Beta"), findNovelsWithoutChapters(entries, chapters))
    }

    @Test
    fun `novels hydrated locally from their plugin are not reported`() {
        val entries = listOf(
            "novel:a" to """{"novelId":"novel:a","title":"Alpha"}""",
            "novel:b" to """{"novelId":"novel:b","title":"Beta"}""",
        )

        assertEquals(listOf("Beta"), findNovelsWithoutChapters(entries, emptyList(), setOf("novel:a")))
    }

    @Test
    fun `untitled entries fall back to their id and malformed records are skipped`() {
        val entries = listOf(
            "novel:z" to """{"novelId":"novel:z","title":""}""",
            "novel:bad" to "not json",
        )

        assertEquals(listOf("novel:z"), findNovelsWithoutChapters(entries, listOf("[]", "{}")))
    }
}
