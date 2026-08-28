package epigraph.sync.core.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EpigraphCoreBootstrapPlanTest {
    @Test
    fun `orders dependencies before categories works and reader state`() {
        val capabilities = capabilities(
            setOf(
                "novel.history",
                "novel.entry",
                "novel.plugin",
                "novel.repository",
                "novel.category_assignment",
                "novel.category",
            ),
        )
        val candidates = listOf(
            CoreSyncCandidate("history", "novel.history"),
            CoreSyncCandidate("work", "novel.entry"),
            CoreSyncCandidate("assignment", "novel.category_assignment"),
            CoreSyncCandidate("plugin", "novel.plugin"),
            CoreSyncCandidate("category", "novel.category"),
            CoreSyncCandidate("repo", "novel.repository"),
        )

        assertEquals(
            listOf("repo", "plugin", "category", "work", "assignment", "history"),
            EpigraphCoreBootstrapPlanner.plan(capabilities, candidates).orderedCandidates().map { it.id },
        )
    }

    @Test
    fun `keeps unsupported comic library mutations blocked instead of reporting success`() {
        val capabilities = capabilities(setOf("comic.history", "comic.page_bookmark"))
        val plan = EpigraphCoreBootstrapPlanner.plan(
            capabilities,
            listOf(
                CoreSyncCandidate("entry", "comic.entry"),
                CoreSyncCandidate("history", "comic.history"),
            ),
        )

        assertEquals(listOf("history"), plan.orderedCandidates().map { it.id })
        assertEquals(listOf("entry"), plan.blockedByCore.map { it.id })
    }

    @Test
    fun `books transfer metadata before immutable asset phase`() {
        assertEquals(CoreBootstrapPhase.LIBRARY_ENTRIES, EpigraphCoreBootstrapPlanner.phaseOf("book.entry"))
        assertEquals(CoreBootstrapPhase.ASSETS, EpigraphCoreBootstrapPlanner.phaseOf("novel.chapter_asset"))
    }

    private fun capabilities(entityTypes: Set<String>) = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("books:global"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = true,
        supportsSnapshot = true,
        supportsAssets = true,
        supportsNovelChapterAssets = true,
        supportsNovelPluginSync = true,
        supportsSuwayomiProxy = true,
        supportsSuwayomiWebsocketProxy = true,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = 1,
        snapshotEntityTypes = entityTypes,
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
    )
}
