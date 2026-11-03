package epigraph.books.pdf

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PdfBorderCropTest {

    private val white = 0xFFFFFFFF.toInt()
    private val black = 0xFF000000.toInt()

    private fun page(width: Int, height: Int, fill: (x: Int, y: Int) -> Int) =
        IntArray(width * height) { fill(it % width, it / width) }

    @Test
    fun `blank margin is trimmed down to the content plus padding`() {
        val pixels = page(200, 200) { x, y -> if (x in 50..149 && y in 40..159) black else white }

        assertEquals(
            PdfBorderCrop.Bounds(left = 48, top = 38, right = 152, bottom = 162),
            PdfBorderCrop.contentBounds(pixels, 200, 200),
        )
    }

    @Test
    fun `blank page keeps its full size`() {
        assertNull(PdfBorderCrop.contentBounds(page(100, 100) { _, _ -> white }, 100, 100))
    }

    @Test
    fun `content reaching the edges is left alone`() {
        val pixels = page(100, 100) { x, y -> if (x == 0 && y == 0) white else if (x == 99 || y == 99) black else white }

        assertNull(PdfBorderCrop.contentBounds(pixels, 100, 100))
    }

    @Test
    fun `near-white antialiasing stays margin`() {
        val nearWhite = 0xFFF0F0F0.toInt()
        val pixels = page(200, 200) { x, y ->
            when {
                x in 80..119 && y in 80..119 -> black
                y == 10 -> nearWhite
                else -> white
            }
        }

        assertEquals(
            PdfBorderCrop.Bounds(left = 78, top = 78, right = 122, bottom = 122),
            PdfBorderCrop.contentBounds(pixels, 200, 200),
        )
    }

    @Test
    fun `dark pages use their own margin color`() {
        val pixels = page(200, 200) { x, y -> if (x in 50..149 && y in 50..149) white else black }

        assertEquals(
            PdfBorderCrop.Bounds(left = 48, top = 48, right = 152, bottom = 152),
            PdfBorderCrop.contentBounds(pixels, 200, 200),
        )
    }
}
