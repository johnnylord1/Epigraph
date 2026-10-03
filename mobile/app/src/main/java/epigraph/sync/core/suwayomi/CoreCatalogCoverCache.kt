package epigraph.sync.core.suwayomi

import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

data class CoreCatalogCoverReference(val reference: String)

fun interface CoreCatalogCoverSink {
    suspend fun materialize(references: List<CoreCatalogCoverReference>)
}

object DeferredCoreCatalogCoverSink : CoreCatalogCoverSink {
    override suspend fun materialize(references: List<CoreCatalogCoverReference>) = Unit
}

fun interface CoreCatalogCoverStore {
    fun target(reference: String): File?

    fun loadCursor(): Int = 0

    fun saveCursor(cursor: Int) = Unit
}

/** Materializes confirmed Core covers without making cover availability authoritative. */
class CoreCatalogCoverCache(
    private val client: CoreCoverByteSource,
    private val store: CoreCatalogCoverStore,
    private val maxPerSync: Int = DEFAULT_MAX_PER_SYNC,
) : CoreCatalogCoverSink {
    init {
        require(maxPerSync > 0)
    }

    override suspend fun materialize(references: List<CoreCatalogCoverReference>) {
        val missing = references.asSequence()
            .map(CoreCatalogCoverReference::reference)
            .filter { SuwayomiCoreThumbnailReference.parse(it) != null }
            .distinct()
            .filter { reference ->
                store.target(reference)?.let { !it.isFile || it.length() == 0L } == true
            }
            .toList()
        if (missing.isEmpty()) {
            store.saveCursor(0)
            return
        }

        val start = Math.floorMod(store.loadCursor(), missing.size)
        val attemptLimit = minOf(missing.size, maxPerSync * MAX_ATTEMPT_MULTIPLIER)
        var attempted = 0
        var published = 0
        while (attempted < attemptLimit && published < maxPerSync) {
            val reference = missing[(start + attempted) % missing.size]
            attempted += 1
            val result = try {
                withTimeoutOrNull(FETCH_TIMEOUT_MS) { client.fetch(reference) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                null
            }
            if (result == null) {
                store.saveCursor((start + attempted) % missing.size)
                return
            }
            when (result) {
                is CoreHttpResult.Success -> if (publish(reference, result.value)) published += 1
                is CoreHttpResult.Failure -> {
                    if (result.statusCode == 401 || result.statusCode == 403 || result.statusCode >= 500) {
                        store.saveCursor((start + attempted) % missing.size)
                        return
                    }
                }
            }
        }
        store.saveCursor((start + attempted) % missing.size)
    }

    private fun publish(reference: String, bytes: ByteArray): Boolean {
        if (bytes.isEmpty() || bytes.size > MAX_COVER_BYTES || !bytes.hasSupportedImageSignature()) return false
        val target = store.target(reference) ?: return false
        target.parentFile?.mkdirs()
        val temporary = File(target.parentFile, "${target.name}.${System.nanoTime()}.part")
        try {
            FileOutputStream(temporary).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            if (target.isFile && !target.delete()) return false
            if (!temporary.renameTo(target)) return false
            return true
        } finally {
            temporary.delete()
        }
    }

    private fun ByteArray.hasSupportedImageSignature(): Boolean {
        val jpeg = size >= 3 && this[0] == 0xff.toByte() && this[1] == 0xd8.toByte() && this[2] == 0xff.toByte()
        val png = size >= 8 && copyOfRange(0, 8).contentEquals(PNG_SIGNATURE)
        val webp = size >= 12 &&
            copyOfRange(0, 4).contentEquals(RIFF_SIGNATURE) &&
            copyOfRange(8, 12).contentEquals(WEBP_SIGNATURE)
        val gif = size >= 6 && (
            copyOfRange(0, 6).contentEquals(GIF87A_SIGNATURE) ||
                copyOfRange(0, 6).contentEquals(GIF89A_SIGNATURE)
            )
        return jpeg || png || webp || gif
    }

    private companion object {
        const val DEFAULT_MAX_PER_SYNC = 32
        const val MAX_ATTEMPT_MULTIPLIER = 2
        const val FETCH_TIMEOUT_MS = 5_000L
        const val MAX_COVER_BYTES = 16 * 1024 * 1024
        val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        val RIFF_SIGNATURE = byteArrayOf(0x52, 0x49, 0x46, 0x46)
        val WEBP_SIGNATURE = byteArrayOf(0x57, 0x45, 0x42, 0x50)
        val GIF87A_SIGNATURE = "GIF87a".encodeToByteArray()
        val GIF89A_SIGNATURE = "GIF89a".encodeToByteArray()
    }
}
