package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.Assert.assertEquals
import org.junit.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.Database
import yokai.data.memoColumnAdapter

/**
 * Keyset-paged digest reads must return exactly the map a single unpaged read returns. The test
 * compares them on rows that cross page boundaries (one row per page, exact multiples, and a page larger
 * than the table) and with a second profile in the same table.
 */
class V4DigestPagingTest {

    @Test
    fun pagedDigestReadMatchesTheWholeTableRead() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        Database.Schema.create(driver)
        val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
        val store = SqlDelightV4SyncStore(database)

        val expected = LinkedHashMap<V4DigestKey, V4StoredDigest>()
        for (domain in listOf("comics", "novels")) {
            for (type in listOf("comic.work", "comic.chapter", "comic.category")) {
                for (index in 0 until 23) {
                    val key = V4DigestKey(domain, type, "k/${index.toString().padStart(3, '0')}")
                    expected[key] = V4StoredDigest("digest-$index", deleted = index % 5 == 0)
                }
            }
        }
        store.saveDigests("srv-1", "main", expected)
        store.saveDigests(
            "srv-1", "other",
            mapOf(V4DigestKey("comics", "comic.work", "k/000") to V4StoredDigest("other", deleted = false)),
        )

        val whole = database.v4_syncQueries.selectV4LocalDigests("srv-1", "main").executeAsList()
            .associate { row ->
                V4DigestKey(row.domain, row.entity_type, row.entity_key) to
                    V4StoredDigest(row.digest, row.deleted != 0L)
            }
        assertEquals(expected, whole)

        for (pageRows in listOf(1L, 2L, 23L, 24L, 69L, 70L, V4_DIGEST_PAGE_ROWS)) {
            assertEquals("page size $pageRows", whole, store.loadDigests("srv-1", "main", pageRows))
        }
        assertEquals(emptyMap<V4DigestKey, V4StoredDigest>(), store.loadDigests("srv-1", "nobody"))
        driver.close()
    }
}
