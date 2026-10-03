package epigraph.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

/** Durable reader position. All indexes are zero-based. */
@Serializable
sealed interface ReaderLocator {
    val entityId: EpigraphEntityId
    val contentType: ContentType

    @Serializable
    @SerialName("manga")
    data class Manga(
        override val entityId: EpigraphEntityId,
        val chapterId: String,
        val pageIndex: Int,
        val pageOffset: Double = 0.0,
        /** Optional source page count, used to publish an exact Core progress percentage. */
        val pageCount: Int? = null,
        /** Progress across the chapter, normalized to [0, 1]. */
        val progression: Double = 0.0,
        /** V3 provider-owned identity. Legacy sessions may omit these fields. */
        val portableWork: PortableWorkRef.Comic? = null,
        val portableChapter: PortableChapterRef.Comic? = null,
    ) : ReaderLocator {
        @Transient
        override val contentType: ContentType = ContentType.MANGA

        init {
            validateProtocolIdentifier(chapterId, "manga chapter ID")
            require(pageIndex >= 0) { "page index must not be negative" }
            validateProgression(pageOffset, "page offset")
            require(pageCount == null || pageCount > 0) { "page count must be positive when present" }
            validateProgression(progression, "manga progression")
            require(portableChapter == null || portableChapter.work == portableWork) {
                "portable chapter must belong to the portable work"
            }
        }
    }

    @Serializable
    @SerialName("novel")
    data class Novel(
        override val entityId: EpigraphEntityId,
        val chapterId: String,
        val blockIndex: Int,
        val textOffset: Int,
        val progression: Double = 0.0,
        val chapterOrderKey: Double? = null,
        /** V3 provider-owned identity. Legacy sessions may omit these fields. */
        val portableWork: PortableWorkRef.Novel? = null,
        val portableChapter: PortableChapterRef.Novel? = null,
    ) : ReaderLocator {
        @Transient
        override val contentType: ContentType = ContentType.NOVEL

        init {
            validateProtocolIdentifier(chapterId, "novel chapter ID")
            require(blockIndex >= 0) { "block index must not be negative" }
            require(textOffset >= 0) { "text offset must not be negative" }
            validateProgression(progression, "novel progression")
            require(chapterOrderKey == null || chapterOrderKey.isFinite()) {
                "novel chapter order key must be finite"
            }
            require(portableChapter == null || portableChapter.work == portableWork) {
                "portable chapter must belong to the portable novel work"
            }
        }
    }

    @Serializable
    @SerialName("epub")
    data class Epub(
        override val entityId: EpigraphEntityId,
        val cfi: String? = null,
        val progression: Double,
    ) : ReaderLocator {
        @Transient
        override val contentType: ContentType = ContentType.EPUB

        init {
            cfi?.let {
                require(it.isNotBlank()) { "EPUB CFI must not be blank when present" }
                require(it.length <= MAX_LOCATOR_TEXT_LENGTH) { "EPUB CFI is too long" }
                require(it.none(Char::isISOControl)) { "EPUB CFI must not contain control characters" }
            }
            validateProgression(progression, "EPUB progression")
        }
    }

    @Serializable
    @SerialName("pdf")
    data class Pdf(
        override val entityId: EpigraphEntityId,
        val pageIndex: Int,
        val pageOffset: Double = 0.0,
        val characterOffset: Int? = null,
        val totalPages: Int? = null,
        val documentProgression: Double? = null,
    ) : ReaderLocator {
        @Transient
        override val contentType: ContentType = ContentType.PDF

        init {
            require(pageIndex >= 0) { "page index must not be negative" }
            validateProgression(pageOffset, "PDF page offset")
            require(characterOffset == null || characterOffset >= 0) {
                "PDF character offset must not be negative"
            }
            require(totalPages == null || totalPages > 0) {
                "PDF total pages must be positive when present"
            }
            require(totalPages == null || pageIndex < totalPages) {
                "PDF page index must be smaller than total pages"
            }
            documentProgression?.let { validateProgression(it, "PDF document progression") }
        }
    }
}

private fun validateProgression(value: Double, label: String) {
    require(value.isFinite() && value in 0.0..1.0) { "$label must be between 0 and 1" }
}

private const val MAX_LOCATOR_TEXT_LENGTH = 4096
