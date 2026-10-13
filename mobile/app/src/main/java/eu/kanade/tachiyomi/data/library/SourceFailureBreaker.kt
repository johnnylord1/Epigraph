package eu.kanade.tachiyomi.data.library

/**
 * Tells one library update to stop trying a source after [limit] failed titles in a row, so a
 * source behind a Cloudflare challenge or returning HTTP 502 does not cost a timeout per title.
 * A successful title resets the count. Each source in each run gets its own instance.
 */
internal class SourceFailureBreaker(val limit: Int) {
    private var consecutiveFailures = 0

    val isOpen: Boolean
        get() = consecutiveFailures >= limit

    fun record(failed: Boolean) {
        consecutiveFailures = if (failed) consecutiveFailures + 1 else 0
    }
}
