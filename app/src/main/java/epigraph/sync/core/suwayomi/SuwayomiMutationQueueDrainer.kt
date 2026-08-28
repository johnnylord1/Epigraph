package epigraph.sync.core.suwayomi

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiGraphqlRequest
import epigraph.sync.core.protocol.SuwayomiGraphqlResponse
import epigraph.sync.core.protocol.SuwayomiMutationOperation
import java.util.concurrent.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.coroutines.withContext
import kotlinx.coroutines.NonCancellable
import tachiyomi.data.Aethon_suwayomi_mutation_queue
import yokai.data.DatabaseHandler

data class SuwayomiMutationDrainReport(
    val claimed: Int,
    val succeeded: Int,
    val retryScheduled: Int,
    val blocked: Int,
    val pending: Long,
)

/**
 * Applies queued comics writes through Suwayomi's official GraphQL operations.
 *
 * This is deliberately not an extension manager or a second Syncd. It owns only the durable
 * intent queue and performs one sequential batch per profile. Every successful mutation is
 * followed by a bounded read from the official catalog/proxy before the intent is removed.
 */
class SuwayomiMutationQueueDrainer(
    private val database: DatabaseHandler,
    private val json: Json = Json { ignoreUnknownKeys = true },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun pendingCount(): Long = database.await {
        aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne()
    }

    suspend fun drain(
        session: CoreCredentialSession,
        proxy: SuwayomiMutationGateway,
        nowEpochMillis: Long,
        canonicalProjectionEnabled: Boolean = false,
    ): SuwayomiMutationDrainReport {
        require(nowEpochMillis >= 0) { "drain timestamp must not be negative" }
        val claimedRows = claim(nowEpochMillis, session.profileId)
        if (claimedRows.isEmpty()) {
            return SuwayomiMutationDrainReport(0, 0, 0, 0, pendingCount(session.profileId))
        }

        var succeeded = 0
        var retries = 0
        var blocked = 0
        for (row in claimedRows) {
            if (canonicalProjectionEnabled && row.operation_name in CORE_PROJECTED_OPERATIONS) {
                discardProjectedDuplicate(row.operation_id)
                blocked += 1
                continue
            }
            when (val result = applyOne(session, proxy, row)) {
                ApplyResult.SUCCESS -> succeeded += 1
                ApplyResult.RETRY -> retries += 1
                ApplyResult.BLOCKED -> blocked += 1
            }
        }
        return SuwayomiMutationDrainReport(
            claimed = claimedRows.size,
            succeeded = succeeded,
            retryScheduled = retries,
            blocked = blocked,
            pending = pendingCount(session.profileId),
        )
    }

    private suspend fun claim(now: Long, profileId: String): List<Aethon_suwayomi_mutation_queue> = database.await(inTransaction = true) {
        aethon_suwayomi_mutation_queueQueries.recoverExpired(now)
        aethon_suwayomi_mutation_queueQueries
            .selectReadyForProfile(profileId, now, MAX_BATCH.toLong())
            .executeAsList()
            .also { rows ->
                val leaseUntil = now + LEASE_MILLIS
                rows.forEach { row ->
                    aethon_suwayomi_mutation_queueQueries.markInFlight(
                        operationId = row.operation_id,
                        inFlightAt = now,
                        leaseUntil = leaseUntil,
                    )
                }
            }
    }

    private suspend fun pendingCount(profileId: String): Long = database.await {
        aethon_suwayomi_mutation_queueQueries.pendingCountForProfile(profileId).executeAsOne()
    }

    private suspend fun applyOne(
        session: CoreCredentialSession,
        proxy: SuwayomiMutationGateway,
        row: Aethon_suwayomi_mutation_queue,
    ): ApplyResult {
        val request = runCatching {
            val variables = json.parseToJsonElement(row.variables_json).jsonObject
            // mangaId is local confirmation context for chapter progress; the official mutation
            // does not declare it as a GraphQL variable, so never forward it to Suwayomi.
            val graphVariables = if (row.operation_name == "UpdateChaptersProgress") {
                JsonObject(variables.filterKeys { it != "mangaId" })
            } else {
                variables
            }
            SuwayomiCommandRequest(
                operation = operationFor(row.operation_name),
                variables = graphVariables,
            )
        }.getOrNull() ?: return block(row.operation_id, "invalid_variables")
        val confirmationVariables = runCatching {
            json.parseToJsonElement(row.variables_json).jsonObject
        }.getOrNull() ?: return block(row.operation_id, "invalid_variables")

        val response = try {
            proxy.command(session, request)
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) {
                fail(row.operation_id, row.attempt_count, "cancelled", clock())
            }
            throw cancelled
        } catch (_: Throwable) {
            return fail(row.operation_id, row.attempt_count, "transport_failure", clock())
        }

        when (response) {
            is CoreHttpResult.Failure -> {
                if (response.statusCode.isRetryable()) {
                    fail(row.operation_id, row.attempt_count, "core_http_${response.statusCode}", clock())
                } else {
                    block(row.operation_id, "core_http_${response.statusCode}")
                }
            }
            is CoreHttpResult.Success -> {
                val confirmation = try {
                    confirm(session, proxy, row.operation_name, confirmationVariables)
                } catch (cancelled: CancellationException) {
                    withContext(NonCancellable) {
                        fail(row.operation_id, row.attempt_count, "cancelled", clock())
                    }
                    throw cancelled
                } catch (_: Throwable) {
                    return fail(row.operation_id, row.attempt_count, "confirmation_transport_failure", clock())
                }
                when (confirmation) {
                    SuwayomiConfirmation.SUCCESS -> {
                        succeed(row.operation_id)
                        return ApplyResult.SUCCESS
                    }
                    SuwayomiConfirmation.RETRY -> return fail(row.operation_id, row.attempt_count, "confirmation_retry", clock())
                    SuwayomiConfirmation.BLOCKED -> return block(row.operation_id, "confirmation_failed")
                }
            }
        }
        return if (response is CoreHttpResult.Failure && response.statusCode.isRetryable()) {
            ApplyResult.RETRY
        } else {
            ApplyResult.BLOCKED
        }
    }

    private suspend fun confirm(
        session: CoreCredentialSession,
        proxy: SuwayomiMutationGateway,
        operationName: String,
        variables: JsonObject,
    ): SuwayomiConfirmation = when (operationName) {
        "UpdateManga" -> confirmManga(proxy, session, variables)
        "UpdateMangaCategories" -> confirmCategories(proxy, session, variables)
        "UpdateChaptersProgress" -> confirmChapters(proxy, session, variables)
        "UpdateCategory" -> confirmCategory(proxy, session, operationName, variables)
        "DeleteCategory" -> confirmCategory(proxy, session, operationName, variables)
        "UpdateCategoryOrder" -> confirmCategory(proxy, session, operationName, variables)
        else -> SuwayomiConfirmation.BLOCKED
    }

    private suspend fun confirmCategory(
        proxy: SuwayomiMutationGateway,
        session: CoreCredentialSession,
        operationName: String,
        variables: JsonObject,
    ): SuwayomiConfirmation {
        val id = variables["id"]?.jsonPrimitive?.longOrNull ?: return SuwayomiConfirmation.BLOCKED
        val expectedName = variables["name"]?.jsonPrimitive?.contentOrNull
        val expectedOrder = variables["position"]?.jsonPrimitive?.longOrNull
        var offset = 0L
        var found: JsonObject? = null
        do {
            val response = proxy.catalog(session, SuwayomiCatalogOperation.CATEGORIES, 250, offset)
            val page = when (response) {
                is CoreHttpResult.Failure -> return if (response.statusCode.isRetryable()) {
                    SuwayomiConfirmation.RETRY
                } else {
                    SuwayomiConfirmation.BLOCKED
                }
                is CoreHttpResult.Success -> response.value
            }
            val categories = (page.data["categories"] as? JsonObject)?.get("nodes") as? JsonArray
                ?: return SuwayomiConfirmation.BLOCKED
            found = categories
                .mapNotNull { it as? JsonObject }
                .firstOrNull { it["id"]?.jsonPrimitive?.longOrNull == id }
            if (found != null || !page.page.hasNextPage) break
            val next = offset + page.page.pageSize
            if (next <= offset || next > Int.MAX_VALUE) return SuwayomiConfirmation.BLOCKED
            offset = next
        } while (true)

        return when (operationName) {
            "DeleteCategory" -> if (found == null) SuwayomiConfirmation.SUCCESS else SuwayomiConfirmation.RETRY
            "UpdateCategory" -> if (found?.get("name")?.jsonPrimitive?.contentOrNull == expectedName) {
                SuwayomiConfirmation.SUCCESS
            } else {
                SuwayomiConfirmation.RETRY
            }
            "UpdateCategoryOrder" -> if (found?.get("order")?.jsonPrimitive?.longOrNull == expectedOrder) {
                SuwayomiConfirmation.SUCCESS
            } else {
                SuwayomiConfirmation.RETRY
            }
            else -> SuwayomiConfirmation.BLOCKED
        }
    }

    private suspend fun confirmManga(
        proxy: SuwayomiMutationGateway,
        session: CoreCredentialSession,
        variables: JsonObject,
    ): SuwayomiConfirmation {
        val id = variables["id"]?.jsonPrimitive?.longOrNull ?: return SuwayomiConfirmation.BLOCKED
        val expected = variables["inLibrary"]?.jsonPrimitive?.booleanOrNull ?: return SuwayomiConfirmation.BLOCKED
        val response = proxy.graphql(
            session,
            SuwayomiGraphqlRequest(
                query = SuwayomiOfficialDocuments.CONFIRM_MANGA,
                variables = kotlinx.serialization.json.buildJsonObject { put("id", id) },
                operationName = "ConfirmManga",
            ),
        )
        return when (response) {
            is CoreHttpResult.Failure -> if (response.statusCode.isRetryable()) {
                SuwayomiConfirmation.RETRY
            } else {
                SuwayomiConfirmation.BLOCKED
            }
            is CoreHttpResult.Success -> response.value.toConfirmation { data ->
                data["manga"]?.jsonObject?.get("inLibrary")?.jsonPrimitive?.booleanOrNull == expected
            }
        }
    }

    private suspend fun confirmCategories(
        proxy: SuwayomiMutationGateway,
        session: CoreCredentialSession,
        variables: JsonObject,
    ): SuwayomiConfirmation {
        val mangaId = variables["mangaId"]?.jsonPrimitive?.longOrNull ?: return SuwayomiConfirmation.BLOCKED
        val add = variables["addTo"]?.jsonArray?.longIds() ?: return SuwayomiConfirmation.BLOCKED
        val remove = variables["removeFrom"]?.jsonArray?.longIds() ?: return SuwayomiConfirmation.BLOCKED
        var offset = 0L
        val present = mutableSetOf<Long>()
        do {
            val response = proxy.catalog(session, SuwayomiCatalogOperation.CATEGORIES, 250, offset)
            val page = when (response) {
                is CoreHttpResult.Failure -> return if (response.statusCode.isRetryable()) SuwayomiConfirmation.RETRY else SuwayomiConfirmation.BLOCKED
                is CoreHttpResult.Success -> response.value
            }
            val categories = (page.data["categories"] as? JsonObject)?.get("nodes") as? JsonArray
                ?: return SuwayomiConfirmation.BLOCKED
            categories.forEach { category ->
                val categoryObject = category as? JsonObject ?: return@forEach
                val id = categoryObject["id"]?.jsonPrimitive?.longOrNull ?: return@forEach
                val mangaNodes = (categoryObject["mangas"] as? JsonObject)?.get("nodes") as? JsonArray
                if (mangaNodes?.any {
                    (it as? JsonObject)?.get("id")?.jsonPrimitive?.longOrNull == mangaId
                } == true) {
                    present += id
                }
            }
            if (!page.page.hasNextPage) break
            val next = offset + page.page.pageSize
            if (next <= offset || next > Int.MAX_VALUE) return SuwayomiConfirmation.BLOCKED
            offset = next
        } while (true)
        return if (add.all(present::contains) && remove.none(present::contains)) {
            SuwayomiConfirmation.SUCCESS
        } else {
            SuwayomiConfirmation.RETRY
        }
    }

    private suspend fun confirmChapters(
        proxy: SuwayomiMutationGateway,
        session: CoreCredentialSession,
        variables: JsonObject,
    ): SuwayomiConfirmation {
        val ids = variables["ids"]?.jsonArray?.longIds() ?: return SuwayomiConfirmation.BLOCKED
        val mangaId = variables["mangaId"]?.jsonPrimitive?.longOrNull ?: return SuwayomiConfirmation.BLOCKED
        val expectedRead = variables["isRead"]?.jsonPrimitive?.booleanOrNull
        val expectedBookmarked = variables["isBookmarked"]?.jsonPrimitive?.booleanOrNull
        val expectedLastPage = variables["lastPageRead"]?.jsonPrimitive?.longOrNull
        val matched = mutableListOf<JsonObject>()
        var offset = 0L
        do {
            val response = proxy.catalog(session, SuwayomiCatalogOperation.CHAPTERS, 250, offset, mangaId)
            val page = when (response) {
                is CoreHttpResult.Failure -> return if (response.statusCode.isRetryable()) SuwayomiConfirmation.RETRY else SuwayomiConfirmation.BLOCKED
                is CoreHttpResult.Success -> response.value
            }
            val chapters = (page.data["chapters"] as? JsonObject)?.get("nodes") as? JsonArray
                ?: return SuwayomiConfirmation.BLOCKED
            matched += chapters.mapNotNull { it as? JsonObject }
                .filter { chapter -> chapter["id"]?.jsonPrimitive?.longOrNull in ids }
            if (!page.page.hasNextPage) break
            val next = offset + page.page.pageSize
            if (next <= offset || next > Int.MAX_VALUE) return SuwayomiConfirmation.BLOCKED
            offset = next
        } while (matched.mapNotNull { it["id"]?.jsonPrimitive?.longOrNull }.toSet().size < ids.size)
        if (matched.mapNotNull { it["id"]?.jsonPrimitive?.longOrNull }.toSet().size != ids.size) {
            return SuwayomiConfirmation.RETRY
        }
        return if (matched.all { chapter ->
                val value = chapter.jsonObject
                (expectedRead == null || value["isRead"]?.jsonPrimitive?.booleanOrNull == expectedRead) &&
                    (expectedBookmarked == null || value["isBookmarked"]?.jsonPrimitive?.booleanOrNull == expectedBookmarked) &&
                    (expectedLastPage == null || value["lastPageRead"]?.jsonPrimitive?.longOrNull == expectedLastPage)
            }) SuwayomiConfirmation.SUCCESS else SuwayomiConfirmation.RETRY
    }

    private suspend fun succeed(operationId: String) = database.await(inTransaction = true) {
        aethon_suwayomi_mutation_queueQueries.deleteSucceeded(operationId)
    }

    private suspend fun discardProjectedDuplicate(operationId: String) =
        database.await(inTransaction = true) {
            aethon_suwayomi_mutation_queueQueries.deleteSucceeded(operationId)
        }

    private suspend fun block(operationId: String, reason: String): ApplyResult {
        database.await(inTransaction = true) {
            aethon_suwayomi_mutation_queueQueries.markBlocked(operationId, reason)
        }
        return ApplyResult.BLOCKED
    }

    private suspend fun fail(operationId: String, attemptCount: Long, reason: String, now: Long): ApplyResult {
        val delay = (BASE_RETRY_MILLIS shl minOf(attemptCount.toInt().coerceAtLeast(0), 8))
            .coerceAtMost(MAX_RETRY_MILLIS)
        val next = if (now > Long.MAX_VALUE - delay) Long.MAX_VALUE else now + delay
        database.await(inTransaction = true) {
            aethon_suwayomi_mutation_queueQueries.markFailed(
                nextAttemptAt = next,
                lastError = reason,
                operationId = operationId,
            )
        }
        return ApplyResult.RETRY
    }

    private fun operationFor(operationName: String): SuwayomiMutationOperation = when (operationName) {
        "UpdateManga" -> SuwayomiMutationOperation.UPDATE_MANGA
        "UpdateMangaCategories" -> SuwayomiMutationOperation.UPDATE_MANGA_CATEGORIES
        "UpdateChaptersProgress" -> SuwayomiMutationOperation.UPDATE_CHAPTERS_PROGRESS
        "UpdateCategory" -> SuwayomiMutationOperation.UPDATE_CATEGORY
        "DeleteCategory" -> SuwayomiMutationOperation.DELETE_CATEGORY
        "UpdateCategoryOrder" -> SuwayomiMutationOperation.UPDATE_CATEGORY_ORDER
        else -> error("unsupported Suwayomi operation")
    }

    private enum class ApplyResult { SUCCESS, RETRY, BLOCKED }
    private companion object {
        const val MAX_BATCH = 8
        const val LEASE_MILLIS = 60_000L
        const val BASE_RETRY_MILLIS = 30_000L
        const val MAX_RETRY_MILLIS = 6 * 60 * 60 * 1000L
        val CORE_PROJECTED_OPERATIONS = setOf(
            "UpdateManga",
            "UpdateMangaCategories",
            "UpdateChaptersProgress",
            "UpdateCategory",
            "DeleteCategory",
            "UpdateCategoryOrder",
        )
    }
}

private enum class SuwayomiConfirmation { SUCCESS, RETRY, BLOCKED }

private fun SuwayomiGraphqlResponse.toConfirmation(
    check: (JsonObject) -> Boolean,
): SuwayomiConfirmation {
    if (hasErrors || data == null) return SuwayomiConfirmation.BLOCKED
    return if (check(data)) SuwayomiConfirmation.SUCCESS else SuwayomiConfirmation.RETRY
}

private fun JsonArray.longIds(): List<Long> = mapNotNull { it.jsonPrimitive.longOrNull }

private fun Int.isRetryable(): Boolean = this == 408 || this == 425 || this == 429 || this >= 500
