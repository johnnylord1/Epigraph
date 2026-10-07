package epigraph.sync.core.extensions

import epigraph.sync.core.protocol.CoreExtensionDescriptor
import epigraph.sync.core.protocol.CoreExtensionInventory
import epigraph.sync.core.protocol.CoreExtensionSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class ExtensionParityResolverTest {
    @Test
    fun `deduplicates multi-source package and reports exact installed match`() {
        val inventory = inventory(
            extension("eu.kanade.tachiyomi.extension.en.example", "1", source(10, "One")),
            extension("eu.kanade.tachiyomi.extension.en.example", "1", source(11, "Two")),
        )

        val report = ExtensionParityResolver.resolve(
            inventory = inventory,
            installed = listOf(
                MobileInstalledExtension(
                    "eu.kanade.tachiyomi.extension.en.example",
                    1,
                    "1.0",
                    setOf(10, 11),
                ),
            ),
            available = emptyList(),
            untrustedPackages = emptySet(),
        )

        assertEquals(1, report.items.size)
        assertEquals(listOf(10L, 11L), report.items.single().sourceIds)
        assertEquals(ExtensionParityStatus.INSTALLED, report.items.single().status)
    }

    @Test
    fun `package comparison is exact and missing package uses official availability`() {
        val desktopPackage = "eu.kanade.tachiyomi.extension.en.Example"
        val inventory = inventory(extension(desktopPackage, "1", source(10, "One")))

        val report = ExtensionParityResolver.resolve(
            inventory = inventory,
            installed = listOf(MobileInstalledExtension(desktopPackage.lowercase(), 1, "1.0", setOf(11))),
            available = listOf(MobileAvailableExtension(desktopPackage, 2, "2.0", setOf(10))),
            untrustedPackages = emptySet(),
        )

        assertEquals(ExtensionParityStatus.MISSING_AVAILABLE, report.items.single().status)
    }

    @Test
    fun `a fork serving every desktop source id counts as installed`() {
        val report = ExtensionParityResolver.resolve(
            inventory = inventory(
                extension("original.package", "1", source(10, "Served")),
                extension("partial.package", "1", source(10, "Served"), source(12, "Missing")),
            ),
            installed = listOf(MobileInstalledExtension("revived.package", 1, "1.0", setOf(10))),
            available = listOf(
                MobileAvailableExtension("original.package", 1, "1.0", setOf(10)),
                MobileAvailableExtension("partial.package", 1, "1.0", setOf(10, 12)),
            ),
            untrustedPackages = emptySet(),
        )

        val statuses = report.items.associate { it.packageName to it.status }
        assertEquals(ExtensionParityStatus.INSTALLED, statuses["original.package"])
        assertEquals(ExtensionParityStatus.MISSING_AVAILABLE, statuses["partial.package"])
    }

    @Test
    fun `distinguishes update source mismatch unavailable and untrusted states`() {
        val report = ExtensionParityResolver.resolve(
            inventory = inventory(
                extension("installed.update", "1", source(1, "Update")),
                extension("installed.mismatch", "1", source(2, "Mismatch")),
                extension("installed.stale", "1", source(5, "Stale")),
                extension("missing.none", "1", source(3, "Missing")),
                extension("missing.untrusted", "1", source(4, "Blocked")),
            ),
            installed = listOf(
                MobileInstalledExtension("installed.update", 1, "1.0", setOf(1)),
                MobileInstalledExtension("installed.mismatch", 1, "1.0", setOf(99)),
                MobileInstalledExtension("installed.stale", 1, "1.0", setOf(98)),
            ),
            available = listOf(
                MobileAvailableExtension("installed.update", 2, "2.0", setOf(1)),
                MobileAvailableExtension("installed.stale", 2, "2.0", setOf(5)),
            ),
            untrustedPackages = setOf("missing.untrusted"),
        )

        val statuses = report.items.associate { it.packageName to it.status }
        assertEquals(ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE, statuses["installed.update"])
        assertEquals(ExtensionParityStatus.SOURCE_ID_MISMATCH, statuses["installed.mismatch"])
        assertEquals(ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE, statuses["installed.stale"])
        assertEquals(ExtensionParityStatus.MISSING_UNAVAILABLE, statuses["missing.none"])
        assertEquals(ExtensionParityStatus.UNTRUSTED_OR_BLOCKED, statuses["missing.untrusted"])
    }

    @Test
    fun `inventory hash is stable but scoped by server and profile`() {
        val first = ExtensionParityResolver.resolve(
            inventory("server-a", "main", extension("pkg", "1", source(1, "One"))),
            emptyList(),
            emptyList(),
            emptySet(),
        )
        val reordered = ExtensionParityResolver.resolve(
            inventory("server-a", "main", extension("pkg", "1", source(1, "One"))),
            emptyList(),
            emptyList(),
            emptySet(),
        )
        val otherServer = ExtensionParityResolver.resolve(
            inventory("server-b", "main", extension("pkg", "1", source(1, "One"))),
            emptyList(),
            emptyList(),
            emptySet(),
        )

        assertEquals(first.inventoryHash, reordered.inventoryHash)
        assertNotEquals(first.inventoryHash, otherServer.inventoryHash)
    }

    @Test
    fun `requires explicit approval for an unknown desktop repository`() {
        val extension = extension("missing.store", "1", source(1, "One")).copy(
            storeIndexUrl = "https://store.example/index.min.json",
        )

        val pending = ExtensionParityResolver.resolve(
            inventory(extension),
            emptyList(),
            emptyList(),
            emptySet(),
        )
        val approved = ExtensionParityResolver.resolve(
            inventory(extension),
            emptyList(),
            emptyList(),
            emptySet(),
            configuredRepositoryBaseUrls = setOf("https://store.example"),
        )

        assertEquals(
            ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED,
            pending.items.single().status,
        )
        assertEquals(ExtensionParityStatus.MISSING_UNAVAILABLE, approved.items.single().status)
        assertNotEquals(pending.inventoryHash, inventory(extension.copy(storeIndexUrl = null)).let {
            ExtensionParityResolver.resolve(it, emptyList(), emptyList(), emptySet()).inventoryHash
        })
    }

    @Test
    fun `legacy desktop repository is only a resolution hint`() {
        val extension = extension("missing.legacy", "1", source(1, "One")).copy(
            legacyRepositoryIndexUrl = "https://repo.example/extensions/",
        )

        val pending = ExtensionParityResolver.resolve(
            inventory(extension),
            emptyList(),
            emptyList(),
            emptySet(),
        )
        val approved = ExtensionParityResolver.resolve(
            inventory(extension),
            emptyList(),
            emptyList(),
            emptySet(),
            configuredRepositoryBaseUrls = setOf("https://repo.example/extensions"),
        )

        assertEquals(ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED, pending.items.single().status)
        assertEquals("https://repo.example/extensions/", pending.items.single().repositoryHintUrl)
        assertEquals(null, pending.items.single().storeIndexUrl)
        assertEquals(ExtensionParityStatus.MISSING_UNAVAILABLE, approved.items.single().status)
    }

    @Test
    fun `normalizes legacy repository base only at the installer boundary`() {
        val legacy = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/"

        assertEquals(
            "https://raw.githubusercontent.com/keiyoushi/extensions/repo",
            ExtensionParityResolver.repositoryBaseUrl(legacy),
        )
        assertEquals(
            "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
            ExtensionParityResolver.repositoryIndexUrl(legacy),
        )
        assertEquals(
            "https://store.example/index.json",
            ExtensionParityResolver.repositoryIndexUrl("https://store.example/index.json"),
        )
        assertEquals(
            "https://raw.githubusercontent.com/keiyoushi/extensions/repo",
            ExtensionParityResolver.repositoryBaseUrl(
                "https://github.com/keiyoushi/extensions/raw/repo/index.pb",
            ),
        )
        assertEquals(
            "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
            ExtensionParityResolver.repositoryIndexUrl(
                "https://github.com/keiyoushi/extensions/raw/repo/index.pb",
            ),
        )
        assertEquals(
            "https://raw.githubusercontent.com/Owner/Mihon-repo/repo/index.min.json",
            ExtensionParityResolver.repositoryIndexUrl(
                "https://raw.githubusercontent.com/Owner/Mihon-repo/repo/repo.json",
            ),
        )
    }

    private fun inventory(vararg extensions: CoreExtensionDescriptor) =
        inventory("server-a", "main", *extensions)

    private fun inventory(
        serverId: String,
        profileId: String,
        vararg extensions: CoreExtensionDescriptor,
    ) = CoreExtensionInventory(
        schemaVersion = 1,
        serverId = serverId,
        profileId = profileId,
        runtimeFingerprint = "runtime",
        generatedAtMs = 1,
        extensions = extensions.toList(),
    )

    private fun extension(
        packageName: String,
        versionCode: String,
        vararg sources: CoreExtensionSource,
    ) = CoreExtensionDescriptor(
        packageName = packageName,
        displayName = packageName.substringAfterLast('.'),
        versionCode = versionCode,
        versionName = "$versionCode.0",
        sources = sources.toList(),
    )

    private fun source(id: Long, name: String) = CoreExtensionSource(id.toString(), name, "en")
}
