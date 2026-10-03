package yokai.data

import app.cash.sqldelight.ColumnAdapter
import eu.kanade.tachiyomi.source.model.UpdateStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.util.*

// TODO: Move to yokai.data.DatabaseAdapter

val updateStrategyAdapter = object : ColumnAdapter<UpdateStrategy, Long> {
    private val enumValues by lazy { UpdateStrategy.entries }

    override fun decode(databaseValue: Long): UpdateStrategy =
        enumValues.getOrElse(databaseValue.toInt()) { UpdateStrategy.ALWAYS_UPDATE }

    override fun encode(value: UpdateStrategy): Long = value.ordinal.toLong()
}

val dateAdapter = object : ColumnAdapter<Date, Long> {
    override fun decode(databaseValue: Long): Date = Date(databaseValue)
    override fun encode(value: Date): Long = value.time
}

private const val listOfStringsSeparator = ", "
val listOfStringsAdapter = object : ColumnAdapter<List<String>, String> {
    override fun decode(databaseValue: String) =
        if (databaseValue.isEmpty()) {
            listOf()
        } else {
            databaseValue.split(listOfStringsSeparator)
        }
    override fun encode(value: List<String>) = value.joinToString(separator = listOfStringsSeparator)
}

// Mirrors mihon's MemoColumnAdapter: lib 1.6 extensions store opaque JSON payloads in
// mangas/chapters memo (e.g. the mangaSlug needed to resolve page URLs).
val memoColumnAdapter = object : ColumnAdapter<JsonObject, ByteArray> {
    override fun decode(databaseValue: ByteArray): JsonObject =
        Json.decodeFromString<JsonObject>(databaseValue.decodeToString())

    override fun encode(value: JsonObject): ByteArray = value.toString().encodeToByteArray()
}
