package epigraph.contract

/** Adds stable document-wide metrics to a zero-based PDF locator. */
fun ReaderLocator.Pdf.withDocumentMetrics(totalPages: Int): ReaderLocator.Pdf {
    require(totalPages > 0) { "PDF total pages must be positive" }
    require(pageIndex < totalPages) { "PDF page index must be smaller than total pages" }
    val progression = if (totalPages == 1) {
        1.0
    } else {
        ((pageIndex + pageOffset) / (totalPages - 1).toDouble()).coerceIn(0.0, 1.0)
    }
    return copy(totalPages = totalPages, documentProgression = progression)
}
