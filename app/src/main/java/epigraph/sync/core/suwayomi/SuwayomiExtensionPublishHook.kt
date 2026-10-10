package epigraph.sync.core.suwayomi

import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiMutationOperation
import epigraph.sync.core.work.CoreNegotiatedSessionHook
import epigraph.sync.core.work.CoreOutboxSyncConnection
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** Extensions and repositories installed on this phone, as the desktop runtime names them. */
data class PhoneExtensionState(
    val packageNames: List<String>,
    /** Full repository index URLs, e.g. `https://.../repo/index.min.json`. */
    val repoIndexUrls: List<String>,
)

fun interface PhoneExtensionStateSource {
    suspend fun current(): PhoneExtensionState
}

/** Remembers, per paired desktop, what this phone already published so it is sent only once. */
interface PublishedExtensionLedger {
    fun published(desktopKey: String): Set<String>
    fun markPublished(desktopKey: String, entries: Collection<String>)
}

/**
 * Publishes extensions and repositories added on the phone to the desktop Suwayomi runtime, the
 * phone-to-desktop half of extension parity (the desktop-to-phone half is
 * [epigraph.sync.core.extensions.ExtensionReconciliationCoordinator]).
 *
 * Each repository and package is published once per paired desktop: removing it later on the
 * desktop is a newer decision and is not undone by the phone on the next sync.
 */
class SuwayomiExtensionPublishHook(
    private val phone: PhoneExtensionStateSource,
    private val ledger: PublishedExtensionLedger,
    private val maxPackagesPerSession: Int = 10,
) : CoreNegotiatedSessionHook {

    override suspend fun onNegotiated(
        capabilities: CoreCapabilities,
        connection: CoreOutboxSyncConnection,
    ) {
        if (!capabilities.supportsSuwayomiExtensionInstall) return
        val channel = connection.suwayomiCommands() ?: return
        if (channel.serverId == LEGACY_UNBOUND_SERVER_ID) return
        val desktopKey = "${channel.serverId}:${channel.profileId}"
        val done = ledger.published(desktopKey)
        val state = phone.current()

        // Repositories first, so the desktop runtime can offer the packages that follow.
        val repos = state.repoIndexUrls.distinct()
            .filter { isPublishableRepo(it) && REPO_PREFIX + it !in done }
            .take(MAX_REPOS)
        if (repos.isNotEmpty()) {
            val result = channel.command(
                SuwayomiCommandRequest(
                    operation = SuwayomiMutationOperation.ADD_EXTENSION_REPOS,
                    variables = buildJsonObject { putJsonArray("repos") { repos.forEach { add(JsonPrimitive(it)) } } },
                ),
            )
            if (result is CoreHttpResult.Failure && !result.isRejection()) return
            ledger.markPublished(desktopKey, repos.map { REPO_PREFIX + it })
        }

        val packages = state.packageNames.distinct()
            .filter { PACKAGE_PREFIX + it !in done }
            .take(maxPackagesPerSession)
        for (packageName in packages) {
            val result = channel.command(
                SuwayomiCommandRequest(
                    operation = SuwayomiMutationOperation.INSTALL_EXTENSION,
                    variables = buildJsonObject { put("pkgName", packageName) },
                ),
            )
            // The Core is unreachable or busy: retry on the next sync. A package the desktop
            // rejects, already has, or cannot find in its repositories is settled.
            if (result is CoreHttpResult.Failure && !result.isRejection()) return
            ledger.markPublished(desktopKey, listOf(PACKAGE_PREFIX + packageName))
        }
    }

    companion object {
        private const val REPO_PREFIX = "repo:"
        private const val PACKAGE_PREFIX = "pkg:"
        private const val MAX_REPOS = 20

        internal fun isPublishableRepo(url: String): Boolean =
            url.startsWith("https://") && url.endsWith(".json") && url.none { it.isWhitespace() }

        /** 4xx except auth and throttling, or a 503 the Core marked non-retryable. */
        private fun CoreHttpResult.Failure.isRejection(): Boolean = when (statusCode) {
            401, 403, 408, 429 -> false
            in 400..499 -> true
            503 -> errorEnvelope?.error?.retryable == false
            else -> false
        }
    }
}

class SharedPreferencesPublishedExtensionLedger(context: android.content.Context) : PublishedExtensionLedger {
    private val preferences =
        context.getSharedPreferences("epigraph_core_published_extensions", android.content.Context.MODE_PRIVATE)

    override fun published(desktopKey: String): Set<String> =
        preferences.getStringSet(desktopKey, null).orEmpty().toSet()

    override fun markPublished(desktopKey: String, entries: Collection<String>) {
        if (entries.isEmpty()) return
        preferences.edit().putStringSet(desktopKey, published(desktopKey) + entries).apply()
    }
}
