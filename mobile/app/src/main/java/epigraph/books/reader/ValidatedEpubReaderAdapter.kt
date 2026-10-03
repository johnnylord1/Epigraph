package epigraph.books.reader

import android.content.Context
import epigraph.books.importing.EpubArchiveValidator
import epigraph.books.model.LocalBookDocument
import epigraph.contract.ReaderLocator
import epigraph.novel.reader.security.NovelHtmlSanitizer
import java.io.File
import org.jsoup.Jsoup
import org.json.JSONObject
import org.readium.r2.navigator.epub.EpubNavigatorFactory
import org.readium.r2.navigator.epub.EpubNavigatorFragment
import org.readium.r2.navigator.epub.EpubPreferences
import org.readium.r2.navigator.epub.EpubDefaults
import org.readium.r2.shared.publication.Link
import org.readium.r2.shared.publication.Locator
import org.readium.r2.shared.publication.Publication
import org.readium.r2.shared.ExperimentalReadiumApi
import org.readium.r2.shared.util.asset.AssetRetriever
import org.readium.r2.shared.util.Try
import org.readium.r2.shared.util.http.HttpClient
import org.readium.r2.shared.util.http.HttpError
import org.readium.r2.shared.util.http.HttpRequest
import org.readium.r2.shared.util.http.HttpStreamResponse
import org.readium.r2.streamer.PublicationOpener
import org.readium.r2.streamer.parser.DefaultPublicationParser

/**
 * EPUBs are imported into the app's private store before this adapter is called. Readium still
 * accepts an [HttpClient] for publications which have external references, so make that boundary
 * explicit: a local publication may resolve only resources in its own container. The navigator
 * serves those resources from the publication and never gets a network-capable client.
 */
private object LocalOnlyHttpClient : HttpClient {
    override suspend fun stream(request: HttpRequest): Try<HttpStreamResponse, HttpError> =
        Try.Failure(
            HttpError.IO(
                IllegalStateException("External EPUB resource blocked: ${request.url}"),
            ),
        )
}

/**
 * Opens EPUBs through the one supported engine: Readium's publication and navigator stack.
 *
 * The importer remains the first validation boundary. Readium then parses the same private file
 * and the resulting [Publication] stays alive for the reader lifetime. The UI receives the
 * [ReadiumEpubReaderSession] capability and hosts an [EpubNavigatorFragment]; it never renders
 * ZIP entries itself.
 */
@OptIn(ExperimentalReadiumApi::class)
class ValidatedEpubReaderAdapter(
    private val context: Context,
) : EpubReaderAdapter {
    override suspend fun open(request: EpubReaderOpenRequest): BookReaderSession<ReaderLocator.Epub> {
        val file = request.document.file
        require(file.isFile && file.canRead()) { "The EPUB file is unavailable" }
        EpubArchiveValidator.validate(file)

        val httpClient = LocalOnlyHttpClient
        // A local file is retrieved into Readium's private asset container. The navigator serves
        // only publication resources; the client above rejects every external URL.
        val retriever = AssetRetriever(context.contentResolver, httpClient)
        val asset = retriever.retrieve(file).getOrNull()
            ?: error("Readium could not retrieve the EPUB asset")
        val parser = DefaultPublicationParser(context, httpClient, retriever, null)
        val publication = PublicationOpener(parser)
            .open(asset, allowUserInteraction = false)
            .getOrNull()
            ?: error("Readium could not parse the EPUB publication")

        return try {
            ReadiumEpubReaderSession(request.document, publication, request.initialLocator)
        } catch (failure: Throwable) {
            publication.close()
            throw failure
        }
    }
}

/**
 * The canonical EPUB reader session. It owns the Readium [Publication] and exposes the data
 * operations required by the book repository while keeping navigator-specific types at the UI
 * boundary. [navigatorFactory] is used by [epigraph.books.ui.LocalBookReaderActivity] to mount the
 * real Readium navigator fragment.
 */
@OptIn(ExperimentalReadiumApi::class)
class ReadiumEpubReaderSession(
    private val document: LocalBookDocument,
    val publication: Publication,
    initialLocator: ReaderLocator.Epub?,
) : BookReaderSession<ReaderLocator.Epub>, EpubNavigatorSession {
    private val readingOrder: List<Link> = publication.readingOrder
    private val navigatorFactory = EpubNavigatorFactory(
        publication = publication,
        configuration = EpubNavigatorFactory.Configuration(defaults = EpubDefaults()),
    )
    private var closed = false
    private var readiumLocator: Locator = initialLocator
        ?.let(::toReadiumLocator)
        ?: publication.readingOrder.firstOrNull()?.let(publication::locatorFromLink)
        ?: error("The EPUB publication has an empty reading order")
    private var highlights: List<ReaderHighlight<ReaderLocator.Epub>> = emptyList()

    override val capabilities = ReaderCapabilities(
        tableOfContents = true,
        textSearch = true,
        textSelection = true,
        highlights = true,
        textToSpeech = true,
    )

    override val navigator: EpubNavigatorFactory
        get() = navigatorFactory

    override val spineSize: Int
        get() = readingOrder.size

    override suspend fun currentLocator(): ReaderLocator.Epub {
        ensureOpen()
        return toReaderLocator(readiumLocator)
    }

    override suspend fun navigateTo(locator: ReaderLocator.Epub) {
        ensureOpen()
        require(locator.entityId == document.entityId) { "The EPUB locator belongs to another document" }
        readiumLocator = toReadiumLocator(locator)
    }

    /** Updates persistence state from Readium's navigator pagination callback. */
    override fun updateFromNavigator(locator: Locator) {
        if (!closed) readiumLocator = locator
    }

    override fun toReaderLocator(locator: Locator): ReaderLocator.Epub = toReaderLocatorInternal(locator)

    override fun toReadiumLocator(locator: ReaderLocator.Epub): Locator {
        require(locator.entityId == document.entityId) { "The EPUB locator belongs to another document" }
        val stored = locator.cfi?.let { encoded ->
            runCatching { Locator.fromJSON(JSONObject(encoded)) }.getOrNull()
        }
        if (stored != null && belongsToPublication(stored)) return stored

        val index = chapterIndexFor(locator)
        val base = publication.locatorFromLink(readingOrder[index])
            ?: error("The EPUB spine link has no locator")
        val last = (readingOrder.size - 1).coerceAtLeast(1)
        val localProgression = (locator.progression * last - index).coerceIn(0.0, 1.0)
        return base.copyWithLocations(
            progression = localProgression,
            totalProgression = locator.progression.coerceIn(0.0, 1.0),
        )
    }

    override fun chapterIndexFor(locator: ReaderLocator.Epub): Int {
        val last = (readingOrder.size - 1).coerceAtLeast(0)
        val stored = locator.cfi?.let { encoded ->
            runCatching { Locator.fromJSON(JSONObject(encoded)) }.getOrNull()
        }
        val href = stored?.href?.toString()?.substringBefore('#')
        val byHref = href?.let { target ->
            readingOrder.indexOfFirst { link ->
                publication.url(link).toString().substringBefore('#') == target ||
                    link.href.toString().substringBefore('#') == target
            }
        } ?: -1
        if (byHref >= 0) return byHref
        val legacy = locator.cfi
            ?.substringAfter("aethon-spine:")
            ?.substringBefore(':')
            ?.toIntOrNull()
        return (legacy ?: BookChapterMetrics.epubChapterIndex(locator.progression, readingOrder.size))
            .coerceIn(0, last)
    }

    override suspend fun tableOfContents(): List<ReaderTocEntry<ReaderLocator.Epub>> {
        ensureOpen()
        fun convert(link: Link): ReaderTocEntry<ReaderLocator.Epub> =
            ReaderTocEntry(
                title = link.title?.ifBlank { "Untitled section" } ?: "Untitled section",
                locator = toReaderLocator(publication.locatorFromLink(link) ?: error("EPUB TOC link has no locator")),
                children = link.children.map(::convert),
            )
        return publication.tableOfContents.map(::convert)
    }

    override suspend fun search(query: String): List<ReaderSearchResult<ReaderLocator.Epub>> {
        ensureOpen()
        val normalized = query.trim()
        if (normalized.isEmpty()) return emptyList()
        return readingOrder.mapIndexedNotNull { index, link ->
            val text = chapterText(index)
            if (!text.contains(normalized, ignoreCase = true)) return@mapIndexedNotNull null
            ReaderSearchResult(
                locator = toReaderLocator(publication.locatorFromLink(link) ?: return@mapIndexedNotNull null),
                excerpt = text.excerptAround(normalized),
            )
        }
    }

    override suspend fun extractText(range: ReaderRange<ReaderLocator.Epub>): String {
        ensureOpen()
        require(range.start.entityId == document.entityId && range.end.entityId == document.entityId) {
            "The EPUB range belongs to another document"
        }
        val start = chapterIndexFor(range.start)
        val end = chapterIndexFor(range.end)
        require(start <= end) { "The EPUB range must be ordered" }
        return buildString {
            for (index in start..end) {
                if (isNotEmpty()) append('\n')
                append(chapterText(index))
            }
        }
    }

    override suspend fun renderHighlights(highlights: List<ReaderHighlight<ReaderLocator.Epub>>) {
        ensureOpen()
        highlights.forEach { highlight ->
            require(highlight.range.start.entityId == document.entityId)
            require(highlight.range.end.entityId == document.entityId)
        }
        this.highlights = highlights.toList()
    }

    fun currentHighlights(): List<ReaderHighlight<ReaderLocator.Epub>> = highlights

    override fun close() {
        if (closed) return
        closed = true
        highlights = emptyList()
        publication.close()
    }

    private fun toReaderLocatorInternal(locator: Locator): ReaderLocator.Epub {
        val progression = locator.locations.totalProgression
            ?: run {
                val index = chapterIndexForHref(locator.href.toString()).coerceAtLeast(0)
                val local = locator.locations.progression ?: 0.0
                val last = (readingOrder.size - 1).coerceAtLeast(1)
                ((index + local) / last).coerceIn(0.0, 1.0)
            }
        val json = locator.toJSON().toString()
        // ReaderLocator validates this field at 4096 characters. A locator produced by Readium
        // is normally far smaller; reject an unexpectedly huge context rather than persisting a
        // truncated CFI that could not be restored safely.
        require(json.length <= 4096) { "Readium locator is too large to persist" }
        return ReaderLocator.Epub(document.entityId, cfi = json, progression = progression.coerceIn(0.0, 1.0))
    }

    private fun chapterIndexForHref(href: String): Int {
        val target = href.substringBefore('#')
        return readingOrder.indexOfFirst { link ->
            publication.url(link).toString().substringBefore('#') == target ||
                link.href.toString().substringBefore('#') == target
        }
    }

    private fun belongsToPublication(locator: Locator): Boolean =
        chapterIndexForHref(locator.href.toString()) >= 0

    private suspend fun chapterText(index: Int): String {
        val link = readingOrder.getOrNull(index) ?: error("The EPUB chapter is outside the spine")
        val resource = publication.get(link) ?: return ""
        val length = resource.length().getOrNull() ?: return ""
        if (length <= 0L) return ""
        val bytes = resource.read(0L..(length - 1L)).getOrNull() ?: return ""
        val sanitized = NovelHtmlSanitizer.sanitize(bytes.toString(Charsets.UTF_8))
        return Jsoup.parseBodyFragment(sanitized).text().replace(Regex("\\s+"), " ").trim()
    }

    private fun ensureOpen() {
        check(!closed) { "The EPUB reader is closed" }
    }

    private fun String.excerptAround(query: String): String {
        val index = indexOf(query, ignoreCase = true).coerceAtLeast(0)
        val start = (index - 120).coerceAtLeast(0)
        val end = (index + query.length + 120).coerceAtMost(length)
        return substring(start, end).trim()
    }
}

/** UI-facing capability for mounting the only EPUB renderer. */
@OptIn(ExperimentalReadiumApi::class)
interface EpubNavigatorSession {
    val navigator: EpubNavigatorFactory
    val spineSize: Int
    fun toReaderLocator(locator: Locator): ReaderLocator.Epub
    fun toReadiumLocator(locator: ReaderLocator.Epub): Locator
    fun chapterIndexFor(locator: ReaderLocator.Epub): Int
    fun updateFromNavigator(locator: Locator)
}
