package epigraph.contract

import kotlinx.serialization.Serializable

/**
 * Stable, protocol-level identity for content.
 *
 * This ID supplements the database's existing local ID; it must never replace it.
 */
@JvmInline
@Serializable
value class EpigraphEntityId(val value: String) {
    init {
        validateProtocolIdentifier(value, "Epigraph entity ID")
    }

    override fun toString(): String = value
}

@JvmInline
@Serializable
value class DeviceId(val value: String) {
    init {
        validateProtocolIdentifier(value, "device ID")
    }

    override fun toString(): String = value
}

@JvmInline
@Serializable
value class ClientMutationId(val value: String) {
    init {
        validateProtocolIdentifier(value, "client mutation ID")
    }

    override fun toString(): String = value
}

@JvmInline
@Serializable
value class SyncScopeId(val value: String) {
    init {
        validateProtocolIdentifier(value, "sync scope ID")
    }

    override fun toString(): String = value
}

@JvmInline
@Serializable
value class SyncEntityType(val value: String) {
    init {
        validateProtocolIdentifier(value, "sync entity type")
        require(ENTITY_TYPE.matches(value)) {
            "sync entity type must use lowercase dot-separated protocol segments"
        }
    }

    override fun toString(): String = value
}

/** Explicit mapping which leaves the legacy J2K local ID untouched. */
@Serializable
data class LocalEntityBinding(
    val localId: String,
    val entityId: EpigraphEntityId,
    val source: SourceBinding? = null,
) {
    init {
        validateProtocolIdentifier(localId, "local entity ID")
    }
}

internal fun validateProtocolIdentifier(value: String, label: String) {
    require(value.isNotBlank()) { "$label must not be blank" }
    require(value == value.trim()) { "$label must not have surrounding whitespace" }
    require(value.length <= MAX_IDENTIFIER_LENGTH) {
        "$label must not exceed $MAX_IDENTIFIER_LENGTH characters"
    }
    require(value.none(Char::isISOControl)) { "$label must not contain control characters" }
}

private const val MAX_IDENTIFIER_LENGTH = 512
private val ENTITY_TYPE = Regex("[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+")
