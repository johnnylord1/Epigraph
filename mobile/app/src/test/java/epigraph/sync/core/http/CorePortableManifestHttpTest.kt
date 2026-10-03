package epigraph.sync.core.http

import epigraph.contract.PortableWorkRef
import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.protocol.CorePortableManifest
import epigraph.sync.core.protocol.CorePortableNovelManifest
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

class CorePortableManifestHttpTest {
    @Test
    fun `portable manifest preserves opaque provider keys and decimal source ids`() = runTest {
        val client = EpigraphCoreHttpClient(
            client = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
                val request = chain.request()
                assertEquals("/v1/portable/manifest", request.url.encodedPath)
                assertEquals("comics:profile:profile-a", request.url.queryParameter("scopeId"))
                assertEquals("100", request.url.queryParameter("pageSize"))
                assertEquals("0", request.url.queryParameter("offset"))
                assertEquals("Bearer token", request.header(EpigraphCoreWireProtocol.AUTHORIZATION_HEADER))
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("ok")
                    .body(MANIFEST.toResponseBody(JSON_MEDIA_TYPE))
                    .build()
            }).build(),
            baseUrl = "https://core.local/".toHttpUrl(),
            clientVersion = "0.1.0",
            json = Json { ignoreUnknownKeys = true },
            preserveInterceptorsForTests = true,
        )

        val result = client.portableManifest("token", "profile-a")

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val manifest = (result as CoreHttpResult.Success<CorePortableManifest>).value
        val ref = manifest.works.single().reference
        assertInstanceOf(PortableWorkRef.Comic::class.java, ref)
        assertEquals("-10002", ref.sourceId.value)
        assertEquals("/Manga/Keep-Case?view=AbC%2F123", ref.mangaKey.value)
        assertEquals(setOf("-10002"), manifest.comicDependencies.single().requiredSourceIds.map { it.value }.toSet())
        assertEquals("https://store.example/index.min.json", manifest.comicDependencies.single().extensionStore?.storeIndexUrl)
        assertEquals("snapshot-comics", manifest.snapshotId)
    }

    @Test
    fun `novel manifest preserves plugin identity and opaque novel path`() = runTest {
        val client = EpigraphCoreHttpClient(
            client = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
                val request = chain.request()
                assertEquals("/v1/portable/novel-manifest", request.url.encodedPath)
                assertEquals("novels:profile:profile-a", request.url.queryParameter("scopeId"))
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("ok")
                    .body(NOVEL_MANIFEST.toResponseBody(JSON_MEDIA_TYPE))
                    .build()
            }).build(),
            baseUrl = "https://core.local/".toHttpUrl(),
            clientVersion = "0.1.0",
            json = Json { ignoreUnknownKeys = true },
            preserveInterceptorsForTests = true,
        )

        val result = client.portableNovelManifest("token", "profile-a")

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val manifest = (result as CoreHttpResult.Success<CorePortableNovelManifest>).value
        val ref = manifest.works.single().reference
        assertEquals("lnreader.plugin", ref.pluginId)
        assertEquals("/Novel/Keep-Case?view=AbC%2F123", ref.novelKey.value)
        assertEquals("https://repo.example/.dist/plugins.min.json", manifest.novelDependencies.single().repository?.indexUrl)
        assertEquals("snapshot-novels", manifest.snapshotId)
    }

    @Test
    fun `unknown future manifest schema is a non retryable compatibility result`() = runTest {
        val client = EpigraphCoreHttpClient(
            client = OkHttpClient.Builder().addInterceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("ok")
                    .body(MANIFEST.replace("\"schemaVersion\": 3", "\"schemaVersion\": 4").toResponseBody(JSON_MEDIA_TYPE))
                    .build()
            }.build(),
            baseUrl = "https://core.local/".toHttpUrl(),
            clientVersion = "0.1.0",
            json = Json { ignoreUnknownKeys = true },
            preserveInterceptorsForTests = true,
        )

        val result = client.portableManifest("token", "profile-a")

        assertInstanceOf(CoreHttpResult.Failure::class.java, result)
        result as CoreHttpResult.Failure
        assertEquals(422, result.statusCode)
        assertEquals("CLIENT_RESPONSE_UNSUPPORTED", result.errorEnvelope?.error?.code)
        assertEquals(false, result.errorEnvelope?.error?.retryable)
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val MANIFEST = """
            {
              "schemaVersion": 3,
              "scopeId": "comics:profile:profile-a",
              "runtimeFingerprint": "runtime-hash",
              "generatedAtMs": 123,
              "snapshotId": "snapshot-comics",
              "snapshotFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "snapshotExpiresAtMs": 120123,
              "page": {"offset": 0, "pageSize": 100, "hasNextPage": false, "totalCount": 1},
              "comicDependencies": [{
                "pkgName": "eu.kanade.tachiyomi.extension.en.example",
                "requiredSourceIds": ["-10002"],
                "observedVersionCode": "7",
                "extensionStore": {
                  "storeIndexUrl": "https://store.example/index.min.json",
                  "displayNameHint": "Example"
                }
              }],
              "works": [{
                "portableId": "comic:0123456789abcdef",
                "reference": {
                  "type": "comic",
                  "sourceId": "-10002",
                  "mangaKey": "/Manga/Keep-Case?view=AbC%2F123"
                },
                "dependencyPackageName": "eu.kanade.tachiyomi.extension.en.example",
                "titleHint": "Hint only",
                "providerLabelHint": "Example"
              }]
            }
        """.trimIndent()
        val NOVEL_MANIFEST = """
            {
              "schemaVersion": 3,
              "scopeId": "novels:profile:profile-a",
              "manifestFingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              "generatedAtMs": 123,
              "snapshotId": "snapshot-novels",
              "snapshotFingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              "snapshotExpiresAtMs": 120123,
              "page": {"offset": 0, "pageSize": 100, "hasNextPage": false, "totalCount": 1},
              "novelDependencies": [{
                "pluginId": "lnreader.plugin",
                "observedVersion": "1.2.3",
                "repository": {"indexUrl": "https://repo.example/.dist/plugins.min.json"},
                "observedArtifactSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
              }],
              "works": [{
                "portableId": "novel:0123456789abcdef",
                "reference": {
                  "type": "novel",
                  "pluginId": "lnreader.plugin",
                  "novelKey": "/Novel/Keep-Case?view=AbC%2F123"
                },
                "dependencyPluginId": "lnreader.plugin",
                "titleHint": "Hint only"
              }]
            }
        """.trimIndent()
    }
}
