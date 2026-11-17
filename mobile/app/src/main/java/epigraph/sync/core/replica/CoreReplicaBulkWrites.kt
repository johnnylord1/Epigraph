package epigraph.sync.core.replica

import app.cash.sqldelight.db.SqlDriver

/**
 * Multi-row forms of the mirror's per-row writes, with the same conflict rules as
 * `upsertCoreReplicaRecord` and `insertCoreReplicaInboxEvent`. SQLDelight generates one
 * statement per row, and a first sync confirms thousands of records in a row: each statement
 * costs its own prepare and step while every other write waits on the transaction.
 */
internal object CoreReplicaBulkWrites {
    class RecordRow(
        val key: CoreReplicaKey,
        val serverVersion: Long,
        val lamport: Long,
        val recordJson: String,
        val payloadSha256: String,
    )

    class InboxRow(
        val event: CoreReplicaInboxEvent,
        val payloadSha256: String,
        val appliedAt: Long,
    )

    /** Rows in the same list keep their order, so a later row for the same key wins as before. */
    fun upsertRecords(driver: SqlDriver, rows: List<RecordRow>) {
        if (rows.isEmpty()) return
        rows.chunked(ROWS_PER_STATEMENT).forEach { chunk ->
            val sql = buildString {
                append("INSERT INTO aethon_core_replica_record(")
                append("scope_id, entity_type, entity_id, server_version, lamport, record_json, payload_sha256")
                append(") VALUES ")
                values(chunk.size, RECORD_COLUMNS)
                append(" ON CONFLICT(scope_id, entity_type, entity_id) DO UPDATE SET ")
                append("server_version = excluded.server_version, lamport = excluded.lamport, ")
                append("record_json = excluded.record_json, payload_sha256 = excluded.payload_sha256 ")
                append("WHERE excluded.server_version >= aethon_core_replica_record.server_version")
            }
            driver.execute(null, sql, chunk.size * RECORD_COLUMNS) {
                chunk.forEachIndexed { index, row ->
                    val at = index * RECORD_COLUMNS
                    bindString(at, row.key.scopeId)
                    bindString(at + 1, row.key.entityType)
                    bindString(at + 2, row.key.entityId)
                    bindLong(at + 3, row.serverVersion)
                    bindLong(at + 4, row.lamport)
                    bindString(at + 5, row.recordJson)
                    bindString(at + 6, row.payloadSha256)
                }
            }
        }
        driver.notifyListeners("aethon_core_replica_record")
    }

    fun insertInboxEvents(driver: SqlDriver, rows: List<InboxRow>) {
        if (rows.isEmpty()) return
        rows.chunked(ROWS_PER_STATEMENT).forEach { chunk ->
            val sql = buildString {
                append("INSERT INTO aethon_core_replica_inbox(")
                append("global_event_id, scope_id, entity_type, entity_id, operation, payload_sha256, applied_at")
                append(") VALUES ")
                values(chunk.size, INBOX_COLUMNS)
            }
            driver.execute(null, sql, chunk.size * INBOX_COLUMNS) {
                chunk.forEachIndexed { index, row ->
                    val at = index * INBOX_COLUMNS
                    bindLong(at, row.event.globalEventId)
                    bindString(at + 1, row.event.scopeId)
                    bindString(at + 2, row.event.entityType)
                    bindString(at + 3, row.event.entityId)
                    bindString(at + 4, row.event.operation)
                    bindString(at + 5, row.payloadSha256)
                    bindLong(at + 6, row.appliedAt)
                }
            }
        }
        driver.notifyListeners("aethon_core_replica_inbox")
    }

    private fun StringBuilder.values(rows: Int, columns: Int) {
        val tuple = (1..columns).joinToString(",", "(", ")") { "?" }
        repeat(rows) { index ->
            if (index > 0) append(',')
            append(tuple)
        }
    }

    // 100 rows of 7 columns stay under SQLite's historical limit of 999 bound parameters.
    private const val ROWS_PER_STATEMENT = 100
    private const val RECORD_COLUMNS = 7
    private const val INBOX_COLUMNS = 7
}
