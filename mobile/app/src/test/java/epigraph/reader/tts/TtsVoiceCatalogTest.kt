package epigraph.reader.tts

import android.app.Application
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, manifest = Config.NONE)
@ConscryptMode(ConscryptMode.Mode.OFF)
class TtsVoiceCatalogTest {

    private lateinit var previousLocale: Locale

    @Before
    fun setUp() {
        previousLocale = Locale.getDefault()
        Locale.setDefault(Locale.US)
    }

    @After
    fun tearDown() {
        Locale.setDefault(previousLocale)
    }

    @Test
    fun `lists installed offline voices of every language`() {
        val voices = listOf(
            voice("pt-br-x-afs-local", Locale.forLanguageTag("pt-BR")),
            voice("en-us-x-sfg-local", Locale.US),
            voice("ja-jp-x-htm-local", Locale.JAPAN),
        )

        val entries = TtsVoiceCatalog.usableVoices(voices)

        assertEquals(
            listOf("en-us-x-sfg-local", "ja-jp-x-htm-local", "pt-br-x-afs-local"),
            entries.map { it.name },
        )
        assertEquals("Portuguese (Brazil) · pt-br-x-afs-local", entries.last().label)
    }

    @Test
    fun `skips network and not installed voices`() {
        val voices = listOf(
            voice("en-us-x-sfg-network", Locale.US, network = true),
            voice("fr-fr-x-frd-local", Locale.FRANCE, features = setOf(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)),
            voice("de-de-x-deb-local", Locale.GERMANY),
        )

        assertEquals(listOf("de-de-x-deb-local"), TtsVoiceCatalog.usableVoices(voices).map { it.name })
    }

    private fun voice(
        name: String,
        locale: Locale,
        network: Boolean = false,
        features: Set<String> = emptySet(),
    ) = Voice(name, locale, Voice.QUALITY_NORMAL, Voice.LATENCY_NORMAL, network, features)
}
