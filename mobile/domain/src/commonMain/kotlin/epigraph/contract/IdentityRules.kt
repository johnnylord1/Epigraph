package epigraph.contract

/** Pure identity rules shared by import, backup and synchronization code. */
object EpigraphIdentityRules {
    fun importedBookId(contentType: ContentType, sha256: String): EpigraphEntityId {
        require(contentType == ContentType.EPUB || contentType == ContentType.PDF) {
            "byte-hash identity is only valid for EPUB and PDF"
        }
        val canonicalHash = canonicalSha256(sha256)
        return EpigraphEntityId("${contentType.name.lowercase()}:sha256:$canonicalHash")
    }

    /** Unambiguous deterministic key; titles intentionally have no role in identity. */
    fun sourceBindingKey(binding: SourceBinding): String = buildString {
        append("source:v1|")
        listOf(
            binding.ecosystem,
            binding.repository,
            binding.plugin,
            binding.sourceId,
            binding.normalizedUrl,
        ).forEach { value -> append(value.length).append(':').append(value) }
    }

    fun canonicalSha256(value: String): String {
        val canonical = value.trim().lowercase()
        require(SHA_256.matches(canonical)) { "SHA-256 must contain exactly 64 hexadecimal characters" }
        return canonical
    }

    private val SHA_256 = Regex("[0-9a-f]{64}")
}
