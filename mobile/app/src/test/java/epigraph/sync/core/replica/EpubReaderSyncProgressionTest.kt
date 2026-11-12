package epigraph.sync.core.replica

import android.app.Application
import epigraph.books.model.BookAssetId
import epigraph.books.model.LocalBookDocument
import epigraph.books.reader.ReadiumEpubReaderSession
import epigraph.contract.ContentType
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.readium.r2.shared.publication.Locator
import org.readium.r2.shared.publication.Manifest
import org.readium.r2.shared.publication.Publication
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode

@RunWith(RobolectricTestRunner::class)
@ConscryptMode(ConscryptMode.Mode.OFF)
@Config(sdk = [35], application = Application::class, manifest = Config.NONE)
class EpubReaderSyncProgressionTest {
    @Test
    fun singleResourceBookKeepsItsChapterProgressForSync() {
        val session = session(chapters = 1)
        try {
            val readium = locator(chapterProgression = 0.77, totalProgression = 0.0)
            val saved = session.toReaderLocator(readium)

            assertEquals(0.77, saved.progression, 0.000001)
            assertEquals(readium.toJSON().toString(), saved.cfi)
            assertEquals(
                1.0,
                session.toReaderLocator(locator(chapterProgression = 1.0, totalProgression = 0.0)).progression,
                0.000001,
            )
        } finally {
            session.close()
        }
    }

    @Test
    fun multipleResourceBookKeepsReadiumsPublicationProgress() {
        val session = session(chapters = 2)
        try {
            val saved = session.toReaderLocator(locator(chapterProgression = 0.77, totalProgression = 0.35))

            assertEquals(0.35, saved.progression, 0.000001)
        } finally {
            session.close()
        }
    }

    @Test
    fun singleResourceBookKeepsPublicationProgressWhenChapterProgressIsMissing() {
        val session = session(chapters = 1)
        try {
            val saved = session.toReaderLocator(locator(chapterProgression = null, totalProgression = 0.35))

            assertEquals(0.35, saved.progression, 0.000001)
        } finally {
            session.close()
        }
    }

    private fun session(chapters: Int): ReadiumEpubReaderSession {
        val readingOrder = (1..chapters).joinToString(",") { chapter ->
            """{"href":"EPUB/$chapter.xhtml","type":"application/xhtml+xml"}"""
        }
        val manifest = requireNotNull(
            Manifest.fromJSON(
                JSONObject("""{"metadata":{"title":"Sync test"},"readingOrder":[$readingOrder]}"""),
            ),
        )
        return ReadiumEpubReaderSession(
            LocalBookDocument(
                contentType = ContentType.EPUB,
                assetId = BookAssetId.fromSha256("a".repeat(64)),
                file = File("unused-sync-test.epub"),
                displayName = "Sync test",
            ),
            Publication(manifest),
            initialLocator = null,
        )
    }

    private fun locator(chapterProgression: Double?, totalProgression: Double): Locator {
        val locations = JSONObject().put("totalProgression", totalProgression)
        chapterProgression?.let { locations.put("progression", it) }
        return requireNotNull(
            Locator.fromJSON(
                JSONObject()
                    .put("href", "EPUB/1.xhtml")
                    .put("type", "application/xhtml+xml")
                    .put("locations", locations),
            ),
        )
    }
}
