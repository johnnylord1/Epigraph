package epigraph.books.pdf

/**
 * Rebuilds paragraphs from the line-broken text Pdfium extracts for one page.
 *
 * The desktop reflows from pdf.js positions (line gaps and font sizes). Pdfium only gives the
 * text here, so paragraph ends are inferred from the lines themselves: a blank line, or a line
 * that stops clearly short of the page's text width and is followed by what reads as a new
 * paragraph or heading. Everything else is joined so the text wraps to the screen, not to the
 * printed page.
 */
object PdfTextReflow {

    /** A line shorter than this share of the page's longest line may end a paragraph. */
    private const val SHORT_LINE_RATIO = 0.8

    private val bullet = Regex("""^([-•●▪–—*]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s""")

    fun paragraphs(text: String): List<String> {
        val lines = text
            .replace("\r\n", "\n")
            .replace('\r', '\n')
            .split('\n')
            .map { it.replace(Regex("""[\t  ]+"""), " ").trim() }
        val longest = lines.maxOfOrNull { it.length } ?: 0
        if (longest == 0) return emptyList()

        val paragraphs = mutableListOf<String>()
        val current = StringBuilder()
        fun flush() {
            if (current.isNotBlank()) paragraphs += current.toString().trim()
            current.clear()
        }

        lines.forEachIndexed { index, line ->
            if (line.isEmpty()) {
                flush()
                return@forEachIndexed
            }
            if (current.isNotEmpty() && bullet.containsMatchIn(line)) flush()
            append(current, line)
            val next = lines.getOrNull(index + 1).orEmpty()
            if (next.isNotEmpty() && endsParagraph(line, next, longest)) flush()
        }
        flush()
        return paragraphs
    }

    private fun endsParagraph(line: String, next: String, longest: Int): Boolean {
        val short = line.length < longest * SHORT_LINE_RATIO
        if (!short) return false
        val first = next.first()
        return line.last() in ".!?:;\"”’)]…" || first.isUpperCase() || first.isDigit() || !first.isLetter()
    }

    private fun append(target: StringBuilder, line: String) {
        if (target.isEmpty()) {
            target.append(line)
            return
        }
        val last = target.last()
        // A soft hyphen at a line end splits one word ("recon-" + "struct"); keep real
        // compounds whose next part is capitalized ("Anglo-" + "Saxon").
        if (last == '-' && target.length > 1 && target[target.length - 2].isLetter() && line.first().isLowerCase()) {
            target.setLength(target.length - 1)
            target.append(line)
        } else {
            target.append(' ').append(line)
        }
    }
}
