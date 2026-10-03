package epigraph.sync.core.trackers

import android.content.Context
import epigraph.contract.SyncEntityType
import epigraph.sync.TrackingSyncGate
import epigraph.sync.core.pairing.CorePairingEndedListener
import epigraph.sync.core.protocol.CoreCapabilities
import java.io.File
import java.io.IOException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Receives the capabilities of a Core that passed the compatibility check in a sync run. */
fun interface CoreCapabilityObserver {
    suspend fun onNegotiated(capabilities: CoreCapabilities)
}

/**
 * The last capabilities negotiated with the paired Core, reduced to what local writers need to
 * decide whether a tracker change may be queued. Local writes happen offline, so they cannot ask
 * the Core; the outbox adapter re-checks the live capabilities before anything is sent.
 *
 * The file holds no secrets and lives in `noBackupFilesDir`, so a restored backup can never make
 * a new device believe an old Core advertised tracker sync.
 */
class CoreTrackingCapabilityCache(
    private val file: File,
) : TrackingSyncGate, CoreCapabilityObserver, CorePairingEndedListener {
    private val lock = Mutex()
    private var loaded = false
    private var current: NegotiatedTrackerCapabilities? = null

    override suspend fun advertises(entityType: SyncEntityType): Boolean =
        entityType.value in snapshot()?.entityTypes.orEmpty()

    suspend fun supportsTrackerCredentials(): Boolean = snapshot()?.trackerCredentialsV1 == true

    override suspend fun onNegotiated(capabilities: CoreCapabilities) {
        val next = NegotiatedTrackerCapabilities(
            entityTypes = capabilities.snapshotEntityTypes.filterTo(sortedSetOf()) { it in TRACKING_TYPES },
            trackerCredentialsV1 = capabilities.supportsTrackerCredentialsV1,
        )
        lock.withLock {
            ensureLoaded()
            if (current == next) return
            current = next
            write(next)
        }
    }

    override suspend fun onPairingEnded() = lock.withLock {
        current = null
        loaded = true
        if (file.exists() && !file.delete()) throw IOException("tracker capability cache was not removed")
    }

    private suspend fun snapshot(): NegotiatedTrackerCapabilities? = lock.withLock {
        ensureLoaded()
        current
    }

    private fun ensureLoaded() {
        if (loaded) return
        current = runCatching {
            if (file.isFile && file.length() <= MAX_FILE_BYTES) {
                json.decodeFromString(NegotiatedTrackerCapabilities.serializer(), file.readText())
            } else {
                null
            }
        }.getOrNull()
        loaded = true
    }

    private fun write(value: NegotiatedTrackerCapabilities) {
        val directory = file.parentFile ?: throw IOException("tracker capability cache has no directory")
        if (!directory.exists() && !directory.mkdirs()) throw IOException("tracker capability cache directory")
        val part = File(directory, "${file.name}.part")
        part.writeText(json.encodeToString(NegotiatedTrackerCapabilities.serializer(), value))
        if (!part.renameTo(file)) {
            file.delete()
            if (!part.renameTo(file)) {
                part.delete()
                throw IOException("tracker capability cache was not published")
            }
        }
    }

    @Serializable
    private data class NegotiatedTrackerCapabilities(
        val entityTypes: Set<String> = emptySet(),
        val trackerCredentialsV1: Boolean = false,
    )

    companion object {
        private val TRACKING_TYPES = setOf("comic.tracking", "novel.tracking")
        private const val MAX_FILE_BYTES = 16 * 1024L
        private val json = Json { ignoreUnknownKeys = true }

        fun create(context: Context) = CoreTrackingCapabilityCache(
            File(File(context.noBackupFilesDir, "aethon-sync"), "tracker-capabilities-v1.json"),
        )
    }
}
