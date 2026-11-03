package epigraph.books.pdf

import android.graphics.Bitmap

/**
 * The "Crop borders" toggle for PDF pages: trims the blank margin around a rendered page, as the
 * comic reader does for manga pages. The page corner gives the margin color.
 */
object PdfBorderCrop {
    /** A channel difference at or below this counts as margin (antialiasing and scan noise). */
    private const val TOLERANCE = 24

    /** Breathing room kept around the content, as a fraction of the page side. */
    private const val PADDING = 0.01

    /** Crops that would keep almost the whole page are skipped to avoid a needless copy. */
    private const val MIN_TRIM = 0.02

    data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        val width get() = right - left
        val height get() = bottom - top
    }

    /**
     * Returns the padded content rectangle of an ARGB page ([right] and [bottom] exclusive), or
     * null when the page is blank or the margin is too thin to be worth trimming.
     */
    fun contentBounds(pixels: IntArray, width: Int, height: Int): Bounds? {
        if (width <= 0 || height <= 0 || pixels.size < width * height) return null
        val background = pixels[0]
        var left = width
        var top = height
        var right = -1
        var bottom = -1
        for (y in 0 until height) {
            val row = y * width
            for (x in 0 until width) {
                if (isContent(pixels[row + x], background)) {
                    if (x < left) left = x
                    if (x > right) right = x
                    if (y < top) top = y
                    bottom = y
                }
            }
        }
        if (right < 0) return null
        val padX = (width * PADDING).toInt()
        val padY = (height * PADDING).toInt()
        val bounds = Bounds(
            left = (left - padX).coerceAtLeast(0),
            top = (top - padY).coerceAtLeast(0),
            right = (right + 1 + padX).coerceAtMost(width),
            bottom = (bottom + 1 + padY).coerceAtMost(height),
        )
        val trimmed = 1.0 - (bounds.width.toDouble() * bounds.height) / (width.toDouble() * height)
        return bounds.takeIf { trimmed >= MIN_TRIM }
    }

    /** Returns the cropped page, recycling [bitmap], or [bitmap] itself when nothing is trimmed. */
    fun crop(bitmap: Bitmap): Bitmap {
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        val bounds = contentBounds(pixels, width, height) ?: return bitmap
        val cropped = Bitmap.createBitmap(bitmap, bounds.left, bounds.top, bounds.width, bounds.height)
        if (cropped !== bitmap) bitmap.recycle()
        return cropped
    }

    private fun isContent(pixel: Int, background: Int): Boolean =
        channelDiff(pixel, background, 16) > TOLERANCE ||
            channelDiff(pixel, background, 8) > TOLERANCE ||
            channelDiff(pixel, background, 0) > TOLERANCE

    private fun channelDiff(a: Int, b: Int, shift: Int): Int =
        kotlin.math.abs(((a shr shift) and 0xFF) - ((b shr shift) and 0xFF))
}
