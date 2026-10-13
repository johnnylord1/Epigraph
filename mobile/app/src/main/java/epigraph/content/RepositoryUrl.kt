package epigraph.content

/** Comparison of extension and plugin repository addresses written by different apps. */
object RepositoryUrl {
    private val GITHUB_HOSTS = setOf("github.com", "www.github.com", "raw.githubusercontent.com")

    /**
     * [url] in the form two addresses of the same repository share. The scheme and host ignore
     * case, and so do a GitHub owner and repository name: `LNReader/lnreader-plugins` and
     * `lnreader/lnreader-plugins` are one repository. Branches and paths keep their case.
     */
    fun comparable(url: String): String {
        val value = url.trim().trimEnd('/')
        val schemeEnd = value.indexOf("://")
        if (schemeEnd < 0) return value
        val segments = value.substring(schemeEnd + 3).split('/').toMutableList()
        val host = segments.first().lowercase()
        segments[0] = host
        if (host in GITHUB_HOSTS) {
            for (index in 1..minOf(2, segments.lastIndex)) segments[index] = segments[index].lowercase()
        }
        return value.substring(0, schemeEnd).lowercase() + "://" + segments.joinToString("/")
    }
}
