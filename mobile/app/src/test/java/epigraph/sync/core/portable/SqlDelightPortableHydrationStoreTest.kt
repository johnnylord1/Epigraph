package epigraph.sync.core.portable
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import epigraph.contract.DecimalSourceId
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableIdentityV3
import kotlinx.serialization.json.JsonObject
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.sync.portable.PortableChapterBindingRecord
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

    @Test
    fun `chapter states confirmed before their chapters were bound are applied on binding`() = runTest {
        database.mangasQueries.insert(
            source = 8531542650987673943,
            url = "/series/165",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Restored comic",
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
        val mangaId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        val work = PortableWorkRef.Comic(DecimalSourceId("8531542650987673943"), ProviderOwnedKey("/series/165"))
        val workId = PortableIdentityV3.workId(work)
        val bindings = epigraph.sync.portable.SqlDelightPortableBindingStore(database)
        bindings.upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Restored comic",
                providerLabelHint = null,
                attemptCount = 1,
                updatedAt = 1,
            ),
        )
        val chapters = listOf("/series/165/a", "/series/165/b").mapIndexed { index, key ->
            database.chaptersQueries.insert(
                mangaId = mangaId,
                url = key,
                name = "Chapter ${index + 1}",
                scanlator = null,
                read = false,
                bookmark = false,
                lastPageRead = 0,
                pagesLeft = 0,
                chapterNumber = index + 1.0,
                sourceOrder = index.toLong(),
                dateFetch = 0,
                dateUpload = 0,
                memo = JsonObject(emptyMap()),
            )
            val localId = database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
            val ref = PortableChapterRef.Comic(work, ProviderOwnedKey(key))
            val chapterId = PortableIdentityV3.chapterId(ref)
            val entityId = "comic.chapter_state::$workId::$chapterId"
            database.aethon_syncQueries.upsertCoreReplicaRecord(
                scopeId = "comics:profile:main",
                entityType = "comic.chapter_state",
                entityId = entityId,
                serverVersion = 10L + index,
                lamport = 1,
                recordJson = """{"chapterId":"$chapterId","comicId":"$workId","read":true,""" +
                    """"portableWorkRef":{"type":"comic","sourceId":"8531542650987673943","mangaKey":"/series/165"},""" +
                    """"portableChapterRef":{"type":"comic","chapterKey":"$key",""" +
                    """"work":{"type":"comic","sourceId":"8531542650987673943","mangaKey":"/series/165"}}}""",
                payloadSha256 = "0".repeat(64),
            )
            PortableChapterBindingRecord(
                portableChapterId = chapterId,
                portableWorkId = workId,
                ref = ref,
                localReference = localId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                attemptCount = 1,
                updatedAt = 1,
            )
        }

        SqlDelightPortableHydrationStore(handler).persist(
            comicDependencies = emptyList(),
            novelDependencies = emptyList(),
            works = emptyList(),
            chapters = chapters,
        )

        assertEquals(
            listOf(true, true),
            database.chaptersQueries.getChaptersByMangaId(mangaId, 0).executeAsList().map { it.read },
        )
    }

    @Test
    fun `tracking confirmed before its work had a local row reaches it once the work is persisted`() = runTest {
        database.mangasQueries.insert(
            source = 10002,
            url = "/Manga/Tracked",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Tracked comic",
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
        val ref = PortableWorkRef.Comic(DecimalSourceId("10002"), ProviderOwnedKey("/Manga/Tracked"))
        val workId = PortableIdentityV3.workId(ref)
        database.aethon_syncQueries.upsertCoreReplicaRecord(
            scopeId = "comics:profile:main",
            entityType = "comic.tracking",
            entityId = "comic.tracking::$workId::anilist",
            serverVersion = 10,
            lamport = 1,
            recordJson = """{"comicId":"$workId","trackerKey":"anilist","remoteId":4242,"title":"Tracked",""" +
                """"remoteUrl":"https://anilist.co/manga/4242","status":1,"progress":3.0,""" +
                """"totalChapters":10,"score":7.0,"updatedAtMs":100}""",
            payloadSha256 = "0".repeat(64),
        )

        SqlDelightPortableHydrationStore(handler).persist(
            comicDependencies = emptyList(),
            novelDependencies = emptyList(),
            works = listOf(
                PortableWorkBindingRecord(
                    portableId = workId,
                    ref = ref,
                    localReference = localId.toString(),
                    resolution = PortableResolution(PortableResolutionState.BOUND),
                    titleHint = "Tracked comic",
                    providerLabelHint = null,
                    attemptCount = 1,
                    updatedAt = 1,
                ),
            ),
        )

        assertEquals(4242L, database.manga_syncQueries.getAllByMangaId(localId).executeAsList().single().remote_id)
    }
}
