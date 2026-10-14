package epigraph.novel.plugin

import epigraph.novel.plugin.model.NovelPluginIndex
import epigraph.novel.source.NovelSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class LibraryNovelPluginsTest {

    private fun plugin(id: String, lang: String, url: String = "https://example.org/$id.js") =
        NovelPluginIndex(id = id, name = id.replaceFirstChar(Char::uppercase), lang = lang, version = "1.0.0", url = url)

    @Test
    fun `restored novels ask for the plugins their source ids belong to`() {
        // LNReader names the language; the source id uses its code, like an installed plugin.
        val centralNovel = plugin("centralnovel", "Português")
        val kiniga = plugin("kiniga", "Português")
        val royalRoad = plugin("royalroad", "English")
        val unused = plugin("novelbin", "English")
        val library = setOf(
            NovelSource.sourceIdFor("centralnovel", "pt"),
            NovelSource.sourceIdFor("kiniga", "pt"),
            NovelSource.sourceIdFor("royalroad", "en"),
            // A comic source of the library.
            2499283573021220255L,
        )

        val needed = pluginsNeededByLibrary(library, installedIds = setOf("royalroad"), listOf(unused, royalRoad, kiniga, centralNovel))

        assertEquals(listOf("centralnovel", "kiniga"), needed.map { it.id })
    }

    @Test
    fun `a listing without a download address is left out`() {
        val library = setOf(NovelSource.sourceIdFor("illusia", "en"))

        assertEquals(emptyList<NovelPluginIndex>(), pluginsNeededByLibrary(library, emptySet(), listOf(plugin("illusia", "English", url = ""))))
    }
}
