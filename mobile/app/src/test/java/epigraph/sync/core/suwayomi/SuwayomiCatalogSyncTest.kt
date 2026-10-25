package epigraph.sync.core.suwayomi
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreSyncStatus
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiCatalogPage
import epigraph.sync.core.protocol.SuwayomiCatalogResponse
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.replica.EpigraphCoreDomainProjection
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import epigraph.sync.core.work.CompositeCoreReplicaSync
import epigraph.sync.core.work.CoreReplicaSyncPort
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class SuwayomiCatalogSyncTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val session = CoreCredentialSession(
        origin = "https://core.test/",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "pairing",
        profileId = PROFILE,
        tokenId = "token",
        scopes = listOf("comics:profile:$PROFILE", "books:global"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        serverId = SERVER,
        accessTokenUtf8 = byteArrayOf(1, 2, 3),
    )

    @AfterEach
    fun close() {
        session.close()
        driver.close()
    }

    @Test
    fun `stale server references are rebound to the current core instead of duplicating`() = runTest {
        val staleServer = "desktop-zero"
        val staleEntityId = "suwayomi:server:$staleServer:profile:$PROFILE:manga:7"
        database.aethon_syncQueries.upsertIdentity(
            entityId = staleEntityId,
            contentType = "MANGA",
            localReference = "1",
            createdAt = 0,
            updatedAt = 0,
        )
        database.aethon_syncQueries.upsertCoreRemoteIdentity(
            entityId = staleEntityId,
            serverId = staleServer,
            profileId = PROFILE,
            remoteType = "SUWAYOMI_MANGA",
            remoteId = "7",
            bindingStatus = "BOUND",
            updatedAt = 0,
        )
        database.mangasQueries.insert(
            source = EpigraphCoreSource.ID,
            url = "aethon-core://suwayomi/$staleServer/$PROFILE/manga/7",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Stranded",
            status = 0,
            thumbnailUrl = null,
            favorite = true,
            lastUpdate = 0,
            initialized = true,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = 0,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )

        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val sync = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = false, includeCategoryAssignment = false),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        )

        val outcome = sync.synchronize(session, capabilities(), 1000)

        assertEquals(epigraph.sync.core.work.CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(1, database.mangasQueries.findFavorites().executeAsList().size)
        val rebound = database.aethon_syncQueries
            .selectCoreRemoteIdentity(SERVER, PROFILE, "SUWAYOMI_MANGA", "7")
            .executeAsOne()
        assertEquals(staleEntityId, rebound.entity_id)
        assertEquals("BOUND", rebound.binding_status)
        val manga = database.mangasQueries.findFavorites().executeAsList().single()
        assertEquals(
            SuwayomiCoreContentReference.Manga(SERVER, PROFILE, 7),
            SuwayomiCoreContentReference.parseManga(manga.url),
        )
    }

    @Test
    fun `unproven stale rows are left untouched`() = runTest {
        val staleServer = "desktop-zero"
        val staleEntityId = "suwayomi:server:$staleServer:profile:$PROFILE:manga:7"
        database.aethon_syncQueries.upsertIdentity(
            entityId = staleEntityId,
            contentType = "MANGA",
            localReference = "1",
            createdAt = 0,
            updatedAt = 0,
        )
        database.aethon_syncQueries.upsertCoreRemoteIdentity(
            entityId = staleEntityId,
            serverId = staleServer,
            profileId = PROFILE,
            remoteType = "SUWAYOMI_MANGA",
            remoteId = "7",
            bindingStatus = "BOUND",
            updatedAt = 0,
        )
        // Native source row: the bridge proof fails, so nothing may be rewritten.
        database.mangasQueries.insert(
            source = 42,
            url = "/manga/7",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Native",
            status = 0,
            thumbnailUrl = null,
            favorite = true,
            lastUpdate = 0,
            initialized = true,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = 0,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )

        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val sync = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = false, includeCategoryAssignment = false),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        )

        sync.synchronize(session, capabilities(), 1000)

        // The native row is untouched; the catalog legitimately materializes a new bridge row.
        val native = database.mangasQueries.findFavorites().executeAsList().first { it.source == 42L }
        assertEquals("/manga/7", native.url)
        val stale = database.aethon_syncQueries
            .selectCoreRemoteIdentityByEntityId(staleEntityId)
            .executeAsOne()
        assertEquals(staleServer, stale.server_id)
    }

    @Test
    fun `catalog pages materialize library and categories without eager chapter loading`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val materializedCovers = mutableListOf<CoreCatalogCoverReference>()
        val sync = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { materializedCovers += it },
            pageSize = 1,
        )

        val outcome = sync.synchronize(session, capabilities(), 1000)

        assertEquals(epigraph.sync.core.work.CoreReplicaSyncOutcome.APPLIED, outcome)
        val mangas = database.mangasQueries.findFavorites().executeAsList()
        assertEquals(2, mangas.size)
        assertEquals("Suwayomi One", mangas.first().title)
        assertTrue(mangas.first().initialized)
        assertEquals(2, materializedCovers.size)
        assertTrue(mangas.first().thumbnail_url!!.startsWith("aethon-core://"))
        assertEquals(
            SuwayomiCoreThumbnailReference.Parsed(SERVER, PROFILE, 7),
            SuwayomiCoreThumbnailReference.parse(mangas.first().thumbnail_url!!),
        )
        val remoteIdentity = database.aethon_syncQueries
            .selectCoreRemoteIdentity(SERVER, PROFILE, "SUWAYOMI_MANGA", "7")
            .executeAsOne()
        assertEquals("BOUND", remoteIdentity.binding_status)
        assertEquals(
            "suwayomi:server:$SERVER:profile:$PROFILE:manga:7",
            remoteIdentity.entity_id,
        )
        val sourceBinding = database.aethon_syncQueries
            .selectBindingsByEntityId(remoteIdentity.entity_id)
            .executeAsList()
            .single()
        assertEquals(EXTENSION_PACKAGE, sourceBinding.plugin_package)
        assertEquals("42", sourceBinding.source_id)

        val category = database.categoriesQueries.findAllByMangaId(mangas.first()._id).executeAsList().single()
        assertEquals("Remote Favorites", category.name)

        val binding = database.aethon_syncQueries
            .selectChapterBindingByEntityId("suwayomi:profile:$PROFILE:chapter:900")
            .executeAsOneOrNull()
        assertNull(binding)
    }

    @Test
    fun `suwayomi default category is accepted but not materialized as a user folder`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val sync = SuwayomiCatalogSync(
            pages = FixturePages(
                includeSecondManga = false,
                includeCategoryAssignment = false,
                categoryId = 0,
            ),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
        )

        val outcome = sync.synchronize(session, capabilities(), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertTrue(database.categoriesQueries.findAll().executeAsList().isEmpty())
    }

    @Test
    fun `thumbnail references encode and decode path segments without Android Uri`() {
        val reference = SuwayomiCoreThumbnailReference.forManga("profile/main", 7)

        assertEquals("aethon-core://suwayomi/profile%2Fmain/manga/7", reference)
        assertEquals(
            SuwayomiCoreThumbnailReference.Parsed(null, "profile/main", 7),
            SuwayomiCoreThumbnailReference.parse(reference),
        )
    }

    @Test
    fun `later catalog sync preserves a locally proven extension binding`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val sync = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = false),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
        )
        sync.synchronize(session, capabilities(), 1000)
        val manga = database.mangasQueries.findFavorites().executeAsOne()
        database.mangasQueries.update(
            source = 42,
            url = "https://source.test/manga/7",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = null,
            status = null,
            thumbnailUrl = null,
            favorite = null,
            lastUpdate = null,
            initialized = null,
            viewer = null,
            hideTitle = null,
            chapterFlags = null,
            dateAdded = null,
            filteredScanlators = null,
            updateStrategy = null,
            coverLastModified = null,
            nextUpdate = null,
            fetchInterval = null,
            memo = null,
            mangaId = manga._id,
        )

        sync.synchronize(session, capabilities(), 2000)

        val refreshed = database.mangasQueries.findById(manga._id).executeAsOne()
        assertEquals(42, refreshed.source)
        assertEquals("https://source.test/manga/7", refreshed.url)
    }

    @Test
    fun `catalog still runs when the snapshot replica needs a retry`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val catalog = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        )

        val outcome = CompositeCoreReplicaSync(
            replica = CoreReplicaSyncPort { _, _, _ -> CoreReplicaSyncOutcome.RETRY },
            catalog = catalog,
        ).synchronize(session, capabilities(), 1000)

        assertEquals(CoreReplicaSyncOutcome.RETRY, outcome)
        assertEquals(2, database.mangasQueries.findFavorites().executeAsList().size)
    }

    @Test
    fun `catalog still runs when the snapshot replica throws`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val catalog = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        )

        val outcome = CompositeCoreReplicaSync(
            replica = CoreReplicaSyncPort { _, _, _ -> error("fixture replica failure") },
            catalog = catalog,
        ).synchronize(session, capabilities(), 1000)

        assertEquals(CoreReplicaSyncOutcome.RETRY, outcome)
        assertEquals(2, database.mangasQueries.findFavorites().executeAsList().size)
    }

    @Test
    fun `portable manifest resolves before catalog projection`() = runTest {
        val order = mutableListOf<String>()

        val outcome = CompositeCoreReplicaSync(
            replica = CoreReplicaSyncPort { _, _, _ -> CoreReplicaSyncOutcome.DEFERRED },
            catalog = CoreReplicaSyncPort { _, _, _ ->
                order += "catalog"
                CoreReplicaSyncOutcome.APPLIED
            },
            portableManifest = CoreReplicaSyncPort { _, _, _ ->
                order += "portable"
                CoreReplicaSyncOutcome.APPLIED
            },
        ).synchronize(session, capabilities(), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(listOf("portable", "catalog"), order)
    }

    @Test
    fun `novel plugin inventory is built after the replica commits declarations`() = runTest {
        val order = mutableListOf<String>()
        val novelSession = session.copyWithServerMetadata(scopes = session.scopes + "novels:profile:$PROFILE")

        val outcome = novelSession.use { selected ->
            CompositeCoreReplicaSync(
                replica = CoreReplicaSyncPort { _, _, _ ->
                    order += "replica"
                    CoreReplicaSyncOutcome.APPLIED
                },
                catalog = CoreReplicaSyncPort { _, _, _ -> CoreReplicaSyncOutcome.DEFERRED },
                novelPlugins = CoreReplicaSyncPort { _, _, _ ->
                    order += "novelPlugins"
                    CoreReplicaSyncOutcome.APPLIED
                },
            ).synchronize(selected, capabilities(), 1000)
        }

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(listOf("replica", "novelPlugins"), order)
    }

    @Test
    fun `confirmed comic state replays independently from the Suwayomi catalog`() = runTest {
        var replicaScopes = emptyList<String>()
        var catalogScopes = emptyList<String>()

        val outcome = CompositeCoreReplicaSync(
            replica = CoreReplicaSyncPort { selected, _, _ ->
                replicaScopes = selected.scopes
                CoreReplicaSyncOutcome.APPLIED
            },
            catalog = CoreReplicaSyncPort { selected, _, _ ->
                catalogScopes = selected.scopes
                CoreReplicaSyncOutcome.APPLIED
            },
        ).synchronize(session, capabilities(), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(setOf("comics:profile:$PROFILE", "books:global"), replicaScopes.toSet())
        assertEquals(session.scopes, catalogScopes)
    }

    @Test
    fun `complete library refresh demotes removed entries without deleting local metadata`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val first = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = true),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        )
        first.synchronize(session, capabilities(), 1000)

        val second = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = false),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        )
        val outcome = second.synchronize(session, capabilities(), 2000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(1, database.mangasQueries.findFavorites().executeAsList().size)
        assertEquals("Suwayomi Two", database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi Two" }.title)
        assertEquals(false, database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi Two" }.favorite)
    }

    @Test
    fun `complete category refresh removes only stale assignments from the same Core scope`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        SuwayomiCatalogSync(
            pages = FixturePages(includeCategoryAssignment = true),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(), 1000)
        val manga = database.mangasQueries.findFavorites().executeAsList().first()
        database.categoriesQueries.insert("Local only", 99, 0, "a")
        val localCategoryId = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.insertMangaCategoryAssignment(manga._id, localCategoryId)

        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(includeCategoryAssignment = false),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(), 2000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(
            listOf("Local only"),
            database.categoriesQueries.findAllByMangaId(manga._id).executeAsList().map { it.name },
        )
    }

    @Test
    fun `incomplete terminal page retries without demoting library rows`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = true),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(), 1000)

        val incomplete = object : SuwayomiCatalogPageSource {
            override suspend fun read(
                session: CoreCredentialSession,
                operation: SuwayomiCatalogOperation,
                pageSize: Long,
                offset: Long,
                mangaId: Long?,
            ): CoreHttpResult<SuwayomiCatalogResponse> {
                val response = FixturePages(includeSecondManga = false)
                    .read(session, operation, pageSize, offset, mangaId)
                if (operation != SuwayomiCatalogOperation.LIBRARY || response !is CoreHttpResult.Success) {
                    return response
                }
                return CoreHttpResult.Success(
                    response.value.copy(
                        page = response.value.page.copy(totalCount = 2),
                    ),
                )
            }
        }
        val outcome = SuwayomiCatalogSync(
            pages = incomplete,
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(), 2000)

        assertEquals(CoreReplicaSyncOutcome.RETRY, outcome)
        assertEquals(2, database.mangasQueries.findFavorites().executeAsList().size)
    }

    @Test
    fun `unpaired catalog request preserves the last known library`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = true),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(), 1000)
        val before = database.mangasQueries.findFavorites().executeAsList()

        val unpaired = SuwayomiCatalogPageSource { _, _, _, _, _ ->
            CoreHttpResult.Failure(401, null)
        }
        val outcome = SuwayomiCatalogSync(
            pages = unpaired,
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(), 2000)

        assertEquals(CoreReplicaSyncOutcome.NEEDS_USER_ACTION, outcome)
        assertEquals(before, database.mangasQueries.findFavorites().executeAsList())
        assertTrue(before.all { it.initialized })
    }

    @Test
    fun `credential v2 binds proven legacy rows without changing local ids`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val sync = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = false),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        )
        val legacy = session(LEGACY_UNBOUND_SERVER_ID)
        try {
            sync.synchronize(legacy, capabilities(), 1000)
        } finally {
            legacy.close()
        }
        val before = database.mangasQueries.findFavorites().executeAsList().single()

        sync.synchronize(session, capabilities(), 2000)

        val after = database.mangasQueries.findFavorites().executeAsList().single()
        assertEquals(before._id, after._id)
        assertEquals(1, database.mangasQueries.findAll().executeAsList().size)
        val binding = database.aethon_syncQueries
            .selectCoreRemoteIdentityByEntityId("suwayomi:profile:$PROFILE:manga:7")
            .executeAsOne()
        assertEquals(SERVER, binding.server_id)
        assertEquals("BOUND", binding.binding_status)
        // The V1 category is rebound to the V2 server together with the proven legacy rows, so
        // the phone keeps one "Remote Favorites" instead of a duplicate.
        assertEquals(
            1,
            database.categoriesQueries.findAll().executeAsList().count { it.name == "Remote Favorites" },
        )
    }

    @Test
    fun `catalog defers when the Core does not advertise the catalog bridge`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val sync = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        )

        val outcome = sync.synchronize(
            session,
            capabilities().copy(supportsSuwayomiCatalog = false),
            1000,
        )

        assertEquals(CoreReplicaSyncOutcome.DEFERRED, outcome)
        assertTrue(database.mangasQueries.findFavorites().executeAsList().isEmpty())
    }

    @Test
    fun `catalog reconciles more than six hundred works without eager chapter requests`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        var chapterRequests = 0
        val pages = largeLibraryPages(total = 601L) { operation, _ ->
            if (operation == SuwayomiCatalogOperation.CHAPTERS) chapterRequests += 1
        }

        val outcome = SuwayomiCatalogSync(
            pages = pages,
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 100,
        ).synchronize(session, capabilities(), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(601, database.mangasQueries.findFavorites().executeAsList().size)
        assertEquals(0, chapterRequests)
    }

    @Test
    fun `library pages after the first are read a few at a time`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        var inFlight = 0
        var maxInFlight = 0
        val pages = largeLibraryPages(total = 901L) { operation, _ ->
            if (operation != SuwayomiCatalogOperation.LIBRARY) return@largeLibraryPages
            inFlight += 1
            maxInFlight = maxOf(maxInFlight, inFlight)
            delay(100)
            inFlight -= 1
        }

        val outcome = SuwayomiCatalogSync(
            pages = pages,
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 100,
        ).synchronize(session, capabilities(), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(901, database.mangasQueries.findFavorites().executeAsList().size)
        assertTrue(maxInFlight in 2..SuwayomiCatalogSync.PARALLEL_PAGE_READS, "max in flight: $maxInFlight")
    }

    @Test
    fun `a failed later library page retries without demoting library rows`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        SuwayomiCatalogSync(
            pages = largeLibraryPages(total = 301L),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 100,
        ).synchronize(session, capabilities(), 1000)

        val healthy = largeLibraryPages(total = 301L)
        val failing = SuwayomiCatalogPageSource { session, operation, pageSize, offset, mangaId ->
            if (operation == SuwayomiCatalogOperation.LIBRARY && offset == 200L) {
                CoreHttpResult.Failure(statusCode = 503, errorEnvelope = null)
            } else {
                healthy.read(session, operation, pageSize, offset, mangaId)
            }
        }
        val outcome = SuwayomiCatalogSync(
            pages = failing,
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 100,
        ).synchronize(session, capabilities(), 2000)

        assertEquals(CoreReplicaSyncOutcome.RETRY, outcome)
        assertEquals(301, database.mangasQueries.findFavorites().executeAsList().size)
    }

    private fun largeLibraryPages(
        total: Long,
        onRead: suspend (SuwayomiCatalogOperation, Long) -> Unit = { _, _ -> },
    ) = SuwayomiCatalogPageSource { _, operation, pageSize, offset, _ ->
            onRead(operation, offset)
            val nodes = when (operation) {
                SuwayomiCatalogOperation.LIBRARY -> (offset until minOf(offset + pageSize, total)).map { id ->
                    buildJsonObject {
                        put("id", id + 1)
                        put("title", "Work ${id + 1}")
                        put("sourceId", 42)
                        put("realUrl", "https://source.test/manga/${id + 1}")
                        put("inLibrary", true)
                    }
                }
                SuwayomiCatalogOperation.CATEGORIES,
                SuwayomiCatalogOperation.CHAPTERS,
                -> emptyList()
            }
            val connection = when (operation) {
                SuwayomiCatalogOperation.LIBRARY -> "mangas"
                SuwayomiCatalogOperation.CATEGORIES -> "categories"
                SuwayomiCatalogOperation.CHAPTERS -> "chapters"
            }
            val operationTotal = if (operation == SuwayomiCatalogOperation.LIBRARY) total else 0L
            CoreHttpResult.Success(
                SuwayomiCatalogResponse(
                    schemaVersion = 1,
                    scopeId = "comics:profile:$PROFILE",
                    operation = operation.wireName,
                    generatedAtMs = 1000,
                    page = SuwayomiCatalogPage(
                        offset = offset,
                        pageSize = pageSize,
                        hasNextPage = offset + nodes.size < operationTotal,
                        totalCount = operationTotal,
                    ),
                    data = buildJsonObject {
                        put(connection, buildJsonObject {
                            put("nodes", buildJsonArray { nodes.forEach(::add) })
                        })
                    },
                ),
            )
        }

    @Test
    fun `catalog retries without reading pages while desktop projection is pending`() = runTest {
        var pageReads = 0
        val countingPages = object : SuwayomiCatalogPageSource {
            override suspend fun read(
                session: CoreCredentialSession,
                operation: SuwayomiCatalogOperation,
                pageSize: Long,
                offset: Long,
                mangaId: Long?,
            ): CoreHttpResult<SuwayomiCatalogResponse> {
                pageReads++
                return FixturePages().read(session, operation, pageSize, offset, mangaId)
            }
        }
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val status = FixtureStatus(
            CoreHttpResult.Success(
                CoreSyncStatus(
                    scopeId = "comics:profile:$PROFILE",
                    currentServerVersion = 1,
                    minReplayableServerVersion = 0,
                    comicAuthorityMode = "suwayomi-confirmed-v1",
                    suwayomiProjectionPending = 1,
                    suwayomiProjectionBlocked = 0,
                    suwayomiProjectionInFlight = 0,
                    ready = false,
                ),
            ),
        )
        val outcome = SuwayomiCatalogSync(
            pages = countingPages,
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            projectionStatus = status,
        ).synchronize(session, capabilities().copy(supportsSyncStatusV1 = true), 1000)

        assertEquals(CoreReplicaSyncOutcome.RETRY, outcome)
        assertEquals(0, pageReads)
        assertEquals(0, database.mangasQueries.findFavorites().executeAsList().size)
    }

    @Test
    fun `catalog retries while a desktop projection is in flight`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            projectionStatus = FixtureStatus(
                CoreHttpResult.Success(
                    CoreSyncStatus(
                        scopeId = "comics:profile:$PROFILE",
                        currentServerVersion = 1,
                        minReplayableServerVersion = 0,
                        comicAuthorityMode = "suwayomi-confirmed-v1",
                        suwayomiProjectionPending = 0,
                        suwayomiProjectionBlocked = 0,
                        suwayomiProjectionInFlight = 1,
                        ready = false,
                    ),
                ),
            ),
        ).synchronize(session, capabilities().copy(supportsSyncStatusV1 = true), 1000)

        assertEquals(CoreReplicaSyncOutcome.RETRY, outcome)
    }

    @Test
    fun `catalog applies once desktop projection is ready`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            projectionStatus = FixtureStatus(
                CoreHttpResult.Success(
                    CoreSyncStatus(
                        scopeId = "comics:profile:$PROFILE",
                        currentServerVersion = 1,
                        minReplayableServerVersion = 0,
                        comicAuthorityMode = "suwayomi-confirmed-v1",
                        suwayomiProjectionPending = 0,
                        suwayomiProjectionBlocked = 0,
                        suwayomiProjectionInFlight = 0,
                        ready = true,
                    ),
                ),
            ),
        ).synchronize(session, capabilities().copy(supportsSyncStatusV1 = true), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(2, database.mangasQueries.findFavorites().executeAsList().size)
    }

    @Test
    fun `catalog applies while the desktop applies only chapter progress`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            projectionStatus = FixtureStatus(
                CoreHttpResult.Success(
                    CoreSyncStatus(
                        scopeId = "comics:profile:$PROFILE",
                        currentServerVersion = 1,
                        minReplayableServerVersion = 0,
                        comicAuthorityMode = "suwayomi-confirmed-v1",
                        suwayomiProjectionPending = 40,
                        suwayomiProjectionBlocked = 0,
                        suwayomiProjectionInFlight = 8,
                        ready = false,
                        suwayomiCatalogProjectionPending = 0,
                    ),
                ),
            ),
        ).synchronize(session, capabilities().copy(supportsSyncStatusV1 = true), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(2, database.mangasQueries.findFavorites().executeAsList().size)
    }

    @Test
    fun `catalog retries while the desktop applies a catalog change`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            projectionStatus = FixtureStatus(
                CoreHttpResult.Success(
                    CoreSyncStatus(
                        scopeId = "comics:profile:$PROFILE",
                        currentServerVersion = 1,
                        minReplayableServerVersion = 0,
                        comicAuthorityMode = "suwayomi-confirmed-v1",
                        suwayomiProjectionPending = 1,
                        suwayomiProjectionBlocked = 0,
                        suwayomiProjectionInFlight = 0,
                        ready = false,
                        suwayomiCatalogProjectionPending = 1,
                    ),
                ),
            ),
        ).synchronize(session, capabilities().copy(supportsSyncStatusV1 = true), 1000)

        assertEquals(CoreReplicaSyncOutcome.RETRY, outcome)
    }

    @Test
    fun `catalog applies when only blocked projections remain`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            projectionStatus = FixtureStatus(
                CoreHttpResult.Success(
                    CoreSyncStatus(
                        scopeId = "comics:profile:$PROFILE",
                        currentServerVersion = 1,
                        minReplayableServerVersion = 0,
                        comicAuthorityMode = "suwayomi-confirmed-v1",
                        suwayomiProjectionPending = 0,
                        suwayomiProjectionBlocked = 1,
                        suwayomiProjectionInFlight = 0,
                        ready = false,
                    ),
                ),
            ),
        ).synchronize(session, capabilities().copy(supportsSyncStatusV1 = true), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
    }

    @Test
    fun `catalog retries when the projection status request fails`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            projectionStatus = FixtureStatus(
                CoreHttpResult.Failure(503, null),
            ),
        ).synchronize(session, capabilities().copy(supportsSyncStatusV1 = true), 1000)

        assertEquals(CoreReplicaSyncOutcome.RETRY, outcome)
    }

    @Test
    fun `catalog ignores projection status when the Core does not advertise it`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            projectionStatus = object : SuwayomiProjectionStatusSource {
                override suspend fun status(
                    session: CoreCredentialSession,
                    scopeId: String,
                ): CoreHttpResult<CoreSyncStatus>? {
                    throw AssertionError("projection status must not be queried when Core does not advertise it")
                }
            },
        ).synchronize(session, capabilities(), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
    }

    @Test
    fun `pending local favorite survives a stale catalog without the title`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val projection = EpigraphCoreDomainProjection()

        val first = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 1000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, first)

        val entityId8 = "suwayomi:server:$SERVER:profile:$PROFILE:manga:8"
        database.aethon_syncQueries.enqueueMutation(
            clientMutationId = "m1",
            deviceId = "phone",
            scopeId = "comics:profile:$PROFILE",
            entityType = "comic.entry",
            entityId = entityId8,
            operation = "set_library_membership",
            payloadJson = "{}",
            createdAt = 1500,
            nextAttemptAt = 1500,
        )

        val second = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = false),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 2000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, second)

        val favorites = database.mangasQueries.findFavorites().executeAsList()
        assertEquals(2, favorites.size)
        val titles = favorites.map { it.title }.toSet()
        assertTrue("Suwayomi One" in titles)
        assertTrue("Suwayomi Two" in titles)
    }

    @Test
    fun `pending legacy queue row protects the title from demotion`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val projection = EpigraphCoreDomainProjection()

        val first = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 1000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, first)

        val entityId8 = "suwayomi:server:$SERVER:profile:$PROFILE:manga:8"
        database.aethon_suwayomi_mutation_queueQueries.enqueue(
            operationId = "op1",
            profileId = PROFILE,
            operationName = "UpdateManga",
            variablesJson = "{}",
            entityId = entityId8,
            createdAt = 1500,
            nextAttemptAt = 1500,
        )

        val second = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = false),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 2000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, second)

        val favorites = database.mangasQueries.findFavorites().executeAsList()
        assertEquals(2, favorites.size)
        val titles = favorites.map { it.title }.toSet()
        assertTrue("Suwayomi Two" in titles)
    }

    @Test
    fun `pending local unfavorite is not re-favorited by a stale catalog`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val projection = EpigraphCoreDomainProjection()

        val first = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 1000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, first)

        val manga8 = database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi Two" }
        database.mangasQueries.markNotFavorite(manga8._id)

        // The Core acknowledged the unfavorite (replica wait below the catalog's synthetic
        // version), but the desktop has not projected it to Suwayomi yet.
        val entityId8 = "suwayomi:server:$SERVER:profile:$PROFILE:manga:8"
        database.aethon_syncQueries.upsertReplicaWait(
            deviceId = "phone",
            clientMutationId = "m1",
            scopeId = "comics:profile:$PROFILE",
            entityType = "comic.entry",
            entityId = entityId8,
            canonicalEntityId = entityId8,
            resultStatus = "APPLIED",
            requiredServerVersion = 1500,
            appliedLamport = null,
            eventClockJson = null,
            canonicalRecordSha256 = null,
            receivedAt = 1500,
        )

        val second = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 2000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, second)

        val manga8After = database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi Two" }
        assertEquals(false, manga8After.favorite)
    }

    @Test
    fun `pending local category removal is not restored by a stale catalog`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val projection = EpigraphCoreDomainProjection()

        val first = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 1000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, first)

        val manga7 = database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi One" }
        val categoryId = database.categoriesQueries.findAll().executeAsList().single { it.name == "Remote Favorites" }._id
        database.aethon_syncQueries.deleteMangaCategoryAssignment(manga7._id, categoryId)

        val entityId7 = "suwayomi:server:$SERVER:profile:$PROFILE:manga:7"
        database.aethon_syncQueries.enqueueMutation(
            clientMutationId = "m1",
            deviceId = "phone",
            scopeId = "comics:profile:$PROFILE",
            entityType = "comic.category_assignment",
            entityId = entityId7,
            operation = "set_category_assignment",
            payloadJson = "{}",
            createdAt = 1500,
            nextAttemptAt = 1500,
        )

        val second = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 2000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, second)

        val assignments = database.categoriesQueries.findAllByMangaId(manga7._id).executeAsList()
        assertTrue(assignments.isEmpty())
    }

    @Test
    fun `pending local category assignment survives a stale catalog`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val projection = EpigraphCoreDomainProjection()

        val first = SuwayomiCatalogSync(
            pages = FixturePages(includeCategoryAssignment = false),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 1000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, first)

        val manga7 = database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi One" }
        val remoteCategoryId = database.categoriesQueries.findAll().executeAsList()
            .single { it.name == "Remote Favorites" }._id
        database.aethon_syncQueries.insertMangaCategoryAssignment(manga7._id, remoteCategoryId)

        val entityId7 = "suwayomi:server:$SERVER:profile:$PROFILE:manga:7"
        database.aethon_syncQueries.enqueueMutation(
            clientMutationId = "m1",
            deviceId = "phone",
            scopeId = "comics:profile:$PROFILE",
            entityType = "comic.category_assignment",
            entityId = entityId7,
            operation = "set_category_assignment",
            payloadJson = "{}",
            createdAt = 1500,
            nextAttemptAt = 1500,
        )

        val second = SuwayomiCatalogSync(
            pages = FixturePages(includeCategoryAssignment = false),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 2000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, second)

        val assignments = database.categoriesQueries.findAllByMangaId(manga7._id).executeAsList()
        assertTrue(assignments.any { it.name == "Remote Favorites" })
    }

    @Test
    fun `settled titles are still reconciled when another title is protected`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val projection = EpigraphCoreDomainProjection()

        val first = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 1000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, first)

        val entityId8 = "suwayomi:server:$SERVER:profile:$PROFILE:manga:8"
        database.aethon_syncQueries.enqueueMutation(
            clientMutationId = "m1",
            deviceId = "phone",
            scopeId = "comics:profile:$PROFILE",
            entityType = "comic.entry",
            entityId = entityId8,
            operation = "set_library_membership",
            payloadJson = "{}",
            createdAt = 1500,
            nextAttemptAt = 1500,
        )

        val second = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = false, includeCategoryAssignment = false),
            database = handler,
            projection = projection,
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
        ).synchronize(session, capabilities(), 2000)
        assertEquals(CoreReplicaSyncOutcome.APPLIED, second)

        val favorites = database.mangasQueries.findFavorites().executeAsList()
        assertTrue(favorites.any { it.title == "Suwayomi Two" })

        val manga7 = database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi One" }
        val assignments = database.categoriesQueries.findAllByMangaId(manga7._id).executeAsList()
        assertTrue(assignments.isEmpty())
    }

    @Test
    fun `remote category waits while a same-named phone category awaits its bind`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        suspend fun sync(pages: FixturePages, capabilities: CoreCapabilities, now: Long) = SuwayomiCatalogSync(
            pages = pages,
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities, now)
        sync(FixturePages(includeCategoryAssignment = false, categoryId = 0), capabilities(), 1000)
        val manga = database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi One" }
        database.categoriesQueries.insert("Remote Favorites", 1, 0, "a")
        val localCategoryId = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.insertMangaCategoryAssignment(manga._id, localCategoryId)
        assertEquals(
            listOf(localCategoryId),
            database.aethon_syncQueries.selectUnpublishedComicCategories().executeAsList().map { it._id },
        )
        val remoteEntityId = "suwayomi:server:$SERVER:profile:$PROFILE:category:55"

        // The create hook will bind the phone category to Suwayomi id 55; materializing it first
        // would leave two "Remote Favorites" folders and make the hook refuse the bind.
        val held = sync(FixturePages(), capabilities(categoryCreate = true), 2000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, held)
        assertEquals(
            listOf(localCategoryId),
            database.categoriesQueries.findAll().executeAsList().filter { it.name == "Remote Favorites" }.map { it._id },
        )
        assertNull(database.aethon_syncQueries.selectCategoryIdentityByEntityId(remoteEntityId).executeAsOneOrNull())
        assertEquals(
            listOf(localCategoryId),
            database.categoriesQueries.findAllByMangaId(manga._id).executeAsList().map { it._id },
        )

        // Without the create capability no bind is coming, so the remote category is materialized.
        val materialized = sync(FixturePages(), capabilities(), 3000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, materialized)
        assertTrue(
            database.aethon_syncQueries.selectCategoryIdentityByEntityId(remoteEntityId).executeAsOneOrNull() != null,
        )
    }

    @Test
    fun `a backup restored on the phone keeps one folder when its titles are adopted in the same run`() = runTest {
        database.mangasQueries.insert(
            source = 42,
            url = "/manga/7",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Suwayomi One",
            status = 0,
            thumbnailUrl = null,
            favorite = true,
            lastUpdate = 0,
            initialized = true,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = 0,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )
        val restoredId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        database.categoriesQueries.insert("Remote Favorites", 0, 0, "a")
        val localCategoryId = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.insertMangaCategoryAssignment(restoredId, localCategoryId)
        // Before the catalog adopts the restored title it has no Core identity, so the folder does
        // not look like it holds synced comics yet.
        assertTrue(database.aethon_syncQueries.selectUnpublishedComicCategories().executeAsList().isEmpty())

        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(includeSecondManga = false),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(categoryCreate = true), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        assertEquals(restoredId, database.mangasQueries.findFavorites().executeAsList().single()._id)
        assertEquals(
            listOf(localCategoryId),
            database.categoriesQueries.findAll().executeAsList().filter { it.name == "Remote Favorites" }.map { it._id },
        )
        assertEquals(
            listOf(localCategoryId),
            database.categoriesQueries.findAllByMangaId(restoredId).executeAsList().map { it._id },
        )
        // The create hook binds the folder by name on the next session.
        assertEquals(
            listOf(localCategoryId),
            database.aethon_syncQueries.selectUnpublishedComicCategories().executeAsList().map { it._id },
        )
    }

    @Test
    fun `remote category is materialized when no phone category of that name awaits a bind`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        val outcome = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(categoryCreate = true), 1000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        val manga = database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi One" }
        assertEquals(
            listOf("Remote Favorites"),
            database.categoriesQueries.findAllByMangaId(manga._id).executeAsList().map { it.name },
        )
    }

    @Test
    fun `re-pairing to another desktop keeps the folder and its comics until it is bound by name`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        suspend fun sync(credentials: CoreCredentialSession, now: Long) = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(credentials, capabilities(categoryCreate = true), now)
        val previous = session("desktop-zero")
        try {
            sync(previous, 1000)
        } finally {
            previous.close()
        }
        val folder = database.categoriesQueries.findAll().executeAsList().single { it.name == "Remote Favorites" }
        val held = database.aethon_syncQueries.selectMangaIdsByCategory(folder._id).executeAsList()
        assertTrue(held.isNotEmpty())
        database.categoriesQueries.insert("Novels", 2, 0, "a")
        val novelsFolder = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertCategoryIdentity(
            "novel-category-local-$novelsFolder", novelsFolder, "NOVEL", "Novels", 0, 1,
        )

        val outcome = sync(session, 2000)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, outcome)
        // Before, the folder of the previous desktop was deleted with every assignment in it.
        val folders = database.categoriesQueries.findAll().executeAsList()
        assertEquals(listOf(folder._id), folders.filter { it.name == "Remote Favorites" }.map { it._id })
        assertTrue(folders.any { it._id == novelsFolder })
        assertTrue(database.aethon_syncQueries.selectMangaIdsByCategory(folder._id).executeAsList().containsAll(held))
        assertTrue(
            database.aethon_syncQueries
                .selectCategoryIdentityByEntityId("suwayomi:server:desktop-zero:profile:$PROFILE:category:55")
                .executeAsOneOrNull() == null,
        )
        // The new desktop's same-named category waits for the create hook, which binds this folder.
        assertNull(
            database.aethon_syncQueries
                .selectCategoryIdentityByEntityId("suwayomi:server:$SERVER:profile:$PROFILE:category:55")
                .executeAsOneOrNull(),
        )
        assertEquals(
            listOf(folder._id),
            database.aethon_syncQueries.selectUnpublishedComicCategories().executeAsList().map { it._id },
        )
    }

    @Test
    fun `remote comic category joins a same-named folder that holds no comics`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        database.categoriesQueries.insert("Remote Favorites", 0, 0, "a")
        val folder = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertCategoryIdentity(
            "novel-category-local-$folder", folder, "NOVEL", "Remote Favorites", 0, 1,
        )

        SuwayomiCatalogSync(
            pages = FixturePages(),
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(categoryCreate = true), 1000)

        assertEquals(
            listOf(folder),
            database.categoriesQueries.findAll().executeAsList().filter { it.name == "Remote Favorites" }.map { it._id },
        )
        assertEquals(
            mapOf(
                "MANGA" to "suwayomi:server:$SERVER:profile:$PROFILE:category:55",
                "NOVEL" to "novel-category-local-$folder",
            ),
            database.aethon_syncQueries.selectCategoryIdentitiesByLocalId(folder).executeAsList()
                .associate { it.content_scope to it.entity_id },
        )
        val manga = database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi One" }
        assertEquals(
            listOf(folder),
            database.categoriesQueries.findAllByMangaId(manga._id).executeAsList().map { it._id },
        )
    }

    @Test
    fun `a comic category deleted on the desktop keeps a folder shared with novels`() = runTest {
        val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
        suspend fun sync(pages: FixturePages, now: Long) = SuwayomiCatalogSync(
            pages = pages,
            database = handler,
            projection = EpigraphCoreDomainProjection(),
            pageSize = 1,
        ).synchronize(session, capabilities(), now)
        sync(FixturePages(), 1000)
        val folder = database.categoriesQueries.findAll().executeAsList().single { it.name == "Remote Favorites" }
        database.aethon_syncQueries.upsertCategoryIdentity(
            "novel-category-local-${folder._id}", folder._id, "NOVEL", "Remote Favorites", 0, 1,
        )

        // Suwayomi id 55 is gone; the catalog now lists a different category.
        sync(FixturePages(categoryId = 56), 2000)

        val kept = database.categoriesQueries.findAll().executeAsList().filter { it._id == folder._id }
        assertEquals(1, kept.size)
        val manga = database.mangasQueries.findAll().executeAsList().single { it.title == "Suwayomi One" }
        assertFalse(folder._id in database.categoriesQueries.findAllByMangaId(manga._id).executeAsList().map { it._id })
        assertEquals(
            listOf("NOVEL"),
            database.aethon_syncQueries.selectCategoryIdentitiesByLocalId(folder._id).executeAsList().map { it.content_scope },
        )
    }

    @Test
    fun `legacy category identity is rebound to the server-scoped id when the name matches`() = runTest {
        database.categoriesQueries.insert("Lendo", 0, 0, "a")
        val folder = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertCategoryIdentity(
            "suwayomi:profile:$PROFILE:category:1", folder, "MANGA", "Lendo", 0, 1,
        )
        val credentials = session("srv1")
        try {
            val entityId = SuwayomiCatalogSync.resolveCategoryEntityId(database, credentials, 1, "Lendo")

            assertEquals("suwayomi:server:srv1:profile:$PROFILE:category:1", entityId)
            val rebound = database.aethon_syncQueries.selectCategoryIdentityByEntityId(entityId).executeAsOne()
            assertEquals(folder, rebound.local_category_id)
            assertNull(
                database.aethon_syncQueries
                    .selectCategoryIdentityByEntityId("suwayomi:profile:$PROFILE:category:1")
                    .executeAsOneOrNull(),
            )
        } finally {
            credentials.close()
        }
    }

    @Test
    fun `legacy category identity is not rebound when the remote name differs`() = runTest {
        database.categoriesQueries.insert("Lendo", 0, 0, "a")
        val folder = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertCategoryIdentity(
            "suwayomi:profile:$PROFILE:category:1", folder, "MANGA", "Lendo", 0, 1,
        )
        val credentials = session("srv1")
        try {
            val entityId = SuwayomiCatalogSync.resolveCategoryEntityId(database, credentials, 1, "Outro")

            assertEquals("suwayomi:server:srv1:profile:$PROFILE:category:1", entityId)
            val legacy = database.aethon_syncQueries
                .selectCategoryIdentityByEntityId("suwayomi:profile:$PROFILE:category:1")
                .executeAsOne()
            assertEquals(folder, legacy.local_category_id)
            assertNull(
                database.aethon_syncQueries.selectCategoryIdentityByEntityId(entityId).executeAsOneOrNull(),
            )
        } finally {
            credentials.close()
        }
    }

    @Test
    fun `legacy category duplicate is merged into the server-scoped folder`() = runTest {
        database.categoriesQueries.insert("Lendo", 0, 0, "a")
        val legacyFolder = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.categoriesQueries.insert("Lendo", 1, 0, "a")
        val currentFolder = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertCategoryIdentity(
            "suwayomi:profile:$PROFILE:category:1", legacyFolder, "MANGA", "Lendo", 0, 1,
        )
        database.aethon_syncQueries.upsertCategoryIdentity(
            "suwayomi:server:srv1:profile:$PROFILE:category:1", currentFolder, "MANGA", "Lendo", 0, 1,
        )
        insertManga("Merge One")
        insertManga("Merge Two")
        val mangaOne = database.mangasQueries.findAll().executeAsList().single { it.title == "Merge One" }._id
        val mangaTwo = database.mangasQueries.findAll().executeAsList().single { it.title == "Merge Two" }._id
        database.mangas_categoriesQueries.insert(mangaOne, legacyFolder)
        database.mangas_categoriesQueries.insert(mangaTwo, legacyFolder)
        database.mangas_categoriesQueries.insert(mangaTwo, currentFolder)
        val credentials = session("srv1")
        try {
            val entityId = SuwayomiCatalogSync.resolveCategoryEntityId(database, credentials, 1, "Lendo")

            assertEquals("suwayomi:server:srv1:profile:$PROFILE:category:1", entityId)
            assertEquals(
                listOf(currentFolder),
                database.categoriesQueries.findAllByMangaId(mangaOne).executeAsList().map { it._id },
            )
            assertEquals(
                listOf(currentFolder),
                database.categoriesQueries.findAllByMangaId(mangaTwo).executeAsList().map { it._id },
            )
            assertTrue(database.aethon_syncQueries.selectMangaIdsByCategory(legacyFolder).executeAsList().isEmpty())
            assertFalse(database.categoriesQueries.findAll().executeAsList().any { it._id == legacyFolder })
            assertNull(
                database.aethon_syncQueries
                    .selectCategoryIdentityByEntityId("suwayomi:profile:$PROFILE:category:1")
                    .executeAsOneOrNull(),
            )
        } finally {
            credentials.close()
        }
    }

    @Test
    fun `legacy unbound session leaves category identities untouched`() = runTest {
        database.categoriesQueries.insert("Lendo", 0, 0, "a")
        val folder = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertCategoryIdentity(
            "suwayomi:profile:$PROFILE:category:1", folder, "MANGA", "Lendo", 0, 1,
        )
        val credentials = session(LEGACY_UNBOUND_SERVER_ID)
        try {
            val entityId = SuwayomiCatalogSync.resolveCategoryEntityId(database, credentials, 1, "Lendo")

            assertEquals("suwayomi:profile:$PROFILE:category:1", entityId)
            val legacy = database.aethon_syncQueries.selectCategoryIdentityByEntityId(entityId).executeAsOne()
            assertEquals(folder, legacy.local_category_id)
        } finally {
            credentials.close()
        }
    }

    private fun insertManga(title: String) {
        database.mangasQueries.insert(
            source = EpigraphCoreSource.ID,
            url = "aethon-core://suwayomi/$SERVER/$PROFILE/manga/$title",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = title,
            status = 0,
            thumbnailUrl = null,
            favorite = true,
            lastUpdate = 0,
            initialized = true,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = 0,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )
    }

    private fun capabilities(categoryCreate: Boolean = false) = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("comics:profile:$PROFILE", "books:global"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = false,
        supportsSnapshot = false,
        supportsAssets = false,
        supportsNovelChapterAssets = false,
        supportsNovelPluginSync = false,
        supportsSuwayomiProxy = true,
        supportsSuwayomiCatalog = true,
        supportsSuwayomiWebsocketProxy = false,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = 1,
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
        supportsCausalMutationsV3 = categoryCreate,
        snapshotEntityTypes = if (categoryCreate) {
            setOf("comic.entry", "comic.category", "comic.category_assignment", "comic.chapter_state", "comic.history")
        } else {
            emptySet()
        },
        supportsSuwayomiCategoryCreate = categoryCreate,
    )

    private fun session(serverId: String) = CoreCredentialSession(
        origin = "https://core.test/",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "pairing-$serverId",
        profileId = PROFILE,
        tokenId = "token-$serverId",
        scopes = listOf("comics:profile:$PROFILE"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        serverId = serverId,
        accessTokenUtf8 = byteArrayOf(1, 2, 3),
    )

    @Test
    fun `unchanged catalog over an unchanged library is not applied again`() = runTest {
        val stamps = object : CatalogApplyStampStore {
            val values = mutableMapOf<String, CatalogApplyStamp>()
            override fun get(key: String) = values[key]
            override fun put(key: String, stamp: CatalogApplyStamp) { values[key] = stamp }
            override fun remove(key: String) { values.remove(key) }
        }
        val sync = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO),
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            stamps = stamps,
        )
        fun titles() = database.mangasQueries.findFavorites().executeAsList().map { it.title }.sorted()

        sync.synchronize(session, capabilities(), 1000)
        assertEquals(listOf("Suwayomi One", "Suwayomi Two"), titles())
        assertEquals(1, stamps.values.size)

        driver.execute(null, "UPDATE mangas SET title = 'Local edit' WHERE title = 'Suwayomi One'", 0)
        sync.synchronize(session, capabilities(), 2000)
        assertEquals(listOf("Local edit", "Suwayomi Two"), titles())

        // A changed local library is reconciled even though the catalog is the same.
        driver.execute(null, "UPDATE mangas SET favorite = 0 WHERE title = 'Local edit'", 0)
        sync.synchronize(session, capabilities(), 3000)
        assertEquals(listOf("Suwayomi One", "Suwayomi Two"), titles())

        driver.execute(null, "UPDATE mangas SET title = 'Local edit' WHERE title = 'Suwayomi One'", 0)
        sync.synchronize(session, capabilities(), 3000 + SuwayomiCatalogSync.REAPPLY_INTERVAL_MS)
        assertEquals(listOf("Suwayomi One", "Suwayomi Two"), titles())
    }

    @Test
    fun `a local library change rewrites only the records the library no longer shows`() = runTest {
        val stamps = object : CatalogApplyStampStore {
            val values = mutableMapOf<String, CatalogApplyStamp>()
            override fun get(key: String) = values[key]
            override fun put(key: String, stamp: CatalogApplyStamp) { values[key] = stamp }
            override fun remove(key: String) { values.remove(key) }
        }
        val sync = SuwayomiCatalogSync(
            pages = FixturePages(),
            database = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO),
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            stamps = stamps,
        )
        fun titles() = database.mangasQueries.findFavorites().executeAsList().map { it.title }.sorted()
        fun assignments() = driver.executeQuery(
            null,
            "SELECT COUNT(*) FROM mangas_categories",
            { cursor -> app.cash.sqldelight.db.QueryResult.Value(if (cursor.next().value) cursor.getLong(0) else null) },
            0,
        ).value

        sync.synchronize(session, capabilities(), 1000)
        assertEquals(1L, assignments())
        driver.execute(null, "UPDATE mangas SET title = 'Local two' WHERE title = 'Suwayomi Two'", 0)
        driver.execute(null, "UPDATE mangas SET favorite = 0 WHERE title = 'Suwayomi One'", 0)
        driver.execute(null, "DELETE FROM mangas_categories", 0)

        sync.synchronize(session, capabilities(), 2000)

        // The title out of the library and the missing assignment come back; the title the
        // library still shows is not written again, so its local edit stays until a full apply.
        assertEquals(listOf("Local two", "Suwayomi One"), titles())
        assertEquals(1L, assignments())
        assertEquals(1000, stamps.values.values.single().appliedAt)
    }

    @Test
    fun `a changed catalog writes only the titles that changed until the next full apply`() = runTest {
        val stamps = object : CatalogApplyStampStore {
            val values = mutableMapOf<String, CatalogApplyStamp>()
            override fun get(key: String) = values[key]
            override fun put(key: String, stamp: CatalogApplyStamp) { values[key] = stamp }
            override fun remove(key: String) { values.remove(key) }
        }
        fun sync(secondTitle: String) = SuwayomiCatalogSync(
            pages = FixturePages(secondTitle = secondTitle),
            database = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO),
            projection = EpigraphCoreDomainProjection(),
            covers = CoreCatalogCoverSink { },
            pageSize = 1,
            stamps = stamps,
        )
        fun titles() = database.mangasQueries.findFavorites().executeAsList().map { it.title }.sorted()

        sync("Suwayomi Two").synchronize(session, capabilities(), 1000)
        driver.execute(null, "UPDATE mangas SET title = 'Local edit' WHERE title = 'Suwayomi One'", 0)

        sync("Renamed on desktop").synchronize(session, capabilities(), 2000)
        assertEquals(listOf("Local edit", "Renamed on desktop"), titles())
        assertEquals(1000, stamps.values.values.single().appliedAt)

        sync("Renamed again").synchronize(session, capabilities(), 1000 + SuwayomiCatalogSync.REAPPLY_INTERVAL_MS)
        assertEquals(listOf("Renamed again", "Suwayomi One"), titles())
    }

    private class FixturePages(
        private val includeSecondManga: Boolean = true,
        private val includeCategoryAssignment: Boolean = true,
        private val categoryId: Long = 55,
        private val secondTitle: String = "Suwayomi Two",
    ) : SuwayomiCatalogPageSource {
        override suspend fun read(
            session: CoreCredentialSession,
            operation: SuwayomiCatalogOperation,
            pageSize: Long,
            offset: Long,
            mangaId: Long?,
        ): CoreHttpResult<SuwayomiCatalogResponse> {
            val nodes = when (operation) {
                SuwayomiCatalogOperation.LIBRARY -> when (offset) {
                    0L -> listOf(manga(7, "Suwayomi One"))
                    else -> if (includeSecondManga) listOf(manga(8, secondTitle)) else emptyList()
                }
                SuwayomiCatalogOperation.CATEGORIES -> listOf(
                    buildJsonObject {
                        put("id", categoryId)
                        put("name", "Remote Favorites")
                        put("order", 0)
                        put("mangas", buildJsonObject {
                            put("nodes", buildJsonArray {
                                if (includeCategoryAssignment) {
                                    add(buildJsonObject { put("id", 7); put("inLibrary", true) })
                                }
                            })
                        })
                    },
                )
                SuwayomiCatalogOperation.CHAPTERS -> if (mangaId == 7L) listOf(chapter()) else emptyList()
            }
            val connection = when (operation) {
                SuwayomiCatalogOperation.LIBRARY -> "mangas"
                SuwayomiCatalogOperation.CATEGORIES -> "categories"
                SuwayomiCatalogOperation.CHAPTERS -> "chapters"
            }
            val hasNext = operation == SuwayomiCatalogOperation.LIBRARY && offset == 0L && includeSecondManga
            val totalCount = when (operation) {
                SuwayomiCatalogOperation.LIBRARY -> if (includeSecondManga) 2L else 1L
                else -> nodes.size.toLong()
            }
            return CoreHttpResult.Success(
                SuwayomiCatalogResponse(
                    schemaVersion = 1,
                    scopeId = "comics:profile:$PROFILE",
                    operation = operation.wireName,
                    generatedAtMs = 1000,
                    page = SuwayomiCatalogPage(offset, pageSize, hasNext, totalCount),
                    data = buildJsonObject {
                        put(connection, buildJsonObject {
                            put("nodes", buildJsonArray { nodes.forEach(::add) })
                        })
                    },
                ),
            )
        }

        private fun manga(id: Long, title: String) = buildJsonObject {
            put("id", id)
            put("title", title)
            put("sourceId", 42)
            put("source", buildJsonObject {
                put("id", 42)
                put("name", "Fixture Source")
                put("lang", "en")
                put("extension", buildJsonObject { put("pkgName", EXTENSION_PACKAGE) })
            })
            put("realUrl", "https://source.test/manga/$id")
            put("url", "/manga/$id")
            put("thumbnailUrl", "/api/v1/manga/$id/thumbnail")
            put("inLibrary", true)
        }

        private fun chapter() = buildJsonObject {
            put("id", 900)
            put("name", "Chapter 3")
            put("chapterNumber", 3.0)
            put("isRead", true)
            put("isBookmarked", true)
            put("pageCount", 10)
            put("lastPageRead", 3)
            put("realUrl", "https://source.test/chapter/900")
            put("uploadDate", 900)
        }
    }

    private class FixtureStatus(
        private val result: CoreHttpResult<CoreSyncStatus>?,
    ) : SuwayomiProjectionStatusSource {
        var calls = 0
            private set

        override suspend fun status(
            session: CoreCredentialSession,
            scopeId: String,
        ): CoreHttpResult<CoreSyncStatus>? {
            calls++
            return result
        }
    }

    private companion object {
        const val SERVER = "desktop-one"
        const val PROFILE = "main"
        const val EXTENSION_PACKAGE = "eu.kanade.tachiyomi.extension.en.fixture"
    }
}
