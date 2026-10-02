package eu.kanade.tachiyomi.core.storage

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class AndroidStorageFolderProviderTest {

    @Test
    fun `release keeps the plain folder and every other install gets its own`() {
        assertEquals("Epigraph", AndroidStorageFolderProvider.folderName("Epigraph", "app.epigraph.mobile"))
        assertEquals("Epigraph-debug", AndroidStorageFolderProvider.folderName("Epigraph", "app.epigraph.mobile.debug"))
        assertEquals("Epigraph-local", AndroidStorageFolderProvider.folderName("Epigraph", "app.epigraph.mobile.local"))
        assertEquals("Epigraph-nightly", AndroidStorageFolderProvider.folderName("Epigraph", "app.epigraph.mobile.nightly"))
    }
}
