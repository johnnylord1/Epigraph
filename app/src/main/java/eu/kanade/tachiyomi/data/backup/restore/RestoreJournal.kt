package eu.kanade.tachiyomi.data.backup.restore

import java.io.File
import java.io.FileOutputStream

/**
 * Checkpoints of one backup restore, so a restore stopped by process death or by the system
 * resumes after the last committed stage or title instead of starting over.
 *
 * The journal is a small append-only text file. Its first line identifies the backup (its URI and
 * the SHA-256 of its bytes); each following line marks a committed step or a recorded error. A
 * line cut short by a crash has no trailing newline and is ignored. Re-applying a step committed
 * just before the crash, but not journaled yet, is harmless because every restore step merges.
 */
class RestoreJournal(private val file: File) {
    private val done = mutableSetOf<String>()
    private val errors = mutableListOf<Pair<Long, String>>()

    /** Steps already committed by an earlier attempt of the same restore. */
    val completed: Set<String> get() = done

    /** Errors recorded by earlier attempts of the same restore, with their epoch millis. */
    val recordedErrors: List<Pair<Long, String>> get() = errors

    /**
     * Opens the journal for [backupIdentity]. Checkpoints of any other backup are discarded.
     *
     * @return true when an interrupted restore of the same backup is resumed.
     */
    fun open(backupIdentity: String): Boolean {
        done.clear()
        errors.clear()
        val header = HEADER + escape(backupIdentity)
        val lines = readCompleteLines()
        if (lines.firstOrNull() == header) {
            lines.drop(1).forEach(::parse)
            // Rewrite only complete lines, so a partial line cannot merge into the next append.
            write(lines)
            return done.isNotEmpty() || errors.isNotEmpty()
        }
        write(listOf(header))
        return false
    }

    fun isDone(step: String): Boolean = step in done

    fun markDone(step: String) {
        require(step.isNotBlank() && '\n' !in step && '\r' !in step) { "Invalid restore step: $step" }
        if (done.add(step)) append("$DONE$step")
    }

    fun recordError(epochMillis: Long, message: String) {
        errors += epochMillis to message
        append("$ERROR$epochMillis ${escape(message)}")
    }

    /** Forgets the restore: it finished, or the user cancelled it. */
    fun delete() {
        done.clear()
        errors.clear()
        file.delete()
    }

    private fun parse(line: String) {
        when {
            line.startsWith(DONE) -> done += line.removePrefix(DONE)
            line.startsWith(ERROR) -> {
                val body = line.removePrefix(ERROR)
                val time = body.substringBefore(' ').toLongOrNull() ?: return
                errors += time to unescape(body.substringAfter(' ', ""))
            }
        }
    }

    private fun readCompleteLines(): List<String> {
        val text = runCatching { file.takeIf(File::isFile)?.readText() }.getOrNull().orEmpty()
        if ('\n' !in text) return emptyList()
        return text.substringBeforeLast('\n').split('\n').filter(String::isNotEmpty)
    }

    private fun write(lines: List<String>) {
        file.parentFile?.mkdirs()
        val partial = File(file.parentFile, file.name + ".tmp")
        partial.writeText(lines.joinToString(separator = "") { "$it\n" })
        if (!partial.renameTo(file)) {
            file.delete()
            if (!partial.renameTo(file)) {
                partial.delete()
                throw IllegalStateException("Unable to write the restore journal")
            }
        }
    }

    private fun append(line: String) {
        FileOutputStream(file, true).use { it.write("$line\n".toByteArray(Charsets.UTF_8)) }
    }

    companion object {
        private const val HEADER = "epigraph-restore 1 "
        private const val DONE = "done "
        private const val ERROR = "error "

        const val CATEGORIES = "categories"
        const val REPOSITORIES = "repositories"
        const val EXTENSION_REPOSITORIES = "extension-repositories"
        const val APP_PREFERENCES = "app-prefs"
        const val SOURCE_PREFERENCES = "source-prefs"
        const val NOVEL_PLUGINS = "novel-plugins"

        fun manga(index: Int) = "m:$index"
        fun localBook(index: Int) = "l:$index"

        fun file(filesDir: File) = File(filesDir, "restore/journal")

        internal fun escape(value: String): String = buildString(value.length) {
            value.forEach { char ->
                when (char) {
                    '\\' -> append("\\\\")
                    '\n' -> append("\\n")
                    '\r' -> append("\\r")
                    else -> append(char)
                }
            }
        }

        internal fun unescape(value: String): String = buildString(value.length) {
            var index = 0
            while (index < value.length) {
                val char = value[index]
                if (char == '\\' && index + 1 < value.length) {
                    when (value[index + 1]) {
                        'n' -> append('\n')
                        'r' -> append('\r')
                        else -> append(value[index + 1])
                    }
                    index += 2
                } else {
                    append(char)
                    index++
                }
            }
        }
    }
}
