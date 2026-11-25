package epigraph.sync.core.novels

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.portable.PortableDependencyTrustCoordinator
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import epigraph.sync.core.work.CoreReplicaSyncPort
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.plugin.model.NovelPluginIndex
import epigraph.novel.repo.NovelRepoRepository
import epigraph.novel.repo.interactor.NovelRepoIndexValidator
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable

@Serializable
data class CoreNovelRepositoryRequirement(
    val repositoryId: String,
    val canonicalUrl: String,
    val displayName: String,
    val enabled: Boolean,
)

@Serializable
data class CoreNovelPluginRequirement(
    val repositoryId: String,
    val pluginId: String,
    val sourceId: String,
    val version: String,
    val enabled: Boolean,
    val artifactSha256: String,
    val artifactByteLength: Long,
    val name: String = "",
    val lang: String = "",
)

data class CoreNovelDependencyManifest(
    val repositories: List<CoreNovelRepositoryRequirement>,
    val plugins: List<CoreNovelPluginRequirement>,
    /** Repository and plugin entity ids the Core confirmed as deleted, with the delete's Lamport. */
    val removed: Map<String, Long> = emptyMap(),
)

fun interface CoreNovelDependencyReader {
    suspend fun read(scopeId: String): CoreNovelDependencyManifest
}

interface LnReaderPluginGateway {
    suspend fun configuredRepository(requirement: CoreNovelRepositoryRequirement): String?
    suspend fun repositoryPlugins(indexUrl: String): List<NovelPluginIndex>
    fun installedVersion(pluginId: String): String?
    fun installedArtifactMatches(requirement: CoreNovelPluginRequirement): Boolean
}

/** Read-only view over repositories and plugins managed by the existing LNReader stack. */
class ManagedLnReaderPluginGateway(
    private val repositories: NovelRepoRepository,
    private val plugins: NovelPluginManager,
) : LnReaderPluginGateway {
    constructor(
        repositories: NovelRepoRepository,
        @Suppress("UNUSED_PARAMETER") validator: NovelRepoIndexValidator,
        plugins: NovelPluginManager,
    ) : this(repositories, plugins)

    override suspend fun configuredRepository(requirement: CoreNovelRepositoryRequirement): String? =
        repositories.getAll()
            .firstOrNull { it.baseUrl.matchesDeclaredRepository(requirement.canonicalUrl) }
            ?.baseUrl

    override suspend fun repositoryPlugins(indexUrl: String): List<NovelPluginIndex> =
        plugins.refreshRepositoryPlugins(indexUrl)

    override fun installedVersion(pluginId: String): String? = plugins.getInstalledVersion(pluginId)

    override fun installedArtifactMatches(requirement: CoreNovelPluginRequirement): Boolean =
        plugins.installedArtifactMatches(
            pluginId = requirement.pluginId,
            expectedVersion = requirement.version,
            expectedSha256 = requirement.artifactSha256,
            expectedByteLength = requirement.artifactByteLength,
        )
}

/**
 * Compares Core declarations with local LNReader state after replica commit.
 * This path never adds repositories, installs plugins or consumes executable content from Syncd.
 */
class LnReaderPluginReplicaSync(
    private val dependencies: CoreNovelDependencyReader,
    private val gateway: LnReaderPluginGateway,
    private val inventories: LnReaderDependencyInventoryStore = InMemoryLnReaderDependencyInventoryStore(),
    private val portableTrust: PortableDependencyTrustCoordinator? = null,
) : CoreReplicaSyncPort {
    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome {
        require(nowEpochMillis >= 0) { "sync timestamp must be epoch milliseconds" }
        if (!capabilities.supportsNovelPluginSync) return CoreReplicaSyncOutcome.DEFERRED
        val scopeId = "novels:profile:${credentials.profileId}"
        if (scopeId !in credentials.scopes) return CoreReplicaSyncOutcome.DEFERRED

        return try {
            val manifest = dependencies.read(scopeId)
            val repositories = manifest.repositories
                .filter(CoreNovelRepositoryRequirement::enabled)
                .distinctBy(CoreNovelRepositoryRequirement::repositoryId)
                .map { requirement ->
                    val configuredUrl = gateway.configuredRepository(requirement)
                    LnReaderRepositoryInventoryItem(
                        requirement = requirement,
                        status = if (configuredUrl == null) {
                            LnReaderRepositoryParityStatus.APPROVAL_REQUIRED
                        } else {
                            LnReaderRepositoryParityStatus.INSTALLED
                        },
                        configuredIndexUrl = configuredUrl,
                    )
                }
            val repositoryPlugins = repositories.mapNotNull { repository ->
                repository.configuredIndexUrl?.let { indexUrl ->
                    repository.requirement.repositoryId to gateway.repositoryPlugins(indexUrl)
                }
            }.toMap()
            val plugins = manifest.plugins
                .filter(CoreNovelPluginRequirement::enabled)
                .distinctBy(CoreNovelPluginRequirement::pluginId)
                .map { requirement ->
                    if (!requirement.hasArtifactIdentity) {
                        return@map versionOnlyInventoryItem(requirement, repositoryPlugins)
                    }
                    val candidates = repositoryPlugins[requirement.repositoryId]
                    val candidate = candidates?.singleMatching(requirement)
                    val installedVersion = gateway.installedVersion(requirement.pluginId)
                    val status = when {
                        gateway.installedArtifactMatches(requirement) -> LnReaderPluginParityStatus.INSTALLED
                        candidates == null -> LnReaderPluginParityStatus.MISSING_UNAVAILABLE
                        candidate == null && candidates.any {
                            it.id == requirement.pluginId || it.id == requirement.sourceId
                        } -> LnReaderPluginParityStatus.IDENTITY_MISMATCH
                        candidate == null -> LnReaderPluginParityStatus.MISSING_UNAVAILABLE
                        candidate.version != requirement.version || candidate.url.isBlank() -> {
                            LnReaderPluginParityStatus.IDENTITY_MISMATCH
                        }
                        installedVersion != null -> LnReaderPluginParityStatus.UPDATE_AVAILABLE
                        else -> LnReaderPluginParityStatus.MISSING_AVAILABLE
                    }
                    LnReaderPluginInventoryItem(
                        requirement = requirement,
                        status = status,
                        installedVersion = installedVersion,
                        availableVersion = candidate?.version,
                    )
                }
            inventories.replace(
                LnReaderDependencyInventory(
                    serverId = credentials.serverId,
                    profileId = credentials.profileId,
                    generatedAtMs = nowEpochMillis,
                    fingerprint = manifest.fingerprint(),
                    repositories = repositories,
                    plugins = plugins,
                ),
            )
            repositories.forEach { repository ->
                val configuredUrl = repository.configuredIndexUrl ?: return@forEach
                portableTrust?.trustNovelRepository(
                    serverId = credentials.serverId,
                    profileId = credentials.profileId,
                    indexUrls = setOf(repository.requirement.canonicalUrl, configuredUrl),
                )
            }
            CoreReplicaSyncOutcome.APPLIED
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            CoreReplicaSyncOutcome.DEFERRED
        }
    }

    /**
     * Sync V4 declares installed plugins by id and version only (no artifact hash). Any
     * configured repository may serve the plugin; the declared repository is only preferred.
     * The stored requirement points at the serving repository and its offered version, so the
     * explicit install action resolves the same index entry.
     */
    private fun versionOnlyInventoryItem(
        requirement: CoreNovelPluginRequirement,
        repositoryPlugins: Map<String, List<NovelPluginIndex>>,
    ): LnReaderPluginInventoryItem {
        val installedVersion = gateway.installedVersion(requirement.pluginId)
        val served = repositoryPlugins.entries
            .sortedByDescending { it.key == requirement.repositoryId }
            .firstNotNullOfOrNull { (repositoryId, plugins) ->
                plugins.singleMatching(requirement)
                    ?.takeIf { it.url.isNotBlank() }
                    ?.let { repositoryId to it }
            }
        val offered = served?.second?.takeIf {
            compareNovelPluginVersions(it.version, requirement.version) >= 0
        }
        val installedCurrent = installedVersion != null &&
            compareNovelPluginVersions(installedVersion, requirement.version) >= 0
        val status = when {
            installedCurrent -> LnReaderPluginParityStatus.INSTALLED
            offered == null -> LnReaderPluginParityStatus.MISSING_UNAVAILABLE
            installedVersion != null -> LnReaderPluginParityStatus.UPDATE_AVAILABLE
            else -> LnReaderPluginParityStatus.MISSING_AVAILABLE
        }
        val stored = if (served != null && offered != null && !installedCurrent) {
            requirement.copy(repositoryId = served.first, version = offered.version)
        } else if (served != null) {
            requirement.copy(repositoryId = served.first)
        } else {
            requirement
        }
        return LnReaderPluginInventoryItem(
            requirement = stored,
            status = status,
            installedVersion = installedVersion,
            availableVersion = served?.second?.version,
        )
    }
}

/** A requirement without an artifact hash comes from Sync V4 and is matched by id and version. */
val CoreNovelPluginRequirement.hasArtifactIdentity: Boolean
    get() = artifactSha256.isNotEmpty()

/** Compares dotted numeric plugin versions ("1.0.10" > "1.0.9"); non-numeric parts compare as text. */
internal fun compareNovelPluginVersions(left: String, right: String): Int {
    val a = left.trim().removePrefix("v").split('.', '-', '+')
    val b = right.trim().removePrefix("v").split('.', '-', '+')
    for (index in 0 until maxOf(a.size, b.size)) {
        val x = a.getOrNull(index).orEmpty()
        val y = b.getOrNull(index).orEmpty()
        val xn = x.toLongOrNull()
        val yn = y.toLongOrNull()
        val result = when {
            xn != null && yn != null -> xn.compareTo(yn)
            x.isEmpty() && y.isNotEmpty() -> if (yn == 0L) 0 else -1
            y.isEmpty() && x.isNotEmpty() -> if (xn == 0L) 0 else 1
            else -> x.compareTo(y)
        }
        if (result != 0) return result
    }
    return 0
}
