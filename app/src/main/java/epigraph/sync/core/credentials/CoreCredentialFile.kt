package epigraph.sync.core.credentials

import android.system.Os
import java.io.File
import java.io.FileOutputStream

interface CoreCredentialBlobStore {
    @Throws(CoreCredentialException::class)
    fun read(): ByteArray?

    @Throws(CoreCredentialException::class)
    fun writeAtomically(value: ByteArray)

    @Throws(CoreCredentialException::class)
    fun delete()
}

fun interface CoreCredentialFilePublisher {
    /** Must replace [target] atomically; both files are guaranteed to be in the same directory. */
    fun publish(source: File, target: File)
}

object AndroidAtomicCoreCredentialFilePublisher : CoreCredentialFilePublisher {
    override fun publish(source: File, target: File) {
        // rename(2) replaces an existing regular file atomically on Android/Linux.
        Os.rename(source.absolutePath, target.absolutePath)
    }
}

/** A private file writer that publishes only after flushing the complete `.part` file. */
class PrivateAtomicCoreCredentialFile(
    private val directory: File,
    private val fileName: String = DEFAULT_FILE_NAME,
    private val publisher: CoreCredentialFilePublisher = AndroidAtomicCoreCredentialFilePublisher,
) : CoreCredentialBlobStore {
    private val finalFile: File
        get() = safeChild(fileName)
    private val partFile: File
        get() = safeChild("$fileName.part")

    override fun read(): ByteArray? = translateIoFailures {
        val file = finalFile
        if (!file.exists()) return@translateIoFailures null
        if (!file.isFile || file.length() > MAX_FILE_BYTES) {
            throw CoreCredentialException(CoreCredentialFailure.CORRUPTED)
        }
        file.readBytes()
    }

    override fun writeAtomically(value: ByteArray) {
        if (value.isEmpty() || value.size > MAX_FILE_BYTES) {
            throw CoreCredentialException(CoreCredentialFailure.INVALID_INPUT)
        }
        translateIoFailures {
            if (!directory.exists() && !directory.mkdirs()) {
                throw CoreCredentialException(CoreCredentialFailure.IO)
            }
            val part = partFile
            if (part.exists() && !part.delete()) {
                throw CoreCredentialException(CoreCredentialFailure.IO)
            }
            try {
                FileOutputStream(part).use { output ->
                    output.write(value)
                    output.flush()
                    output.fd.sync()
                }
                publisher.publish(part, finalFile)
            } finally {
                if (part.exists()) part.delete()
            }
        }
    }

    override fun delete() = translateIoFailures {
        val part = partFile
        if (part.exists() && !part.delete()) {
            throw CoreCredentialException(CoreCredentialFailure.IO)
        }
        val final = finalFile
        if (final.exists() && !final.delete()) {
            throw CoreCredentialException(CoreCredentialFailure.IO)
        }
    }

    private fun safeChild(name: String): File {
        val canonicalDirectory = directory.canonicalFile
        val child = File(canonicalDirectory, name).canonicalFile
        if (child.parentFile != canonicalDirectory) {
            throw CoreCredentialException(CoreCredentialFailure.INVALID_INPUT)
        }
        return child
    }

    private inline fun <T> translateIoFailures(block: () -> T): T = try {
        block()
    } catch (error: CoreCredentialException) {
        throw error
    } catch (error: Throwable) {
        throw CoreCredentialException(CoreCredentialFailure.IO, error)
    }

    companion object {
        const val DEFAULT_FILE_NAME = "core-session-v1.bin"
        private const val MAX_FILE_BYTES = 128 * 1024L
    }
}
