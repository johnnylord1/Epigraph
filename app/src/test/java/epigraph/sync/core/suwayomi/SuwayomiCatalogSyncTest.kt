package epigraph.sync.core.suwayomi
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
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
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
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
        // A V1 category has no server identity. It is retained as legacy-unbound while the V2
        // server receives a distinct category row, avoiding an unsafe cross-desktop rebind.
        assertEquals(
            2,
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
        val total = 601L
        val pages = SuwayomiCatalogPageSource { _, operation, pageSize, offset, _ ->
            if (operation == SuwayomiCatalogOperation.CHAPTERS) chapterRequests += 1
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

    private fun capabilities() = CoreCapabilities(
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
        snapshotEntityTypes = emptySet(),
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
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

    private class FixturePages(
        private val includeSecondManga: Boolean = true,
        private val includeCategoryAssignment: Boolean = true,
        private val categoryId: Long = 55,
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
                    else -> if (includeSecondManga) listOf(manga(8, "Suwayomi Two")) else emptyList()
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

    private companion object {
        const val SERVER = "desktop-one"
        const val PROFILE = "main"
        const val EXTENSION_PACKAGE = "eu.kanade.tachiyomi.extension.en.fixture"
    }
}
