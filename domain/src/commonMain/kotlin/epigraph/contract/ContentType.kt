package epigraph.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Content families understood by the Epigraph protocol. */
@Serializable
enum class ContentType {
    @SerialName("manga")
    MANGA,

    @SerialName("novel")
    NOVEL,

    @SerialName("epub")
    EPUB,

    @SerialName("pdf")
    PDF,
}
