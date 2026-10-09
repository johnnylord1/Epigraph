package epigraph.sync.core.replica

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter

class SqlDelightCoreLamportSourceTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `lamport never falls behind the wall clock and stays strictly increasing`() = runTest {
        var now = 5_000L
        val source = SqlDelightCoreLamportSource(handler, wallClock = { now })

        assertEquals(5_000L, source.nextLamport())
        assertEquals(5_001L, source.nextLamport())

        // A desktop delete stamped later than the phone's clock still moves the counter past it.
        database.aethon_syncQueries.advanceCoreLamport(9_000L)
        assertEquals(9_001L, source.nextLamport())

        now = 20_000L
        assertEquals(20_000L, source.nextLamport())
    }

    @Test
    fun `a permanently refused outbox row no longer holds the entity`() {
        database.aethon_syncQueries.enqueueMutation(
            clientMutationId = "refused",
            deviceId = "phone-a",
            scopeId = SCOPE_ID,
            entityType = "book.progress",
            entityId = "book-1",
            operation = "merge",
            payloadJson = "{}",
            createdAt = 1,
            nextAttemptAt = 1,
        )
        assertTrue(isHeld())

        driver.execute(
            null,
            "UPDATE aethon_sync_outbox SET status = 'ERROR', last_error = 'blocked:invalid_patch'",
            0,
        )
        assertFalse(isHeld())

        driver.execute(
            null,
            "UPDATE aethon_sync_outbox SET status = 'ERROR', last_error = 'timeout'",
            0,
        )
        assertTrue(isHeld())
    }

    private fun isHeld(): Boolean = database.aethon_syncQueries.hasBlockingMutationForObservedVersion(
        scopeId = SCOPE_ID,
        entityType = "book.progress",
        entityId = "book-1",
        observedServerVersion = 10,
    ).executeAsOne()

    private companion object {
        const val SCOPE_ID = "books:global"
    }
}
