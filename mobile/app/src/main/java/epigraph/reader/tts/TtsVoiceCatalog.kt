package epigraph.reader.tts

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import java.util.Locale

/**
 * Lists the voices a text-to-speech engine can actually use, for the readers' voice pickers.
 *
 * A voice also selects the spoken language, so the list spans every installed language, not
 * only the device's. Voices that need a network connection or whose data is not downloaded
 * (engine feature `notInstalled`) are left out: selecting them fails silently or falls back to
 * the default voice. [openTtsSettings] lets the user download more voices.
 */
object TtsVoiceCatalog {

    data class Entry(val name: String, val label: String)

    /**
     * Starts an engine probe and calls [onReady] on the main thread with the usable voices
     * (empty when the engine fails to start). The caller must [TextToSpeech.shutdown] the
     * returned instance when it no longer needs the result, e.g. when its view detaches.
     */
    fun probe(context: Context, engine: String? = null, onReady: (List<Entry>) -> Unit): TextToSpeech {
        val main = Handler(Looper.getMainLooper())
        var tts: TextToSpeech? = null
        val listener = TextToSpeech.OnInitListener { status ->
            // The engine may call back before the constructor has returned.
            main.post {
                val voices = if (status == TextToSpeech.SUCCESS) {
                    runCatching { usableVoices(tts?.voices.orEmpty()) }.getOrDefault(emptyList())
                } else {
                    emptyList()
                }
                onReady(voices)
            }
        }
        return (
            if (engine.isNullOrBlank()) {
                TextToSpeech(context.applicationContext, listener)
            } else {
                TextToSpeech(context.applicationContext, listener, engine)
            }
            ).also { tts = it }
    }

    fun usableVoices(voices: Collection<Voice>): List<Entry> = voices
        .filter { !it.isNetworkConnectionRequired && NOT_INSTALLED !in it.features.orEmpty() }
        .map { Entry(it.name, label(it.locale, it.name)) }
        .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })

    fun label(locale: Locale, name: String): String {
        val language = locale.getDisplayName(Locale.getDefault())
            .replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.getDefault()) else it.toString() }
        return if (language.isBlank()) name else "$language · $name"
    }

    fun openTtsSettings(context: Context) {
        runCatching {
            context.startActivity(Intent(TTS_SETTINGS_ACTION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private const val NOT_INSTALLED = TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED
    private const val TTS_SETTINGS_ACTION = "com.android.settings.TTS_SETTINGS"
}
