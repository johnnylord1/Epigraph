package epigraph.recommendations

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/**
 * The last pool each Discover mode gathered, kept in the app cache so the screen opens with it
 * at once and refreshes behind it. A file that does not read back is simply ignored.
 */
class DiscoverPoolStore(private val dir: File) {

    @Serializable
    private class Saved(val version: Int, val pool: DiscoverPool)

    fun read(mode: DiscoverMode): DiscoverPool? {
        val file = file(mode)
        if (!file.isFile) return null
        return runCatching {
            val text = GZIPInputStream(file.inputStream()).bufferedReader().use { it.readText() }
            json.decodeFromString(Saved.serializer(), text)
                .takeIf { it.version == VERSION && it.pool.mode == mode }
                ?.pool
        }.getOrNull() ?: run {
            file.delete()
            null
        }
    }

    fun write(pool: DiscoverPool) {
        runCatching {
            dir.mkdirs()
            val target = file(pool.mode)
            val temp = File(dir, target.name + ".tmp")
            GZIPOutputStream(temp.outputStream()).bufferedWriter().use {
                it.write(json.encodeToString(Saved.serializer(), Saved(VERSION, pool)))
            }
            if (!temp.renameTo(target)) {
                target.delete()
                temp.renameTo(target)
            }
        }
    }

    private fun file(mode: DiscoverMode) = File(dir, "${mode.name.lowercase()}.json.gz")

    private companion object {
        /** Bump when [DiscoverPool] changes in a way old files would read wrong. */
        const val VERSION = 1

        val json = Json {
            ignoreUnknownKeys = true
            allowSpecialFloatingPointValues = true
            allowStructuredMapKeys = true
        }
    }
}
