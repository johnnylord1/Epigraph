package epigraph.sync.core.portable
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import epigraph.contract.DecimalSourceId
import epigraph.contract.PortableIdentityV3
import kotlinx.serialization.json.JsonObject
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.sync.portable.PortableWorkBindingRecord
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class SqlDelightPortableHydrationStoreTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also(Database.Schema::create)
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `bound portable work remains visible after the paired session is unavailable`() = runTest {
        database.mangasQueries.insert(
            source = 10002,
            url = "/Manga/KeepCase?part=A%2FB",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Offline comic",
            status = 0,
            thumbnailUrl = "https://covers.example/offline.jpg",
            favorite = false,
            lastUpdate = null,
            initialized = true,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = null,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )
        val localId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        val ref = PortableWorkRef.Comic(
            DecimalSourceId("10002"),
            ProviderOwnedKey("/Manga/KeepCase?part=A%2FB"),
        )
        val record = PortableWorkBindingRecord(
            portableId = PortableIdentityV3.workId(ref),
            ref = ref,
            localReference = localId.toString(),
            resolution = PortableResolution(PortableResolutionState.BOUND),
            titleHint = "Offline comic",
            providerLabelHint = "Fixture",
            attemptCount = 1,
            updatedAt = 100,
        )

        SqlDelightPortableHydrationStore(handler).persist(
            comicDependencies = emptyList(),
            novelDependencies = emptyList(),
            works = listOf(record),
        )

        assertTrue(database.mangasQueries.findById(localId).executeAsOne().favorite)
    }

    @Test
    fun `bound comic whose local row still uses another source is hydrated again`() = runTest {
        database.mangasQueries.insert(
            source = epigraph.sync.core.suwayomi.EpigraphCoreSource.ID,
            url = "aethon-core://suwayomi/main/manga/1",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Bridge placeholder",
            status = 0,
            thumbnailUrl = null,
            favorite = true,
            lastUpdate = null,
            initialized = true,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = null,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )
        val localId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        val ref = PortableWorkRef.Comic(
            DecimalSourceId("2522335540328470744"),
            ProviderOwnedKey("https://www.webtoons.com/example"),
        )
        val record = PortableWorkBindingRecord(
            portableId = PortableIdentityV3.workId(ref),
            ref = ref,
            localReference = localId.toString(),
            resolution = PortableResolution(PortableResolutionState.BOUND),
            titleHint = "Bridge placeholder",
            providerLabelHint = "Webtoons.com",
            attemptCount = 1,
            updatedAt = 1,
        )
        val bindings = epigraph.sync.portable.SqlDelightPortableBindingStore(database)
        bindings.upsertWork(record)
        bindings.markManifestMembership("server", "main", record.portableId, 1)

        val snapshot = SqlDelightPortableHydrationStore(handler).load("server", "main", 10)

        assertEquals(listOf(record.portableId), snapshot.works.map { it.portableId })
    }
}
