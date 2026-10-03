package epigraph.sync.core.novels
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import yokai.data.Database

class SqlDelightLnReaderDependencyInventoryStoreTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also(Database.Schema::create)
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val store = SqlDelightLnReaderDependencyInventoryStore(database, clock = { 200 })

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `inventory survives store recreation and remains scoped`() = runTest {
        val inventory = LnReaderDependencyInventory(
            serverId = "desktop-a",
            profileId = "main",
            generatedAtMs = 100,
            fingerprint = "a".repeat(64),
            repositories = listOf(
                LnReaderRepositoryInventoryItem(
                    requirement = CoreNovelRepositoryRequirement(
                        repositoryId = "repo-a",
                        canonicalUrl = "https://example.invalid/plugins.min.json",
                        displayName = "Example",
                        enabled = true,
                    ),
                    status = LnReaderRepositoryParityStatus.APPROVAL_REQUIRED,
                    configuredIndexUrl = null,
                ),
            ),
            plugins = emptyList(),
        )

        store.replace(inventory)

        val reopened = SqlDelightLnReaderDependencyInventoryStore(database)
        assertEquals(inventory, reopened.get("desktop-a", "main"))
        assertNull(reopened.get("desktop-b", "main"))
    }
}
