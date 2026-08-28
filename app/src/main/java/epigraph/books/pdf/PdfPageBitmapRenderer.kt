package epigraph.books.pdf

import android.graphics.Bitmap

/** Optional capability exposed by engines that can rasterize a page for OCR. */
interface PdfPageBitmapRenderer {
    suspend fun renderPageBitmap(pageIndex: Int, maxDimension: Int = 2_000): Bitmap?
}
