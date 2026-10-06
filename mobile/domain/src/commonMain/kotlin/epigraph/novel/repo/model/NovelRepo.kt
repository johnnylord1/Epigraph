package epigraph.novel.repo.model

data class NovelRepo(
    val baseUrl: String,
    val name: String,
) {
    /** GitHub-hosted indexes all share one host, so they are told apart by owner/repository. */
    val displayName: String
        get() = githubRepository(baseUrl) ?: name
}

private val GITHUB_HOSTS = setOf("raw.githubusercontent.com", "github.com", "www.github.com")

private fun githubRepository(url: String): String? {
    val segments = url.substringAfter("://").split('/')
    if (segments.size < 3 || segments[0].lowercase() !in GITHUB_HOSTS) return null
    val (owner, repository) = segments[1] to segments[2]
    return if (owner.isBlank() || repository.isBlank()) null else "$owner/$repository"
}
