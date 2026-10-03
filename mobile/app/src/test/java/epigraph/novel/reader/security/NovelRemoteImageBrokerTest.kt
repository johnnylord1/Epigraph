package epigraph.novel.reader.security

import java.net.InetAddress
import okhttp3.Dns
import okhttp3.OkHttpClient
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class NovelRemoteImageBrokerTest {
    private fun brokerResolvingTo(address: String) = NovelRemoteImageBroker(
        baseClient = OkHttpClient.Builder().dns(Dns { listOf(InetAddress.getByName(address)) }).build(),
    )

    @Test
    fun `hosts resolving to private addresses are never contacted`() {
        val url = NovelHtmlSanitizer.remoteImageUrl("https://images.example/cover.png")!!
        assertNull(brokerResolvingTo("127.0.0.1").load(url))
        assertNull(brokerResolvingTo("10.1.2.3").load(url))
    }

    @Test
    fun `only broker urls produced by the sanitizer are loaded`() {
        val broker = brokerResolvingTo("127.0.0.1")
        assertNull(broker.load("https://images.example/cover.png"))
        assertNull(broker.load(NovelHtmlSanitizer.REMOTE_IMAGE_SCHEME + "://not%20a%20url"))
    }
}
