package epigraph.books.reader

import android.content.Context
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import epigraph.books.importing.EpubArchiveValidator
import epigraph.books.model.LocalBookDocument
import epigraph.contract.ContentType

/**
 * Reads the stable document counts used by the details chrome without opening a reader session.
 *
 * Progress locators remain the source of truth for resume. This inspector only supplies display
 * metrics: EPUB spine entries are displayed as chapters (titled from the book's TOC when it names
 * them) and PDFs as pages. Password-protected or unavailable files return null so the UI can
 * report that the count is unavailable instead of inventing a percentage.
 */
class BookStructureInspector(private val context: Context) {

    fun inspect(document: LocalBookDocument): BookStructure? = runCatching {
        when (document.contentType) {
            ContentType.EPUB -> {
                val manifest = EpubArchiveValidator.validate(document.file)
                val tocTitles = EpubTocTitles.read(document.file, manifest.navigationPath)
                val titles = manifest.spinePaths.mapIndexed { index, path ->
                    tocTitles[path]?.let { return@mapIndexed it }
                    val fileName = path.substringAfterLast('/').substringBeforeLast('.')
                    fileName
                        .replace(Regex("[_-]+"), " ")
                        .replace(Regex("\\s+"), " ")
                        .trim()
                        .takeIf { it.isNotBlank() }
                        ?.replaceFirstChar { character -> character.titlecase() }
                        ?: "Chapter ${index + 1}"
                }
                BookStructure(
                    chapterCount = titles.size.coerceAtLeast(1),
                    chapterTitles = titles,
                    chapterPaths = manifest.spinePaths,
                )
            }

            ContentType.PDF -> inspectPdf(document)

            else -> error("Only EPUB and PDF documents have local book structures")
        }
    }.getOrNull()

    private fun inspectPdf(document: LocalBookDocument): BookStructure {
        val descriptor = ParcelFileDescriptor.open(
            document.file,
            ParcelFileDescriptor.MODE_READ_ONLY,
        )
        val renderer = PdfRenderer(descriptor)
        return try {
            BookStructure(
                // A PDF is one publication chapter; PdfRenderer supplies the display count
                // without opening AhmerPdfium. The latter is reserved for the interactive reader
                // and has a native teardown path that must not run during library inspection.
                chapterCount = 1,
                chapterTitles = listOf("Document"),
                pageCount = renderer.pageCount.coerceAtLeast(1),
            )
        } finally {
            runCatching { renderer.close() }
            runCatching { descriptor.close() }
        }
    }
}

data class BookStructure(
    val chapterCount: Int? = null,
    val pageCount: Int? = null,
    /** Stable display labels for the detail chapter catalog, when the format exposes them. */
    val chapterTitles: List<String> = emptyList(),
    /** Zero-based PDF page anchors matching [chapterTitles]. */
    val chapterStartPages: List<Int> = emptyList(),
    /** Archive paths of the EPUB spine resources matching [chapterTitles]. */
    val chapterPaths: List<String> = emptyList(),
)
