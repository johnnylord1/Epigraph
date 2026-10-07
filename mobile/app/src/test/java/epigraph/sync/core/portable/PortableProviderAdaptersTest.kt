package epigraph.sync.core.portable

import epigraph.contract.ComicDependency
import epigraph.contract.ChapterResolution
import epigraph.contract.DecimalSourceId
import epigraph.contract.ExtensionStoreReference
import epigraph.contract.NovelDependency
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderDependency
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.RepositoryReference
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PortableProviderAdaptersTest {
    @Test
    fun `comic dependency is ready only when the exact source is loaded by the package`() = runTest {
        val registry = FakeComicRegistry(
            installed = setOf(PACKAGE),
            packagesBySource = mapOf(10L to PACKAGE, 11L to "other.package"),
            readySources = setOf(10L, 11L),
        )
        val provider = MihonPortableProvider(registry, EmptyLookup)
        val ready = comicDependency(setOf("10"))
        val mismatch = comicDependency(setOf("11"))

        val report = provider.inspectDependencies(listOf(ready, mismatch)).resolutions

        assertEquals(PortableResolutionState.READY, report.getValue(ready).state)
        assertEquals(PortableResolutionState.REQUIRES_USER_ACTION, report.getValue(mismatch).state)
    }

    @Test
    fun `a fork loading the same source id stands in for a package that is not installed`() = runTest {
        val registry = FakeComicRegistry(
            installed = setOf("revived.package"),
            packagesBySource = mapOf(10L to "revived.package"),
            readySources = setOf(10L),
        )
        val provider = MihonPortableProvider(registry, EmptyLookup)
        val served = comicDependency(setOf("10"))
        val missing = comicDependency(setOf("12"))

        val report = provider.inspectDependencies(listOf(served, missing)).resolutions

        assertEquals(PortableResolutionState.READY, report.getValue(served).state)
        assertEquals(PortableResolutionReason.EXTENSION_NOT_FOUND, report.getValue(missing).reason)
    }

    @Test
    fun `comic work binds only by exact source and opaque key`() = runTest {
        val ref = PortableWorkRef.Comic(DecimalSourceId("10"), ProviderOwnedKey("/Keep/Case?A=%2F"))
        val lookup = object : PortableLocalEntityLookup by EmptyLookup {
            override suspend fun comicWork(sourceId: Long, mangaKey: String): String? =
                if (sourceId == 10L && mangaKey == "/Keep/Case?A=%2F") "918" else null
        }
        val provider = MihonPortableProvider(
            FakeComicRegistry(setOf(PACKAGE), mapOf(10L to PACKAGE), setOf(10L)),
            lookup,
        )

        val resolution = provider.resolveWork(ref)

        assertEquals(PortableResolutionState.BOUND, resolution.resolution.state)
        assertEquals("918", resolution.localId)
    }

    @Test
    fun `missing chapter is delegated to the upstream chapter materializer`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("10"), ProviderOwnedKey("/series/Exact"))
        val chapter = PortableChapterRef.Comic(work, ProviderOwnedKey("/chapter/2?part=Keep"))
        val provider = MihonPortableProvider(
            FakeComicRegistry(setOf(PACKAGE), mapOf(10L to PACKAGE), setOf(10L)),
            EmptyLookup,
            chapterMaterializer = PortableChapterMaterializer { requested ->
                ChapterResolution(
                    requested,
                    PortableResolution(PortableResolutionState.BOUND),
                    "441",
                )
            },
        )

        val resolution = provider.resolveChapter(chapter)

        assertEquals(chapter, resolution.ref)
        assertEquals(PortableResolutionState.BOUND, resolution.resolution.state)
        assertEquals("441", resolution.localId)
    }

    @Test
    fun `missing chapters from one source are delegated as one batch`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("10"), ProviderOwnedKey("/series/Exact"))
        val chapters = listOf(
            PortableChapterRef.Comic(work, ProviderOwnedKey("/chapter/1")),
            PortableChapterRef.Comic(work, ProviderOwnedKey("/chapter/2")),
        )
        var batchCalls = 0
        val materializer = object : PortableChapterMaterializer {
            override suspend fun materialize(ref: PortableChapterRef): ChapterResolution =
                error("single-item fallback must not be used")

            override suspend fun materializeAll(refs: List<PortableChapterRef>): List<ChapterResolution> {
                batchCalls += 1
                return refs.mapIndexed { index, ref ->
                    ChapterResolution(
                        ref,
                        PortableResolution(PortableResolutionState.BOUND),
                        "local-${index + 1}",
                    )
                }
            }
        }
        val provider = MihonPortableProvider(
            FakeComicRegistry(setOf(PACKAGE), mapOf(10L to PACKAGE), setOf(10L)),
            EmptyLookup,
            chapterMaterializer = materializer,
        )

        val resolutions = provider.resolveChapters(chapters)

        assertEquals(1, batchCalls)
        assertEquals(chapters, resolutions.map(ChapterResolution::ref))
        assertEquals(listOf("local-1", "local-2"), resolutions.map(ChapterResolution::localId))
    }

    @Test
    fun `comic chapter is not materialized before its exact source is loaded`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("10"), ProviderOwnedKey("/series/Exact"))
        val chapter = PortableChapterRef.Comic(work, ProviderOwnedKey("/chapter/1"))
        var materializerCalls = 0
        val provider = MihonPortableProvider(
            FakeComicRegistry(setOf(PACKAGE), mapOf(10L to PACKAGE), emptySet()),
            EmptyLookup,
            chapterMaterializer = PortableChapterMaterializer { requested ->
                materializerCalls += 1
                ChapterResolution(requested, PortableResolution(PortableResolutionState.BOUND), "unexpected")
            },
        )

        val resolution = provider.resolveChapter(chapter)

        assertEquals(0, materializerCalls)
        assertEquals(PortableResolutionState.RETRYABLE_FAILURE, resolution.resolution.state)
        assertEquals(PortableResolutionReason.SOURCE_NOT_LOADED, resolution.resolution.reason)
    }

    @Test
    fun `restored comic binds to its exact local rows while the extension is not installed`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("10"), ProviderOwnedKey("/series/Exact"))
        val chapter = PortableChapterRef.Comic(work, ProviderOwnedKey("/chapter/1"))
        val lookup = object : PortableLocalEntityLookup by EmptyLookup {
            override suspend fun comicWork(sourceId: Long, mangaKey: String): String? =
                if (sourceId == 10L && mangaKey == "/series/Exact") "918" else null

            override suspend fun comicChapter(sourceId: Long, mangaKey: String, chapterKey: String): String? =
                if (sourceId == 10L && mangaKey == "/series/Exact" && chapterKey == "/chapter/1") "77" else null
        }
        val provider = MihonPortableProvider(FakeComicRegistry(emptySet(), emptyMap(), emptySet()), lookup)

        val existing = provider.resolveExistingWork(work)
        val resolved = provider.resolveWork(work)
        val chapterResolution = provider.resolveChapter(chapter)

        assertEquals(PortableResolutionState.BOUND, existing?.resolution?.state)
        assertEquals("918", existing?.localId)
        assertEquals("918", resolved.localId)
        assertEquals(PortableResolutionState.BOUND, chapterResolution.resolution.state)
        assertEquals("77", chapterResolution.localId)
        assertNull(
            provider.resolveExistingWork(
                PortableWorkRef.Comic(DecimalSourceId("10"), ProviderOwnedKey("/series/Other")),
            ),
        )
    }

    @Test
    fun `trusted novel dependency still requires the exact plugin to be installed`() = runTest {
        val dependency = ProviderDependency.Novel(
            NovelDependency(
                pluginId = "plugin.example",
                repository = RepositoryReference("https://plugins.example/.dist/plugins.min.json"),
            ),
        )
        val provider = LnReaderPortableProvider(FakeNovelRegistry(), EmptyLookup)

        val resolution = provider.inspectDependencies(listOf(dependency)).resolutions.getValue(dependency)

        assertEquals(PortableResolutionState.PENDING_DEPENDENCY, resolution.state)
        assertEquals(PortableResolutionReason.PLUGIN_NOT_FOUND, resolution.reason)
        assertEquals("plugin.example", dependency.dependency.pluginId)
        assertNull(provider.resolveWork(
            PortableWorkRef.Novel("plugin.example", ProviderOwnedKey("novel/path")),
        ).localId)
    }

    @Test
    fun `installed novel plugin is not ready until its exact source is loaded`() = runTest {
        val dependency = ProviderDependency.Novel(NovelDependency(pluginId = "plugin.example"))
        val provider = LnReaderPortableProvider(
            FakeNovelRegistry(installed = setOf("plugin.example")),
            EmptyLookup,
        )

        val resolution = provider.inspectDependencies(listOf(dependency)).resolutions.getValue(dependency)

        assertEquals(PortableResolutionState.RETRYABLE_FAILURE, resolution.state)
        assertEquals(PortableResolutionReason.SOURCE_NOT_LOADED, resolution.reason)
    }

    private fun comicDependency(sourceIds: Set<String>) = ProviderDependency.Comic(
        ComicDependency(
            pkgName = PACKAGE,
            requiredSourceIds = sourceIds.map(::DecimalSourceId).toSet(),
            extensionStore = ExtensionStoreReference("https://store.example/index.min.json"),
        ),
    )

    private class FakeComicRegistry(
        private val installed: Set<String>,
        private val packagesBySource: Map<Long, String>,
        private val readySources: Set<Long>,
    ) : ComicDependencyRegistry {
        override fun isPackageInstalled(packageName: String): Boolean = packageName in installed
        override fun packageForSource(sourceId: Long): String? = packagesBySource[sourceId]
        override fun isSourceReady(sourceId: Long): Boolean = sourceId in readySources
    }

    private class FakeNovelRegistry(
        private val installed: Set<String> = emptySet(),
        private val sources: Map<String, Long> = emptyMap(),
    ) : NovelDependencyRegistry {
        override suspend fun prepare() = Unit
        override fun isPluginInstalled(pluginId: String): Boolean = pluginId in installed
        override fun sourceId(pluginId: String): Long? = sources[pluginId]
    }

    private object EmptyLookup : PortableLocalEntityLookup {
        override suspend fun comicWork(sourceId: Long, mangaKey: String): String? = null
        override suspend fun comicChapter(sourceId: Long, mangaKey: String, chapterKey: String): String? = null
        override suspend fun novelWork(sourceId: Long, novelKey: String): String? = null
        override suspend fun novelChapter(sourceId: Long, novelKey: String, chapterKey: String): String? = null
    }

    private companion object {
        const val PACKAGE = "eu.kanade.tachiyomi.extension.en.example"
    }
}
