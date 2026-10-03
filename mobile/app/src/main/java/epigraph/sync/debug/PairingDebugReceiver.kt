package epigraph.sync.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.koin.core.context.GlobalContext
import epigraph.sync.core.replica.CoreReplicaCheckpointResetter
import epigraph.sync.core.pairing.EpigraphCorePairingController
import epigraph.sync.core.pairing.PairingSyncSelection

/**
 * Debug-only pairing injector (registered only in the debug manifest):
 *
 *   adb push bundle.json /data/local/tmp/epigraph_pairing_bundle.json
 *   adb shell am broadcast -a epigraph.debug.PAIRING_INJECT
 *
 * Reads the bundle JSON from a device file (no shell quoting, no IME, no QR) and
 * pairs immediately with the default sync selection. Exists purely so end-to-end
 * pairing tests are deterministic; release builds never register it.
 */
class PairingDebugReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_RESET_REPLICA) {
            val resetter = GlobalContext.get().getOrNull<CoreReplicaCheckpointResetter>()
            if (resetter == null) {
                Log.w(TAG, "replica resetter not ready")
                return
            }
            Log.i(TAG, "resetting Core replica checkpoints for debug smoke")
            CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                runCatching { resetter.reset() }
                    .onSuccess { Log.i(TAG, "Core replica checkpoints reset") }
                    .onFailure { Log.e(TAG, "Core replica checkpoint reset failed", it) }
            }
            return
        }
        val path = intent.getStringExtra(EXTRA_PATH) ?: DEFAULT_PATH
        val file = File(path)
        if (!file.exists()) {
            Log.w(TAG, "bundle file not found: $path")
            return
        }
        val raw = file.readText().trim()
        if (raw.isEmpty()) {
            Log.w(TAG, "empty bundle at $path")
            return
        }
        val controller = GlobalContext.get().getOrNull<EpigraphCorePairingController>()
        if (controller == null) {
            Log.w(TAG, "pairing controller not ready")
            return
        }
        Log.i(TAG, "injecting pairing bundle (${raw.length} chars) from $path")
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            controller.pair(raw, PairingSyncSelection.defaults())
        }
    }

    companion object {
        private const val TAG = "PairingDebug"
        const val ACTION = "epigraph.debug.PAIRING_INJECT"
        const val ACTION_RESET_REPLICA = "epigraph.debug.CORE_REPLICA_RESET"
        const val EXTRA_PATH = "path"
        const val DEFAULT_PATH = "/data/local/tmp/epigraph_pairing_bundle.json"
    }
}
