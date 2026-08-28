package eu.kanade.tachiyomi.ui.reader

/** Stable, chapter-local text anchor used by the canonical novel WebView reader. */
data class NovelTextPosition(
    val blockIndex: Int,
    val textOffset: Int,
) {
    init {
        require(blockIndex >= 0) { "block index must not be negative" }
        require(textOffset >= 0) { "text offset must not be negative" }
    }

    /**
     * Older Epigraph records were emitted as `block:0:0` regardless of the actual position.
     * Treat that sentinel as exact only at the beginning of a chapter; otherwise the reader
     * must use the persisted percentage so an upgrade cannot jump a user back to the top.
     */
    fun isExactAnchor(progression: Double): Boolean =
        blockIndex > 0 || textOffset > 0 || progression <= START_OF_CHAPTER_EPSILON

    private companion object {
        const val START_OF_CHAPTER_EPSILON = 0.001
    }
}
