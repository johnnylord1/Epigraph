package epigraph.sync.core.http

import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.protocol.CoreExtensionInventory
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Test

class CoreExtensionInventoryHttpTest {
    @Test
    fun `extension inventory is authenticated and profile scoped`() = runTest {
        val client = EpigraphCoreHttpClient(
            client = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
                val request = chain.request()
                assertEquals("/v1/suwayomi/extensions", request.url.encodedPath)
                assertEquals("comics:profile:profile-a", request.url.queryParameter("scopeId"))
                assertEquals("Bearer token", request.header(EpigraphCoreWireProtocol.AUTHORIZATION_HEADER))
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("ok")
                    .body(INVENTORY.toResponseBody(JSON))
                    .build()
            }).build(),
            baseUrl = "https://core.local/".toHttpUrl(),
            clientVersion = "0.1.0",
            json = Json { ignoreUnknownKeys = true },
            preserveInterceptorsForTests = true,
        )

        val result = client.suwayomiExtensions("token", "profile-a")

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val inventory = (result as CoreHttpResult.Success<CoreExtensionInventory>).value
        assertEquals("server-a", inventory.serverId)
        assertEquals("pkg.example", inventory.extensions.single().packageName)
        assertEquals(
            "https://repo.example/extensions/",
            inventory.extensions.single().legacyRepositoryIndexUrl,
        )
        assertEquals(listOf("10", "11"), inventory.extensions.single().sources.map { it.id })
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
        val INVENTORY = """
            {
              "schemaVersion": 1,
              "serverId": "server-a",
              "profileId": "profile-a",
              "runtimeFingerprint": "runtime-hash",
              "generatedAtMs": 123,
              "extensions": [{
                "packageName": "pkg.example",
                "displayName": "Example",
                "versionCode": "1",
                "versionName": "1.0",
                "legacyRepositoryIndexUrl": "https://repo.example/extensions/",
                "sources": [
                  {"id": 10, "name": "One", "lang": "en"},
                  {"id": 11, "name": "Two", "lang": "en"}
                ]
              }]
            }
        """.trimIndent()
    }
}
