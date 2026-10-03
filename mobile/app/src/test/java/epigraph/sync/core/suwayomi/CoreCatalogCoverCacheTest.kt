package epigraph.sync.core.suwayomi

import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import java.nio.file.Path
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

    private fun reference(id: Long) =
        SuwayomiCoreThumbnailReference.forManga("desktop", "main", id)

    private fun pngBytes() = byteArrayOf(
        0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x01,
    )
}
