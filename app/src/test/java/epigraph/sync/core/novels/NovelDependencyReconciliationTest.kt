package epigraph.sync.core.novels

import epigraph.sync.core.novels.NovelDependencyBaselineEntry.Kind
import epigraph.sync.core.novels.NovelDependencyReconciliation.Deletion
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class NovelDependencyReconciliationTest {
    private val repoUrl = "https://plugins.test/index.json"
    private val repoId = CoreNovelDependencyIds.repositoryId(repoUrl)
    private val repository = CoreNovelRepositoryRequirement(repoId, repoUrl, "plugins.test", enabled = true)
    private val plugin = CoreNovelPluginRequirement(
        repositoryId = repoId,
        pluginId = "novelfire",
        sourceId = "novelfire",
        version = "1.0.0",
        enabled = true,
        artifactSha256 = "a".repeat(64),
        artifactByteLength = 10,
    )
    private val pluginId = NovelDependencyReconciliation.entityId(plugin)
    private val agreed = mapOf(
        repoId to NovelDependencyBaselineEntry(repoId, Kind.REPOSITORY, repoUrl),
        pluginId to NovelDependencyBaselineEntry(pluginId, Kind.PLUGIN, "novelfire"),
    )

    @Test
    fun `first meeting removes nothing and remembers what both sides hold`() {
        val core = CoreNovelDependencyManifest(listOf(repository), listOf(plugin))

        val removals = NovelDependencyReconciliation.remoteRemovals(core, emptyMap(), true, true) { 1L }
        val deletions = NovelDependencyReconciliation.localDeletions(core, emptyMap(), emptySet(), emptySet(), true, true)
        val next = NovelDependencyReconciliation.nextBaseline(
            core, emptyMap(), setOf(repoId), setOf("novelfire"), emptySet(), emptySet(), true, true,
        )

        assertEquals(emptyList<String>(), removals.pluginIds + removals.repositoryUrls)
        assertEquals(emptyList<Deletion>(), deletions)
        assertEquals(agreed.values.toSet(), next.toSet())
    }

    @Test
    fun `a delete from the other device removes what both sides held`() {
        val core = CoreNovelDependencyManifest(emptyList(), emptyList(), removed = mapOf(repoId to 500L, pluginId to 400L))

        val removals = NovelDependencyReconciliation.remoteRemovals(core, agreed, true, true) { 300L }

        assertEquals(listOf("novelfire"), removals.pluginIds)
        assertEquals(listOf(repoUrl), removals.repositoryUrls)
        assertEquals(setOf(repoId, pluginId), removals.settledEntityIds)
    }

    @Test
    fun `a plugin installed again after the delete is kept`() {
        val core = CoreNovelDependencyManifest(listOf(repository), emptyList(), removed = mapOf(pluginId to 400L))

        val removals = NovelDependencyReconciliation.remoteRemovals(core, agreed, true, true) { 900L }

        assertEquals(emptyList<String>(), removals.pluginIds)
        assertEquals(setOf(pluginId), removals.settledEntityIds)
    }

    @Test
    fun `a tombstone outside the baseline or for an excluded kind removes nothing`() {
        val core = CoreNovelDependencyManifest(emptyList(), emptyList(), removed = mapOf(repoId to 500L, pluginId to 400L))

        val unknown = NovelDependencyReconciliation.remoteRemovals(core, emptyMap(), true, true) { 300L }
        val pluginsOff = NovelDependencyReconciliation.remoteRemovals(core, agreed, true, false) { 300L }

        assertEquals(emptyList<String>(), unknown.pluginIds + unknown.repositoryUrls)
        assertEquals(emptyList<String>(), pluginsOff.pluginIds)
        assertEquals(setOf(repoId), pluginsOff.settledEntityIds)
    }

    @Test
    fun `removing here deletes plugins before their repository`() {
        val core = CoreNovelDependencyManifest(listOf(repository), listOf(plugin))

        val pluginOnly = NovelDependencyReconciliation.localDeletions(core, agreed, setOf(repoId), emptySet(), true, true)
        val repositoryGone = NovelDependencyReconciliation.localDeletions(core, agreed, emptySet(), setOf("novelfire"), true, true)

        assertEquals(listOf(Deletion(EpigraphCoreEntityType.NOVEL_PLUGIN, pluginId)), pluginOnly)
        assertEquals(
            listOf(
                Deletion(EpigraphCoreEntityType.NOVEL_PLUGIN, pluginId),
                Deletion(EpigraphCoreEntityType.NOVEL_REPOSITORY, repoId),
            ),
            repositoryGone,
        )
    }

    @Test
    fun `nothing is deleted when plugins cannot be read or the entry was never agreed`() {
        val core = CoreNovelDependencyManifest(listOf(repository), listOf(plugin))

        val unreadable = NovelDependencyReconciliation.localDeletions(core, agreed, emptySet(), null, true, true)
        val notAgreed = NovelDependencyReconciliation.localDeletions(core, emptyMap(), emptySet(), emptySet(), true, true)

        assertEquals(emptyList<Deletion>(), unreadable)
        assertEquals(emptyList<Deletion>(), notAgreed)
    }

    @Test
    fun `a delete that waits stays agreed and a queued one leaves`() {
        val core = CoreNovelDependencyManifest(listOf(repository), listOf(plugin))

        val next = NovelDependencyReconciliation.nextBaseline(
            core = core,
            agreed = agreed,
            localRepositoryIds = emptySet(),
            installedPluginIds = emptySet(),
            deletedEntityIds = setOf(pluginId),
            pendingDeletionIds = setOf(repoId),
            includeRepositories = true,
            includePlugins = true,
        )

        assertEquals(listOf(agreed.getValue(repoId)), next)
    }

    @Test
    fun `a plugin sent here and removed before the Core confirms it is still deleted`() {
        val sentPlugin = agreed.getValue(pluginId)
        val beforeConfirm = CoreNovelDependencyManifest(listOf(repository), emptyList())

        val afterSend = NovelDependencyReconciliation.nextBaseline(
            core = beforeConfirm,
            agreed = mapOf(repoId to agreed.getValue(repoId)),
            localRepositoryIds = setOf(repoId),
            installedPluginIds = setOf("novelfire"),
            deletedEntityIds = emptySet(),
            pendingDeletionIds = emptySet(),
            includeRepositories = true,
            includePlugins = true,
            sent = listOf(sentPlugin),
        ).associateBy(NovelDependencyBaselineEntry::entityId)
        val confirmed = CoreNovelDependencyManifest(listOf(repository), listOf(plugin))
        val deletions = NovelDependencyReconciliation.localDeletions(
            confirmed, afterSend, setOf(repoId), emptySet(), true, true,
        )

        assertEquals(agreed, afterSend)
        assertEquals(listOf(Deletion(EpigraphCoreEntityType.NOVEL_PLUGIN, pluginId)), deletions)
    }

    @Test
    fun `a sent entry deleted in the same pass leaves the baseline`() {
        val next = NovelDependencyReconciliation.nextBaseline(
            core = CoreNovelDependencyManifest(emptyList(), emptyList()),
            agreed = emptyMap(),
            localRepositoryIds = emptySet(),
            installedPluginIds = emptySet(),
            deletedEntityIds = setOf(pluginId),
            pendingDeletionIds = emptySet(),
            includeRepositories = true,
            includePlugins = true,
            sent = listOf(agreed.getValue(pluginId)),
        )

        assertEquals(emptyList<NovelDependencyBaselineEntry>(), next)
    }

    @Test
    fun `kinds not reconciled keep their entries`() {
        val core = CoreNovelDependencyManifest(emptyList(), emptyList())

        val next = NovelDependencyReconciliation.nextBaseline(
            core, agreed, emptySet(), null, emptySet(), emptySet(), includeRepositories = false, includePlugins = true,
        )

        assertEquals(agreed.values.toSet(), next.toSet())
    }
}
