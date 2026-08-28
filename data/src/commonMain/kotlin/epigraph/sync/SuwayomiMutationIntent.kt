package epigraph.sync

/**
 * An official Suwayomi mutation that must be applied after the local transaction commits.
 *
 * The JSON is the variables object for the documented GraphQL operation. Keeping this record
 * independent from the Syncd envelope prevents comics catalog ownership from leaking into the
 * cross-device snapshot protocol.
 */
data class SuwayomiMutationIntent(
    val operationId: String,
    val profileId: String,
    val operationName: String,
    val variablesJson: String,
    val entityId: String,
    val createdAtEpochMillis: Long,
) {
    init {
        require(operationId.isNotBlank()) { "Suwayomi operation ID must not be blank" }
        require(profileId.isNotBlank()) { "Suwayomi profile ID must not be blank" }
        require(operationName.isNotBlank()) { "Suwayomi operation name must not be blank" }
        require(variablesJson.isNotBlank()) { "Suwayomi variables must not be blank" }
        require(entityId.isNotBlank()) { "Suwayomi entity ID must not be blank" }
        require(createdAtEpochMillis >= 0) { "Suwayomi timestamp must not be negative" }
    }
}
