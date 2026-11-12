package epigraph.books.pdf

import android.content.Context
import android.os.ParcelFileDescriptor
import com.ahmer.pdfium.PdfDocument
import com.ahmer.pdfium.PdfiumCore
import epigraph.books.local.LocalBookPdfSection
import java.io.File
import yokai.i18n.MR
import yokai.util.lang.getString

/** An outline entry as the file has it. [pageIndex] is outside the document when it has no destination. */
internal data class PdfOutlineEntry(val title: String?, val pageIndex: Int, val depth: Int)

data class PdfOutlineDocument(val sections: List<LocalBookPdfSection>, val pageCount: Int)

fun interface PdfOutlineReader {
    /** The file's outline, or null when it cannot be read, such as a password-protected PDF. */
    fun read(file: File): PdfOutlineDocument?
}

/** One section alone says nothing the whole document does not, so it gives no chapters. */
internal fun normalizePdfOutline(
    entries: List<PdfOutlineEntry>,
    pageCount: Int,
    pageLabel: (Int) -> String,
): List<LocalBookPdfSection> = pdfOutlineSections(entries, pageCount, pageLabel).takeIf { it.size >= 2 }.orEmpty()

/**
 * An outline's sections, by the desktop's rules so both sides agree on them: every depth, in page
 * order, without entries that lead nowhere or repeat.
 */
internal fun pdfOutlineSections(
    entries: List<PdfOutlineEntry>,
    pageCount: Int,
    pageLabel: (Int) -> String,
): List<LocalBookPdfSection> =
    entries
        .filter { it.pageIndex in 0 until pageCount }
        .map { entry ->
            LocalBookPdfSection(
                title = entry.title?.replace(OUTLINE_TITLE_SEPARATORS, " ")?.trim()?.takeIf { it.isNotEmpty() }
                    ?: pageLabel(entry.pageIndex + 1),
                pageIndex = entry.pageIndex,
                depth = entry.depth,
            )
        }
        .distinctBy { it.pageIndex to it.title.lowercase() }
        .sortedWith(compareBy({ it.pageIndex }, { it.depth }))

private val OUTLINE_TITLE_SEPARATORS = Regex("[\\s\\p{Cc}]+")

/** An outline as the file links it. A node is an opaque handle, and [ROOT] also means no node. */
internal interface PdfOutlineTree {
    fun firstChild(node: Long): Long
    fun nextSibling(node: Long): Long
    fun entry(node: Long, depth: Int): PdfOutlineEntry

    companion object {
        const val ROOT = 0L
    }
}

/** Every entry in file order, each node once, so a malformed outline that links back still ends. */
internal fun walkPdfOutline(tree: PdfOutlineTree): List<PdfOutlineEntry> {
    val entries = mutableListOf<PdfOutlineEntry>()
    val seen = HashSet<Long>()
    val pending = ArrayDeque<Pair<Long, Int>>()
    pending.addLast(tree.firstChild(PdfOutlineTree.ROOT) to 0)
    while (pending.isNotEmpty()) {
        val (node, depth) = pending.removeLast()
        if (node == PdfOutlineTree.ROOT || !seen.add(node)) continue
        entries += tree.entry(node, depth)
        pending.addLast(tree.nextSibling(node) to depth)
        pending.addLast(tree.firstChild(node) to depth + 1)
    }
    return entries
}

/**
 * [PdfDocument.bookmarks] spends its depth limit on every entry with children, so it drops the rest
 * of the outline after about fifteen of them. Its natives are private, and these public accessors
 * are the only way to them: proguard-rules.pro keeps them by name.
 */
private class PdfiumOutlineTree(private val document: Long) : PdfOutlineTree {
    private val firstChild = accessor("access\$nativeGetFirstChildBookmark", LONG, LONG)
    private val nextSibling = accessor("access\$nativeGetSiblingBookmark", LONG, LONG)
    private val title = accessor("access\$nativeGetBookmarkTitle", LONG)
    private val destination = accessor("access\$nativeGetBookmarkDestIndex", LONG, LONG)

    override fun firstChild(node: Long) = firstChild.invoke(null, document, node) as Long

    override fun nextSibling(node: Long) = nextSibling.invoke(null, document, node) as Long

    override fun entry(node: Long, depth: Int) = PdfOutlineEntry(
        title = title.invoke(null, node) as String?,
        pageIndex = (destination.invoke(null, document, node) as Long).toOutlinePage(),
        depth = depth,
    )

    private fun accessor(name: String, vararg parameters: Class<*>) =
        PdfDocument::class.java.getMethod(name, *parameters)

    private companion object {
        val LONG: Class<*> = Long::class.javaPrimitiveType!!
    }
}

private fun Long.toOutlinePage(): Int = coerceIn(-1L, Int.MAX_VALUE.toLong()).toInt()

/**
 * The document's outline. The library's own reading is the fallback, and it is guarded too: a cyclic
 * outline ends in a StackOverflowError inside it.
 */
internal fun PdfDocument.readOutlineEntries(): List<PdfOutlineEntry> =
    runCatching { synchronized(PdfiumCore.lock) { walkPdfOutline(PdfiumOutlineTree(nativePtr)) } }
        .recoverCatching { buildList { collectOutline(bookmarks, depth = 0) } }
        .getOrDefault(emptyList())

private fun MutableList<PdfOutlineEntry>.collectOutline(bookmarks: List<PdfDocument.Bookmark>, depth: Int) {
    bookmarks.forEach { bookmark ->
        add(PdfOutlineEntry(bookmark.title, bookmark.pageIndex.toOutlinePage(), depth))
        collectOutline(bookmark.children, depth + 1)
    }
}

class PdfiumPdfOutlineReader(private val context: Context) : PdfOutlineReader {
    override fun read(file: File): PdfOutlineDocument? = runCatching {
        val core = PdfiumCore(context)
        val descriptor = try {
            ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        } catch (failure: Throwable) {
            core.close()
            throw failure
        }
        val pdf = try {
            core.newDocument(descriptor, "")
        } catch (failure: Throwable) {
            descriptor.close()
            core.close()
            throw failure
        }
        // The core closes the document and its descriptor; closing the document first crashes.
        try {
            val pageCount = pdf.totalPages
            if (pageCount <= 0) return@runCatching null
            PdfOutlineDocument(
                sections = normalizePdfOutline(pdf.readOutlineEntries(), pageCount) { page ->
                    context.getString(MR.strings.page_, page)
                },
                pageCount = pageCount,
            )
        } finally {
            runCatching { core.close() }
        }
    }.getOrNull()
}
