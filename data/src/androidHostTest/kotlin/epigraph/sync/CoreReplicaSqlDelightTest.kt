package epigraph.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import yokai.data.Database

class CoreReplicaSqlDelightTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val database = Database(
        driver,
        chaptersAdapter = tachiyomi.data.Chapters.Adapter(yokai.data.memoColumnAdapter),
        mangasAdapter = tachiyomi.data.Mangas.Adapter(yokai.data.memoColumnAdapter),
    )
    private val queries = database.aethon_syncQueries

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `checkpoint never regresses`() {
        queries.upsertCoreReplicaCheckpoint(
            "FILTERED:books:global",
            "FILTERED",
            "books:global",
            12,
            100,
        )
        queries.upsertCoreReplicaCheckpoint(
            "FILTERED:books:global",
            "FILTERED",
            "books:global",
            11,
            101,
        )

        val checkpoint = queries.selectCoreReplicaCheckpoint("FILTERED:books:global").executeAsOne()
        assertEquals(12L, checkpoint.last_global_event_id)
        assertEquals(100L, checkpoint.updated_at)
    }

    @Test
    fun `authoritative scope replacement queries never touch outbox`() {
        queries.enqueueMutation(
            clientMutationId = "mutation-1",
            deviceId = "phone-a",
            scopeId = "books:global",
            entityType = "book.entry",
            entityId = "local-book",
            operation = "upsert_media",
            payloadJson = "{}",
            createdAt = 1,
            nextAttemptAt = 1,
        )
        queries.upsertCoreReplicaRecord(
            scopeId = "books:global",
            entityType = "book.entry",
            entityId = "old",
            serverVersion = 1,
            lamport = 1,
            recordJson = "{}",
            payloadSha256 = "a".repeat(64),
        )

        queries.deleteCoreReplicaRecordsByScope("books:global")
        queries.deleteCoreReplicaTombstonesByScope("books:global")

        assertEquals(1L, queries.pendingMutationCount().executeAsOne())
        assertNotNull(queries.selectReadyMutations(1, 10).executeAsOneOrNull())
    }

    @Test
    fun `inbox event id is globally idempotent`() {
        queries.insertCoreReplicaInboxEvent(
            7,
            "books:global",
            "book.entry",
            "book-1",
            "merge",
            "b".repeat(64),
            1,
        )

        assertEquals(true, queries.isCoreReplicaInboxEventApplied(7).executeAsOne())
        val duplicate = runCatching {
            queries.insertCoreReplicaInboxEvent(
                7,
                "novels:profile:main",
                "novel.entry",
                "novel-1",
                "merge",
                "c".repeat(64),
                2,
            )
        }
        assertNotNull(duplicate.exceptionOrNull())
    }

    @Test
    fun `lamport clock only advances`() {
        queries.advanceCoreLamport(7)
        queries.advanceCoreLamport(3)

        assertEquals(7L, queries.selectCoreLamport().executeAsOne())
    }
}
