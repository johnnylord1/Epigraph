package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.Database

class BlockedComicOutboxMigrationTest {
    @Test
    fun `migration 50 reopens only valid server-scoped comic mutations`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            createOutbox(driver)
            insertBlocked(driver, "valid", "comic.history", SERVER_SCOPED_COMIC_ID, "blocked:INVALID_COMIC_ID")
            insertBlocked(driver, "legacy", "comic.history", "suwayomi:profile:main:manga:7", "blocked:INVALID_COMIC_ID")
            insertBlocked(driver, "other", "comic.history", SERVER_SCOPED_COMIC_ID, "blocked:INVALID_PAGE_COUNT")
            insertBlocked(driver, "unsupported", "book.progress", SERVER_SCOPED_COMIC_ID, "blocked:INVALID_COMIC_ID")

            Database.Schema.migrate(driver, oldVersion = 50, newVersion = 51)

            val recovered = recoveredState(driver)
            assertEquals(RowState("PENDING", 0, null), recovered.state)
            assertNotEquals("valid", recovered.clientMutationId)
            assertTrue(recovered.clientMutationId.matches(Regex("[0-9a-f]{32}")))
            assertEquals(
                recovered.clientMutationId,
                Json.parseToJsonElement(recovered.payloadJson)
                    .jsonObject.getValue("clientMutationId").jsonPrimitive.content,
            )
            assertEquals(RowState("ERROR", Long.MAX_VALUE, "blocked:INVALID_COMIC_ID"), state(driver, "legacy"))
            assertEquals(RowState("ERROR", Long.MAX_VALUE, "blocked:INVALID_PAGE_COUNT"), state(driver, "other"))
            assertEquals(RowState("ERROR", Long.MAX_VALUE, "blocked:INVALID_COMIC_ID"), state(driver, "unsupported"))
        }
    }

    private fun createOutbox(driver: JdbcSqliteDriver) {
        driver.execute(
            identifier = null,
            sql = """
                CREATE TABLE aethon_sync_outbox(
                    sequence INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    client_mutation_id TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    last_error TEXT,
                    in_flight_at INTEGER,
                    lease_until INTEGER
                )
            """.trimIndent(),
            parameters = 0,
        )
    }

    private fun insertBlocked(
        driver: JdbcSqliteDriver,
        mutationId: String,
        entityType: String,
        entityId: String,
        error: String,
    ) {
        driver.execute(
            identifier = null,
            sql = """
                INSERT INTO aethon_sync_outbox(
                    device_id, client_mutation_id, scope_id, entity_type, entity_id,
                    operation, payload_json, created_at, next_attempt_at, status, last_error,
                    in_flight_at, lease_until
                ) VALUES ('device', ?, 'comics:profile:main', ?, ?, 'set_progress', ?, 1, ?, 'ERROR', ?, 2, 3)
            """.trimIndent(),
            parameters = 6,
            binders = {
                bindString(0, mutationId)
                bindString(1, entityType)
                bindString(2, entityId)
                bindString(3, "{\"clientMutationId\":\"$mutationId\"}")
                bindLong(4, Long.MAX_VALUE)
                bindString(5, error)
            },
        )
    }

    private fun recoveredState(driver: JdbcSqliteDriver): RecoveredRow = driver.executeQuery(
        identifier = null,
        sql = """
            SELECT client_mutation_id, payload_json, status, next_attempt_at, last_error
            FROM aethon_sync_outbox
            WHERE entity_id = ? AND status = 'PENDING'
        """.trimIndent(),
        mapper = { cursor ->
            check(cursor.next().value)
            QueryResult.Value(
                RecoveredRow(
                    clientMutationId = cursor.getString(0)!!,
                    payloadJson = cursor.getString(1)!!,
                    state = RowState(cursor.getString(2)!!, cursor.getLong(3)!!, cursor.getString(4)),
                ),
            )
        },
        parameters = 1,
        binders = { bindString(0, SERVER_SCOPED_COMIC_ID) },
    ).value

    private fun state(driver: JdbcSqliteDriver, mutationId: String): RowState = driver.executeQuery(
        identifier = null,
        sql = "SELECT status, next_attempt_at, last_error FROM aethon_sync_outbox WHERE client_mutation_id = ?",
        mapper = { cursor ->
            check(cursor.next().value)
            QueryResult.Value(RowState(cursor.getString(0)!!, cursor.getLong(1)!!, cursor.getString(2)))
        },
        parameters = 1,
        binders = { bindString(0, mutationId) },
    ).value

    private data class RowState(
        val status: String,
        val nextAttemptAt: Long,
        val lastError: String?,
    )

    private data class RecoveredRow(
        val clientMutationId: String,
        val payloadJson: String,
        val state: RowState,
    )

    private companion object {
        const val SERVER_SCOPED_COMIC_ID =
            "suwayomi:server:desktop-a:profile:main:manga:7"
    }
}
