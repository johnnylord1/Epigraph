package exh.util

import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.transform
import kotlin.coroutines.coroutineContext

fun <T> Flow<T>.cancellable() = onEach {
    coroutineContext.ensureActive()
}

/**
 * Emits the first value at once, then at most one value per [periodMillis], always the latest.
 * A sync writes the database many times a second; a screen only needs its newest state.
 */
fun <T> Flow<T>.throttleLatest(periodMillis: Long): Flow<T> = conflate().transform {
    emit(it)
    delay(periodMillis)
}
