package epigraph.sync.core.suwayomi

import epigraph.sync.core.extensions.ExtensionParityItem
import epigraph.sync.core.extensions.ExtensionParityReport
import epigraph.sync.core.extensions.ExtensionParityStatus
import epigraph.sync.core.suwayomi.EpigraphCoreBridgeLabeler.Companion.resolveExtensionName
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class EpigraphCoreBridgeLabelerTest {
    private val report = ExtensionParityReport(
        serverId = "server",
        profileId = "profile",
        inventoryHash = "hash",
        generatedAtMs = 0L,
        items = listOf(
            item("eu.kanade.tachiyomi.extension.en.mangadex", "MangaDex", listOf(2499283573021220255L)),
            item("eu.kanade.tachiyomi.extension.all.comick", "Comick", listOf(42L)),
        ),
    )

    @Test
    fun `source id match wins over package name`() {
        assertEquals(
            "Comick",
            resolveExtensionName("eu.kanade.tachiyomi.extension.en.mangadex", "42", listOf(report)),
        )
    }

    @Test
    fun `package name is used when the source id is not in the inventory`() {
        assertEquals(
            "MangaDex",
            resolveExtensionName("eu.kanade.tachiyomi.extension.en.mangadex", "999", listOf(report)),
        )
    }

    @Test
    fun `falls back to the package suffix without an inventory`() {
        assertEquals("mangadex", resolveExtensionName("eu.kanade.tachiyomi.extension.en.mangadex", "1", emptyList()))
    }

    @Test
    fun `unknown or blank packages produce no label`() {
        assertNull(resolveExtensionName("unknown", "1", emptyList()))
        assertNull(resolveExtensionName("", "not-a-number", emptyList()))
    }

    private fun item(packageName: String, displayName: String, sourceIds: List<Long>) = ExtensionParityItem(
        packageName = packageName,
        displayName = displayName,
        desktopVersionName = "1.0",
        mobileVersionName = null,
        sourceNames = listOf(displayName),
        sourceIds = sourceIds,
        status = ExtensionParityStatus.MISSING_AVAILABLE,
    )
}
