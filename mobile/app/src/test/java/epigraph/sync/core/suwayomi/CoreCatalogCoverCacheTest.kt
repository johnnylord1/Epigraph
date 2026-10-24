package epigraph.sync.core.suwayomi

import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import java.nio.file.Path
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class CoreCatalogCoverCacheTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `materializes a bounded valid cover batch atomically`() = runTest {
        val requested = mutableListOf<String>()
        val bytes = pngBytes()
        val cache = CoreCatalogCoverCache(
            client = CoreCoverByteSource { reference ->
                requested += reference
                CoreHttpResult.Success(bytes)
            },
            store = CoreCatalogCoverStore { reference ->
                directory.resolve(reference.hashCode().toString()).toFile()
            },
            maxPerSync = 1,
        )
        val first = reference(1)
        val second = reference(2)

        cache.materialize(listOf(CoreCatalogCoverReference(first), CoreCatalogCoverReference(second)))

        assertEquals(listOf(first), requested)
        assertArrayEquals(bytes, directory.resolve(first.hashCode().toString()).toFile().readBytes())
        assertFalse(directory.resolve(second.hashCode().toString()).toFile().exists())
        assertTrue(directory.toFile().listFiles().orEmpty().none { it.extension == "part" })
    }

    @Test
    fun `keeps a confirmed cached cover while unpaired fetch is unavailable`() = runTest {
        val reference = reference(7)
        val target = directory.resolve(reference.hashCode().toString()).toFile()
        target.writeBytes(pngBytes())
        var requests = 0
        val cache = CoreCatalogCoverCache(
            client = CoreCoverByteSource {
                requests += 1
                CoreHttpResult.Failure(401, null)
            },
            store = CoreCatalogCoverStore { target },
        )

        cache.materialize(listOf(CoreCatalogCoverReference(reference)))

        assertEquals(0, requests)
        assertArrayEquals(pngBytes(), target.readBytes())
    }

    @Test
    fun `does not publish an invalid image payload`() = runTest {
        val reference = reference(9)
        val target = directory.resolve("invalid-cover").toFile()
        val cache = CoreCatalogCoverCache(
            client = CoreCoverByteSource { CoreHttpResult.Success("not-an-image".encodeToByteArray()) },
            store = CoreCatalogCoverStore { target },
        )

        cache.materialize(listOf(CoreCatalogCoverReference(reference)))

        assertFalse(target.exists())
    }

    @Test
    fun `materializes gif covers used by suwayomi sources`() = runTest {
        val reference = reference(10)
        val target = directory.resolve("animated-cover").toFile()
        val bytes = "GIF89a".encodeToByteArray() + byteArrayOf(0x01, 0x00, 0x01, 0x00)
        val cache = CoreCatalogCoverCache(
            client = CoreCoverByteSource { CoreHttpResult.Success(bytes) },
            store = CoreCatalogCoverStore { target },
        )

        cache.materialize(listOf(CoreCatalogCoverReference(reference)))

        assertArrayEquals(bytes, target.readBytes())
    }

    @Test
    fun `advances the persistent cursor after an upstream failure`() = runTest {
        val first = reference(11)
        val second = reference(12)
        var storedCursor = 0
        val requested = mutableListOf<String>()
        val store = object : CoreCatalogCoverStore {
            override fun target(reference: String) = directory.resolve(reference.hashCode().toString()).toFile()
            override fun loadCursor() = storedCursor
            override fun saveCursor(cursor: Int) {
                storedCursor = cursor
            }
        }
        val cache = CoreCatalogCoverCache(
            client = CoreCoverByteSource { reference ->
                requested += reference
                if (reference == first) CoreHttpResult.Failure(503, null)
                else CoreHttpResult.Success(pngBytes())
            },
            store = store,
            maxPerSync = 1,
        )

        cache.materialize(listOf(CoreCatalogCoverReference(first), CoreCatalogCoverReference(second)))
        cache.materialize(listOf(CoreCatalogCoverReference(first), CoreCatalogCoverReference(second)))

        assertEquals(listOf(first, second), requested)
        assertTrue(store.target(second).isFile)
    }

    @Test
    fun `stops at the time budget and resumes the remaining covers on the next pass`() = runTest {
        val references = (21L..24L).map(::reference)
        var now = 0L
        var storedCursor = 0
        val requested = mutableListOf<String>()
        val store = object : CoreCatalogCoverStore {
            override fun target(reference: String) = directory.resolve(reference.hashCode().toString()).toFile()
            override fun loadCursor() = storedCursor
            override fun saveCursor(cursor: Int) {
                storedCursor = cursor
            }
        }
        val cache = CoreCatalogCoverCache(
            client = CoreCoverByteSource { reference ->
                requested += reference
                now += 1_000
                CoreHttpResult.Failure(404, null)
            },
            store = store,
            budgetMillis = 2_000,
            elapsedMillis = { now },
        )

        cache.materialize(references.map(::CoreCatalogCoverReference))
        assertEquals(references.take(2), requested)

        cache.materialize(references.map(::CoreCatalogCoverReference))
        assertEquals(references, requested)
    }

    @Test
    fun `background sink returns at once and runs only the latest waiting request`() = runTest {
        val release = CompletableDeferred<Unit>()
        val passes = mutableListOf<List<String>>()
        val sink = BackgroundCoreCatalogCoverSink(
            delegate = CoreCatalogCoverSink { references ->
                passes += references.map { it.reference }
                if (passes.size == 1) release.await()
            },
            scope = backgroundScope,
        )

        sink.materialize(listOf(CoreCatalogCoverReference("one")))
        runCurrent()
        sink.materialize(listOf(CoreCatalogCoverReference("two")))
        sink.materialize(listOf(CoreCatalogCoverReference("three")))
        assertEquals(listOf(listOf("one")), passes)

        release.complete(Unit)
        runCurrent()
        assertEquals(listOf(listOf("one"), listOf("three")), passes)
    }

    private fun reference(id: Long) =
        SuwayomiCoreThumbnailReference.forManga("desktop", "main", id)

    private fun pngBytes() = byteArrayOf(
        0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x01,
    )
}
