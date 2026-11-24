package epigraph.sync.v4

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class V4SyncDomainPolicyTest {
    @Test
    fun `disabled content and preference domains are rejected`() {
        val policy = V4SyncDomainPolicy(syncComics = false, syncNovels = false, syncBooks = false)

        assertFalse(policy.allows("comics", "comic.work", "source:/work", null))
        assertFalse(policy.allows("novels", "novel.work", "plugin:/work", null))
        assertFalse(policy.allows("books", "book.work", "a".repeat(64), null))
        assertFalse(policy.allows("preferences", "extension.pref", "comic:source:key", null))
        assertFalse(policy.allows("preferences", "extension.pref", "novel:plugin:key", null))
    }

    @Test
    fun `extension repository and installed inventory use their individual policy switches`() {
        val policy = V4SyncDomainPolicy(
            syncComics = true,
            syncNovels = true,
            reconcileComicRepositories = true,
            reconcileComicExtensions = false,
            reconcileNovelRepositories = false,
            reconcileNovelPlugins = true,
        )
        fun item(type: String, kind: String) = policy.allows(
            "extensions", type, "$kind:package", buildJsonObject { put("kind", kind) },
        )

        assertTrue(item("extension.repo", "comic"))
        assertFalse(item("extension.installed", "comic"))
        assertFalse(item("extension.repo", "novel"))
        assertTrue(item("extension.installed", "novel"))
        assertTrue(policy.allows("preferences", "extension.pref", "comic:source:key", null))
        assertTrue(policy.allows("preferences", "extension.pref", "novel:plugin:key", null))
    }
}
