package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.Database
import yokai.data.memoColumnAdapter

class V4DigestExistenceTest {
    private fun createStore(): SqlDelightV4SyncStore {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        Database.Schema.create(driver)
        val db = Database(
            driver = driver,
            mangasAdapter = Mangas.Adapter(memoAdapter = memoColumnAdapter),
            chaptersAdapter = Chapters.Adapter(memoAdapter = memoColumnAdapter),
        )
        return SqlDelightV4SyncStore(db)
    }

    @Test
    fun `hasDigests is false until a baseline row exists for that server and profile`() {
        val store = createStore()
        assertFalse(store.hasDigests("server-a", "profile-1"))

        store.saveDigests(
            "server-a",
            "profile-1",
            mapOf(V4DigestKey("manga", "work", "w1") to V4StoredDigest("d1", deleted = false)),
        )

        assertTrue(store.hasDigests("server-a", "profile-1"))
        assertFalse(store.hasDigests("server-a", "profile-2"))
        assertFalse(store.hasDigests("server-b", "profile-1"))
    }
}
