package epigraph.sync.core.novels

import epigraph.sync.core.portable.PortableDependencyTrustCoordinator
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.plugin.model.NovelPluginIndex
import epigraph.novel.repo.NovelRepoRepository
import epigraph.novel.repo.interactor.NovelRepoIndexValidation
import epigraph.novel.repo.interactor.NovelRepoIndexValidator
import epigraph.novel.repo.model.NovelRepo
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException

sealed interface LnReaderRepositoryApprovalResult {
    data class Approved(val indexUrl: String) : LnReaderRepositoryApprovalResult
    data class AlreadyApproved(val indexUrl: String) : LnReaderRepositoryApprovalResult
    data object InventoryNotFound : LnReaderRepositoryApprovalResult
    data object RequirementNotFound : LnReaderRepositoryApprovalResult
    data object RepositoryRejected : LnReaderRepositoryApprovalResult
    data class Failed(val reason: String) : LnReaderRepositoryApprovalResult
}

sealed interface LnReaderPluginInstallResult {
    data object Installed : LnReaderPluginInstallResult
    data object AlreadyInstalled : LnReaderPluginInstallResult
    data object InventoryNotFound : LnReaderPluginInstallResult
    data object RequirementNotFound : LnReaderPluginInstallResult
    data object RepositoryApprovalRequired : LnReaderPluginInstallResult
    data object PluginUnavailable : LnReaderPluginInstallResult
    data object IdentityMismatch : LnReaderPluginInstallResult
    data object ArtifactRejected : LnReaderPluginInstallResult
    data class Failed(val reason: String) : LnReaderPluginInstallResult
}

interface LnReaderDependencyActionGateway {
    suspend fun approveRepository(
        requirement: CoreNovelRepositoryRequirement,
    ): LnReaderRepositoryApprovalResult

    suspend fun installPlugin(
        repositoryIndexUrl: String,
        requirement: CoreNovelPluginRequirement,
    ): LnReaderPluginInstallResult
}

/** Explicit user actions delegated exclusively to the existing LNReader managers. */
class ManagedLnReaderDependencyActionGateway(
    private val repositories: NovelRepoRepository,
    private val validator: NovelRepoIndexValidator,
    private val plugins: NovelPluginManager,
) : LnReaderDependencyActionGateway {
    // "Install all" installs every plugin of a repository in a row; fetch its index once, not
    // once per plugin.
    private val repositoryIndexes = ConcurrentHashMap<String, Pair<Long, List<NovelPluginIndex>>>()

    override suspend fun approveRepository(
        requirement: CoreNovelRepositoryRequirement,
    ): LnReaderRepositoryApprovalResult {
        repositories.getAll().firstOrNull {
            it.baseUrl.matchesDeclaredRepository(requirement.canonicalUrl)
        }?.let {
            return LnReaderRepositoryApprovalResult.AlreadyApproved(it.baseUrl)
        }
        return when (val validation = validator.validate(requirement.canonicalUrl)) {
            is NovelRepoIndexValidation.Valid -> {
                repositories.getAll().firstOrNull { it.baseUrl == validation.indexUrl }?.let {
                    return LnReaderRepositoryApprovalResult.AlreadyApproved(it.baseUrl)
                }
                repositories.insert(NovelRepo(validation.indexUrl, requirement.displayName))
                LnReaderRepositoryApprovalResult.Approved(validation.indexUrl)
            }
            else -> LnReaderRepositoryApprovalResult.RepositoryRejected
        }
    }

    override suspend fun installPlugin(
        repositoryIndexUrl: String,
        requirement: CoreNovelPluginRequirement,
    ): LnReaderPluginInstallResult {
        if (plugins.installedArtifactMatches(
                pluginId = requirement.pluginId,
                expectedVersion = requirement.version,
                expectedSha256 = requirement.artifactSha256,
                expectedByteLength = requirement.artifactByteLength,
            )
        ) {
            return LnReaderPluginInstallResult.AlreadyInstalled
        }
        val candidates = repositoryPlugins(repositoryIndexUrl)
        val candidate = candidates.singleMatching(requirement)
            ?: return if (candidates.any { it.id == requirement.pluginId || it.id == requirement.sourceId }) {
                LnReaderPluginInstallResult.IdentityMismatch
            } else {
                LnReaderPluginInstallResult.PluginUnavailable
            }
        if (candidate.version != requirement.version || candidate.url.isBlank()) {
            return LnReaderPluginInstallResult.IdentityMismatch
        }
        val installed = plugins.installPlugin(
            plugin = candidate,
            expectedSha256 = requirement.artifactSha256,
            expectedByteLength = requirement.artifactByteLength,
        )
        if (!installed) return LnReaderPluginInstallResult.ArtifactRejected
        return if (plugins.installedArtifactMatches(
                pluginId = requirement.pluginId,
                expectedVersion = requirement.version,
                expectedSha256 = requirement.artifactSha256,
                expectedByteLength = requirement.artifactByteLength,
            )
        ) {
            LnReaderPluginInstallResult.Installed
        } else {
            LnReaderPluginInstallResult.ArtifactRejected
        }
    }

    private suspend fun repositoryPlugins(indexUrl: String): List<NovelPluginIndex> {
        val now = System.currentTimeMillis()
        repositoryIndexes[indexUrl]?.takeIf { (fetchedAt, _) -> now - fetchedAt < INDEX_REUSE_MS }
            ?.let { (_, cached) -> return cached }
        return plugins.refreshRepositoryPlugins(indexUrl).also { fetched ->
            if (fetched.isNotEmpty()) repositoryIndexes[indexUrl] = now to fetched
        }
    }

    private companion object {
        const val INDEX_REUSE_MS = 60_000L
    }
}

class LnReaderDependencyActionCoordinator(
    private val inventories: LnReaderDependencyInventoryStore,
    private val gateway: LnReaderDependencyActionGateway,
    private val portableTrust: PortableDependencyTrustCoordinator? = null,
    private val coreArtifacts: CoreNovelPluginArtifactGateway? = null,
) {
    suspend fun inventory(serverId: String, profileId: String): LnReaderDependencyInventory? =
        inventories.get(serverId, profileId)

    suspend fun approveRepository(
        serverId: String,
        profileId: String,
        repositoryId: String,
    ): LnReaderRepositoryApprovalResult = try {
        val inventory = inventories.get(serverId, profileId)
            ?: return LnReaderRepositoryApprovalResult.InventoryNotFound
        val requirement = inventory.repositories
            .singleOrNull { it.requirement.repositoryId == repositoryId }
            ?.requirement
            ?: return LnReaderRepositoryApprovalResult.RequirementNotFound
        gateway.approveRepository(requirement).also { result ->
            val indexUrl = when (result) {
                is LnReaderRepositoryApprovalResult.Approved -> result.indexUrl
                is LnReaderRepositoryApprovalResult.AlreadyApproved -> result.indexUrl
                else -> null
            }
            if (indexUrl != null) {
                portableTrust?.trustNovelRepository(
                    serverId,
                    profileId,
                    setOf(requirement.canonicalUrl, indexUrl),
                )
                inventories.replace(
                    inventory.copy(
                        repositories = inventory.repositories.map { item ->
                            if (item.requirement.repositoryId == repositoryId) {
                                item.copy(
                                    status = LnReaderRepositoryParityStatus.INSTALLED,
                                    configuredIndexUrl = indexUrl,
                                )
                            } else {
                                item
                            }
                        },
                    ),
                )
            }
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        LnReaderRepositoryApprovalResult.Failed(error.javaClass.simpleName)
    }

    suspend fun installPlugin(
        serverId: String,
        profileId: String,
        pluginId: String,
    ): LnReaderPluginInstallResult = try {
        val inventory = inventories.get(serverId, profileId)
            ?: return LnReaderPluginInstallResult.InventoryNotFound
        val plugin = inventory.plugins.singleOrNull { it.requirement.pluginId == pluginId }
            ?: return LnReaderPluginInstallResult.RequirementNotFound
        if (plugin.status == LnReaderPluginParityStatus.INSTALLED) {
            return LnReaderPluginInstallResult.AlreadyInstalled
        }
        val indexUrl = inventory.repositories.singleOrNull {
            it.requirement.repositoryId == plugin.requirement.repositoryId
        }?.configuredIndexUrl
        val repositoryResult = when {
            plugin.status == LnReaderPluginParityStatus.IDENTITY_MISMATCH ->
                LnReaderPluginInstallResult.IdentityMismatch
            indexUrl == null -> LnReaderPluginInstallResult.RepositoryApprovalRequired
            else -> gateway.installPlugin(indexUrl, plugin.requirement)
        }
        // The paired Core serves the desktop's exact artifact, verified by hash and size, so a
        // repository that was not added, lacks that version or republished it with other bytes
        // no longer blocks the install.
        val resolvedResult = if (repositoryResult in CORE_ARTIFACT_FALLBACK) {
            coreArtifacts?.install(serverId, profileId, plugin.requirement) ?: repositoryResult
        } else {
            repositoryResult
        }
        resolvedResult.also { result ->
            if (
                result == LnReaderPluginInstallResult.Installed ||
                result == LnReaderPluginInstallResult.AlreadyInstalled
            ) {
                inventories.replace(
                    inventory.copy(
                        plugins = inventory.plugins.map { item ->
                            if (item.requirement.pluginId == pluginId) {
                                item.copy(
                                    status = LnReaderPluginParityStatus.INSTALLED,
                                    installedVersion = item.requirement.version,
                                )
                            } else {
                                item
                            }
                        },
                    ),
                )
                portableTrust?.wake()
            }
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        LnReaderPluginInstallResult.Failed(error.javaClass.simpleName)
    }

    private companion object {
        val CORE_ARTIFACT_FALLBACK = setOf(
            LnReaderPluginInstallResult.PluginUnavailable,
            LnReaderPluginInstallResult.IdentityMismatch,
            LnReaderPluginInstallResult.RepositoryApprovalRequired,
            LnReaderPluginInstallResult.ArtifactRejected,
        )
    }
}

internal fun List<NovelPluginIndex>.singleMatching(
    requirement: CoreNovelPluginRequirement,
): NovelPluginIndex? {
    val pluginMatches = filter { it.id == requirement.pluginId }
    if (pluginMatches.size == 1) return pluginMatches.single()
    return null
}
