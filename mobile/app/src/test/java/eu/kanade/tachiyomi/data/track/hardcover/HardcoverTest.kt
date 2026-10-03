package eu.kanade.tachiyomi.data.track.hardcover

import android.content.Context
import eu.kanade.tachiyomi.data.track.model.TrackContentType
import io.mockk.mockk
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class HardcoverTest {

    @Test
    fun `hardcover urls preserve the book id independently from the slug`() {
        val url = HardcoverApi.bookUrl(1234, "the-left-hand-of-darkness")

        assertEquals(1234L, HardcoverApi.bookIdFromUrl(url))
        assertEquals(1234L, HardcoverApi.bookIdFromUrl("https://hardcover.app/books/1234"))
        assertEquals(1234L, HardcoverApi.bookIdFromUrl("hardcover:1234"))
        assertNull(HardcoverApi.bookIdFromUrl("https://example.com/books/1234"))
    }

    @Test
    fun `chapter progress is translated to pages by relative position`() {
        assertEquals(250, Hardcover.progressAsPages(25f, 100, 1000))
        assertEquals(25f, Hardcover.chapterFromPages(250, 100, 1000))
        assertNull(Hardcover.progressAsPages(0f, 100, 1000))
        assertNull(Hardcover.chapterFromPages(null, 100, 1000))
    }

    @Test
    fun `hardcover is exposed only for novels`() {
        val service = Hardcover(mockk<Context>(relaxed = true), id = 12L)

        assertEquals(setOf(TrackContentType.NOVEL), service.supportedContentTypes)
    }
}
