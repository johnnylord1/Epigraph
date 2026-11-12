package epigraph.books.pdf

import android.graphics.Bitmap

/** Optional capability exposed by engines that can rasterize a page for OCR. */
interface PdfPageBitmapRenderer {
    suspend fun renderPageBitmap(pageIndex: Int, maxDimension: Int = 2_000): Bitmap?

    /** Height over width of every page, read without rendering them. */
    suspend fun pageAspects(): FloatArray

    /** The width in pixels a page takes at its physical size on this screen. */
    suspend fun pagePixelWidth(pageIndex: Int): Int
}
