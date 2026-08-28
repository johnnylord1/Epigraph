package epigraph.sync.core.suwayomi
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiCatalogPage
import epigraph.sync.core.protocol.SuwayomiCatalogResponse
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiCommandResponse
import epigraph.sync.core.protocol.SuwayomiGraphqlRequest
import epigraph.sync.core.protocol.SuwayomiGraphqlResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class SuwayomiMutationQueueDrainerTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
    private val session = CoreCredentialSession(
        origin = "https://core.test/",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "pairing",
        profileId = PROFILE,
        tokenId = "token",
        scopes = listOf("comics:profile:$PROFILE"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        accessTokenUtf8 = byteArrayOf(1, 2, 3),
    )

    @AfterEach
    fun close() {
        session.close()
        driver.close()
    }

    @Test
    fun `successful official mutation is confirmed before queue removal`() = runTest {
        enqueue(
            operationId = "op-library",
            operationName = "UpdateManga",
            variables = "{\"id\":7,\"inLibrary\":true}",
        )
        val gateway = FakeGateway()

        val report = drainer().drain(session, gateway, nowEpochMillis = 100)

        assertEquals(SuwayomiMutationDrainReport(1, 1, 0, 0, 0), report)
        assertEquals(listOf("UpdateManga", "ConfirmManga"), gateway.operations)
        assertEquals(0, database.aethon_suwayomi_mutation_queueQueries.selectReady(100, 10).executeAsList().size)
    }

    @Test
    fun `transient Core failure keeps intent for a later attempt`() = runTest {
        enqueue(
            operationId = "op-retry",
            operationName = "UpdateManga",
            variables = "{\"id\":7,\"inLibrary\":true}",
        )
        val gateway = FakeGateway(mutationResult = CoreHttpResult.Failure(503, null))

        val report = drainer().drain(session, gateway, nowEpochMillis = 100)
        val row = database.aethon_suwayomi_mutation_queueQueries.selectReady(100_000, 10).executeAsList()

        assertEquals(1, report.retryScheduled)
        assertEquals(1, row.size)
        assertEquals("ERROR", row.single().status)
        assertEquals("core_http_503", row.single().last_error)
        assertTrue(row.single().next_attempt_at > 100)
    }

    @Test
    fun `chapter progress carries manga identity and is confirmed from catalog`() = runTest {
        enqueue(
            operationId = "op-progress",
            operationName = "UpdateChaptersProgress",
            variables = "{\"mangaId\":7,\"ids\":[900],\"isRead\":true,\"lastPageRead\":3}",
        )
        val gateway = FakeGateway(
            chapters = buildJsonObject {
                put(
                    "chapters",
                    buildJsonObject {
                        put(
                            "nodes",
                            Json.parseToJsonElement("[{\"id\":900,\"isRead\":true,\"isBookmarked\":false,\"lastPageRead\":3}]"),
                        )
                    },
                )
            },
        )

        val report = drainer().drain(session, gateway, nowEpochMillis = 100)

        assertEquals(1, report.succeeded)
        assertEquals(0, database.aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne())
        assertEquals(7L, gateway.lastCatalogMangaId)
        assertTrue(gateway.lastMutationVariables!!.containsKey("ids"))
        assertTrue(!gateway.lastMutationVariables!!.containsKey("mangaId"))
    }

    @Test
    fun `a session only drains its own Suwayomi profile`() = runTest {
        enqueue(
            operationId = "op-other-profile",
            operationName = "UpdateManga",
            variables = "{\"id\":7,\"inLibrary\":true}",
            profileId = "secondary",
        )
        val gateway = FakeGateway()

        val report = drainer().drain(session, gateway, nowEpochMillis = 100)

        assertEquals(0, report.claimed)
        assertEquals(0, report.pending)
        assertEquals(1, database.aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne())
        assertTrue(gateway.operations.isEmpty())
    }

    @Test
    fun `canonical Core projection quarantines every legacy direct write`() = runTest {
        enqueue("legacy-entry", "UpdateManga", "{\"id\":7,\"inLibrary\":true}")
        enqueue(
            "legacy-category",
            "UpdateMangaCategories",
            "{\"mangaId\":7,\"addTo\":[3],\"removeFrom\":[]}",
        )
        enqueue(
            "legacy-progress",
            "UpdateChaptersProgress",
            "{\"mangaId\":7,\"ids\":[900],\"lastPageRead\":3}",
        )
        val gateway = FakeGateway()

        val report = drainer().drain(
            session,
            gateway,
            nowEpochMillis = 100,
            canonicalProjectionEnabled = true,
        )

        assertEquals(SuwayomiMutationDrainReport(3, 0, 0, 3, 0), report)
        assertTrue(gateway.operations.isEmpty())
        val rows = database.aethon_suwayomi_mutation_queueQueries.selectReady(Long.MAX_VALUE, 10).executeAsList()
        assertTrue(rows.isEmpty())
    }

    private fun enqueue(
        operationId: String,
        operationName: String,
        variables: String,
        profileId: String = PROFILE,
    ) {
        database.aethon_suwayomi_mutation_queueQueries.enqueue(
            operationId = operationId,
            profileId = profileId,
            operationName = operationName,
            variablesJson = variables,
            entityId = "suwayomi:profile:$PROFILE:manga:7",
            createdAt = 100,
            nextAttemptAt = 0,
        )
    }

    private fun drainer() = SuwayomiMutationQueueDrainer(handler, clock = { 100 })

    private class FakeGateway(
        private val mutationResult: CoreHttpResult<SuwayomiCommandResponse> = CoreHttpResult.Success(
            SuwayomiCommandResponse(
                schemaVersion = 1,
                scopeId = "comics:profile:$PROFILE",
                operation = epigraph.sync.core.protocol.SuwayomiMutationOperation.UPDATE_MANGA,
                appliedAtMs = 100,
                data = buildJsonObject { put("updateManga", buildJsonObject { }) },
            ),
        ),
        private val chapters: kotlinx.serialization.json.JsonObject? = null,
    ) : SuwayomiMutationGateway {
        val operations = mutableListOf<String>()
        var lastMutationVariables: kotlinx.serialization.json.JsonObject? = null
        var lastCatalogMangaId: Long? = null

        override suspend fun command(
            session: CoreCredentialSession,
            request: SuwayomiCommandRequest,
        ): CoreHttpResult<SuwayomiCommandResponse> {
            operations += when (request.operation) {
                epigraph.sync.core.protocol.SuwayomiMutationOperation.UPDATE_MANGA -> "UpdateManga"
                epigraph.sync.core.protocol.SuwayomiMutationOperation.UPDATE_MANGA_CATEGORIES -> "UpdateMangaCategories"
                epigraph.sync.core.protocol.SuwayomiMutationOperation.UPDATE_CHAPTERS_PROGRESS -> "UpdateChaptersProgress"
                epigraph.sync.core.protocol.SuwayomiMutationOperation.UPDATE_CATEGORY -> "UpdateCategory"
                epigraph.sync.core.protocol.SuwayomiMutationOperation.DELETE_CATEGORY -> "DeleteCategory"
                epigraph.sync.core.protocol.SuwayomiMutationOperation.UPDATE_CATEGORY_ORDER -> "UpdateCategoryOrder"
            }
            if (request.operation == epigraph.sync.core.protocol.SuwayomiMutationOperation.UPDATE_CHAPTERS_PROGRESS) {
                lastMutationVariables = request.variables
            }
            return mutationResult
        }

        override suspend fun graphql(
            session: CoreCredentialSession,
            request: SuwayomiGraphqlRequest,
        ): CoreHttpResult<SuwayomiGraphqlResponse> {
            operations += request.operationName.orEmpty()
            if (request.operationName == "UpdateChaptersProgress") lastMutationVariables = request.variables
            if (request.operationName == "ConfirmManga") {
                return CoreHttpResult.Success(
                    SuwayomiGraphqlResponse(
                        data = buildJsonObject {
                            put("manga", buildJsonObject { put("inLibrary", true) })
                        },
                    ),
                )
            }
            return CoreHttpResult.Success(
                SuwayomiGraphqlResponse(data = buildJsonObject { put("query", true) }),
            )
        }

        override suspend fun catalog(
            session: CoreCredentialSession,
            operation: SuwayomiCatalogOperation,
            pageSize: Long,
            offset: Long,
            mangaId: Long?,
        ): CoreHttpResult<SuwayomiCatalogResponse> {
            lastCatalogMangaId = mangaId
            return CoreHttpResult.Success(
                SuwayomiCatalogResponse(
                    schemaVersion = 1,
                    scopeId = "comics:profile:$PROFILE",
                    operation = operation.wireName,
                    generatedAtMs = 100,
                    page = SuwayomiCatalogPage(
                        offset,
                        pageSize,
                        hasNextPage = false,
                        totalCount = 0,
                    ),
                    data = chapters ?: buildJsonObject { put("chapters", buildJsonObject { put("nodes", Json.parseToJsonElement("[]")) }) },
                ),
            )
        }
    }

    private companion object {
        const val PROFILE = "main"
    }
}
