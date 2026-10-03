package epigraph.books.model

import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphIdentityRules
import epigraph.contract.ContentType
import java.io.File

/** Raw immutable blob identity. The protocol-level entity identity also includes the content type. */
@JvmInline
value class BookAssetId private constructor(
    val value: String,
) {
    init {
        require(SHA_256.matches(value)) { "Book asset IDs must be lowercase SHA-256 values" }
    }

    override fun toString(): String = value

    companion object {
        private val SHA_256 = Regex("[0-9a-f]{64}")

        fun fromSha256(value: String): BookAssetId = BookAssetId(value.lowercase())
    }
}

data class LocalBookDocument(
    val contentType: ContentType,
    val assetId: BookAssetId,
    val file: File,
    val displayName: String,
) {
    init {
        require(contentType == ContentType.EPUB || contentType == ContentType.PDF) {
            "A local book document must be EPUB or PDF"
        }
        require(displayName.isNotBlank()) { "A book must have a display name" }
    }

    val entityId: EpigraphEntityId = EpigraphIdentityRules.importedBookId(contentType, assetId.value)
}
