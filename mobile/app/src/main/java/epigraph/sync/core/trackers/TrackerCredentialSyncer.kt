package epigraph.sync.core.trackers

import epigraph.sync.TrackerSyncKeys
import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialFailure
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreTrackerCredential
import epigraph.sync.core.protocol.CoreTrackerCredentialDelete
import epigraph.sync.core.protocol.CoreTrackerCredentialList
import epigraph.sync.core.protocol.CoreTrackerCredentialWrite
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** The paired, pinned-TLS Core endpoints for `tracker.credential`. */
interface TrackerCredentialChannel {
    suspend fun list(): CoreHttpResult<CoreTrackerCredentialList>

    suspend fun put(trackerKey: String, write: CoreTrackerCredentialWrite): CoreHttpResult<CoreTrackerCredential>

    suspend fun delete(trackerKey: String, delete: CoreTrackerCredentialDelete): CoreHttpResult<CoreTrackerCredential>
}

/** The tracker logins the app actually uses. `null` means logged out. */
interface TrackerCredentialSource {
    /** Local tracker IDs whose logins are portable between devices. */
    val syncIds: Set<Long>

    fun read(syncId: Long): TrackerSecret?

    /** Replaces the login (logging the service out first) or logs it out when [secret] is null. */
    fun apply(syncId: Long, secret: TrackerSecret?)
}

data class TrackerCredentialSyncReport(
    val applied: Int = 0,
    val pushed: Int = 0,
    val conflicts: Int = 0,
    val failed: Int = 0,
    /** Why each failure happened, as tracker key and HTTP status only; never a credential value. */
    val failures: List<String> = emptyList(),
) {
    fun failure(reason: String) = copy(failed = failed + 1, failures = failures + reason)
}

/**
 * Converges local tracker logins with the Core. The Core revision is authoritative: when both
 * sides changed since the last agreement, the Core value is applied and the local change is
 * counted as a conflict. Local changes are sent as compare-and-set writes against the last agreed
 * revision; a 409 is resolved by the next run, which reads the newer Core value.
 *
 * Nothing here logs credential values, and the Core only ever sees them through [TrackerCredentialChannel].
 */
class TrackerCredentialSyncer(
    private val vault: TrackerCredentialVault,
    private val source: TrackerCredentialSource,
    private val deviceId: () -> String,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val operation = Mutex()

    suspend fun synchronize(channel: TrackerCredentialChannel): TrackerCredentialSyncReport = operation.withLock {
        withContext(ioDispatcher) { synchronizeLocked(channel) }
    }

    /**
     * Unpair: forget every agreement and log out the trackers whose current login was delivered
     * by the Core. Logins the user entered on this device stay untouched.
     */
    suspend fun wipe() = operation.withLock {
        withContext(ioDispatcher) {
            val entries = try {
                vault.read()
            } catch (_: CoreCredentialException) {
                emptyMap()
            }
            entries.forEach { (trackerKey, entry) ->
                val secret = entry.secret ?: return@forEach
                if (!entry.receivedFromCore) return@forEach
                val syncId = TrackerSyncKeys.syncIdFor(trackerKey) ?: return@forEach
                if (syncId in source.syncIds && source.read(syncId) == secret) source.apply(syncId, null)
            }
            vault.clear()
        }
    }

    private suspend fun synchronizeLocked(channel: TrackerCredentialChannel): TrackerCredentialSyncReport {
        val remote = when (val listed = callSafely { channel.list() }) {
            is CoreHttpResult.Success -> listed.value.credentials
                .filter { TrackerSyncKeys.syncIdFor(it.trackerKey) != null && it.revision > 0 }
                .groupBy(CoreTrackerCredential::trackerKey)
                .mapValues { (_, values) -> values.maxBy(CoreTrackerCredential::revision) }
            is CoreHttpResult.Failure -> return TrackerCredentialSyncReport().failure("list http=${listed.statusCode}")
            null -> return TrackerCredentialSyncReport().failure("list unreachable")
        }
        val agreed = try {
            vault.read()
        } catch (failure: CoreCredentialException) {
            if (failure.failure == CoreCredentialFailure.IO) return TrackerCredentialSyncReport().failure("vault io")
            // A corrupted vault or an invalidated Keystore key only loses the agreements; the
            // Core value wins on this run, exactly like a first pairing.
            vault.clear()
            emptyMap()
        }
        val next = agreed.toMutableMap()
        var report = TrackerCredentialSyncReport()

        for (syncId in source.syncIds.sorted()) {
            val trackerKey = TrackerSyncKeys.keyFor(syncId) ?: continue
            val local = source.read(syncId)
            val core = remote[trackerKey]
            // The Core keeps a tombstone for every login it deleted, so an agreement it has no
            // record of at all was lost there (a reset or reinstalled desktop): offer the login again.
            val known = agreed[trackerKey]?.takeIf { core != null }
            if (core == null) next.remove(trackerKey)
            val localChanged = if (known == null) local != null else local != known.secret
            val coreChanged = core != null && core.revision != known?.revision

            if (coreChanged) {
                val secret = core!!.toSecretOrNull()
                if (secret === INVALID) {
                    report = report.failure("$trackerKey unusable")
                    continue
                }
                if (secret != local) source.apply(syncId, secret)
                next[trackerKey] = TrackerCredentialVaultEntry(core.revision, secret, receivedFromCore = secret != null)
                report = report.copy(
                    applied = report.applied + 1,
                    conflicts = report.conflicts + if (localChanged && secret != local) 1 else 0,
                )
                continue
            }
            if (!localChanged) continue

            val baseRevision = known?.revision ?: 0L
            val result = if (local == null) {
                if (core == null) {
                    next.remove(trackerKey)
                    continue
                }
                callSafely { channel.delete(trackerKey, CoreTrackerCredentialDelete(baseRevision, deviceId())) }
            } else {
                callSafely {
                    channel.put(
                        trackerKey,
                        CoreTrackerCredentialWrite(baseRevision, deviceId(), local.username, local.password, local.token),
                    )
                }
            }
            report = when {
                result is CoreHttpResult.Success && result.value.trackerKey == trackerKey -> {
                    next[trackerKey] = TrackerCredentialVaultEntry(result.value.revision, local, receivedFromCore = false)
                    report.copy(pushed = report.pushed + 1)
                }
                result is CoreHttpResult.Failure && result.statusCode == 409 ->
                    report.copy(conflicts = report.conflicts + 1)
                result is CoreHttpResult.Failure -> report.failure("$trackerKey ${if (local == null) "delete" else "put"} http=${result.statusCode}")
                result == null -> report.failure("$trackerKey ${if (local == null) "delete" else "put"} unreachable")
                else -> report.failure("$trackerKey ${if (local == null) "delete" else "put"} mismatched")
            }
        }

        if (next != agreed) {
            try {
                vault.write(next)
            } catch (_: CoreCredentialException) {
                // The next run re-derives the same agreement from the Core revision.
                report = report.failure("vault write")
            }
        }
        return report
    }

    private suspend fun <T> callSafely(block: suspend () -> CoreHttpResult<T>): CoreHttpResult<T>? = try {
        block()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }

    private fun CoreTrackerCredential.toSecretOrNull(): TrackerSecret? {
        if (deleted) return null
        val secret = runCatching { TrackerSecret(username, password, token) }.getOrElse { return INVALID }
        return secret.takeUnless { it.isEmpty }
    }

    private companion object {
        /** Sentinel for a Core value this build cannot store; it is never applied. */
        val INVALID = TrackerSecret("\u0000invalid", "", "")
    }
}
