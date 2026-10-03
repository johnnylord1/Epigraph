package epigraph.sync.core.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EpigraphCoreContractTest {
    private val json = Json { ignoreUnknownKeys = false }

    @Test
    fun `decodes current syncd capabilities without conflating domain protocol v2`() {
        val capabilities = json.decodeFromString<CoreCapabilities>(CAPABILITIES_JSON)

        assertEquals(1, capabilities.serverProtocolVersion)
        assertEquals(EpigraphCoreWireProtocol.CURRENT_VERSION, capabilities.serverProtocolVersion)
        assertFalse(capabilities.supportsSuwayomiCatalog)
        assertFalse(capabilities.supportsSuwayomiContent)
        assertFalse(capabilities.supportsSuwayomiExtensionInventory)
        assertEquals(CoreCompatibility.Compatible, EpigraphCoreCompatibilityEvaluator.evaluate(capabilities))
    }

    @Test
    fun `decodes independently advertised Suwayomi bridge capabilities`() {
        val capabilities = json.decodeFromString<CoreCapabilities>(CAPABILITIES_JSON)
            .copy(
                supportsSuwayomiCatalog = true,
                supportsSuwayomiContent = true,
                supportsSuwayomiExtensionInventory = true,
            )

        assertTrue(capabilities.supportsSuwayomiCatalog)
        assertTrue(capabilities.supportsSuwayomiContent)
        assertTrue(capabilities.supportsSuwayomiExtensionInventory)
    }

    @Test
    fun `requires explicit authority capability before treating Suwayomi as comic authority`() {
        val legacy = json.decodeFromString<CoreCapabilities>(CAPABILITIES_JSON)
        assertFalse(EpigraphCoreCompatibilityEvaluator.isSuwayomiAuthoritativeComics(legacy))

        val declared = legacy.copy(
            comicAuthorityMode = "suwayomi-confirmed-v1",
            supportsConfirmedSuwayomiCommandsV1 = true,
        )
        assertTrue(EpigraphCoreCompatibilityEvaluator.isSuwayomiAuthoritativeComics(declared))
        assertFalse(
            EpigraphCoreCompatibilityEvaluator.isSuwayomiAuthoritativeComics(
                declared.copy(supportsConfirmedSuwayomiCommandsV1 = false),
            ),
        )
    }

    @Test
    fun `gates planned comic entities until Core advertises them`() {
        val capabilities = json.decodeFromString<CoreCapabilities>(CAPABILITIES_JSON)

        assertTrue(EpigraphCoreCompatibilityEvaluator.canSynchronizeEntity(capabilities, "comic.history"))
        assertFalse(EpigraphCoreCompatibilityEvaluator.canSynchronizeEntity(capabilities, "comic.entry"))
        assertFalse(EpigraphCoreCompatibilityEvaluator.canSynchronizeEntity(capabilities, "comic.category_assignment"))
    }

    @Test
    fun `canonical comic projection requires causal receipts and the complete entity contract`() {
        val legacy = json.decodeFromString<CoreCapabilities>(CAPABILITIES_JSON)
        assertFalse(EpigraphCoreCompatibilityEvaluator.supportsCanonicalComicProjection(legacy))

        val complete = legacy.copy(
            supportsCausalMutationsV3 = true,
            snapshotEntityTypes = legacy.snapshotEntityTypes + setOf(
                EpigraphCoreEntityType.COMIC_ENTRY,
                EpigraphCoreEntityType.COMIC_CATEGORY,
                EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT,
                EpigraphCoreEntityType.COMIC_CHAPTER_STATE,
            ),
        )
        assertTrue(EpigraphCoreCompatibilityEvaluator.supportsCanonicalComicProjection(complete))
        assertFalse(
            EpigraphCoreCompatibilityEvaluator.supportsCanonicalComicProjection(
                complete.copy(snapshotEntityTypes = complete.snapshotEntityTypes - EpigraphCoreEntityType.COMIC_CATEGORY),
            ),
        )
    }

    @Test
    fun `rejects incompatible transport protocol`() {
        val capabilities = json.decodeFromString<CoreCapabilities>(CAPABILITIES_JSON)
            .copy(serverProtocolVersion = 2)

        assertInstanceOf(
            CoreCompatibility.ProtocolMismatch::class.java,
            EpigraphCoreCompatibilityEvaluator.evaluate(capabilities),
        )
    }

    @Test
    fun `decodes rejected mutation with Core error details`() {
        val response = json.decodeFromString<CoreMutationsResponse>(MUTATION_RESPONSE_JSON)

        assertEquals(CoreMutationResultStatus.REJECTED, response.results.single().status)
        assertEquals("UNSUPPORTED_ENTITY_TYPE", response.results.single().error?.code)
    }

    @Test
    fun `encodes flat syncd mutation instead of nested Android command envelope`() {
        val request = CoreMutationsRequest(
            requestId = "request-1",
            mutations = listOf(
                CoreMutationInput(
                    entityType = "comic.history",
                    clientMutationId = "mutation-1",
                    scopeId = "comics:profile:main",
                    entityId = "history-1",
                    lamport = 7,
                    patch = buildJsonObject { put("historyId", "history-1") },
                ),
            ),
        )

        val encoded = json.parseToJsonElement(json.encodeToString(request)).jsonObject
        val mutation = encoded.getValue("mutations").jsonArray.single().jsonObject
        assertEquals("comic.history", mutation.getValue("entityType").jsonPrimitive.content)
        assertTrue("command" !in mutation)
        assertTrue("deviceId" !in mutation)
        assertEquals("history-1", mutation.getValue("patch").jsonObject.getValue("historyId").jsonPrimitive.content)
    }

    private companion object {
        val CAPABILITIES_JSON = """
            {
              "serverProtocolVersion": 1,
              "minClientVersion": "0.1.0",
              "supportedScopes": ["books:global", "novels:profile:<paired-profile>", "comics:profile:<paired-profile>"],
              "supportsSseReplay": true,
              "supportsManualIpFallback": true,
              "supportsOwnerTransfer": true,
              "supportsSnapshot": true,
              "supportsAssets": true,
              "supportsNovelChapterAssets": true,
              "supportsNovelPluginSync": true,
              "supportsSuwayomiProxy": true,
              "supportsSuwayomiWebsocketProxy": true,
              "suwayomiProxyPathTemplate": "/v1/suwayomi/{path}?scopeId=comics%3Aprofile%3A{pairedProfile}",
              "snapshotSchemaVersion": 2,
              "snapshotEntityTypes": ["book.entry", "novel.entry", "comic.history", "comic.page_bookmark"],
              "tlsCertSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "mdnsServiceName": "_epigraph-syncd._tcp.local.",
              "currentServerVersion": 42,
              "minReplayableServerVersion": 7
            }
        """.trimIndent()

        val MUTATION_RESPONSE_JSON = """
            {
              "requestId": "request-1",
              "currentServerVersion": 42,
              "results": [{
                "clientMutationId": "mutation-1",
                "entityType": "comic.entry",
                "entityId": "comic-1",
                "scopeId": "comics:profile:profile-1",
                "op": "merge",
                "status": "rejected",
                "error": {
                  "code": "UNSUPPORTED_ENTITY_TYPE",
                  "message": "Unsupported entity type.",
                  "retryable": false
                }
              }]
            }
        """.trimIndent()
    }
}
