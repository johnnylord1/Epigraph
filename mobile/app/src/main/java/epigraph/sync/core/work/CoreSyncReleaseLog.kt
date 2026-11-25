package epigraph.sync.core.work

import android.util.Log

internal object CoreSyncReleaseLog {
    const val TAG = "EpigraphCoreSync"

    fun info(message: String) {
        runCatching { Log.i(TAG, message) }
    }

    fun warn(message: String) {
        runCatching { Log.w(TAG, message) }
    }

    fun formatStageOutcome(stage: String, outcome: String, elapsedMs: Long): String =
        "$stage sync outcome=$outcome elapsedMs=$elapsedMs"

    fun formatStageFailure(stage: String, failureType: String): String =
        "$stage sync failed=$failureType"

    fun formatV4Synced(
        elapsedMs: Long,
        seq: Long,
        uploaded: Int,
        applied: Int,
        pending: Long,
        noop: Boolean,
        assetsSucceeded: Int,
        assetsAttempted: Int,
    ): String =
        "v4 sync complete elapsedMs=$elapsedMs seq=$seq uploaded=$uploaded applied=$applied " +
            "pending=$pending noop=$noop assets=$assetsSucceeded/$assetsAttempted"

    fun classifyV4Failure(statusCode: Int?, retryable: Boolean): String = when {
        statusCode != null -> "http_$statusCode"
        retryable -> "transient_io"
        else -> "non_retryable"
    }

    fun formatV4Failed(
        elapsedMs: Long,
        statusCode: Int?,
        retryable: Boolean,
        pending: Long,
    ): String =
        "v4 sync failed elapsedMs=$elapsedMs status=${statusCode ?: "none"} " +
            "retryable=$retryable pending=$pending category=${classifyV4Failure(statusCode, retryable)}"
}
