package epigraph.sync.core.outbox

/**
 * Transport-neutral view of one persisted Android outbox row.
 *
 * The caller must supply a lamport clock because the current SQLDelight outbox deliberately does
 * not invent one from wall-clock time. [payloadJson] remains the canonical local protocol-v2
 * envelope and is never forwarded to Syncd.
 */
data class CoreOutboxRecord(
    val deviceId: String,
    val clientMutationId: String,
    val scopeId: String,
    val entityType: String,
    val entityId: String,
    val operation: String,
    val payloadJson: String,
    val createdAtEpochMillis: Long,
)

data class CoreOutboxIdentity(
    val deviceId: String,
    val clientMutationId: String,
)
