package epigraph.ui.moment

import android.content.Context
import eu.kanade.tachiyomi.R
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import yokai.i18n.MR
import yokai.util.lang.getString

/**
 * Completions from background work that earn a moment (DESIGN.md §9) when the app is on screen.
 * Nothing is replayed: with no collector (app in the background) the event is dropped and the
 * system notification alone reports it.
 */
object MomentEvents {
    sealed interface Event {
        /** A manual backup was written; [entries] library entries went into it. */
        data class BackupDone(val entries: Int) : Event

        /** A restore finished without errors; [entries] library entries came back. */
        data class RestoreDone(val entries: Int) : Event
    }

    private val events = MutableSharedFlow<Event>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val flow: SharedFlow<Event> = events.asSharedFlow()

    fun post(event: Event) {
        events.tryEmit(event)
    }

    fun spec(context: Context, event: Event): MomentSpec = when (event) {
        is Event.BackupDone -> MomentSpec(
            icon = R.drawable.ic_backup_restore_24dp,
            title = context.getString(MR.strings.moment_backup_done),
            count = event.entries,
            detail = context.getString(MR.strings.moment_entries),
        )
        is Event.RestoreDone -> MomentSpec(
            icon = R.drawable.ic_done_all_24dp,
            title = context.getString(MR.strings.moment_restore_done),
            count = event.entries,
            detail = context.getString(MR.strings.moment_entries),
        )
    }
}
