package epigraph.sync.core.assets

import java.io.File

fun interface CoreAssetCancellation {
    fun isCancelled(): Boolean

    companion object {
        val NONE = CoreAssetCancellation { false }
    }
}

sealed interface CoreAssetTransferState {
    data object Inspecting : CoreAssetTransferState
    data class Resuming(val byteOffset: Long) : CoreAssetTransferState
    data class Transferring(val bytesTransferred: Long, val totalBytes: Long) : CoreAssetTransferState
    data object Verifying : CoreAssetTransferState
    data object Publishing : CoreAssetTransferState
    data class Complete(val disposition: CoreAssetDisposition, val file: File) : CoreAssetTransferState
}

fun interface CoreAssetTransferObserver {
    fun onState(state: CoreAssetTransferState)

    companion object {
        val NONE = CoreAssetTransferObserver { }
    }
}

fun interface CoreAssetFileValidator {
    fun isValid(file: File): Boolean

    companion object {
        val NONE = CoreAssetFileValidator { true }
    }
}

enum class CoreAssetDisposition {
    DOWNLOADED,
    ALREADY_PRESENT,
    UPLOADED,
    ALREADY_ON_CORE,
}

data class CoreAssetTransferResult(
    val assetId: CoreAssetId,
    val byteSize: Long,
    val file: File,
    val disposition: CoreAssetDisposition,
)

enum class CoreAssetFailure {
    CANCELLED,
    LOCAL_STORAGE,
    LOCAL_ASSET_MISSING,
    REMOTE_NOT_FOUND,
    UNAUTHORIZED,
    FORBIDDEN,
    INCOMPATIBLE_CORE,
    REMOTE_PROTOCOL,
    RESPONSE_TOO_LARGE,
    SIZE_MISMATCH,
    HASH_MISMATCH,
    INVALID_CONTENT,
    IMMUTABLE_COLLISION,
    NETWORK,
}

class CoreAssetTransferException(
    val failure: CoreAssetFailure,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
