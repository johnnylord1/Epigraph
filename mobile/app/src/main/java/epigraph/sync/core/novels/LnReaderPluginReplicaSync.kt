package epigraph.sync.core.novels

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.portable.PortableDependencyTrustCoordinator
import epigraph.sync.core.replica.CoreConfirmedRecord
import epigraph.sync.core.replica.CoreReplicaRecordReader
import epigraph.sync.core.replica.CoreReplicaTombstoneReader
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import epigraph.sync.core.work.CoreReplicaSyncPort
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.plugin.model.NovelPluginIndex
import epigraph.novel.repo.NovelRepoRepository
import epigraph.novel.repo.interactor.NovelRepoIndexValidator
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

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

/** Reads only LNReader dependency declarations from the authenticated Core mirror. */
class ReplicaCoreNovelDependencyReader(
    private val records: CoreReplicaRecordReader,
    private val tombstones: CoreReplicaTombstoneReader = CoreReplicaTombstoneReader { _, _ -> emptyList() },
) : CoreNovelDependencyReader {
    override suspend fun read(scopeId: String): CoreNovelDependencyManifest {
        val confirmed = records.confirmedRecords(scopeId, ENTITY_TYPES)
        return CoreNovelDependencyManifest(
            repositories = confirmed.mapNotNull(::repository),
            plugins = confirmed.mapNotNull(::plugin),
            removed = tombstones.confirmedTombstones(scopeId, ENTITY_TYPES)
                .associate { it.key.entityId to it.lamport },
        )
    }

    private fun repository(record: CoreConfirmedRecord): CoreNovelRepositoryRequirement? {
        if (record.key.entityType != EpigraphCoreEntityType.NOVEL_REPOSITORY) return null
        val value = record.record as? JsonObject ?: return null
        val repositoryId = value.string("repositoryId") ?: record.key.entityId
        if (repositoryId != record.key.entityId) return null
        return CoreNovelRepositoryRequirement(
            repositoryId = repositoryId,
            canonicalUrl = value.string("canonicalUrl") ?: return null,
            displayName = value.string("name")?.takeIf(String::isNotBlank) ?: "LNReader repository",
            enabled = value.boolean("enabled") ?: false,
        )
    }

    private fun plugin(record: CoreConfirmedRecord): CoreNovelPluginRequirement? {
        if (record.key.entityType != EpigraphCoreEntityType.NOVEL_PLUGIN) return null
        val value = record.record as? JsonObject ?: return null
        val entityId = value.string("pluginEntityId") ?: record.key.entityId
        if (entityId != record.key.entityId) return null
        val artifactSha256 = value.string("artifactSha256") ?: return null
        if (!SHA_256.matches(artifactSha256)) return null
        return CoreNovelPluginRequirement(
            repositoryId = value.string("repositoryId") ?: return null,
            pluginId = value.string("pluginId") ?: return null,
            sourceId = value.string("sourceId") ?: return null,
            version = value.string("version") ?: return null,
            enabled = value.boolean("enabled") ?: false,
            artifactSha256 = artifactSha256,
            artifactByteLength = value.long("artifactByteLength")?.takeIf { it > 0 } ?: return null,
            name = value.string("name").orEmpty(),
            lang = value.string("lang").orEmpty(),
        )
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)

    private fun JsonObject.boolean(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.booleanOrNull

    private fun JsonObject.long(key: String): Long? = string(key)?.toLongOrNull()

    private companion object {
        val ENTITY_TYPES = setOf(
            EpigraphCoreEntityType.NOVEL_REPOSITORY,
            EpigraphCoreEntityType.NOVEL_PLUGIN,
        )
        val SHA_256 = Regex("[0-9a-f]{64}")
    }
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
}
