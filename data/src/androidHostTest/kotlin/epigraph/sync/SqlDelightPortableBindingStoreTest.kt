package epigraph.sync

import epigraph.contract.DecimalSourceId
import epigraph.contract.ComicDependency
import epigraph.contract.ExtensionStoreReference
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.sync.portable.PortableChapterBindingRecord
import epigraph.sync.portable.PortableComicDependencyRecord
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import epigraph.sync.portable.SqlDelightPortableDependencyStore
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import yokai.data.Database

class SqlDelightPortableBindingStoreTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
        it.execute(null, "PRAGMA foreign_keys = ON", 0)
    }
    private val database = Database(
        driver,
        chaptersAdapter = tachiyomi.data.Chapters.Adapter(yokai.data.memoColumnAdapter),
        mangasAdapter = tachiyomi.data.Mangas.Adapter(yokai.data.memoColumnAdapter),
    )
    private val store = SqlDelightPortableBindingStore(database)
    private val dependencies = SqlDelightPortableDependencyStore(database)

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `pending comic keeps opaque key and minimal hints without a local id`() {
        val ref = PortableWorkRef.Comic(
            DecimalSourceId("-10002"),
            ProviderOwnedKey("/Manga/Keep-Case?view=AbC%2F123"),
        )
        store.upsertWork(
            PortableWorkBindingRecord(
                portableId = "portable:comic:fixture",
                ref = ref,
                localReference = null,
                resolution = PortableResolution(
                    PortableResolutionState.REQUIRES_USER_ACTION,
                    PortableResolutionReason.EXTENSION_STORE_APPROVAL_REQUIRED,
                ),
                titleHint = "Display hint",
                providerLabelHint = "Provider hint",
                attemptCount = 0,
                updatedAt = 1,
            ),
        )

        val restored = store.work(ref)!!
        assertEquals(ref, restored.ref)
        assertNull(restored.localReference)
        assertEquals("Display hint", restored.titleHint)
    }

    @Test
    fun `bound work and chapter keep local ids outside their portable identity`() {
        val workRef = PortableWorkRef.Novel("plugin.example", ProviderOwnedKey("series/one"))
        store.upsertWork(
            PortableWorkBindingRecord(
                portableId = "portable:novel:fixture",
                ref = workRef,
                localReference = "42",
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 1,
                updatedAt = 2,
            ),
        )
        val chapterRef = PortableChapterRef.Novel(workRef, ProviderOwnedKey("chapter/one?lang=en"))
        store.upsertChapter(
            PortableChapterBindingRecord(
                portableChapterId = "portable:novel-chapter:fixture",
                portableWorkId = "portable:novel:fixture",
                ref = chapterRef,
                localReference = "918",
                resolution = PortableResolution(PortableResolutionState.BOUND),
                attemptCount = 1,
                updatedAt = 3,
            ),
        )

        assertEquals("42", store.work(workRef)?.localReference)
        assertEquals("918", store.chapter("portable:novel-chapter:fixture")?.localReference)
        assertEquals(chapterRef, store.chapters("portable:novel:fixture").single().ref)
    }

    @Test
    fun `comic dependency persists store provenance separately from exact source readiness`() {
        val dependency = ComicDependency(
            pkgName = "eu.kanade.tachiyomi.extension.en.example",
            requiredSourceIds = setOf(DecimalSourceId("-9"), DecimalSourceId("10")),
            observedVersionCode = "42",
            extensionStore = ExtensionStoreReference(
                storeIndexUrl = "https://store.example/index.min.json",
                observedManifestSha256 = "a".repeat(64),
                displayNameHint = "Example Store",
            ),
        )
        dependencies.upsertComic(
            PortableComicDependencyRecord(
                serverId = "server-a",
                profileId = "main",
                dependency = dependency,
                trustState = "TRUSTED",
                resolution = PortableResolution(PortableResolutionState.READY),
                updatedAt = 4,
            ),
        )

        val restored = dependencies.comics("server-a", "main").single()
        assertEquals(dependency, restored.dependency)
        assertEquals(PortableResolutionState.READY, restored.resolution.state)
        assertEquals("TRUSTED", restored.trustState)
    }

    @Test
    fun `pending hydration is isolated by server and profile manifest membership`() {
        val ref = PortableWorkRef.Comic(DecimalSourceId("10"), ProviderOwnedKey("/series/one"))
        store.upsertWork(
            PortableWorkBindingRecord(
                portableId = "comic:scoped-fixture",
                ref = ref,
                localReference = null,
                resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 5,
            ),
        )
        store.markManifestMembership("server-a", "main", "comic:scoped-fixture", 5)

        assertEquals(listOf("comic:scoped-fixture"), store.pendingWorks("server-a", "main", 10).map { it.portableId })
        assertEquals(emptyList<PortableWorkBindingRecord>(), store.pendingWorks("server-b", "main", 10))
        assertEquals(emptyList<PortableWorkBindingRecord>(), store.pendingWorks("server-a", "secondary", 10))
    }

    @Test
    fun `bound novel is pending until its local work and chapter catalogue exist`() {
        val ref = PortableWorkRef.Novel("plugin.example", ProviderOwnedKey("series/repair"))
        store.upsertWork(
            PortableWorkBindingRecord(
                portableId = "novel:repair-fixture",
                ref = ref,
                localReference = "42",
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Repair fixture",
                providerLabelHint = null,
                attemptCount = 1,
                updatedAt = 6,
            ),
        )
        store.markManifestMembership("server-a", "main", "novel:repair-fixture", 6)

        assertEquals(listOf("novel:repair-fixture"), store.pendingWorks("server-a", "main", 10).map { it.portableId })

        driver.execute(
            identifier = null,
            sql = """
                INSERT INTO mangas(
                    _id, source, url, title, status, favorite, initialized, viewer,
                    hide_title, chapter_flags, update_strategy, cover_last_modified,
                    next_update, fetch_interval
                ) VALUES (42, 7, 'series/repair', 'Repair fixture', 1, 1, 1, 0, 0, 0, 0, 0, 0, 0)
            """.trimIndent(),
            parameters = 0,
        )
        assertEquals(listOf("novel:repair-fixture"), store.pendingWorks("server-a", "main", 10).map { it.portableId })

        driver.execute(
            identifier = null,
            sql = """
                INSERT INTO chapters(
                    _id, manga_id, url, name, read, bookmark, last_page_read,
                    pages_left, chapter_number, source_order, date_fetch, date_upload
                ) VALUES (84, 42, 'chapter/one', 'Chapter 1', 0, 0, 0, 0, 1, 0, 0, 0)
            """.trimIndent(),
            parameters = 0,
        )

        assertEquals(emptyList<PortableWorkBindingRecord>(), store.pendingWorks("server-a", "main", 10))
    }
}
