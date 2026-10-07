package epigraph.sync.core.extensions

import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import yokai.data.DatabaseHandler
import yokai.data.memoColumnAdapter

data class CoreSourceRelinkCandidate(
    val entityId: String,
    val packageName: String,
    val sourceId: Long,
    val originalUrl: String,
    val localMangaId: Long,
)

data class CoreSourceRelinkResult(
    val observed: Int,
    val relinked: Int,
    val pending: Int,
)

data class CoreSourcePackageScope(
    val serverId: String,
    val profileId: String,
    val packagesBySourceId: Map<Long, String>,
)

interface CoreSourceRelinkStore {
    suspend fun resolveUnknownPackages(
        serverId: String,
        profileId: String,
        packagesBySourceId: Map<Long, String>,
    )
    suspend fun candidates(): List<CoreSourceRelinkCandidate>
    suspend fun relink(candidate: CoreSourceRelinkCandidate): Boolean
}

fun interface CoreSourceRegistry {
    fun isReady(packageName: String, sourceId: Long): Boolean
}

/**
 * Rebinds Core bridge rows only after the official extension registry proves the local source.
 * Missing extensions remain materialized through EpigraphCoreSource and can be retried later.
 */
class CoreSourceRelinker(
    private val store: CoreSourceRelinkStore,
    private val registry: CoreSourceRegistry,
) {
    private val mutex = Mutex()

    suspend fun relinkAvailable(
        packageScopes: List<CoreSourcePackageScope> = emptyList(),
    ): CoreSourceRelinkResult = mutex.withLock {
        packageScopes.forEach { scope ->
            require(scope.serverId.isNotBlank() && scope.profileId.isNotBlank()) {
                "source package enrichment requires a bound Core scope"
            }
            store.resolveUnknownPackages(scope.serverId, scope.profileId, scope.packagesBySourceId)
        }
        val candidates = store.candidates()
        var relinked = 0
        candidates.forEach { candidate ->
            if (registry.isReady(candidate.packageName, candidate.sourceId) && store.relink(candidate)) {
                relinked += 1
            }
        }
        CoreSourceRelinkResult(
            observed = candidates.size,
            relinked = relinked,
            pending = candidates.size - relinked,
        )
    }

    /** The desktop source of every work the Core bridged here, by local work id. */
    suspend fun bridgedWorkSources(): Map<Long, Long> =
        store.candidates().associate { it.localMangaId to it.sourceId }
}

class InstalledCoreSourceRegistry(
    private val extensions: ExtensionManager,
    private val sources: SourceManager,
) : CoreSourceRegistry {
    override fun isReady(packageName: String, sourceId: Long): Boolean =
        extensions.getPackageName(sourceId) == packageName && sources.get(sourceId) is CatalogueSource
}

class SqlDelightCoreSourceRelinkStore(
    private val database: DatabaseHandler,
) : CoreSourceRelinkStore {
    override suspend fun resolveUnknownPackages(
        serverId: String,
        profileId: String,
        packagesBySourceId: Map<Long, String>,
    ) {
        if (packagesBySourceId.isEmpty()) return
        database.await(inTransaction = true) {
            packagesBySourceId.forEach { (sourceId, packageName) ->
                if (sourceId != 0L && packageName.isNotBlank() && packageName != "unknown") {
                    aethon_syncQueries.resolveUnknownSuwayomiBindingPackage(
                        pluginPackage = packageName,
                        sourceId = sourceId.toString(),
                        serverId = serverId,
                        profileId = profileId,
                    )
                }
            }
        }
    }

    override suspend fun candidates(): List<CoreSourceRelinkCandidate> = database.await(inTransaction = false) {
        aethon_syncQueries.selectSuwayomiRelinkCandidates().executeAsList().mapNotNull { row ->
            val parsedSourceId = row.source_id.toLongOrNull()
            val localMangaId = row.local_reference.toLongOrNull()
            if (parsedSourceId == null || parsedSourceId == 0L || localMangaId == null || localMangaId <= 0L) {
                null
            } else {
                CoreSourceRelinkCandidate(
                    entityId = row.entity_id,
                    packageName = row.plugin_package,
                    sourceId = parsedSourceId,
                    originalUrl = row.normalized_url,
                    localMangaId = localMangaId,
                )
            }
        }
    }

    override suspend fun relink(candidate: CoreSourceRelinkCandidate): Boolean = database.await(inTransaction = true) {
        val identity = aethon_syncQueries.selectIdentityByEntityId(candidate.entityId).executeAsOneOrNull()
            ?: return@await false
        if (identity.local_reference.toLongOrNull() != candidate.localMangaId) return@await false
        val manga = mangasQueries.findById(candidate.localMangaId).executeAsOneOrNull()
            ?: return@await false
        if (manga.source == candidate.sourceId && manga.url == candidate.originalUrl) return@await true
        mangasQueries.update(
            source = candidate.sourceId,
            url = candidate.originalUrl,
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
            memo = memoColumnAdapter.encode(JsonObject(emptyMap())),
            mangaId = candidate.localMangaId,
        )
        true
    }
}
