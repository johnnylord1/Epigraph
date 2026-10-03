package epigraph.novel.security

import java.net.InetAddress
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
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

    @Test
    fun `connection dns refuses private answers so rebinding cannot bypass validation`() {
        fun dnsAnswering(vararg literals: String) = policy.publicOnlyDns(
            Dns { literals.map(InetAddress::getByName) },
        )

        assertEquals(
            listOf(InetAddress.getByName("93.184.215.14")),
            dnsAnswering("93.184.215.14").lookup("example.com"),
        )
        listOf("10.0.0.7", "192.168.1.2", "127.0.0.1", "169.254.169.254", "0.1.2.3", "fd00::1", "::1").forEach {
            assertThrows(NovelNetworkPolicyException::class.java) {
                dnsAnswering("93.184.215.14", it).lookup("rebind.example")
            }
        }
        assertThrows(NovelNetworkPolicyException::class.java) {
            dnsAnswering("93.184.215.14").lookup("app.localhost")
        }
    }
}
