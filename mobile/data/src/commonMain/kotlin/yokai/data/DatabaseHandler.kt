package yokai.data

import app.cash.paging.PagingSource
import app.cash.sqldelight.ExecutableQuery
import app.cash.sqldelight.Query
import app.cash.sqldelight.db.SqlDriver
import kotlinx.coroutines.flow.Flow

interface DatabaseHandler {
    /**
     * The driver behind [await], for a statement SQLDelight cannot generate, such as a multi-row
     * VALUES list. Use it only inside [await], so the statement runs on that call's connection
     * and transaction.
     */
    val driver: SqlDriver

    suspend fun <T> await(inTransaction: Boolean = false, block: suspend Database.() -> T): T

    suspend fun <T : Any> awaitList(
        inTransaction: Boolean = false,
        block: suspend Database.() -> Query<T>
    ): List<T>

    suspend fun <T : Any> awaitOne(
        inTransaction: Boolean = false,
        block: suspend Database.() -> Query<T>
    ): T

    suspend fun <T : Any> awaitOneExecutable(
        inTransaction: Boolean = false,
        block: suspend Database.() -> ExecutableQuery<T>,
    ): T

    suspend fun <T : Any> awaitOneOrNull(
        inTransaction: Boolean = false,
        block: suspend Database.() -> Query<T>
    ): T?

    suspend fun <T : Any> awaitFirstOrNull(
        inTransaction: Boolean = false,
        block: suspend Database.() -> Query<T>
    ): T?

    suspend fun <T : Any> awaitOneOrNullExecutable(
        inTransaction: Boolean = false,
        block: suspend Database.() -> ExecutableQuery<T>,
    ): T?

    fun <T : Any> subscribeToList(block: Database.() -> Query<T>): Flow<List<T>>

    /**
     * Like [subscribeToList], but while its tables keep changing the query runs at most once per
     * [periodMillis], always for the newest state. For large queries that a bulk write, such as a
     * restore or a sync, would otherwise run again for every row it writes.
     */
    fun <T : Any> subscribeToListThrottled(periodMillis: Long, block: Database.() -> Query<T>): Flow<List<T>>

    fun <T : Any> subscribeToOne(block: Database.() -> Query<T>): Flow<T>

    fun <T : Any> subscribeToOneOrNull(block: Database.() -> Query<T>): Flow<T?>

    fun <T : Any> subscribeToFirstOrNull(block: Database.() -> Query<T>): Flow<T?>

    fun <T : Any> subscribeToPagingSource(
        countQuery: Database.() -> Query<Long>,
        queryProvider: Database.(Long, Long) -> Query<T>
    ): PagingSource<Int, T>
}
