package epigraph.sync.core.work

import android.content.Context
import android.util.Log
import epigraph.contract.PortableEcosystem
import epigraph.contract.PortableResolutionReason
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.EpigraphCoreCompatibilityEvaluator
import epigraph.sync.core.suwayomi.CatalogApplyStampStore
import epigraph.sync.core.suwayomi.SuwayomiCatalogSync
import epigraph.sync.core.suwayomi.SuwayomiProjectionStatusSource
import epigraph.sync.portable.PortableBootstrapPhase
import epigraph.sync.portable.SqlDelightPortableBootstrapStore
import eu.kanade.tachiyomi.BuildConfig
import eu.kanade.tachiyomi.extension.ExtensionManager
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import yokai.data.DatabaseHandler

/** Comic stages whose input the desktop Core announces as a revision in `/v1/sync/status`. */
enum class CoreCatalogStage(val key: String) {
    EXTENSIONS("extensions"),
    PORTABLE_MANIFEST("portableManifest"),
    CATALOG("catalog"),
}

/** What a stage last applied: the Core revision, the local state it met, and when it really ran. */
data class CoreStageRevision(
    val revision: String,
    val localSignature: String,
    val appliedAt: Long,
)

/** Replaceable cache of [CoreStageRevision]s; losing it only costs one normal run per stage. */
interface CoreStageRevisionStore {
    fun get(key: String): CoreStageRevision?
    fun put(key: String, value: CoreStageRevision)
    fun remove(key: String)
}

class SharedPreferencesCoreStageRevisionStore(context: Context) : CoreStageRevisionStore {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun get(key: String): CoreStageRevision? {
        val parts = preferences.getString(key, null)?.split('\n') ?: return null
        if (parts.size != 3) return null
        return CoreStageRevision(parts[1], parts[2], parts[0].toLongOrNull() ?: return null)
    }

    override fun put(key: String, value: CoreStageRevision) {
        preferences.edit()
            .putString(key, "${value.appliedAt}\n${value.revision}\n${value.localSignature}")
            .apply()
    }

    override fun remove(key: String) {
        preferences.edit().remove(key).apply()
    }

    private companion object {
        const val PREFERENCES = "epigraph_core_stage_revision"
    }
}

/** Where [CoreCatalogRevisionGate] records what [stage] applied for this pairing. */
fun coreStageRevisionKey(credentials: CoreCredentialSession, stage: CoreCatalogStage): String =
    "${credentials.serverId}:${credentials.profileId}:${stage.key}"

/** Local state a stage's last apply depended on; null when the stage must run regardless. */
fun interface CoreCatalogLocalState {
    suspend fun signature(stage: CoreCatalogStage, credentials: CoreCredentialSession): String?
}

class DatabaseCoreCatalogLocalState(
    private val database: DatabaseHandler,
    private val extensions: ExtensionManager,
    private val catalogStamps: CatalogApplyStampStore,
) : CoreCatalogLocalState {
    override suspend fun signature(stage: CoreCatalogStage, credentials: CoreCredentialSession): String? {
        // Installed and untrusted packages decide what the extension review and portable
        // hydration conclude, so installing or trusting one here runs both again.
        val installed = (extensions.installedExtensionsFlow.value.map { "i:${it.pkgName}:${it.versionCode}" } +
            extensions.untrustedExtensionsFlow.value.map { "u:${it.pkgName}:${it.versionCode}" })
            .sorted()
            .joinToString(",")
        if (stage == CoreCatalogStage.EXTENSIONS) return digest(installed)
        val scopeId = "comics:profile:${credentials.profileId}"
        return database.await(inTransaction = false) {
            // Titles with local work in flight are held back by the catalog apply; it must run
            // again once that work settles.
            val unsettled = aethon_syncQueries
                .selectUnsettledSuwayomiComicEntityIds(scopeId, credentials.profileId)
                .executeAsList()
            if (unsettled.isNotEmpty()) return@await null
            val library = aethon_syncQueries.selectComicLibrarySignature(scopeId).executeAsOne().toString()
            when (stage) {
                CoreCatalogStage.CATALOG -> {
                    // An apply that held back folders or titles left work for the next run.
                    val stamp = catalogStamps.get("${credentials.serverId}:${credentials.profileId}")
                    if (stamp == null || stamp.catalogDigest.isEmpty()) null else digest(library)
                }
                CoreCatalogStage.PORTABLE_MANIFEST -> {
                    val bootstrap = SqlDelightPortableBootstrapStore(this)
                        .load(credentials.serverId, credentials.profileId, PortableEcosystem.SUWAYOMI)
                    // Partial only because works wait for an extension or are unsupported: running
                    // again changes nothing until an install, which changes the signature.
                    val settled = bootstrap?.phase == PortableBootstrapPhase.COMPLETED ||
                        (bootstrap?.phase == PortableBootstrapPhase.PARTIAL && bootstrap.lastReason in WAITING_REASONS)
                    if (settled) digest("$library|$installed") else null
                }
                CoreCatalogStage.EXTENSIONS -> error("handled above")
            }
        }
    }

    private companion object {
        val WAITING_REASONS = setOf(
            PortableBootstrapPhase.WAITING_TRUST.name,
            PortableResolutionReason.WORK_RESOLUTION_UNSUPPORTED.name,
        )

        fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray())
            .take(16)
            .joinToString("") { "%02x".format(it) }
    }
}

/**
 * Skips a comic stage while the desktop Core announces the same revision it last applied, the local
 * state it met is unchanged, and its last real run is recent. A Core that announces no revision (an
 * older desktop, or one with unprojected work) runs every stage as before; so does a stage once
 * [REAPPLY_INTERVAL_MS] has passed, which keeps the periodic full reapply.
 */
class CoreCatalogRevisionGate(
    private val status: SuwayomiProjectionStatusSource,
    private val store: CoreStageRevisionStore,
    private val localState: CoreCatalogLocalState,
) {
    /** Reads the announced revisions once for a sync pass; null runs every stage. */
    suspend fun open(credentials: CoreCredentialSession, capabilities: CoreCapabilities): Pass? {
        if (!EpigraphCoreCompatibilityEvaluator.supportsSyncStatus(capabilities)) return null
        val result = try {
            status.status(credentials, "comics:profile:${credentials.profileId}")
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            null
        }
        val value = (result as? CoreHttpResult.Success)?.value ?: return null
        return Pass(
            credentials,
            value.comicLibraryRevision,
            value.comicExtensionsRevision,
            // A desktop that predates the manifest revision gates the manifest on the library.
            value.comicManifestRevision ?: value.comicLibraryRevision,
        )
    }

    inner class Pass internal constructor(
        private val credentials: CoreCredentialSession,
        private val libraryRevision: String?,
        private val extensionsRevision: String?,
        private val manifestRevision: String?,
    ) {
        private val finished = mutableMapOf<CoreCatalogStage, CoreStageRevision>()

        suspend fun run(
            stage: CoreCatalogStage,
            nowEpochMillis: Long,
            synchronize: suspend () -> CoreReplicaSyncOutcome,
        ): CoreReplicaSyncOutcome {
            val key = key(stage)
            val revision = when (stage) {
                CoreCatalogStage.EXTENSIONS -> extensionsRevision
                CoreCatalogStage.PORTABLE_MANIFEST -> manifestRevision
                CoreCatalogStage.CATALOG -> libraryRevision
            }
            // No revision while the Core projects a library change: run, but keep the record. A
            // revision is a digest of the content, so the same one later means the same content,
            // and the local signature still catches what this run changed here.
            if (revision == null) return synchronize()
            val previous = store.get(key)
            val signature = localState.signature(stage, credentials)
            if (
                previous != null && signature != null &&
                previous.revision == revision &&
                previous.localSignature == signature &&
                nowEpochMillis - previous.appliedAt in 0 until REAPPLY_INTERVAL_MS
            ) {
                finished[stage] = previous
                if (BuildConfig.DEBUG) {
                    runCatching { Log.d("EpigraphCoreSync", "${stage.key} skipped: Core revision unchanged") }
                }
                return CoreReplicaSyncOutcome.APPLIED
            }
            // An interrupted run must not leave the old record claiming this revision is applied.
            store.remove(key)
            val outcome = synchronize()
            if (outcome == CoreReplicaSyncOutcome.APPLIED) {
                finished[stage] = CoreStageRevision(revision, "", nowEpochMillis)
            }
            return outcome
        }

        /**
         * Records what each stage applied against the local state left once every stage ran: later
         * stages change the library too, and that change is what this pass applied, not a local edit.
         */
        suspend fun finish() {
            for ((stage, applied) in finished) {
                val signature = localState.signature(stage, credentials)
                if (signature == null) {
                    store.remove(key(stage))
                } else {
                    store.put(key(stage), applied.copy(localSignature = signature))
                }
            }
            finished.clear()
        }

        private fun key(stage: CoreCatalogStage) = coreStageRevisionKey(credentials, stage)
    }

    companion object {
        /** Same as the catalog's own full reapply: no stage goes longer than this without running. */
        const val REAPPLY_INTERVAL_MS = SuwayomiCatalogSync.REAPPLY_INTERVAL_MS
    }
}
