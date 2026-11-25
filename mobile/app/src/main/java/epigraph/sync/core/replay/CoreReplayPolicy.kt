package epigraph.sync.core.replay

/** Scope coverage of one snapshot + SSE subscription pair. */
sealed interface CoreReplayCoverage {
    /** The stream was opened without `scopeId`, covering every scope granted to the token. */
    data object AllGrantedScopes : CoreReplayCoverage

    /** The snapshot and stream cover only [scopeId]. */
    data class Filtered(val scopeId: String) : CoreReplayCoverage {
        init {
            require(scopeId.isNotBlank()) { "scopeId must not be blank" }
        }
    }
}

data class CoreReplayCheckpoint(
    val lastGlobalEventId: Long,
    val coverage: CoreReplayCoverage,
) {
    init {
        require(lastGlobalEventId >= 0) { "lastGlobalEventId must not be negative" }
    }

    /** Exact value to send as the next `Last-Event-ID` header. */
    val lastEventIdHeader: String
        get() = lastGlobalEventId.toString()

    /**
     * A filtered snapshot/feed is never evidence about entities outside its scope. Consumers may
     * delete data only in response to an explicit delete envelope or an authoritative snapshot of
     * that same scope. Missing global versions are not tombstones.
     */
    val mayInferGlobalDeletes: Boolean
        get() = false
}
