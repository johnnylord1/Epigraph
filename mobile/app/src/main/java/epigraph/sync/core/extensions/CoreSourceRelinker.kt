package epigraph.sync.core.extensions

import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import yokai.data.Database
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
    /** Rows this pass actually moved to their native source; the rest were already there. */
    val moved: Int = 0,
)

/** Candidates bound to their native source after a pass, and how many of them the pass moved. */
data class CoreSourceRelinkCount(val bound: Int, val moved: Int)

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

    /** Relinks every candidate in one pass; a store that cannot tell a move counts every bound row as one. */
    suspend fun relinkAll(candidates: List<CoreSourceRelinkCandidate>): CoreSourceRelinkCount =
        candidates.count { relink(it) }.let { CoreSourceRelinkCount(bound = it, moved = it) }
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
        val relinked = store.relinkAll(
            candidates.filter { registry.isReady(it.packageName, it.sourceId) },
        )
        CoreSourceRelinkResult(
            observed = candidates.size,
            relinked = relinked.bound,
            pending = candidates.size - relinked.bound,
            moved = relinked.moved,
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
        relinkRow(candidate, currentRow(candidate)) != RelinkOutcome.NOT_BOUND
    }

    // One transaction for the whole pass: per-row transactions re-ran every library query once per
    // relinked work, which stalled the app for minutes after an extension install. The current rows
    // are read in one query too, since two lookups per work cost seconds on every sync.
    override suspend fun relinkAll(candidates: List<CoreSourceRelinkCandidate>): CoreSourceRelinkCount =
        database.await(inTransaction = true) {
            val current = aethon_syncQueries.selectSuwayomiRelinkStates().executeAsList()
                .associate { it.entity_id to RelinkRow(it.local_reference, it.source, it.url) }
            val outcomes = candidates.map { relinkRow(it, current[it.entityId]) }
            CoreSourceRelinkCount(
                bound = outcomes.count { it != RelinkOutcome.NOT_BOUND },
                moved = outcomes.count { it == RelinkOutcome.MOVED },
            )
        }

    private fun Database.currentRow(candidate: CoreSourceRelinkCandidate): RelinkRow? {
        val identity = aethon_syncQueries.selectIdentityByEntityId(candidate.entityId).executeAsOneOrNull()
            ?: return null
        val manga = identity.local_reference.toLongOrNull()
            ?.let { mangasQueries.findById(it).executeAsOneOrNull() }
            ?: return null
        return RelinkRow(identity.local_reference, manga.source, manga.url)
    }

    /** [current] is the candidate's identity and local work as they are now, or null when either is gone. */
    private fun Database.relinkRow(candidate: CoreSourceRelinkCandidate, current: RelinkRow?): RelinkOutcome {
        current ?: return RelinkOutcome.NOT_BOUND
        if (current.localReference.toLongOrNull() != candidate.localMangaId) return RelinkOutcome.NOT_BOUND
        if (current.source == candidate.sourceId && current.url == candidate.originalUrl) {
            return RelinkOutcome.ALREADY_BOUND
        }
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
        return RelinkOutcome.MOVED
    }

    private data class RelinkRow(val localReference: String, val source: Long, val url: String)

    private enum class RelinkOutcome { NOT_BOUND, ALREADY_BOUND, MOVED }
}
