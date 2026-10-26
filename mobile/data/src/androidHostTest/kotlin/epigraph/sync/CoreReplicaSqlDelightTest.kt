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
    fun `library rows are claimed before older reading state and counted apart`() {
        fun enqueue(id: String, scope: String, type: String) = queries.enqueueMutation(
            clientMutationId = id,
            deviceId = "phone-a",
            scopeId = scope,
            entityType = type,
            entityId = "entity-$id",
            operation = "merge",
            payloadJson = "{}",
            createdAt = 1,
            nextAttemptAt = 1,
        )
        enqueue("progress", "comics:profile:main", "comic.chapter_state")
        enqueue("history", "comics:profile:main", "comic.history")
        enqueue("entry", "comics:profile:main", "comic.entry")
        enqueue("book-progress", "books:global", "book.progress")
        enqueue("assignment", "comics:profile:main", "comic.category_assignment")
        enqueue("blocked", "comics:profile:main", "comic.category")
        enqueue("other-scope", "novels:profile:main", "novel.entry")
        queries.markMutationFailed(
            nextAttemptAt = Long.MAX_VALUE,
            lastError = "blocked:test",
            deviceId = "phone-a",
            clientMutationId = "blocked",
        )
        val scopes = listOf("comics:profile:main", "books:global")

        val claimed = queries.selectReadyMutationsForScopes(scopes, 10, 10).executeAsList()

        assertEquals(
            listOf("entry", "assignment", "progress", "history", "book-progress"),
            claimed.map { it.client_mutation_id },
        )
        assertEquals(2L, queries.pendingLibraryMutationCountForScopes(scopes).executeAsOne())
        assertEquals(1L, queries.pendingLibraryMutationCountForScopes(listOf("novels:profile:main")).executeAsOne())
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
    fun `clearing confirmed state keeps local outbox`() {
        queries.enqueueMutation(
            clientMutationId = "mutation-1",
            deviceId = "phone-a",
            scopeId = "novels:profile:main",
            entityType = "novel.entry",
            entityId = "novel:local",
            operation = "upsert",
            payloadJson = "{}",
            createdAt = 1,
            nextAttemptAt = 1,
        )
        queries.upsertCoreReplicaRecord("novels:profile:main", "novel.entry", "novel:old", 1, 1, "{}", "a".repeat(64))
        queries.upsertCoreReplicaTombstone("novels:profile:main", "novel.entry", "novel:gone", 2, 2, 1, null, "b".repeat(64))

        queries.deleteAllCoreReplicaRecords()
        queries.deleteAllCoreReplicaTombstones()

        assertEquals(emptyList<Any>(), queries.selectCoreReplicaRecordsByScope("novels:profile:main").executeAsList())
        assertEquals(emptyList<Any>(), queries.selectCoreReplicaTombstonesByScope("novels:profile:main").executeAsList())
        assertEquals(1L, queries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `entity is unknown to Core only without record tombstone or local mutation`() {
        val scope = "novels:profile:main"
        fun known(entityId: String) = queries.isEntityKnownToCore(scope, "novel.entry", entityId).executeAsOne()

        assertEquals(false, queries.hasCoreReplicaCoverageForScope(scope).executeAsOne())
        queries.upsertCoreReplicaCheckpoint("FILTERED:$scope", "FILTERED", scope, 3, 1)
        assertEquals(true, queries.hasCoreReplicaCoverageForScope(scope).executeAsOne())
        assertEquals(false, queries.hasCoreReplicaCoverageForScope("comics:profile:main").executeAsOne())

        assertEquals(false, known("novel:missing"))
        queries.upsertCoreReplicaRecord(scope, "novel.entry", "novel:held", 1, 1, "{}", "a".repeat(64))
        queries.upsertCoreReplicaTombstone(scope, "novel.entry", "novel:removed", 2, 2, 1, null, "b".repeat(64))
        queries.enqueueMutation(
            clientMutationId = "mutation-1",
            deviceId = "phone-a",
            scopeId = scope,
            entityType = "novel.entry",
            entityId = "novel:queued",
            operation = "upsert",
            payloadJson = "{}",
            createdAt = 1,
            nextAttemptAt = 1,
        )

        assertEquals(true, known("novel:held"))
        assertEquals(true, known("novel:removed"))
        assertEquals(true, known("novel:queued"))
        assertEquals(false, known("novel:missing"))
        // Another entity type or scope with the same id does not hide the missing entry.
        assertEquals(false, queries.isEntityKnownToCore(scope, "novel.history", "novel:held").executeAsOne())
        assertEquals(false, queries.isEntityKnownToCore("novels:profile:other", "novel.entry", "novel:held").executeAsOne())
    }

    @Test
    fun `lamport clock only advances`() {
        queries.advanceCoreLamport(7)
        queries.advanceCoreLamport(3)

        assertEquals(7L, queries.selectCoreLamport().executeAsOne())
    }
}
