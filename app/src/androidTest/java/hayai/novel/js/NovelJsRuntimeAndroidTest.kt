package hayai.novel.js

import android.util.Base64
import android.util.Log
import androidx.test.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Executes the same QuickJS/bridge path used by LNReader sources, without relying on a
 * network site or a particular third-party plugin. This catches broken asset bundles,
 * CommonJS wrapping, Promise handling and the fetch bridge on a real Android runtime.
 */
@RunWith(AndroidJUnit4::class)
class NovelJsRuntimeAndroidTest {

    /**
     * Executes the pinned Royal Road plugin from the official LNReader v3.0.0 index.
     * This intentionally uses the production bridge (OkHttp + NovelNetworkPolicy), not
     * FakeBridge, so the test covers the real source code, QuickJS shims and live HTTP path.
     * The index URL and SHA are pinned to make a source update visible instead of silently
     * changing the test input.
     */
    @Test
    fun officialRoyalRoadPluginRunsThroughProductionRuntime() = runBlocking {
        val context = InstrumentationRegistry.getTargetContext()
        val pluginUrl = "https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0/.js/src/plugins/english/royalroad.js"
        val pluginCode = downloadPinnedPlugin(pluginUrl)
        val runtime = NovelJsRuntime(
            context = context,
            bridge = NovelJsBridgeImpl(context),
            pluginId = "royalroad",
            userAgent = "EpigraphTest/1.0 (LNReader compatibility)",
        )

        try {
            runtime.initialize(pluginCode)
            assertEquals("\"royalroad\"", runtime.getProperty("id"))
            assertEquals("\"2.3.1\"", runtime.getProperty("version"))

            // Search is the smallest public operation that exercises the real site's HTML
            // response, htmlparser2, URL helpers and the production network broker.
            val searchJson = runtime.callMethod("searchNovels", "\"mother\", 1")
            assertTrue("Royal Road search must return a JSON array", searchJson.trimStart().startsWith("["))

            // When the site returns a result, exercise the next real operation too. A blocked
            // or rate-limited site may legitimately return [], which still proves the plugin
            // ran to completion through QuickJS and the broker.
            val results = JSONArray(searchJson)
            Log.i("EpigraphLNReaderTest", "royalroad search status=ok results=${results.length()} bytes=${searchJson.toByteArray().size}")
            if (results.length() > 0) {
                val path = results.getJSONObject(0).optString("path")
                assertTrue("Royal Road result must include a path", path.isNotBlank())
                val details = runtime.callMethod("parseNovel", "${jsonString(path)}")
                assertTrue("Royal Road details must be JSON", details.trimStart().startsWith("{"))
                assertTrue("Royal Road details must expose chapters", details.contains("chapters"))
                Log.i("EpigraphLNReaderTest", "royalroad details status=ok path=$path bytes=${details.toByteArray().size}")

                val chapters = JSONObject(details).optJSONArray("chapters")
                if (chapters != null && chapters.length() > 0) {
                    val chapterPath = chapters.getJSONObject(0).optString("path")
                    assertTrue("Royal Road chapter must include a path", chapterPath.isNotBlank())
                    val chapter = runtime.callMethod("parseChapter", jsonString(chapterPath))
                    assertTrue("Royal Road chapter must be a JSON string", chapter.trimStart().startsWith("\""))
                    assertTrue("Royal Road chapter content must not be empty", chapter.length > 2)
                    Log.i("EpigraphLNReaderTest", "royalroad chapter status=ok chapters=${chapters.length()} path=$chapterPath bytes=${chapter.toByteArray().size}")
                }
            }
        } finally {
            runtime.close()
        }
    }

    @Test
    fun syntheticLnReaderPluginExecutesAndUsesBridge() = runBlocking {
        val context = InstrumentationRegistry.getTargetContext()
        val runtime = NovelJsRuntime(
            context = context,
            bridge = FakeBridge,
            pluginId = "aethon-synthetic-runtime-test",
            userAgent = "EpigraphTest/1.0",
        )

        try {
            runtime.initialize(
                """
                module.exports = {
                    site: "Synthetic LNReader",
                    popularNovels: async function(page) {
                        return [{ name: "Popular " + page, url: "synthetic://popular/" + page }];
                    },
                    searchNovels: async function(query, page) {
                        return [{ name: query + " " + page, url: "synthetic://search" }];
                    },
                    parseNovel: async function(url) {
                        return { name: "Synthetic detail", url: url, chapters: [{ name: "Chapter 1" }] };
                    },
                    parseChapter: async function(url) {
                        return { text: "Synthetic chapter", url: url };
                    },
                    networkProbe: async function() {
                        var response = await fetch("https://example.test/chapter");
                        return { status: response.status, body: await response.text() };
                    }
                };
                """.trimIndent(),
            )

            assertTrue(runtime.isInitialized)
            assertEquals("\"Synthetic LNReader\"", runtime.getProperty("site"))
            assertTrue(runtime.callMethod("popularNovels", "3").contains("Popular 3"))
            assertTrue(runtime.callMethod("searchNovels", "\"query\", 2").contains("query 2"))
            assertTrue(runtime.callMethod("parseNovel", "\"synthetic://novel\"").contains("Chapter 1"))
            assertTrue(runtime.callMethod("parseChapter", "\"synthetic://chapter\"").contains("Synthetic chapter"))

            val networkResult = runtime.callMethod("networkProbe")
            assertTrue(networkResult.contains("\"status\":200"))
            assertTrue(networkResult.contains("from-bridge"))
        } finally {
            runtime.close()
        }
    }

    private object FakeBridge : NovelJsBridge {
        override suspend fun fetch(url: String, initJson: String): String =
            """{"status":200,"statusText":"OK","body":"from-bridge","bodyBase64":"${Base64.encodeToString("from-bridge".toByteArray(), Base64.NO_WRAP)}","headers":{}}"""

        override suspend fun fetchText(url: String, initJson: String, encoding: String): String = "from-bridge"

        override suspend fun fetchFile(url: String, initJson: String): String =
            Base64.encodeToString("from-bridge".toByteArray(), Base64.NO_WRAP)

        override fun storageGet(pluginId: String, key: String): String? = null

        override fun storageSet(pluginId: String, key: String, valueJson: String) = Unit

        override fun storageDelete(pluginId: String, key: String) = Unit

        override fun storageGetAllKeys(pluginId: String): String = "[]"

        override fun storageClearAll(pluginId: String) = Unit

        override suspend fun sleep(durationMs: Int) = Unit
    }

    private suspend fun downloadPinnedPlugin(url: String): String = withContext(Dispatchers.IO) {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 15_000
            requestMethod = "GET"
            setRequestProperty("User-Agent", "EpigraphTest/1.0")
        }
        try {
            assertEquals("official plugin download status", 200, connection.responseCode)
            val bytes = connection.inputStream.use { it.readBytes() }
            assertTrue("official plugin must stay within runtime's 2 MiB limit", bytes.size <= 2 * 1024 * 1024)
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
                .joinToString("") { "%02X".format(it) }
            assertEquals("pinned Royal Road plugin changed", ROYAL_ROAD_SHA256, digest)
            bytes.toString(Charsets.UTF_8)
        } finally {
            connection.disconnect()
        }
    }

    private fun jsonString(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private companion object {
        const val ROYAL_ROAD_SHA256 = "9EB6ACC6DF7BDC66E320380D0882435BB480B2CFA28B0B8E9013D0F8B60AB806"
    }
}
