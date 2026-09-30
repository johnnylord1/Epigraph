package epigraph.books.pdf

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PdfTextReflowTest {

    @Test
    fun `wrapped body lines join into one paragraph and a short heading stays apart`() {
        val text = """
            Chapter One
            The quick brown fox jumps over the lazy dog while the
            reader keeps following the sentence across printed lines
            until it finally ends here.
            A new paragraph starts after the short closing line of the
            previous one.
        """.trimIndent()

        assertEquals(
            listOf(
                "Chapter One",
                "The quick brown fox jumps over the lazy dog while the reader keeps following " +
                    "the sentence across printed lines until it finally ends here.",
                "A new paragraph starts after the short closing line of the previous one.",
            ),
            PdfTextReflow.paragraphs(text),
        )
    }

    @Test
    fun `hyphenated line ends rejoin the word and blank lines split paragraphs`() {
        val text = "This line ends with a hyphen-\nated word inside one paragraph.\n\nSecond paragraph."

        assertEquals(
            listOf("This line ends with a hyphenated word inside one paragraph.", "Second paragraph."),
            PdfTextReflow.paragraphs(text),
        )
    }

    @Test
    fun `list items start their own paragraph`() {
        val text = "Steps to follow in order:\n1. Open the file\n2. Read the page\n- Close it"

        assertEquals(
            listOf("Steps to follow in order:", "1. Open the file", "2. Read the page", "- Close it"),
            PdfTextReflow.paragraphs(text),
        )
    }

    @Test
    fun `blank text has no paragraphs`() {
        assertEquals(emptyList<String>(), PdfTextReflow.paragraphs(" \n\r\n "))
    }
}
