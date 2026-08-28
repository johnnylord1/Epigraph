package epigraph.sync.core.work

import yokai.data.DatabaseHandler

interface CoreSyncWakeStore {
    suspend fun nextAttemptAt(): Long?
}

class SqlDelightCoreSyncWakeStore(
    private val database: DatabaseHandler,
) : CoreSyncWakeStore {
    override suspend fun nextAttemptAt(): Long? = database.await(inTransaction = false) {
        listOfNotNull(
            aethon_syncQueries.nextMutationAttemptAt().executeAsOne().MIN,
            aethon_suwayomi_mutation_queueQueries.nextAttemptAt().executeAsOne().MIN,
        ).minOrNull()
    }
}
