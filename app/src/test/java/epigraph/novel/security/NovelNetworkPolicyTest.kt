package epigraph.novel.security

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class NovelNetworkPolicyTest {
    private val policy = NovelNetworkPolicy()

    @Test
    fun `only public https is accepted by default`() {
        assertDoesNotThrow { policy.validate("https://example.com/chapter") }
        assertThrows(NovelNetworkPolicyException::class.java) {
            policy.validate("http://example.com/chapter")
        }
        assertThrows(NovelNetworkPolicyException::class.java) {
            policy.validate("https://127.0.0.1/chapter")
        }
    }

    @Test
    fun `redirect validation applies the same policy`() {
        assertDoesNotThrow { policy.validate("https://example.com".toHttpUrl()) }
        assertThrows(NovelNetworkPolicyException::class.java) {
            policy.validate("https://[::1]".toHttpUrl())
        }
    }

    @Test
    fun `explicit host authorization is still limited to https`() {
        val authorized = NovelNetworkPolicy(allowedHosts = setOf("1.1.1.1"))
        assertDoesNotThrow { authorized.validate("https://1.1.1.1/chapter") }
        assertThrows(NovelNetworkPolicyException::class.java) {
            authorized.validate("https://1.0.0.1/chapter")
        }
        assertThrows(NovelNetworkPolicyException::class.java) {
            authorized.validate("http://1.1.1.1/chapter")
        }
    }
}
