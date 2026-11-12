package epigraph.books.pdf

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PdfOutlineTest {
    private fun normalize(vararg entries: PdfOutlineEntry, pageCount: Int = 10) =
        normalizePdfOutline(entries.toList(), pageCount) { "Page $it" }

    @Test
    fun `every depth comes in page order`() {
        val sections = normalize(
            PdfOutlineEntry("Part I", 0, 0),
            PdfOutlineEntry("Chapter 2", 5, 1),
            PdfOutlineEntry("Chapter 1", 1, 1),
        )

        assertEquals(listOf("Part I", "Chapter 1", "Chapter 2"), sections.map { it.title })
        assertEquals(listOf(0, 1, 5), sections.map { it.pageIndex })
        assertEquals(listOf(0, 1, 1), sections.map { it.depth })
    }

    @Test
    fun `sections on one page keep the outer one first`() {
        val sections = normalize(
            PdfOutlineEntry("Chapter 1", 2, 1),
            PdfOutlineEntry("Part I", 2, 0),
        )

        assertEquals(listOf("Part I", "Chapter 1"), sections.map { it.title })
    }

    @Test
    fun `entries that lead nowhere are left out`() {
        val sections = normalize(
            PdfOutlineEntry("No destination", -1, 0),
            PdfOutlineEntry("Past the end", 10, 0),
            PdfOutlineEntry("One", 0, 0),
            PdfOutlineEntry("Two", 9, 0),
        )

        assertEquals(listOf("One", "Two"), sections.map { it.title })
    }

    @Test
    fun `the same title on the same page counts once whatever its case`() {
        val sections = normalize(
            PdfOutlineEntry("Intro", 1, 0),
            PdfOutlineEntry("INTRO", 1, 1),
            PdfOutlineEntry("Intro", 4, 0),
        )

        assertEquals(listOf(1, 4), sections.map { it.pageIndex })
    }

    @Test
    fun `a blank title takes the page number`() {
        val sections = normalize(
            PdfOutlineEntry(" \n\t", 2, 0),
            PdfOutlineEntry(null, 3, 0),
        )

        assertEquals(listOf("Page 3", "Page 4"), sections.map { it.title })
    }

    @Test
    fun `line breaks and control characters in a title become one space`() {
        val sections = normalize(
            PdfOutlineEntry("  Chapter\r\n\u0000 One ", 0, 0),
            PdfOutlineEntry("Two", 1, 0),
        )

        assertEquals("Chapter One", sections.first().title)
    }

    @Test
    fun `fewer than two sections give no chapters`() {
        assertTrue(normalize().isEmpty())
        assertTrue(normalize(PdfOutlineEntry("Only", 3, 0)).isEmpty())
        assertTrue(normalize(PdfOutlineEntry("Only", 3, 0), PdfOutlineEntry("only", 3, 1)).isEmpty())
    }

    @Test
    fun `the contents keep a lone section that gives no chapters`() {
        val entries = listOf(PdfOutlineEntry("Only", 3, 0), PdfOutlineEntry("No destination", -1, 0))

        assertEquals(listOf("Only"), pdfOutlineSections(entries, 10) { "Page $it" }.map { it.title })
    }

    @Test
    fun `an outline comes whole in file order however many entries have children`() {
        val tree = FakeOutline()
        tree.link(PdfOutlineTree.ROOT, child = 10)
        (1L..24L).forEach { part ->
            val node = part * 10
            tree.link(node, next = if (part < 24) node + 10 else 0, child = node + 1)
        }

        val entries = walkPdfOutline(tree)

        assertEquals(48, entries.size)
        assertEquals(listOf("10" to 0, "11" to 1, "20" to 0, "21" to 1), entries.take(4).map { it.title to it.depth })
        assertEquals(listOf("240" to 0, "241" to 1), entries.takeLast(2).map { it.title to it.depth })
    }

    @Test
    fun `a sibling that links back ends the walk`() {
        val tree = FakeOutline()
        tree.link(PdfOutlineTree.ROOT, child = 1)
        tree.link(1, next = 2)
        tree.link(2, next = 1)

        assertEquals(listOf("1", "2"), walkPdfOutline(tree).map { it.title })
    }

    @Test
    fun `a child that links back ends the walk and keeps what follows`() {
        val tree = FakeOutline()
        tree.link(PdfOutlineTree.ROOT, child = 1)
        tree.link(1, next = 2, child = 1)

        assertEquals(listOf("1" to 0, "2" to 0), walkPdfOutline(tree).map { it.title to it.depth })
    }

    @Test
    fun `depth is limited by nothing but the outline`() {
        val tree = FakeOutline()
        tree.link(PdfOutlineTree.ROOT, child = 1)
        (1L until 100_000L).forEach { node -> tree.link(node, child = node + 1) }

        val entries = walkPdfOutline(tree)

        assertEquals(100_000, entries.size)
        assertEquals(99_999, entries.last().depth)
    }

    @Test
    fun `an empty outline has no entries`() {
        assertTrue(walkPdfOutline(FakeOutline()).isEmpty())
    }

    private class FakeOutline : PdfOutlineTree {
        private val children = HashMap<Long, Long>()
        private val siblings = HashMap<Long, Long>()

        fun link(node: Long, next: Long = 0, child: Long = 0) {
            siblings[node] = next
            children[node] = child
        }

        override fun firstChild(node: Long) = children[node] ?: 0

        override fun nextSibling(node: Long) = siblings[node] ?: 0

        override fun entry(node: Long, depth: Int) = PdfOutlineEntry(node.toString(), 0, depth)
    }
}
