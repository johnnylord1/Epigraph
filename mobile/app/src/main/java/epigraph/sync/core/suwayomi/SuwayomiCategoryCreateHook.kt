package epigraph.sync.core.suwayomi

import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.EpigraphCoreCompatibilityEvaluator
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiCommandResponse
import epigraph.sync.core.protocol.SuwayomiMutationOperation
import epigraph.sync.core.work.CoreNegotiatedSessionHook
import epigraph.sync.core.work.CoreOutboxSyncConnection
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** A local comic category that holds comics but has no Suwayomi category yet. */
data class UnpublishedComicCategory(
    val localCategoryId: Long,
    val name: String,
)

fun interface UnpublishedComicCategorySource {
    suspend fun list(): List<UnpublishedComicCategory>
}

fun interface CreatedComicCategoryBinder {
    /** Binds the local category and queues its assignments; a no-op when the local category changed meanwhile. */
    suspend fun bind(localCategoryId: Long, expectedName: String, categoryEntityId: String, suwayomiOrder: Long)
}

/**
 * Creates phone-only comic categories on the desktop Suwayomi through the Core, then binds each
 * local category to the confirmed Suwayomi id so its assignments can sync.
 */
class SuwayomiCategoryCreateHook(
    private val categories: UnpublishedComicCategorySource,
    private val binder: CreatedComicCategoryBinder,
    private val maxPerSession: Int = 20,
) : CoreNegotiatedSessionHook {

    override suspend fun onNegotiated(
        capabilities: CoreCapabilities,
        connection: CoreOutboxSyncConnection,
    ) {
        if (!isEnabled(capabilities)) return
        val channel = connection.suwayomiCommands() ?: return
        // A legacy session is upgraded to a server-bound id on this run; binding a legacy id now
        // would duplicate the category on the next catalog run.
        if (channel.serverId == LEGACY_UNBOUND_SERVER_ID) return

        for (entry in categories.list().filter { isPublishableName(it.name) }.take(maxPerSession)) {
            val name = entry.name
            val result = channel.command(
                SuwayomiCommandRequest(
                    operation = SuwayomiMutationOperation.CREATE_CATEGORY,
                    variables = buildJsonObject { put("name", name) },
                ),
            )
            when (result) {
                is CoreHttpResult.Failure -> {
                    // The Core is unreachable or busy: retry everything on the next sync. A rejection
                    // of this one name must not block the categories after it.
                    if (!result.rejectsOnlyThisCategory()) return
                }
                is CoreHttpResult.Success -> {
                    val created = createdCategory(result.value, name) ?: continue
                    binder.bind(
                        localCategoryId = entry.localCategoryId,
                        expectedName = name,
                        categoryEntityId = suwayomiServerCategoryEntityId(channel.serverId, channel.profileId, created.id),
                        suwayomiOrder = created.order,
                    )
                }
            }
        }
    }

    private data class CreatedCategory(val id: Long, val order: Long)

    companion object {
        private const val MAX_NAME_BYTES = 256

        /** The same gate as [onNegotiated]; the catalog sync uses it to know a bind is coming. */
        internal fun isEnabled(capabilities: CoreCapabilities): Boolean =
            capabilities.supportsSuwayomiCategoryCreate &&
                EpigraphCoreCompatibilityEvaluator.supportsCanonicalComicProjection(capabilities)

        /**
         * Suwayomi reserves "Default" in any letter case for its system category, and an untrimmed
         * local name would never match the remote name later.
         */
        internal fun isPublishableName(name: String): Boolean =
            name.isNotEmpty() &&
                name == name.trim() &&
                '\u0000' !in name &&
                name.encodeToByteArray().size <= MAX_NAME_BYTES &&
                !name.equals("Default", ignoreCase = true)

        /** 4xx except auth and throttling, or a 503 the Core marked non-retryable (a Suwayomi GraphQL error). */
        private fun CoreHttpResult.Failure.rejectsOnlyThisCategory(): Boolean = when (statusCode) {
            401, 403, 408, 429 -> false
            in 400..499 -> true
            503 -> errorEnvelope?.error?.retryable == false
            else -> false
        }

        private fun createdCategory(response: SuwayomiCommandResponse, expectedName: String): CreatedCategory? {
            if (response.operation != SuwayomiMutationOperation.CREATE_CATEGORY) return null
            val createCategory = response.data["createCategory"] as? JsonObject ?: return null
            val category = createCategory["category"] as? JsonObject ?: return null
            val id = category["id"].numberOrNull() ?: return null
            if (id !in 1L..Int.MAX_VALUE.toLong()) return null
            val name = (category["name"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
            if (name != expectedName) return null
            val order = category["order"].numberOrNull() ?: 0L
            return CreatedCategory(id, order)
        }

        /** `longOrNull` also parses quoted strings; the Core always sends these as JSON numbers. */
        private fun JsonElement?.numberOrNull(): Long? = (this as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
    }
}
