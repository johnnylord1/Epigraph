package epigraph.recommendations

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.util.zip.GZIPOutputStream

class DiscoverPoolStoreTest {

    @TempDir
    lateinit var dir: File

    private fun entry(id: Long, title: String, inLibrary: Boolean) = RecommendationEntryInput(
        mangaId = id,
        url = "https://example.com/$id",
        title = title,
        sourceId = 1L,
        sourceName = "TestSource",
        isNovel = false,
        inLibrary = inLibrary,
    )

    private fun gathered(): DiscoverPool {
        val library = entry(1L, "Vagabond", inLibrary = true)
        val pool = DiscoverPool(
            mode = DiscoverMode.COMICS,
            candidates = emptyList(),
            profile = buildTasteProfile(listOf(entryToTasteProfileSeed(library))),
            seedCount = 1,
            knownTitleKeys = setOf("vagabond"),
            knownProviderKeys = emptySet(),
            failedProviders = listOf("Comix"),
            libraryCandidates = listOf(entryToRecommendationCandidate(library, 1_000L)),
            trackerRecordCandidates = listOf(entryToRecommendationCandidate(entry(2L, "Berserk", inLibrary = false), 1_000L)),
            comicEntries = listOf(entry(3L, "Blue Lock", inLibrary = false) to false, entry(4L, "Kaiju No 8", inLibrary = false) to true),
            gatheredAtMs = 1_000L,
            librarySignature = 42,
        )
        return pool.copy(candidates = assembleDiscoverCandidates(pool))
    }

    @Test
    fun `the saved file keeps only what came from the network`() {
        val store = DiscoverPoolStore(dir)
        val pool = gathered()
        store.write(pool)

        val saved = store.read(DiscoverMode.COMICS)!!
        assertTrue(saved.candidates.isEmpty())
        assertTrue(saved.libraryCandidates.isEmpty())
        assertTrue(saved.trackerRecordCandidates.isEmpty())
        assertEquals(pool.comicEntries, saved.comicEntries)
        assertEquals(pool.knownTitleKeys, saved.knownTitleKeys)
        assertEquals(pool.failedProviders, saved.failedProviders)
        assertEquals(pool.gatheredAtMs, saved.gatheredAtMs)
        assertEquals(pool.librarySignature, saved.librarySignature)
    }

    @Test
    fun `a gather with nothing from the network counts as failed`() {
        val pool = gathered()
        assertFalse(pool.foundNothingOnline)
        // Offline: the library and tracker records are still read, but no provider answered.
        assertTrue(pool.copy(comicEntries = emptyList()).foundNothingOnline)
    }

    @Test
    fun `the library read again assembles the same candidates`() {
        val store = DiscoverPoolStore(dir)
        val pool = gathered()
        store.write(pool)

        val saved = store.read(DiscoverMode.COMICS)!!
        val restored = saved.copy(libraryCandidates = pool.libraryCandidates, trackerRecordCandidates = pool.trackerRecordCandidates)
        assertEquals(pool.candidates, assembleDiscoverCandidates(restored))
    }

    @Test
    fun `a file from the first version still opens`() {
        val pool = gathered()
        val json = Json { allowSpecialFloatingPointValues = true; allowStructuredMapKeys = true }
        val text = buildJsonObject {
            put("version", 1)
            put("pool", json.encodeToJsonElement(DiscoverPool.serializer(), pool))
        }.toString()
        GZIPOutputStream(File(dir, "comics.json.gz").outputStream()).bufferedWriter().use { it.write(text) }

        val saved = DiscoverPoolStore(dir).read(DiscoverMode.COMICS)
        assertEquals(pool.comicEntries, saved?.comicEntries)
    }

    @Test
    fun `a file that does not read back is dropped`() {
        val file = File(dir, "novels.json.gz")
        file.writeText("not gzip")

        assertNull(DiscoverPoolStore(dir).read(DiscoverMode.NOVELS))
        assertFalse(file.exists())
    }
}
