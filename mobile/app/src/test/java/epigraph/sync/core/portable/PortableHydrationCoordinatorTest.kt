package epigraph.sync.core.portable

import epigraph.contract.ComicDependency
import epigraph.contract.DecimalSourceId
import epigraph.contract.DependencyResolutionResult
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableContentProvider
import epigraph.contract.PortableEcosystem
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderDependency
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.WorkResolution
import epigraph.contract.ChapterResolution
import epigraph.sync.portable.PortableComicDependencyRecord
import epigraph.sync.portable.PortableChapterBindingRecord
import epigraph.sync.portable.PortableNovelDependencyRecord
import epigraph.sync.portable.PortableWorkBindingRecord
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PortableHydrationCoordinatorTest {
    @Test
    fun `already installed comic remains usable before repository approval`() = runTest {
        val installed = dependency("fixture.installed", "7", trustState = "APPROVAL_REQUIRED")
        val store = FakeStore(
            PortableHydrationSnapshot(
                comics = listOf(installed),
                novels = emptyList(),
                works = listOf(work("installed-work", "7", installed.dependency.pkgName)),
            ),
        )
        val comics = FakeProvider(
            ecosystem = PortableEcosystem.SUWAYOMI,
            dependencyResolution = { ready() },
        )

        val report = PortableHydrationCoordinator(
            store,
            comics,
            FakeProvider(PortableEcosystem.LNREADER),
        ).hydrate("server", "main", 100)

        assertEquals(1, report.boundWorks)
        assertEquals(PortableResolutionState.BOUND, store.works.single().resolution.state)
    }

    @Test
    fun `unresolved dependency does not block an independent source`() = runTest {
        val first = dependency("fixture.one", "1")
        val second = dependency("fixture.two", "2")
        val store = FakeStore(
            PortableHydrationSnapshot(
                comics = listOf(first, second),
                novels = emptyList(),
                works = listOf(
                    work("work-1", "1", first.dependency.pkgName),
                    work("work-2", "2", second.dependency.pkgName),
                ),
            ),
        )
        val comics = FakeProvider(
            ecosystem = PortableEcosystem.SUWAYOMI,
            dependencyResolution = { dependency ->
            if ((dependency as ProviderDependency.Comic).dependency.pkgName == first.dependency.pkgName) ready() else {
                PortableResolution(
                    PortableResolutionState.REQUIRES_USER_ACTION,
                    PortableResolutionReason.EXTENSION_STORE_APPROVAL_REQUIRED,
                )
            }
            },
        )
        val coordinator = PortableHydrationCoordinator(
            store,
            comics,
            FakeProvider(PortableEcosystem.LNREADER),
        )

        val report = coordinator.hydrate("server", "main", 100)

        assertEquals(1, report.boundWorks)
        assertEquals(1, report.pendingWorks)
        assertEquals(PortableResolutionState.BOUND, store.works.single { it.portableId == "work-1" }.resolution.state)
        assertEquals(
            PortableResolutionReason.EXTENSION_STORE_APPROVAL_REQUIRED,
            store.works.single { it.portableId == "work-2" }.resolution.reason,
        )
    }

    @Test
    fun `source queues are serial internally and bounded globally`() = runTest {
        val dependencies = (1..3).map { dependency("fixture.source$it", it.toString()) }
        val works = dependencies.flatMap { dependency ->
            dependency.dependency.requiredSourceIds.flatMap { source ->
                listOf(
                    work("${source.value}-a", source.value, dependency.dependency.pkgName),
                    work("${source.value}-b", source.value, dependency.dependency.pkgName),
                )
            }
        }
        val store = FakeStore(PortableHydrationSnapshot(dependencies, emptyList(), works))
        val active = AtomicInteger()
        val maxActive = AtomicInteger()
        val activeBySource = ConcurrentHashMap<String, AtomicInteger>()
        val maxBySource = ConcurrentHashMap<String, AtomicInteger>()
        val comics = FakeProvider(
            ecosystem = PortableEcosystem.SUWAYOMI,
            resolve = { ref ->
                val source = (ref as PortableWorkRef.Comic).sourceId.value
                val global = active.incrementAndGet()
                maxActive.updateAndGet { maxOf(it, global) }
                val sourceActive = activeBySource.computeIfAbsent(source) { AtomicInteger() }.incrementAndGet()
                maxBySource.computeIfAbsent(source) { AtomicInteger() }.updateAndGet { maxOf(it, sourceActive) }
                delay(10)
                activeBySource.getValue(source).decrementAndGet()
                active.decrementAndGet()
                WorkResolution(ref, ready(PortableResolutionState.BOUND), "local-${ref.mangaKey.value}")
            },
        )

        val report = PortableHydrationCoordinator(
            store,
            comics,
            FakeProvider(PortableEcosystem.LNREADER),
            maxConcurrentSourceQueues = 2,
        ).hydrate("server", "main", 100)

        assertEquals(6, report.boundWorks)
        assertEquals(2, maxActive.get())
        assertEquals(setOf(1), maxBySource.values.map(AtomicInteger::get).toSet())
    }

    @Test
    fun `installed comic source resolves by exact source id when package metadata is absent`() = runTest {
        val dependency = dependency("fixture.one", "1")
        val missingKey = work("missing-key", "1", dependencyKey = null)
        val wrongSource = work("wrong-source", "2", dependency.dependency.pkgName)
        var resolveCalls = 0
        val store = FakeStore(
            PortableHydrationSnapshot(listOf(dependency), emptyList(), listOf(missingKey, wrongSource)),
        )
        val comics = FakeProvider(
            ecosystem = PortableEcosystem.SUWAYOMI,
            resolve = { ref ->
                resolveCalls += 1
                WorkResolution(ref, ready(PortableResolutionState.BOUND), "unexpected")
            },
        )

        PortableHydrationCoordinator(
            store,
            comics,
            FakeProvider(PortableEcosystem.LNREADER),
        ).hydrate("server", "main", 100)

        assertEquals(1, resolveCalls)
        assertEquals(
            PortableResolutionState.BOUND,
            store.works.single { it.portableId == "missing-key" }.resolution.state,
        )
        assertEquals(
            PortableResolutionState.CONFLICT,
            store.works.single { it.portableId == "wrong-source" }.resolution.state,
        )
    }

    private class FakeStore(
        private val snapshot: PortableHydrationSnapshot,
    ) : PortableHydrationStore {
        var works: List<PortableWorkBindingRecord> = emptyList()

        override suspend fun load(serverId: String, profileId: String, limit: Long) = snapshot

        override suspend fun persist(
            comicDependencies: List<PortableComicDependencyRecord>,
            novelDependencies: List<PortableNovelDependencyRecord>,
            works: List<PortableWorkBindingRecord>,
            chapters: List<PortableChapterBindingRecord>,
        ) {
            this.works = works
        }
    }

    private class FakeProvider(
        override val ecosystem: PortableEcosystem,
        private val dependencyResolution: (ProviderDependency) -> PortableResolution = { ready() },
        private val resolve: suspend (PortableWorkRef) -> WorkResolution = { ref ->
            WorkResolution(ref, ready(PortableResolutionState.BOUND), "local-${ref.hashCode()}")
        },
    ) : PortableContentProvider {
        override suspend fun inspectDependencies(dependencies: List<ProviderDependency>) =
            DependencyResolutionResult(dependencies.associateWith(dependencyResolution))

        override suspend fun resolveWork(ref: PortableWorkRef): WorkResolution = resolve(ref)

        override suspend fun resolveChapter(ref: PortableChapterRef) =
            ChapterResolution(ref, PortableResolution(PortableResolutionState.PENDING_PROVIDER))
    }

    private companion object {
        fun dependency(
            pkgName: String,
            sourceId: String,
            trustState: String = "TRUSTED",
        ) = PortableComicDependencyRecord(
            serverId = "server",
            profileId = "main",
            dependency = ComicDependency(pkgName, setOf(DecimalSourceId(sourceId))),
            trustState = trustState,
            resolution = PortableResolution(PortableResolutionState.PENDING_DEPENDENCY),
            updatedAt = 1,
        )

        fun work(portableId: String, sourceId: String, dependencyKey: String?) = PortableWorkBindingRecord(
            portableId = portableId,
            ref = PortableWorkRef.Comic(DecimalSourceId(sourceId), ProviderOwnedKey("/manga/$portableId")),
            dependencyKey = dependencyKey,
            localReference = null,
            resolution = PortableResolution(PortableResolutionState.PENDING_DEPENDENCY),
            titleHint = null,
            providerLabelHint = null,
            attemptCount = 0,
            updatedAt = 1,
        )

        fun ready(state: PortableResolutionState = PortableResolutionState.READY) = PortableResolution(state)
    }
}
