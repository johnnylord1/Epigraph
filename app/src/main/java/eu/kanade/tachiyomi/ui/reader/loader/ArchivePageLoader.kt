package eu.kanade.tachiyomi.ui.reader.loader

import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.ui.reader.model.ReaderPage
import eu.kanade.tachiyomi.util.lang.compareToCaseInsensitiveNaturalOrder
import eu.kanade.tachiyomi.util.system.ImageUtil
import yokai.core.archive.ArchiveReader

/**
 * Loader used to load a chapter from an archive file.
 */
internal class ArchivePageLoader(private val reader: ArchiveReader) : PageLoader() {

    override val isLocal: Boolean = true

    /**
     * Recycles this loader and the open archive.
     */
    override fun recycle() {
        super.recycle()
        reader.close()
    }

    /**
     * Returns the pages found on this archive ordered with a natural comparator.
     */
    override suspend fun getPages(): List<ReaderPage> = reader.useEntries { entries ->
        val imageEntries = entries
            .filter { it.isFile && ImageUtil.isImage(it.name) { reader.getInputStream(it.name)!! } }
            .sortedWith { f1, f2 -> f1.name.compareToCaseInsensitiveNaturalOrder(f2.name) }
            .toList()
        val sourcePositions = archiveSourcePagePositions(imageEntries.map { it.name })
        imageEntries
            .mapIndexed { i, entry ->
                ReaderPage(i).apply {
                    sourcePageIndex = sourcePositions[i]?.index
                    sourcePageCount = sourcePositions[i]?.count
                    stream = { reader.getInputStream(entry.name)!! }
                    status = Page.State.Ready
                }
            }
            .toList()
    }

    /**
     * No additional action required to load the page
     */
    override suspend fun loadPage(page: ReaderPage) {
        check(!isRecycled)
    }
}

internal data class ArchiveSourcePagePosition(
    val index: Int,
    val count: Int,
)

internal fun archiveSourcePagePositions(entryNames: List<String>): List<ArchiveSourcePagePosition?> {
    val indexes = entryNames.map { name ->
        ARCHIVE_PAGE_NAME.matchEntire(name)?.groupValues?.get(1)?.toIntOrNull()?.minus(1)
    }
    val distinct = indexes.filterNotNull().toSortedSet()
    val count = distinct.lastOrNull()?.plus(1) ?: return entryNames.map { null }
    if (indexes.any { it == null } || distinct.toList() != (0 until count).toList()) {
        return entryNames.map { null }
    }
    return indexes.map { ArchiveSourcePagePosition(requireNotNull(it), count) }
}

private val ARCHIVE_PAGE_NAME = Regex("^(\\d+)(?:__\\d+)?\\.[^.]+$")
