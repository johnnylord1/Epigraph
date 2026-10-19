package epigraph.sync.core.novels

import epigraph.contract.DeviceId
import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.NovelPluginDescriptor
import epigraph.contract.RepositoryDescriptor
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.plugin.model.NovelPluginIndex
import epigraph.novel.repo.NovelRepoRepository
import epigraph.sync.ClientMutationIdFactory
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.LocalMutationResult
import epigraph.sync.core.novels.NovelDependencyBaselineEntry.Kind
import epigraph.sync.core.policy.EffectiveSyncPolicy
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import epigraph.sync.core.work.CoreSyncPolicyHook
import kotlinx.coroutines.CancellationException

/**
 * Keeps this phone's LNReader repositories and installed plugins and the paired Core as one list.
 *
 * Both devices are sources of the library, so a novel added here must carry the plugin that reads
 * it to the other device. Only declarations cross Syncd: the repository URL and the plugin's
 * repository, version and artifact hash/size. The other device installs the plugin from that
 * repository and verifies the hash; executable bytes never travel through the Core.
 *
 * Once a repository or plugin is held by both sides, or this device sent it to the Core, it enters
 * the [NovelDependencyBaseline], and from then on a removal on either side reaches the other: removed here becomes a Core delete,
 * and a Core tombstone removes it here. A plugin installed here again after that delete is the
 * newer change and is published instead. Nothing outside the baseline is ever removed, and a
 * missing Core record is never read as a delete.
 *
 * Runs only for the inventories the user kept on in the device's sync selection, before the outbox
 * drains. The pass is idempotent. A declaration the Core already holds, or one still waiting in the
 * outbox, is skipped. A plugin is published only when exactly one configured repository declares
 * it, and private or non-canonical repository URLs stay local.
 */
class LocalNovelDependencyPublisher(
    private val coordinator: EpigraphMutationCoordinator,
    private val repositories: NovelRepoRepository,
    private val plugins: NovelPluginManager,
    private val dependencies: CoreNovelDependencyReader,
    private val scopes: EpigraphSyncScopeProvider,
    private val deviceId: DeviceId,
    private val mutationIds: ClientMutationIdFactory,
    private val baseline: NovelDependencyBaseline = InMemoryNovelDependencyBaseline(),
    private val clock: () -> Long = System::currentTimeMillis,
) : CoreSyncPolicyHook {
    override suspend fun onPolicyResolved(policy: EffectiveSyncPolicy) {
        if (policy.reconcileNovelRepositories || policy.reconcileNovelPlugins) {
            publish(includeRepositories = policy.reconcileNovelRepositories, includePlugins = policy.reconcileNovelPlugins)
        }
    }

    suspend fun publish(includeRepositories: Boolean = true, includePlugins: Boolean = true): Int {
        val scopeId = try {
            scopes.current().novels
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return 0
        }
        val core = dependencies.read(scopeId.value)
        plugins.ensureInstalledPluginsLoaded()
        val agreed = baseline.read(scopeId.value)
        val remote = NovelDependencyReconciliation.remoteRemovals(
            core, agreed, includeRepositories, includePlugins, plugins::installedArtifactModifiedAt,
        )
        remote.pluginIds.forEach { plugins.uninstallPlugin(it) }
        var removedHere = remote.pluginIds.size
        if (remote.repositoryUrls.isNotEmpty()) {
            repositories.getAll()
                .filter { CoreNovelDependencyIds.canonicalRepositoryUrl(it.baseUrl)?.let(remote.repositoryUrls::contains) == true }
                .forEach { repository ->
                    repositories.delete(repository.baseUrl)
                    removedHere++
                }
        }
        val settled = agreed - remote.settledEntityIds

        val localRepositories = localRepositories()
        val localRepositoryIds = localRepositories.mapTo(mutableSetOf(), LocalRepository::id)
        // A plugin that fails to load is still installed, so presence is read from disk.
        val onDisk = plugins.installedArtifactIds()
        val deletions = NovelDependencyReconciliation.localDeletions(
            core, settled, localRepositoryIds, onDisk, includeRepositories, includePlugins,
        ).map { Declaration(it.entityType, SyncCommand.DeleteEntity(EpigraphEntityId(it.entityId))) }

        val declarations = mutableListOf<Declaration>()
        // The Core rejects a plugin whose repository it does not know.
        val knownRepositoryIds = core.repositories.mapTo(mutableSetOf()) { it.repositoryId }
        localRepositories
            .takeIf { includeRepositories }.orEmpty()
            // A repository the Core already holds keeps the state the other device gave it.
            .filter { local -> core.repositories.none { it.repositoryId == local.id } }
            .forEach { local ->
                val descriptor = runCatching {
                    RepositoryDescriptor(
                        ecosystem = LNREADER_ECOSYSTEM,
                        displayName = CoreNovelDependencyIds.repositoryDisplayName(local.canonicalUrl),
                        canonicalUrl = local.canonicalUrl,
                        enabled = true,
                    )
                }.getOrNull() ?: return@forEach
                knownRepositoryIds += local.id
                declarations += Declaration(
                    entityType = EpigraphCoreEntityType.NOVEL_REPOSITORY,
                    command = SyncCommand.UpsertRepository(EpigraphEntityId(local.id), descriptor),
                    sent = NovelDependencyBaselineEntry(local.id, Kind.REPOSITORY, local.canonicalUrl),
                )
            }

        plugins.installedPluginsFlow.value.takeIf { includePlugins }.orEmpty().forEach { installed ->
            val (repository, entry) = declaringRepository(localRepositories, installed.id, installed.version)
                ?: return@forEach
            if (repository.id !in knownRepositoryIds) return@forEach
            val (sha256, byteLength) = plugins.installedArtifactEvidence(installed.id) ?: return@forEach
            val alreadyDeclared = core.plugins.any {
                it.repositoryId == repository.id && it.pluginId == installed.id &&
                    it.version == installed.version && it.artifactSha256 == sha256
            }
            // The Core keeps one artifact per version; a different hash for the same version is a
            // conflict for the user to resolve, not something to overwrite.
            val conflicting = core.plugins.any {
                it.repositoryId == repository.id && it.pluginId == installed.id &&
                    it.version == installed.version && it.artifactSha256 != sha256
            }
            if (alreadyDeclared || conflicting) return@forEach
            val descriptor = runCatching {
                NovelPluginDescriptor(
                    repositoryId = EpigraphEntityId(repository.id),
                    pluginId = installed.id,
                    displayName = entry.name.trim(),
                    version = installed.version,
                    manifestVersion = 1,
                    artifactSha256 = sha256,
                    desiredInstalled = true,
                    sourceId = installed.id,
                    lang = entry.lang.trim(),
                    artifactByteLength = byteLength,
                )
            }.getOrNull() ?: return@forEach
            declarations += Declaration(
                entityType = EpigraphCoreEntityType.NOVEL_PLUGIN,
                command = SyncCommand.UpsertNovelPlugin(
                    EpigraphEntityId(CoreNovelDependencyIds.pluginId(repository.id, installed.id, installed.id)),
                    descriptor,
                ),
                sent = NovelDependencyBaselineEntry(
                    CoreNovelDependencyIds.pluginId(repository.id, installed.id, installed.id),
                    Kind.PLUGIN,
                    installed.id,
                ),
            )
        }

        // What this device sent is agreed from the start, so removing it before the Core confirms
        // it still reaches the other device. A send the Core has not confirmed yet stays agreed
        // while it waits in the outbox.
        val held = core.repositories.mapTo(mutableSetOf()) { it.repositoryId } +
            core.plugins.map(NovelDependencyReconciliation::entityId) + core.removed.keys
        val awaiting = settled.values.filter { it.entityId !in held }
        val stillSending = if (awaiting.isEmpty()) emptyList() else coordinator.readLocal {
            awaiting.filter { entry ->
                aethon_syncQueries.hasUnsettledMutationForEntity(
                    scopeId = scopeId.value,
                    entityType = entry.entityType(),
                    entityId = entry.entityId,
                ).executeAsOne()
            }
        }
        val sent = declarations.mapNotNull(Declaration::sent) + stillSending

        // Plugins go before their repository when deleting, and after it when adding.
        val queued = deletions + declarations
        val queuedDeletions = mutableSetOf<String>()
        val published = if (queued.isEmpty()) 0 else coordinator.mutateLocalBatch(clock()) {
            val envelopes = queued
                .filterNot { declaration ->
                    aethon_syncQueries.hasUnsettledMutationForEntity(
                        scopeId = scopeId.value,
                        entityType = declaration.entityType,
                        entityId = declaration.command.entityId.value,
                    ).executeAsOne()
                }
                .onEach { declaration ->
                    if (declaration.command is SyncCommand.DeleteEntity) queuedDeletions += declaration.command.entityId.value
                }
                .map { declaration -> envelope(scopeId, declaration) }
            LocalMutationResult(envelopes.size, envelopes)
        }
        // Written only after the deletes are queued: one still waiting stays agreed and is tried again.
        baseline.write(
            scopeId.value,
            NovelDependencyReconciliation.nextBaseline(
                core = core,
                agreed = settled,
                localRepositoryIds = localRepositoryIds,
                installedPluginIds = onDisk,
                deletedEntityIds = queuedDeletions,
                pendingDeletionIds = deletions.mapTo(mutableSetOf()) { it.command.entityId.value } - queuedDeletions,
                includeRepositories = includeRepositories,
                includePlugins = includePlugins,
                sent = sent,
            ),
        )
        return removedHere + published
    }

    private suspend fun localRepositories(): List<LocalRepository> =
        repositories.getAll().mapNotNull { repo ->
            val canonicalUrl = CoreNovelDependencyIds.canonicalRepositoryUrl(repo.baseUrl) ?: return@mapNotNull null
            LocalRepository(
                id = CoreNovelDependencyIds.repositoryId(canonicalUrl),
                canonicalUrl = canonicalUrl,
                index = plugins.cachedRepositoryPlugins(repo.baseUrl),
            )
        }.distinctBy(LocalRepository::id)

    /** The configured repository whose index lists this plugin, preferring the installed version. */
    private fun declaringRepository(
        repositories: List<LocalRepository>,
        pluginId: String,
        version: String,
    ): Pair<LocalRepository, NovelPluginIndex>? {
        val listed = repositories.mapNotNull { repository ->
            repository.index.firstOrNull { it.id == pluginId }?.let { repository to it }
        }
        val sameVersion = listed.filter { (_, entry) -> entry.version == version }
        return (sameVersion.singleOrNull() ?: listed.singleOrNull())
            ?.takeIf { (_, entry) -> entry.name.isNotBlank() && entry.lang.isNotBlank() }
    }

    private fun envelope(scopeId: SyncScopeId, declaration: Declaration) = SyncCommandEnvelope(
        protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
        deviceId = deviceId,
        clientMutationId = mutationIds.next(),
        scopeId = scopeId,
        entityType = SyncEntityType(declaration.entityType),
        command = declaration.command,
    )

    private data class LocalRepository(
        val id: String,
        val canonicalUrl: String,
        val index: List<NovelPluginIndex>,
    )

    private data class Declaration(
        val entityType: String,
        val command: SyncCommand,
        /** The baseline entry an upsert from this device stands for. */
        val sent: NovelDependencyBaselineEntry? = null,
    )

    private fun NovelDependencyBaselineEntry.entityType(): String = when (kind) {
        Kind.REPOSITORY -> EpigraphCoreEntityType.NOVEL_REPOSITORY
        Kind.PLUGIN -> EpigraphCoreEntityType.NOVEL_PLUGIN
    }

    private companion object {
        const val LNREADER_ECOSYSTEM = "lnreader"
    }
}
