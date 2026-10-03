package epigraph.recommendations

import java.io.IOException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class HardcoverRecommendationGathererTest {

    @Test
    fun `hardcoverPauseMs returns 10 minutes for HTTP 429 message`() {
        val error = RuntimeException("HTTP 429 Too Many Requests")
        assertEquals(
            HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS,
            hardcoverPauseMs(error),
        )
    }

    @Test
    fun `hardcoverPauseMs returns 5 minutes for non rate-limit error`() {
        val error = IOException("timeout")
        assertEquals(
            HARDCOVER_RECORD_REFRESH_COOLDOWN_MS,
            hardcoverPauseMs(error),
        )
    }
}
