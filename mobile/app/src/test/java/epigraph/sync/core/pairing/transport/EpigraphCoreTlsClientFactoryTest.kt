package epigraph.sync.core.pairing.transport

import okhttp3.OkHttpClient
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test

class EpigraphCoreTlsClientFactoryTest {
    @Test
    fun `the same pinned certificate reuses one client and its connections`() {
        val factory = EpigraphCoreTlsClientFactory(OkHttpClient())

        val first = factory.create(FINGERPRINT)

        assertSame(first, factory.create(FINGERPRINT))
        assertSame(first.sslSocketFactory, factory.create(FINGERPRINT).sslSocketFactory)
    }

    @Test
    fun `a new pinned certificate gets its own client`() {
        val factory = EpigraphCoreTlsClientFactory(OkHttpClient())

        val first = factory.create(FINGERPRINT)
        val repaired = factory.create(OTHER_FINGERPRINT)

        assertNotSame(first, repaired)
        assertNotSame(first.sslSocketFactory, repaired.sslSocketFactory)
        assertSame(repaired, factory.create(OTHER_FINGERPRINT))
    }

    private companion object {
        val FINGERPRINT = "ab".repeat(32)
        val OTHER_FINGERPRINT = "cd".repeat(32)
    }
}
