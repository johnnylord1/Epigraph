package epigraph.sync.core.extensions

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CoreSourceRelinkerTest {
    @Test
    fun `relinks only candidates confirmed by the local extension registry`() = runTest {
        val ready = candidate("ready", "ext.ready", 10)
        val pending = candidate("pending", "ext.missing", 20)
        val applied = mutableListOf<String>()
        val relinker = CoreSourceRelinker(
            store = object : CoreSourceRelinkStore {
                override suspend fun resolveUnknownPackages(
                    serverId: String,
                    profileId: String,
                    packagesBySourceId: Map<Long, String>,
                ) = Unit
                override suspend fun candidates() = listOf(ready, pending)
                override suspend fun relink(candidate: CoreSourceRelinkCandidate): Boolean {
                    applied += candidate.entityId
                    return true
                }
            },
            registry = CoreSourceRegistry { packageName, sourceId ->
                packageName == ready.packageName && sourceId == ready.sourceId
            },
        )

        val result = relinker.relinkAvailable()

        assertEquals(listOf("ready"), applied)
        assertEquals(CoreSourceRelinkResult(observed = 2, relinked = 1, pending = 1), result)
    }

    @Test
    fun `retry remains idempotent when the store reports an existing relink`() = runTest {
        val candidate = candidate("same", "ext.same", 30)
        var calls = 0
        val relinker = CoreSourceRelinker(
            store = object : CoreSourceRelinkStore {
                override suspend fun resolveUnknownPackages(
                    serverId: String,
                    profileId: String,
                    packagesBySourceId: Map<Long, String>,
                ) = Unit
                override suspend fun candidates() = listOf(candidate)
                override suspend fun relink(candidate: CoreSourceRelinkCandidate): Boolean {
                    calls += 1
                    return true
                }
            },
            registry = CoreSourceRegistry { _, _ -> true },
        )

        assertEquals(1, relinker.relinkAvailable().relinked)
        assertEquals(1, relinker.relinkAvailable().relinked)
        assertEquals(2, calls)
    }

    @Test
    fun `cached inventory is applied before relink candidates are loaded`() = runTest {
        val resolved = mutableMapOf<Long, String>()
        val candidate = candidate("legacy", "ext.resolved", 40)
        val relinker = CoreSourceRelinker(
            store = object : CoreSourceRelinkStore {
                override suspend fun resolveUnknownPackages(
                    serverId: String,
                    profileId: String,
                    packagesBySourceId: Map<Long, String>,
                ) {
                    assertEquals("server-a", serverId)
                    assertEquals("main", profileId)
                    resolved += packagesBySourceId
                }

                override suspend fun candidates(): List<CoreSourceRelinkCandidate> {
                    assertEquals(mapOf(40L to "ext.resolved"), resolved)
                    return listOf(candidate)
                }

                override suspend fun relink(candidate: CoreSourceRelinkCandidate) = true
            },
            registry = CoreSourceRegistry { _, _ -> true },
        )

        val result = relinker.relinkAvailable(
            listOf(CoreSourcePackageScope("server-a", "main", mapOf(40L to "ext.resolved"))),
        )

        assertEquals(1, result.relinked)
    }

    private fun candidate(entityId: String, packageName: String, sourceId: Long) =
        CoreSourceRelinkCandidate(
            entityId = entityId,
            packageName = packageName,
            sourceId = sourceId,
            originalUrl = "/title/$entityId",
            localMangaId = sourceId,
        )
}
