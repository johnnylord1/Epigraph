package epigraph.library

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import androidx.core.content.res.ResourcesCompat
import coil3.asDrawable
import coil3.imageLoader
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.size.Scale
import epigraph.books.local.LocalBook
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.domain.manga.models.Manga
import java.io.File
import java.net.URI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import yokai.domain.manga.models.cover

/**
 * What the library Share action produces from the selected works: a list of titles linked to
 * their pages, and the Epigraph share card with their covers and names.
 *
 * Epigraph Desktop builds the same list in `src/lib/library/sharePayload.ts` and draws the same
 * card in `src/lib/library/shareImage.ts`; keep the two in step when changing a value here.
 *
 * The list uses chat markdown that Discord renders: `- [Title](<url>)`. The angle brackets keep
 * Discord from adding a large preview for every link; the card already shows the works.
 */
data class LibraryShareWork(
    val title: String,
    /** The work's page at its source. Anything other than an http(s) address is left out. */
    val url: String? = null,
)

data class LibraryShareCollageLayout(
    val columns: Int,
    val rows: Int,
    /** Works drawn with their cover. */
    val covers: Int,
    /** Works left out of the image; the last cell says how many when this is above zero. */
    val overflow: Int,
)

object LibraryShareText {
    /** The image stays readable in a chat preview; the list always carries every work. */
    const val MAX_CELLS = 40
    private const val MAX_COLUMNS = 8

    /** A cell is a 2:3 cover plus two lines of title. */
    private const val CELL_ASPECT = 1.0 / 1.78

    /** Chat previews show a landscape image best. */
    private const val TARGET_IMAGE_ASPECT = 1.3
    private val whitespace = Regex("\\s+")
    private val markdown = Regex("""([\\\[\]*_~`|<>])""")

    fun shareableUrl(url: String?): String? {
        val value = url?.trim().orEmpty()
        if (value.isEmpty()) return null
        return try {
            val uri = URI(value.replace(" ", "%20"))
            val scheme = uri.scheme?.lowercase()
            if ((scheme == "http" || scheme == "https") && !uri.host.isNullOrEmpty()) uri.toASCIIString() else null
        } catch (_: Exception) {
            null
        }
    }

    private fun cleanTitle(title: String) = title.replace(whitespace, " ").trim()

    /** Escapes what would end a markdown link label early or format the title. */
    fun escapeTitle(title: String): String = cleanTitle(title).replace(markdown, "\\\\$1")

    fun buildText(works: List<LibraryShareWork>): String =
        works
            .filter { cleanTitle(it.title).isNotEmpty() }
            .joinToString("\n") { work ->
                val title = escapeTitle(work.title)
                val url = shareableUrl(work.url)
                if (url != null) "- [$title](<$url>)" else "- $title"
            }

    fun collageLayout(count: Int, maxCells: Int = MAX_CELLS): LibraryShareCollageLayout {
        val total = max(0, count)
        if (total == 0) return LibraryShareCollageLayout(0, 0, 0, 0)
        val cells = min(total, max(1, maxCells))
        val covers = if (total > cells) cells - 1 else cells
        val overflow = total - covers

        var bestColumns = 1
        var bestRows = cells
        var bestScore = Double.POSITIVE_INFINITY
        for (columns in 1..min(cells, MAX_COLUMNS)) {
            val rows = ceil(cells / columns.toDouble()).toInt()
            val empty = rows * columns - cells
            val aspect = columns * CELL_ASPECT / rows
            val score = abs(ln(aspect / TARGET_IMAGE_ASPECT)) + empty * 0.35
            if (score < bestScore) {
                bestColumns = columns
                bestRows = rows
                bestScore = score
            }
        }
        return LibraryShareCollageLayout(bestColumns, bestRows, covers, overflow)
    }

    /** Cuts [text] to [width], ending it with an ellipsis when it does not fit. */
    fun fitLine(text: String, width: Float, measure: (String) -> Float): String {
        if (measure(text) <= width) return text
        var end = text.length
        while (end > 0 && measure(text.substring(0, end).trimEnd() + "…") > width) end -= 1
        return text.substring(0, end).trimEnd() + "…"
    }

    /** Breaks the title into at most [maxLines] lines, ending the last one with an ellipsis when it is cut. */
    fun wrapTitle(title: String, width: Float, maxLines: Int, measure: (String) -> Float): List<String> {
        val words = cleanTitle(title).split(" ").filter { it.isNotEmpty() }
        val lines = mutableListOf<MutableList<String>>()
        for (word in words) {
            val current = lines.lastOrNull()
            if (current != null && measure((current + word).joinToString(" ")) <= width) {
                current += word
            } else {
                lines += mutableListOf(word)
            }
        }
        val kept = lines.take(maxLines - 1).map { it.joinToString(" ") }.toMutableList()
        val rest = lines.drop(maxLines - 1).flatten().joinToString(" ")
        if (rest.isNotEmpty()) kept += rest
        return kept.map { fitLine(it, width, measure) }
    }
}

/** A work on the card: its title and its cover, or null for a placeholder. */
class LibraryShareCardWork(val title: String, val cover: Bitmap?)

/**
 * The Epigraph share card. Sizes are in card units: the card is drawn at 1x to 2x of them so a
 * small selection is still sharp in a chat preview. The palette is the Nocturne theme, the mark
 * is the app's drop (`epigraph_splash_mark.png`, the same file in both apps) and the type is
 * Outfit, bundled in both apps.
 */
object LibraryShareCard {
    const val PADDING = 40f
    const val HEADER_HEIGHT = 84f
    const val MARK_HEIGHT = 40f
    const val MARK_GAP = 14f
    const val DIVIDER_Y = 62f
    const val CELL_WIDTH = 200f
    const val COVER_HEIGHT = 300f
    const val TITLE_GAP = 12f
    const val TITLE_LINE = 21f
    const val TITLE_LINES = 2
    const val GAP_X = 24f
    const val GAP_Y = 28f
    const val RADIUS = 12f
    const val MIN_CONTENT_WIDTH = 440f
    const val MIN_IMAGE_WIDTH = 960f
    const val MAX_SCALE = 2f
    private const val CELL_HEIGHT = COVER_HEIGHT + TITLE_GAP + TITLE_LINE * TITLE_LINES
    private const val COVER_LOAD_CONCURRENCY = 6
    private const val COVER_LOAD_TIMEOUT_MS = 4_000L

    private const val WORDMARK_SIZE = 30f
    private const val COUNT_SIZE = 16f
    private const val TITLE_SIZE = 15f
    private const val MORE_SIZE = 28f
    private const val INITIAL_SIZE = 72f

    private val BACKGROUND = Color.rgb(0x0b, 0x0a, 0x0e)
    private val GLOW = Color.argb(51, 159, 142, 217)
    private val GLOW_FAINT = Color.argb(18, 159, 142, 217)
    private val GLOW_END = Color.argb(0, 159, 142, 217)
    private val DIVIDER = Color.argb(41, 180, 166, 227)
    private val COVER_EDGE = Color.argb(18, 255, 255, 255)
    private val PLACEHOLDER = Color.rgb(0x1a, 0x18, 0x20)
    private val PLACEHOLDER_INK = Color.rgb(0x4f, 0x4a, 0x5a)
    private val MORE_FILL = Color.argb(31, 159, 142, 217)
    private val ACCENT = Color.rgb(0xb4, 0xa6, 0xe3)
    private val TITLE = Color.rgb(0xe9, 0xe7, 0xed)
    private val MUTED = Color.rgb(0x89, 0x83, 0x8f)

    /** The visible part of the 1024x1024 mark image. */
    private val MARK_SOURCE = Rect(330, 214, 330 + 364, 214 + 579)

    /** Loads the covers the card draws, scaled for it; a cover that fails to load is null. */
    suspend fun loadCovers(context: Context, mangas: List<Manga>): List<Bitmap?> = coroutineScope {
        val permits = Semaphore(COVER_LOAD_CONCURRENCY)
        val width = (CELL_WIDTH * MAX_SCALE).roundToInt()
        val height = (COVER_HEIGHT * MAX_SCALE).roundToInt()
        mangas.map { manga ->
            async {
                if (manga.thumbnail_url.isNullOrBlank()) return@async null
                permits.withPermit {
                    withTimeoutOrNull(COVER_LOAD_TIMEOUT_MS) {
                        runCatching {
                            val request = ImageRequest.Builder(context)
                                .data(manga.cover())
                                .size(width, height)
                                .scale(Scale.FILL)
                                // The card is drawn on a software canvas, which cannot read hardware bitmaps.
                                .allowHardware(false)
                                .build()
                            val image = context.imageLoader.execute(request).image
                            (image?.asDrawable(context.resources) as? BitmapDrawable)?.bitmap
                        }.getOrNull()
                    }
                }
            }
        }.awaitAll()
    }

    /** Loads on-disk covers for local EPUB/PDF books, scaled for the share card. */
    suspend fun loadBookCovers(
        context: Context,
        books: List<LocalBook>,
        materializeCover: (LocalBook) -> File?,
    ): List<Bitmap?> = coroutineScope {
        val permits = Semaphore(COVER_LOAD_CONCURRENCY)
        val width = (CELL_WIDTH * MAX_SCALE).roundToInt()
        val height = (COVER_HEIGHT * MAX_SCALE).roundToInt()
        books.map { book ->
            async {
                permits.withPermit {
                    withTimeoutOrNull(COVER_LOAD_TIMEOUT_MS) {
                        val coverFile = book.coverPath?.let(::File)?.takeIf(File::isFile)
                            ?: materializeCover(book)
                            ?: return@withTimeoutOrNull null
                        runCatching {
                            val request = ImageRequest.Builder(context)
                                .data(coverFile)
                                .size(width, height)
                                .scale(Scale.FILL)
                                .allowHardware(false)
                                .build()
                            val image = context.imageLoader.execute(request).image
                            (image?.asDrawable(context.resources) as? BitmapDrawable)?.bitmap
                        }.getOrNull()
                    }
                }
            }
        }.awaitAll()
    }

    /** Draws the card: the brand header, then the covers and names of the works. */
    fun render(
        context: Context,
        works: List<LibraryShareCardWork>,
        countLabel: String,
        moreLabel: (Int) -> String,
    ): Bitmap {
        val layout = LibraryShareText.collageLayout(works.size)
        require(layout.covers > 0 || layout.overflow > 0) { "Nothing to draw" }

        val gridWidth = layout.columns * CELL_WIDTH + (layout.columns - 1) * GAP_X
        val gridHeight = layout.rows * CELL_HEIGHT + (layout.rows - 1) * GAP_Y
        val baseWidth = PADDING * 2 + max(gridWidth, MIN_CONTENT_WIDTH)
        val baseHeight = PADDING * 2 + HEADER_HEIGHT + gridHeight
        val scale = min(MAX_SCALE, max(1f, MIN_IMAGE_WIDTH / baseWidth))
        val bitmap = Bitmap.createBitmap(
            (baseWidth * scale).roundToInt(),
            (baseHeight * scale).roundToInt(),
            Bitmap.Config.ARGB_8888,
        )
        val canvas = Canvas(bitmap)
        canvas.scale(scale, scale)

        val medium = font(context, R.font.outfit_medium, Typeface.NORMAL)
        val semibold = font(context, R.font.outfit_semibold, Typeface.BOLD)

        drawBackground(canvas, baseWidth, baseHeight)
        drawHeader(context, canvas, baseWidth, countLabel, medium, semibold)

        val gridX = (baseWidth - gridWidth) / 2
        val gridY = PADDING + HEADER_HEIGHT
        fun cellX(cell: Int) = gridX + (cell % layout.columns) * (CELL_WIDTH + GAP_X)
        fun cellY(cell: Int) = gridY + (cell / layout.columns) * (CELL_HEIGHT + GAP_Y)

        val fill = Paint(Paint.ANTI_ALIAS_FLAG)
        val imagePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 1f
            color = COVER_EDGE
        }
        val titlePaint = textPaint(medium, TITLE_SIZE, TITLE)
        val initialPaint = textPaint(semibold, INITIAL_SIZE, PLACEHOLDER_INK).apply { textAlign = Paint.Align.CENTER }
        val clip = Path()

        for (cell in 0 until layout.covers) {
            val work = works[cell]
            val x = cellX(cell)
            val y = cellY(cell)
            val bounds = RectF(x, y, x + CELL_WIDTH, y + COVER_HEIGHT)
            canvas.save()
            clip.reset()
            clip.addRoundRect(bounds, RADIUS, RADIUS, Path.Direction.CW)
            canvas.clipPath(clip)
            fill.color = PLACEHOLDER
            canvas.drawRect(bounds, fill)
            val cover = work.cover
            if (cover != null && cover.width > 0 && cover.height > 0) {
                canvas.drawBitmap(cover, centerCrop(cover), bounds, imagePaint)
            } else {
                val initial = work.title.trim().takeIf { it.isNotEmpty() }
                    ?.let { String(Character.toChars(it.codePointAt(0))).uppercase() } ?: "?"
                canvas.drawText(initial, x + CELL_WIDTH / 2, middleBaseline(initialPaint, y + COVER_HEIGHT / 2), initialPaint)
            }
            canvas.restore()
            canvas.drawRoundRect(RectF(x + 0.5f, y + 0.5f, x + CELL_WIDTH - 0.5f, y + COVER_HEIGHT - 0.5f), RADIUS, RADIUS, edge)

            val ascent = -titlePaint.fontMetrics.ascent
            LibraryShareText.wrapTitle(work.title, CELL_WIDTH, TITLE_LINES, titlePaint::measureText)
                .forEachIndexed { line, text ->
                    canvas.drawText(text, x, y + COVER_HEIGHT + TITLE_GAP + line * TITLE_LINE + ascent, titlePaint)
                }
        }

        if (layout.overflow > 0) {
            val x = cellX(layout.covers)
            val y = cellY(layout.covers)
            fill.color = MORE_FILL
            canvas.drawRoundRect(RectF(x, y, x + CELL_WIDTH, y + COVER_HEIGHT), RADIUS, RADIUS, fill)
            val morePaint = textPaint(semibold, MORE_SIZE, ACCENT).apply { textAlign = Paint.Align.CENTER }
            val text = LibraryShareText.fitLine(moreLabel(layout.overflow), CELL_WIDTH - 24, morePaint::measureText)
            canvas.drawText(text, x + CELL_WIDTH / 2, middleBaseline(morePaint, y + COVER_HEIGHT / 2), morePaint)
        }
        return bitmap
    }

    /** Encodes [bitmap] as PNG bytes, optionally embedding an `epigraph-share` tEXt chunk. */
    fun encodePngBytes(bitmap: Bitmap, inlineShareToken: String? = null): ByteArray {
        val raw = java.io.ByteArrayOutputStream().use { out ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) { "Image encoding failed" }
            out.toByteArray()
        }
        return if (inlineShareToken != null) {
            LibraryShareLink.embedShareTokenInPng(raw, inlineShareToken)
        } else {
            raw
        }
    }

    /** Writes PNG bytes to the app cache, replacing the previous one, so a share sheet can read it. */
    fun writePngBytes(context: Context, pngBytes: ByteArray): File {
        val directory = File(context.cacheDir, "shared_image").apply { mkdirs() }
        val target = File(directory, "epigraph-library.png")
        val temporary = File(directory, "epigraph-library.png.tmp")
        temporary.writeBytes(pngBytes)
        if (!temporary.renameTo(target)) {
            temporary.copyTo(target, overwrite = true)
            temporary.delete()
        }
        return target
    }

    /** Writes the card to the app cache, replacing the previous one, so a share sheet can read it. */
    fun writePng(context: Context, bitmap: Bitmap): File =
        writePngBytes(context, encodePngBytes(bitmap))

    private fun font(context: Context, id: Int, fallbackStyle: Int): Typeface =
        runCatching { ResourcesCompat.getFont(context, id) }.getOrNull()
            ?: Typeface.create(Typeface.SANS_SERIF, fallbackStyle)

    private fun textPaint(typeface: Typeface, size: Float, color: Int) =
        Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
            this.typeface = typeface
            textSize = size
            this.color = color
        }

    /** The baseline that centers the text vertically on [center]. */
    private fun middleBaseline(paint: Paint, center: Float): Float {
        val metrics = paint.fontMetrics
        return center - (metrics.ascent + metrics.descent) / 2
    }

    /** The part of the cover that fills a cell, cropped from its center like the library cards. */
    private fun centerCrop(cover: Bitmap): Rect {
        val scale = max(CELL_WIDTH / cover.width, COVER_HEIGHT / cover.height)
        val width = (CELL_WIDTH / scale).roundToInt().coerceIn(1, cover.width)
        val height = (COVER_HEIGHT / scale).roundToInt().coerceIn(1, cover.height)
        val left = (cover.width - width) / 2
        val top = (cover.height - height) / 2
        return Rect(left, top, left + width, top + height)
    }

    private fun drawBackground(canvas: Canvas, width: Float, height: Float) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = BACKGROUND
        canvas.drawRect(0f, 0f, width, height, paint)
        val reach = max(width, height)
        paint.shader = RadialGradient(width * 0.12f, 0f, reach * 0.85f, GLOW, GLOW_END, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, width, height, paint)
        paint.shader = RadialGradient(width, height, reach * 0.6f, GLOW_FAINT, GLOW_END, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, width, height, paint)
    }

    private fun drawHeader(
        context: Context,
        canvas: Canvas,
        width: Float,
        countLabel: String,
        medium: Typeface,
        semibold: Typeface,
    ) {
        val rowCenter = PADDING + MARK_HEIGHT / 2
        var textX = PADDING
        val mark = runCatching {
            BitmapFactory.decodeResource(
                context.resources,
                R.drawable.epigraph_splash_mark,
                BitmapFactory.Options().apply { inScaled = false },
            )
        }.getOrNull()
        if (mark != null && mark.width >= MARK_SOURCE.right && mark.height >= MARK_SOURCE.bottom) {
            val markWidth = MARK_SOURCE.width().toFloat() / MARK_SOURCE.height() * MARK_HEIGHT
            canvas.drawBitmap(
                mark,
                MARK_SOURCE,
                RectF(PADDING, PADDING, PADDING + markWidth, PADDING + MARK_HEIGHT),
                Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG),
            )
            textX += markWidth + MARK_GAP
        }
        mark?.recycle()

        val wordmark = textPaint(semibold, WORDMARK_SIZE, TITLE)
        canvas.drawText("Epigraph", textX, middleBaseline(wordmark, rowCenter), wordmark)
        val wordmarkEnd = textX + wordmark.measureText("Epigraph")

        val count = textPaint(medium, COUNT_SIZE, MUTED).apply { textAlign = Paint.Align.RIGHT }
        val countText = LibraryShareText.fitLine(countLabel, max(0f, width - PADDING - wordmarkEnd - 24), count::measureText)
        canvas.drawText(countText, width - PADDING, middleBaseline(count, rowCenter), count)

        val divider = Paint().apply { color = DIVIDER }
        canvas.drawRect(PADDING, PADDING + DIVIDER_Y, width - PADDING, PADDING + DIVIDER_Y + 1, divider)
    }
}
