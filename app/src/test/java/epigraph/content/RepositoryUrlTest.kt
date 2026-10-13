package epigraph.content

import epigraph.sync.core.novels.matchesDeclaredRepository
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RepositoryUrlTest {
    private val lnReader = "https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0"

    @Test
    fun `a GitHub owner and repository ignore case, the branch and path do not`() {
        assertEquals(
            RepositoryUrl.comparable("$lnReader/.dist"),
            RepositoryUrl.comparable("HTTPS://Raw.GitHubUserContent.com/LNReader/LNReader-Plugins/plugins/v3.0.0/.dist/"),
        )
        assertNotEquals(
            RepositoryUrl.comparable(lnReader),
            RepositoryUrl.comparable(lnReader.replace("/plugins/v3", "/Plugins/v3")),
        )
    }

    @Test
    fun `other hosts keep the case of their paths`() {
        assertEquals("https://example.test/Repo", RepositoryUrl.comparable(" https://Example.TEST/Repo/ "))
    }

    @Test
    fun `an LNReader repository written with another case is the one already added`() {
        val configured = "$lnReader/.dist/plugins.min.json"

        val otherCase = configured.replace("lnreader/lnreader-", "LNReader/lnreader-")
        val fork = configured.replace("lnreader/lnreader-", "johnnylord1/lnreader-")

        assertTrue(configured.matchesDeclaredRepository(otherCase))
        assertFalse(configured.matchesDeclaredRepository(fork))
    }
}
