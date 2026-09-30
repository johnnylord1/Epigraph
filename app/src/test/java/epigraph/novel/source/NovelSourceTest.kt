package epigraph.novel.source

import android.content.Context
import epigraph.novel.js.NovelJsBridge
import io.mockk.mockk
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class NovelSourceTest {
    @Test
    fun `resolveUrl normalizes protocol relative cover urls`() {
        assertEquals("https://cdn.example/cover.jpg", source().resolveUrl("//cdn.example/cover.jpg"))
    }

    @Test
    fun `resolveUrl keeps absolute and resolves relative urls`() {
        val source = source()
        assertEquals("https://cdn.example/cover.jpg", source.resolveUrl("https://cdn.example/cover.jpg"))
        assertEquals("https://example.test/images/cover.jpg", source.resolveUrl("images/cover.jpg"))
    }

    private fun source(): NovelSource = NovelSource(
        pluginId = "fixture",
        pluginName = "Fixture",
        lang = "en",
        siteUrl = "https://example.test",
        pluginCodeProvider = { "" },
        iconUrl = null,
        iconFile = null,
        context = mockk<Context>(relaxed = true),
        bridge = object : NovelJsBridge {
            override suspend fun fetch(url: String, initJson: String) = ""
            override suspend fun fetchText(url: String, initJson: String, encoding: String) = ""
            override suspend fun fetchFile(url: String, initJson: String) = ""
            override fun storageGet(pluginId: String, key: String): String? = null
            override fun storageSet(pluginId: String, key: String, valueJson: String) = Unit
            override fun storageDelete(pluginId: String, key: String) = Unit
            override fun storageGetAllKeys(pluginId: String): String = "[]"
            override fun storageClearAll(pluginId: String) = Unit
            override suspend fun sleep(durationMs: Int) = Unit
        },
        userAgent = "EpigraphTest/1.0",
    )
}
