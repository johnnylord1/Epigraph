package epigraph.sync.core.novels

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class CoreNovelDependencyIdsTest {
    @Test
    fun `matches the Core identity vectors`() {
        // Same vectors as the Core's repository_and_plugin_identity_vectors_are_cross_client_stable.
        val url = CoreNovelDependencyIds.canonicalRepositoryUrl(" HTTPS://Example.COM:443/repository.json ")
        assertEquals("https://example.com/repository.json", url)
        val repositoryId = CoreNovelDependencyIds.repositoryId(url!!)
        assertEquals(
            "novel-repository:1dae0c9bc42503917273ec8bfd1e4fc3de900db765867042f176cd26fdbff91f",
            repositoryId,
        )
        assertEquals(
            "novel-plugin:c7f378a0a77a9b38db6595eaf913f71a83541ac80f4c5876a8e7079c69ff0d69",
            CoreNovelDependencyIds.pluginId(repositoryId, "plugin.test", "source.test"),
        )
    }

    @Test
    fun `keeps the official LNReader index and drops a trailing slash`() {
        val official = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json"
        assertEquals(official, CoreNovelDependencyIds.canonicalRepositoryUrl(official))
        assertEquals(
            "https://example.com/plugins",
            CoreNovelDependencyIds.canonicalRepositoryUrl("https://example.com/plugins/"),
        )
        assertEquals(
            "https://example.com:8443/plugins",
            CoreNovelDependencyIds.canonicalRepositoryUrl("https://example.com:8443/plugins/"),
        )
    }

    @Test
    fun `refuses secret bearing, private and ambiguous URLs`() {
        listOf(
            "http://example.com/repository.json",
            "https://user@example.com/repository.json",
            "https://example.com/repository.json?token=signed",
            "https://example.com/repository.json?",
            "https://example.com/repository.json#fragment",
            "https://example.com/repository.json#",
            "https://localhost/plugins.min.json",
            "https://repo.local/plugins.min.json",
            "https://192.168.1.10/plugins.min.json",
            "https://[::1]/plugins.min.json",
            "https://example.com/a/../plugins.min.json",
            "https://example.com/./plugins.min.json",
            "not a url",
        ).forEach { url ->
            assertNull(CoreNovelDependencyIds.canonicalRepositoryUrl(url), url)
        }
    }

    @Test
    fun `labels repositories like the desktop`() {
        assertEquals(
            "LNReader plugins",
            CoreNovelDependencyIds.repositoryDisplayName(
                "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
            ),
        )
        assertEquals(
            "someone plugins",
            CoreNovelDependencyIds.repositoryDisplayName("https://example.com/someone/plugins.min.json"),
        )
    }
}
