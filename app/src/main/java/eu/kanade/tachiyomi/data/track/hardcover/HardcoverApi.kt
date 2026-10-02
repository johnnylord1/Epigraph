package eu.kanade.tachiyomi.data.track.hardcover

import eu.kanade.tachiyomi.data.track.model.TrackSearch
import eu.kanade.tachiyomi.network.POST
import eu.kanade.tachiyomi.network.awaitSuccess
import eu.kanade.tachiyomi.network.jsonMime
import eu.kanade.tachiyomi.network.parseAs
import eu.kanade.tachiyomi.util.system.withIOContext
import java.io.IOException
import java.time.Instant
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.Headers.Companion.headersOf
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import yokai.util.koin.injectLazy
import kotlinx.coroutines.CancellationException

/**
 * GraphQL transport for Hardcover's authenticated API.
 *
 * The tracker stores the API token in TrackService's private password preference. This class
 * never includes that token in exceptions or logs and keeps all GraphQL details out of the
 * TrackService implementation.
 */
internal class HardcoverApi(
    private val tracker: Hardcover,
    private val client: OkHttpClient,
) {

    private val json: Json by injectLazy()

    suspend fun search(query: String): List<TrackSearch> = withIOContext {
        val data = execute(
            SEARCH_QUERY,
            buildJsonObject {
                put("query", query)
                put("queryType", "Book")
                put("page", 1)
                put("perPage", SEARCH_PAGE_SIZE)
            },
        )

        val search = data["search"]?.jsonObject ?: return@withIOContext emptyList()
        val ids = search["ids"]?.jsonArray.orEmpty().mapNotNull { it.longOrNullValue() }
        val results = search["results"].asJsonArrayOrNull()
        results.mapIndexedNotNull { index, element ->
            val result = element as? JsonObject ?: return@mapIndexedNotNull null
            val bookId = result.longValue("id")
                ?: result.longValue("book_id")
                ?: ids.getOrNull(index)
                ?: return@mapIndexedNotNull null
            val title = result.textValue("title")
                .ifBlank { result.textValue("name") }
                .ifBlank { return@mapIndexedNotNull null }
            val slug = result.textValue("slug")
            TrackSearch.create(tracker.id).apply {
                media_id = bookId
                this.title = title
                tracking_url = bookUrl(bookId, slug)
                cover_url = result.imageUrl()
                summary = result.textValue("description")
                publishing_type = "Book"
                publishing_status = result.textValue("status")
                start_date = result.textValue("release_date")
                    .ifBlank { result.longValue("release_year")?.toString().orEmpty() }
                // Hardcover tracks pages, while Epigraph's Track model tracks chapters. Do not
                // present a page count as a chapter count to the chapter UI.
                total_chapters = 0L
            }
        }
    }

    suspend fun searchBooks(
        query: String,
        limit: Int,
        fields: String? = null,
        weights: String? = null,
        sort: String? = null,
    ): List<HardcoverBookResult> = withIOContext {
        if (query.isBlank()) return@withIOContext emptyList()

        val variables = buildJsonObject {
            put("query", query)
            put("limit", limit)
            put("page", 1)
            if (fields != null) put("fields", fields)
            if (weights != null) put("weights", weights)
            if (sort != null) put("sort", sort)
        }

        val data = execute(RECOMMENDATION_SEARCH_QUERY, variables)

        val resultsElement = data["search"].obj?.get("results")
            ?: return@withIOContext emptyList()

        val documents: List<JsonObject> = when (resultsElement) {
            is JsonPrimitive -> {
                val parsed = runCatching { json.parseToJsonElement(resultsElement.content) }.getOrNull()
                when (parsed) {
                    is JsonObject -> parsed["hits"].arr.orEmpty()
                        .mapNotNull { it.obj?.get("document").obj }
                    is JsonArray -> parsed.mapNotNull { it.obj }
                    else -> emptyList()
                }
            }
            is JsonObject -> resultsElement["hits"].arr.orEmpty()
                .mapNotNull { it.obj?.get("document").obj }
            is JsonArray -> resultsElement.mapNotNull { it.obj }
            else -> emptyList()
        }

        val books = documents.mapNotNull { it.toBookResult() }.take(limit)
        if (books.isEmpty()) return@withIOContext books

        val ids = books.map { it.id }.distinct()
        try {
            val detailsData = execute(
                BOOK_DETAILS_QUERY,
                buildJsonObject { put("ids", JsonArray(ids.map { JsonPrimitive(it) })) },
            )
            val detailsById = detailsData["books"].arr.orEmpty()
                .mapNotNull { it.obj?.toBookResult() }
                .associateBy { it.id }

            books.map { book ->
                val detail = detailsById[book.id] ?: return@map book
                book.mergeWith(detail)
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            books
        }
    }

    suspend fun currentUser(token: String = tracker.getPassword()): HardcoverUser = withIOContext {
        val data = execute(CURRENT_USER_QUERY, token = token)
        val user = data["me"]?.jsonArray?.firstOrNull()?.jsonObject
            ?: throw IOException("Hardcover did not return a user")
        HardcoverUser(
            id = user.longValue("id") ?: 0L,
            username = user.textValue("username"),
        )
    }

    suspend fun findUserBook(bookId: Long): HardcoverUserBook? = withIOContext {
        val data = execute(
            FIND_USER_BOOK_QUERY,
            buildJsonObject { put("bookId", bookId) },
        )
        data["me"]?.jsonArray
            ?.firstOrNull()
            ?.jsonObject
            ?.get("user_books")
            ?.jsonArray
            ?.firstOrNull()
            ?.jsonObject
            ?.toUserBook()
    }

    suspend fun getUserBook(userBookId: Long): HardcoverUserBook? = withIOContext {
        val data = execute(
            GET_USER_BOOK_QUERY,
            buildJsonObject { put("userBookId", userBookId) },
        )
        (data["user_books_by_pk"] as? JsonObject)?.toUserBook()
    }

    suspend fun userBooks(): List<HardcoverLibraryBook> = withIOContext {
        val user = currentUser()
        val data = execute(
            USER_BOOKS_QUERY,
            buildJsonObject { put("userId", user.id) },
        )
        data["user_books"].arr.orEmpty().mapNotNull { it.obj?.toLibraryBook() }
    }

    suspend fun addUserBook(bookId: Long, statusId: Int, rating: Float): HardcoverUserBook =
        withIOContext {
            val ratingField = ratingField(rating)
            val query = ADD_USER_BOOK_QUERY.replace("__RATING__", ratingField)
            val data = execute(
                query,
                buildJsonObject {
                    put("bookId", bookId)
                    put("statusId", statusId)
                },
            )
            val payload = data["insert_user_book"]?.jsonObject
                ?: throw IOException("Hardcover did not return the new user book")
            payload["error"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }?.let {
                throw IOException("Hardcover: $it")
            }
            (payload["user_book"] as? JsonObject)?.toUserBook()
                ?: payload["id"]?.longOrNullValue()?.let { id ->
                    getUserBook(id)
                }
                ?: throw IOException("Hardcover did not return a user book id")
        }

    suspend fun updateUserBook(userBookId: Long, statusId: Int, rating: Float) = withIOContext {
        val ratingField = ratingField(rating)
        val query = UPDATE_USER_BOOK_QUERY.replace("__RATING__", ratingField)
        val data = execute(
            query,
            buildJsonObject {
                put("userBookId", userBookId)
                put("statusId", statusId)
            },
        )
        val payload = data["update_user_book"]?.jsonObject
            ?: throw IOException("Hardcover did not return the updated user book")
        payload["error"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }?.let {
            throw IOException("Hardcover: $it")
        }
    }

    suspend fun updateProgress(userBookId: Long, progressPages: Int) = withIOContext {
        if (progressPages <= 0) return@withIOContext
        val data = execute(
            UPDATE_PROGRESS_QUERY,
            buildJsonObject {
                put("userBookId", userBookId)
                put("progressPages", progressPages)
            },
        )
        val payload = data["upsert_user_book_reads"]?.jsonObject
            ?: throw IOException("Hardcover did not return the progress update")
        payload["error"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }?.let {
            throw IOException("Hardcover: $it")
        }
    }

    suspend fun deleteUserBook(userBookId: Long): Boolean = withIOContext {
        val data = execute(
            DELETE_USER_BOOK_QUERY,
            buildJsonObject { put("userBookId", userBookId) },
        )
        data["delete_user_book"]?.jsonObject?.get("id")?.longOrNullValue() != null
    }

    private suspend fun execute(
        query: String,
        variables: JsonObject = buildJsonObject {},
        token: String = tracker.getPassword(),
    ): JsonObject {
        val payload = buildJsonObject {
            put("query", query)
            put("variables", variables)
        }
        val response = client.newCall(
            POST(
                API_URL,
                headers = headersOf(
                    "Authorization",
                    "Bearer $token",
                    "Accept",
                    "application/json",
                ),
                body = payload.toString().toRequestBody(jsonMime),
            ),
        ).awaitSuccess().parseAs<JsonObject>()

        response["errors"]?.jsonArray
            ?.mapNotNull { it.jsonObject["message"]?.jsonPrimitive?.contentOrNull }
            ?.takeIf { it.isNotEmpty() }
            ?.joinToString("; ")
            ?.let { throw IOException("Hardcover: $it") }

        return response["data"]?.jsonObject
            ?: throw IOException("Hardcover returned no data")
    }

    private fun JsonObject.toUserBook(): HardcoverUserBook? {
        val id = longValue("id") ?: return null
        val bookId = longValue("book_id") ?: return null
        val read = this["user_book_reads"]?.jsonArray
            ?.firstOrNull()
            ?.jsonObject
        return HardcoverUserBook(
            id = id,
            bookId = bookId,
            statusId = longValue("status_id")?.toInt() ?: Hardcover.WANT_TO_READ,
            rating = this["rating"]?.jsonPrimitive?.doubleOrNull?.toFloat() ?: 0f,
            pages = (this["book"] as? JsonObject)?.longValue("pages")
                ?: (this["edition"] as? JsonObject)?.longValue("pages"),
            progressPages = read?.longValue("progress_pages")?.toInt(),
        )
    }

    private fun JsonObject.toLibraryBook(): HardcoverLibraryBook? {
        val book = this["book"].obj ?: return null
        val bookId = book.longValue("id") ?: longValue("book_id") ?: return null
        val title = book.textValue("title").ifBlank { return null }
        val authors = book["contributions"].arr.orEmpty()
            .mapNotNull { it.obj?.get("author").obj?.textValue("name") }
            .filter { it.isNotBlank() }
        return HardcoverLibraryBook(
            bookId = bookId,
            title = title,
            authors = authors,
            coverUrl = book["cached_image"]?.jsonPrimitive?.contentOrNull?.ifBlank { null },
            rating = book["rating"]?.jsonPrimitive?.doubleOrNull,
            userRating = this["rating"]?.jsonPrimitive?.doubleOrNull,
            statusId = longValue("status_id")?.toInt(),
            tags = emptyList(),
            updatedAtMs = this["updated_at"]?.jsonPrimitive?.contentOrNull
                ?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() },
        )
    }

    private fun JsonObject.imageUrl(): String {
        val image = this["image"] ?: this["cover"] ?: this["image_url"]
        return when (image) {
            is JsonPrimitive -> image.contentOrNull.orEmpty()
            is JsonObject -> image.textValue("url")
            else -> ""
        }
    }

    private fun JsonObject.longValue(key: String): Long? = this[key]?.longOrNullValue()

    private fun JsonObject.textValue(key: String): String = this[key].textValue()

    private fun JsonElement?.asJsonArrayOrNull(): JsonArray = when (this) {
        is JsonArray -> this
        is JsonPrimitive -> runCatching { json.parseToJsonElement(content).jsonArray }.getOrDefault(JsonArray(emptyList()))
        else -> JsonArray(emptyList())
    }

    private fun JsonElement?.textValue(): String = when (this) {
        is JsonPrimitive -> contentOrNull.orEmpty()
        is JsonArray -> joinToString(", ") { it.textValue() }
        is JsonObject -> textValue("name").ifBlank { textValue("title") }
        else -> ""
    }

    private fun JsonElement.longOrNullValue(): Long? {
        val primitive = this as? JsonPrimitive ?: return null
        return primitive.longOrNull ?: primitive.contentOrNull?.toLongOrNull()
    }

    private fun ratingField(rating: Float): String {
        if (rating <= 0f) return ""
        return String.format(Locale.US, ", rating: %.1f", rating.coerceIn(0f, 5f))
    }

    private fun JsonObject.toBookResult(): HardcoverBookResult? {
        val id = longValue("id") ?: return null
        val title = textValue("title").ifBlank { return null }
        return HardcoverBookResult(
            id = id,
            title = title,
            authors = extractAuthors(this),
            genres = extractStringList(this["genres"]),
            tags = extractStringList(this["tags"]),
            moods = extractStringList(this["moods"]),
            coverUrl = extractCoverUrl(this),
            releaseYear = (longValue("release_year") ?: longValue("publication_year"))?.toInt(),
            rating = this["rating"]?.doubleOrNullValue() ?: this["average_rating"]?.doubleOrNullValue(),
            ratingsCount = longValue("ratings_count")?.toInt(),
        )
    }

    private fun HardcoverBookResult.mergeWith(detail: HardcoverBookResult): HardcoverBookResult = copy(
        title = detail.title.ifBlank { title },
        authors = detail.authors.ifEmpty { authors },
        genres = detail.genres.ifEmpty { genres },
        tags = detail.tags.ifEmpty { tags },
        moods = detail.moods.ifEmpty { moods },
        coverUrl = detail.coverUrl ?: coverUrl,
        releaseYear = detail.releaseYear ?: releaseYear,
        rating = detail.rating ?: rating,
        ratingsCount = detail.ratingsCount ?: ratingsCount,
    )

    private fun extractAuthors(record: JsonObject): List<String> {
        val authorNames = when (val v = record["author_names"]) {
            is JsonArray -> v.map { normalizeText(it) }
            is JsonPrimitive -> v.contentOrNull?.split(",")?.map { it.trim() }?.filter(String::isNotEmpty) ?: emptyList()
            else -> emptyList()
        }
        val authors = when (val v = record["authors"]) {
            is JsonArray -> v.mapNotNull { extractAuthorName(it) }
            is JsonPrimitive -> v.contentOrNull?.split(",")?.map { it.trim() }?.filter(String::isNotEmpty) ?: emptyList()
            else -> emptyList()
        }
        val cachedContributors = when (val v = record["cached_contributors"]) {
            is JsonArray -> v.mapNotNull { extractAuthorName(it) }
            is JsonPrimitive -> v.contentOrNull?.split(",")?.map { it.trim() }?.filter(String::isNotEmpty) ?: emptyList()
            else -> emptyList()
        }
        val contributions = record["contributions"].arr
            ?: record["book_authors"].arr
            ?: emptyList()
        val contributionAuthors = contributions.mapNotNull {
            it.obj?.get("author").obj?.textValue("name")
        }
        return (authorNames + authors + cachedContributors + contributionAuthors)
            .filter { it.isNotEmpty() }
            .distinct()
    }

    private fun extractAuthorName(value: JsonElement?): String? {
        val obj = value.obj
        if (obj != null) {
            return obj.textValue("name").ifBlank {
                obj["author"].obj?.textValue("name").orEmpty()
            }.takeIf { it.isNotEmpty() }
        }
        return value?.textValue()?.takeIf { it.isNotEmpty() }
    }

    private fun extractStringList(value: JsonElement?, depth: Int = 0): List<String> {
        if (depth > 3 || value == null) return emptyList()
        val text = normalizeText(value)
        if (text.isNotEmpty()) {
            if (text.trimStart().startsWith("[")) {
                val parsed = runCatching { json.parseToJsonElement(text) }.getOrNull()
                if (parsed != null) return extractStringList(parsed, depth + 1)
            }
            return text.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        }
        if (value is JsonArray) {
            return value.flatMap { extractStringList(it, depth + 1) }.distinct()
        }
        if (value is JsonObject) {
            return extractStringList(
                value["name"] ?: value["tag"] ?: value["title"] ?: value["genre"] ?: value["mood"] ?: value["label"],
                depth + 1,
            )
        }
        return emptyList()
    }

    private fun extractCoverUrl(record: JsonObject): String? {
        return extractImageUrl(record["cached_image_url"])
            ?: extractImageUrl(record["image_url"])
            ?: extractImageUrl(record["cover_url"])
            ?: extractImageUrl(record["cached_image"])
            ?: extractImageUrl(record["image"])
            ?: extractImageUrl(record["default_cover_edition"].obj?.get("cached_image"))
            ?: extractImageUrl(record["default_cover_edition"].obj?.get("image"))
            ?: extractImageUrl(record["cover"])
            ?: extractImageUrl(record["assets"])
            // TODO(hardcover-covers): OpenLibrary ISBN cover fallback
    }

    private fun extractImageUrl(value: JsonElement?, depth: Int = 0): String? {
        if (depth > 3 || value == null) return null
        val text = normalizeText(value)
        if (text.isNotEmpty()) {
            if (text.startsWith("http://") || text.startsWith("https://")) return text
            val parsed = runCatching { json.parseToJsonElement(text) }.getOrNull()
            if (parsed != null) return extractImageUrl(parsed, depth + 1)
            return null
        }
        if (value is JsonObject) {
            return extractImageUrl(value["url"] ?: value["src"] ?: value["image"], depth + 1)
        }
        return null
    }

    private fun normalizeText(value: JsonElement?): String = when (value) {
        is JsonPrimitive -> value.contentOrNull?.trim().orEmpty()
        is JsonArray -> value.joinToString(", ") { normalizeText(it) }
        is JsonObject -> normalizeText(value["name"] ?: value["title"])
        else -> ""
    }

    private fun JsonElement?.doubleOrNullValue(): Double? {
        val primitive = this as? JsonPrimitive ?: return null
        return primitive.doubleOrNull ?: primitive.contentOrNull?.toDoubleOrNull()
    }

    private val JsonElement?.obj: JsonObject? get() = this as? JsonObject

    private val JsonElement?.arr: JsonArray? get() = this as? JsonArray

    companion object {
        private const val API_URL = "https://api.hardcover.app/v1/graphql"
        private const val SEARCH_PAGE_SIZE = 20

        private const val CURRENT_USER_QUERY = """
            query CurrentUser {
              me(limit: 1) { id username }
            }
        """

        private const val SEARCH_QUERY = """
            query SearchBooks(${'$'}query: String!, ${'$'}queryType: String!, ${'$'}page: Int!, ${'$'}perPage: Int!) {
              search(
                query: ${'$'}query,
                query_type: ${'$'}queryType,
                page: ${'$'}page,
                per_page: ${'$'}perPage,
                fields: "title,description,slug,image,author_names,release_date,release_year,pages"
              ) { ids results }
            }
        """

        private const val RECOMMENDATION_SEARCH_QUERY = """
            query RecommendationSearch(${'$'}query: String!, ${'$'}limit: Int!, ${'$'}page: Int!, ${'$'}fields: String, ${'$'}weights: String, ${'$'}sort: String) {
              search(
                query: ${'$'}query,
                query_type: "Book",
                per_page: ${'$'}limit,
                page: ${'$'}page,
                fields: ${'$'}fields,
                weights: ${'$'}weights,
                sort: ${'$'}sort
              ) {
                results
              }
            }
        """

        private const val BOOK_DETAILS_QUERY = """
            query BookDetails(${'$'}ids: [Int!]!) {
              books(where: { id: { _in: ${'$'}ids } }) {
                id
                title
                subtitle
                slug
                cached_image
                description
                release_year
                rating
                ratings_count
                book_status_id
                book_status { name }
                contributions {
                  author { name }
                }
              }
            }
        """

        private const val FIND_USER_BOOK_QUERY = """
            query FindUserBook(${'$'}bookId: Int!) {
              me(limit: 1) {
                user_books(limit: 1, where: { book_id: { _eq: ${'$'}bookId } }) {
                  id book_id status_id rating
                  book { pages }
                  edition { pages }
                  user_book_reads(limit: 1, order_by: { id: desc }) {
                    progress_pages
                  }
                }
              }
            }
        """

        private const val GET_USER_BOOK_QUERY = """
            query GetUserBook(${'$'}userBookId: Int!) {
              user_books_by_pk(id: ${'$'}userBookId) {
                id book_id status_id rating
                book { pages }
                edition { pages }
                user_book_reads(limit: 1, order_by: { id: desc }) {
                  progress_pages
                }
              }
            }
        """

        private const val ADD_USER_BOOK_QUERY = """
            mutation AddUserBook(${'$'}bookId: Int!, ${'$'}statusId: Int!) {
              insert_user_book(object: { book_id: ${'$'}bookId, status_id: ${'$'}statusId__RATING__ }) {
                id error
                user_book {
                  id book_id status_id rating
                  book { pages }
                  edition { pages }
                }
              }
            }
        """

        private const val UPDATE_USER_BOOK_QUERY = """
            mutation UpdateUserBook(${'$'}userBookId: Int!, ${'$'}statusId: Int!) {
              update_user_book(id: ${'$'}userBookId, object: { status_id: ${'$'}statusId__RATING__ }) {
                id error
                user_book {
                  id book_id status_id rating
                  book { pages }
                  edition { pages }
                }
              }
            }
        """

        private const val UPDATE_PROGRESS_QUERY = """
            mutation UpdateProgress(${'$'}userBookId: Int!, ${'$'}progressPages: Int!) {
              upsert_user_book_reads(
                user_book_id: ${'$'}userBookId,
                datesRead: [{ progress_pages: ${'$'}progressPages }]
              ) { error user_book_id }
            }
        """

        private const val DELETE_USER_BOOK_QUERY = """
            mutation DeleteUserBook(${'$'}userBookId: Int!) {
              delete_user_book(id: ${'$'}userBookId) { id user_id book_id }
            }
        """

        private const val USER_BOOKS_QUERY = """
            query UserBooks(${'$'}userId: Int!) {
              user_books(
                where: { user_id: { _eq: ${'$'}userId } }
                distinct_on: book_id
                limit: 250
                order_by: [{ book_id: asc }, { updated_at: desc }]
              ) {
                id
                book_id
                status_id
                rating
                updated_at
                user_book_status { status }
                book {
                  id
                  title
                  slug
                  cached_image
                  rating
                  ratings_count
                  book_status_id
                  book_status { name }
                  contributions { author { name } }
                }
              }
            }
        """

        fun bookUrl(bookId: Long, slug: String): String =
            "https://hardcover.app/books/${slug.ifBlank { bookId.toString() }}#$bookId"

        fun bookIdFromUrl(url: String): Long? {
            val fragment = url.substringAfter('#', "")
            if (fragment.toLongOrNull() != null) return fragment.toLong()
            if (url.startsWith("https://hardcover.app/")) {
                Regex("/books/(?:[^/#]+/)?(\\d+)(?:[/?#]|$)").find(url)?.groupValues?.get(1)?.toLongOrNull()?.let {
                    return it
                }
            }
            return Regex("^hardcover:(\\d+)$").find(url)?.groupValues?.get(1)?.toLongOrNull()
        }
    }
}

internal data class HardcoverUser(val id: Long, val username: String)

internal data class HardcoverUserBook(
    val id: Long,
    val bookId: Long,
    val statusId: Int,
    val rating: Float,
    val pages: Long?,
    val progressPages: Int?,
)

data class HardcoverLibraryBook(
    val bookId: Long,
    val title: String,
    val authors: List<String>,
    val coverUrl: String?,
    val rating: Double?,
    val userRating: Double?,
    val statusId: Int?,
    val tags: List<String>,
    val updatedAtMs: Long?,
)

/**
 * A Hardcover search/detail result for recommendations (desktop `HardcoverBookSearchResult`),
 * keeping only the fields the recommendation adapters read.
 */
data class HardcoverBookResult(
    val id: Long,
    val title: String,
    val authors: List<String>,
    val genres: List<String>,
    val tags: List<String>,
    val moods: List<String>,
    val coverUrl: String?,
    val releaseYear: Int?,
    val rating: Double?,
    val ratingsCount: Int?,
)
