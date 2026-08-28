package epigraph.books.tts

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.content.ContextCompat
import eu.kanade.tachiyomi.data.notification.Notifications
import epigraph.books.ui.LocalBookReaderActivity
import hayai.novel.reader.tts.EpigraphTtsNotification
import java.util.Locale

/**
 * Foreground TTS owner for imported EPUB/PDF documents.
 *
 * The reader Activity only submits bounded text and settings. The service owns the platform TTS
 * instance, media session and notification, so leaving the reader (or the app task) does not
 * silently stop playback. Novel playback already uses the same notification builder through its
 * dedicated controller; this service adds the equivalent lifecycle for local books.
 */
class BookTtsPlaybackService : Service() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var textToSpeech: TextToSpeech? = null
    private var textToSpeechReady = false
    private var chunks: List<String> = emptyList()
    private var currentChunk = 0
    private var paused = true
    private var generation = 0
    private var title = "Book"
    private var bookId = ""
    private var speechRate = 1.0f
    private var speechPitch = 1.0f
    private var voiceName: String? = null
    private var mediaSession: MediaSessionCompat? = null

    override fun onCreate() {
        super.onCreate()
        mediaSession = MediaSessionCompat(applicationContext, "EpigraphBookTts").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = resumePlayback()
                override fun onPause() = pausePlayback()
                override fun onStop() = stopPlayback()
                override fun onSkipToNext() = skip(1)
                override fun onSkipToPrevious() = skip(-1)
            })
            isActive = true
        }
        ensureTextToSpeech()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val submitted = intent.getStringExtra(EXTRA_TEXT).orEmpty()
                if (submitted.isBlank()) {
                    stopPlayback()
                    return START_NOT_STICKY
                }
                title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "Book" }
                bookId = intent.getStringExtra(EXTRA_BOOK_ID).orEmpty()
                speechRate = intent.getFloatExtra(EXTRA_RATE, 1.0f).coerceIn(0.5f, 3.0f)
                speechPitch = intent.getFloatExtra(EXTRA_PITCH, 1.0f).coerceIn(0.5f, 2.0f)
                voiceName = intent.getStringExtra(EXTRA_VOICE)?.takeIf { it.isNotBlank() }
                chunks = splitForSpeech(submitted)
                currentChunk = 0
                paused = false
                generation++
                startForegroundWithNotification()
                speakCurrentChunk()
            }

            ACTION_TOGGLE_PAUSE -> if (paused) resumePlayback() else pausePlayback()
            ACTION_STOP_PLAYBACK -> stopPlayback()
            ACTION_NEXT -> skip(1)
            ACTION_PREVIOUS -> skip(-1)
            ACTION_UPDATE_SETTINGS -> {
                speechRate = intent.getFloatExtra(EXTRA_RATE, speechRate).coerceIn(0.5f, 3.0f)
                speechPitch = intent.getFloatExtra(EXTRA_PITCH, speechPitch).coerceIn(0.5f, 2.0f)
                voiceName = intent.getStringExtra(EXTRA_VOICE)?.takeIf { it.isNotBlank() }
                applySettings()
                if (!paused) speakCurrentChunk()
                else updateMediaSession()
            }
            null -> stopPlayback()
        }
        return START_NOT_STICKY
    }

    private fun ensureTextToSpeech() {
        if (textToSpeech != null) return
        textToSpeech = runCatching {
            TextToSpeech(applicationContext) { status ->
                mainHandler.post {
                    textToSpeechReady = status == TextToSpeech.SUCCESS
                    if (textToSpeechReady) {
                        textToSpeech?.setOnUtteranceProgressListener(progressListener)
                        applySettings()
                        if (!paused) speakCurrentChunk()
                    } else {
                        paused = true
                        updateMediaSession()
                    }
                }
            }
        }.getOrNull()
    }

    private val progressListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit

        override fun onDone(utteranceId: String?) {
            mainHandler.post {
                val parts = utteranceId?.split('-') ?: return@post
                if (parts.size != 3 || parts[0] != "epigraphbooktts") return@post
                val eventGeneration = parts[1].toIntOrNull() ?: return@post
                val eventChunk = parts[2].toIntOrNull() ?: return@post
                if (eventGeneration != generation || eventChunk != currentChunk || paused) return@post
                if (currentChunk >= chunks.lastIndex) {
                    stopPlayback()
                } else {
                    currentChunk++
                    speakCurrentChunk()
                }
            }
        }

        override fun onError(utteranceId: String?) {
            mainHandler.post {
                if (!paused) {
                    paused = true
                    updateMediaSession()
                }
            }
        }
    }

    private fun speakCurrentChunk() {
        val engine = textToSpeech ?: return
        if (!textToSpeechReady || paused) return
        val text = chunks.getOrNull(currentChunk) ?: return
        applySettings()
        engine.speak(
            text,
            TextToSpeech.QUEUE_FLUSH,
            null,
            "epigraphbooktts-$generation-$currentChunk",
        )
        updateMediaSession()
        startForegroundWithNotification()
    }

    private fun applySettings() {
        val engine = textToSpeech ?: return
        if (!textToSpeechReady) return
        engine.language = Locale.getDefault()
        engine.setSpeechRate(speechRate)
        engine.setPitch(speechPitch)
        voiceName?.let { name ->
            engine.voices?.firstOrNull { it.name == name }?.let { engine.voice = it }
        }
    }

    private fun pausePlayback() {
        if (chunks.isEmpty()) return
        textToSpeech?.stop()
        paused = true
        updateMediaSession()
        startForegroundWithNotification()
    }

    private fun resumePlayback() {
        if (chunks.isEmpty()) return
        paused = false
        ensureTextToSpeech()
        speakCurrentChunk()
    }

    private fun skip(delta: Int) {
        if (chunks.isEmpty()) return
        currentChunk = (currentChunk + delta).coerceIn(0, chunks.lastIndex)
        paused = false
        generation++
        textToSpeech?.stop()
        speakCurrentChunk()
    }

    private fun stopPlayback() {
        generation++
        paused = true
        chunks = emptyList()
        currentChunk = 0
        textToSpeech?.stop()
        updateMediaSession()
        stopForegroundCompat()
        stopSelf()
    }

    private fun startForegroundWithNotification() {
        val notification = EpigraphTtsNotification.build(
            context = this,
            sessionToken = mediaSession?.sessionToken,
            isPaused = paused,
            progressPercent = if (chunks.isEmpty()) 0 else ((currentChunk + 1) * 100 / chunks.size),
            title = title,
            subtitle = "Local book",
            openReaderIntent = LocalBookReaderActivity.intent(this, bookId),
            serviceClass = BookTtsPlaybackService::class.java,
            toggleAction = ACTION_TOGGLE_PAUSE,
            stopAction = ACTION_STOP_PLAYBACK,
            notificationId = Notifications.ID_BOOK_TTS_PLAYBACK,
        )
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            startForeground(
                Notifications.ID_BOOK_TTS_PLAYBACK,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            startForeground(Notifications.ID_BOOK_TTS_PLAYBACK, notification)
        }
    }

    private fun updateMediaSession() {
        val session = mediaSession ?: return
        val state = when {
            chunks.isEmpty() -> PlaybackStateCompat.STATE_STOPPED
            paused -> PlaybackStateCompat.STATE_PAUSED
            else -> PlaybackStateCompat.STATE_PLAYING
        }
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_STOP or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS,
                )
                .setState(state, currentChunk.toLong(), 1.0f, android.os.SystemClock.elapsedRealtime())
                .build(),
        )
        session.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, "Epigraph Books")
                .putLong(MediaMetadataCompat.METADATA_KEY_NUM_TRACKS, chunks.size.toLong())
                .putLong(MediaMetadataCompat.METADATA_KEY_TRACK_NUMBER, (currentChunk + 1).toLong())
                .build(),
        )
    }

    private fun stopForegroundCompat() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // A foreground audio service is deliberately kept alive when the reader task is swiped
        // away. Explicit Stop or natural completion still tears it down.
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
        mediaSession?.isActive = false
        mediaSession?.release()
        mediaSession = null
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "epigraph.books.tts.START"
        const val ACTION_TOGGLE_PAUSE = "epigraph.books.tts.TOGGLE_PAUSE"
        const val ACTION_STOP_PLAYBACK = "epigraph.books.tts.STOP"
        private const val ACTION_NEXT = "epigraph.books.tts.NEXT"
        private const val ACTION_PREVIOUS = "epigraph.books.tts.PREVIOUS"
        private const val ACTION_UPDATE_SETTINGS = "epigraph.books.tts.UPDATE_SETTINGS"
        private const val EXTRA_TEXT = "epigraph.books.tts.TEXT"
        private const val EXTRA_TITLE = "epigraph.books.tts.TITLE"
        private const val EXTRA_BOOK_ID = "epigraph.books.tts.BOOK_ID"
        private const val EXTRA_RATE = "epigraph.books.tts.RATE"
        private const val EXTRA_PITCH = "epigraph.books.tts.PITCH"
        private const val EXTRA_VOICE = "epigraph.books.tts.VOICE"
        private const val MAX_SUBMITTED_TEXT = 500_000

        fun start(
            context: Context,
            title: String,
            bookId: String,
            text: String,
            rate: Float,
            pitch: Float,
            voice: String?,
        ) {
            val bounded = text.replace(Regex("\\s+"), " ").trim().take(MAX_SUBMITTED_TEXT)
            if (bounded.isBlank()) return
            val intent = Intent(context, BookTtsPlaybackService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_TITLE, title.take(256))
                .putExtra(EXTRA_BOOK_ID, bookId.take(256))
                .putExtra(EXTRA_TEXT, bounded)
                .putExtra(EXTRA_RATE, rate)
                .putExtra(EXTRA_PITCH, pitch)
            voice?.let { intent.putExtra(EXTRA_VOICE, it.take(256)) }
            ContextCompat.startForegroundService(context, intent)
        }

        fun updateSettings(context: Context, rate: Float, pitch: Float, voice: String?) {
            val intent = Intent(context, BookTtsPlaybackService::class.java)
                .setAction(ACTION_UPDATE_SETTINGS)
                .putExtra(EXTRA_RATE, rate)
                .putExtra(EXTRA_PITCH, pitch)
            voice?.let { intent.putExtra(EXTRA_VOICE, it.take(256)) }
            runCatching { context.startService(intent) }
        }

        fun stop(context: Context) {
            runCatching {
                context.startService(Intent(context, BookTtsPlaybackService::class.java).setAction(ACTION_STOP_PLAYBACK))
            }
        }

        private fun splitForSpeech(value: String): List<String> {
            val maxLength = TextToSpeech.getMaxSpeechInputLength().coerceAtLeast(1_000)
            return value
                .split(Regex("\\n\\s*\\n|(?<=[.!?])\\s+(?=[\\p{L}\\d])"))
                .flatMap { part ->
                    part.trim().chunked(maxLength).filter { it.isNotBlank() }
                }
                .ifEmpty { listOf(value.take(maxLength)) }
        }
    }
}
