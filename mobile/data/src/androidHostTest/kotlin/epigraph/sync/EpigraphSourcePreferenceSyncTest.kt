package epigraph.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.SourcePreferenceRules
import epigraph.contract.SourcePreferenceValue
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncScopeId
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class EpigraphSourcePreferenceSyncTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val database = Database(
        driver,
        chaptersAdapter = tachiyomi.data.Chapters.Adapter(yokai.data.memoColumnAdapter),
        mangasAdapter = tachiyomi.data.Mangas.Adapter(yokai.data.memoColumnAdapter),
    )
    private val coordinator = EpigraphMutationCoordinator(
        AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO),
    )
    private val json = Json {
        classDiscriminator = "operation"
        ignoreUnknownKeys = false
    }
    private val store = FakeStore()
    private val mirrorId = SourcePreferenceRules.entityIdFor(SOURCE, MIRROR)

    @AfterEach
    fun closeDriver() {
        driver.close()
    }

    @Test
    fun `a setting chosen before pairing is sent once`() = runTest {
        store.mirror = SourcePreferenceValue.Text("1")

        val first = sync().reconcile(100)
        assertEquals(SourcePreferenceSyncResult(emitted = 1, applied = 0, agreed = 0), first)
        val queued = coordinator.claimReady(100, 1_000, 10).single()
        assertEquals(SourcePreferenceRules.ENTITY_TYPE, queued.entity_type)
        assertEquals(mirrorId, queued.entity_id)
        val command = json.decodeFromString<SyncCommandEnvelope>(queued.payload_json).command
        command as SyncCommand.SetSourcePreference
        assertEquals(SourcePreferenceValue.Text("1"), command.typedValue)

        clearOutbox()
        // Not sent again while the Core has not stored it.
        assertEquals(SourcePreferenceSyncResult(0, 0, 0), sync().reconcile(200))
        // Once stored, it is recorded as agreed.
        coreRecord(version = 4, value = "\"1\"")
        assertEquals(SourcePreferenceSyncResult(0, 0, 1), sync().reconcile(300))
        assertEquals(SourcePreferenceSyncResult(0, 0, 0), sync().reconcile(400))
    }

    @Test
    fun `a desktop change is applied here and never sent back`() = runTest {
        store.mirror = SourcePreferenceValue.Text("0")
        coreRecord(version = 4, value = "\"0\"")
        sync().reconcile(100)

        coreRecord(version = 7, value = "\"1\"")
        val result = sync().reconcile(200)

        assertEquals(SourcePreferenceSyncResult(emitted = 0, applied = 1, agreed = 0), result)
        assertEquals(SourcePreferenceValue.Text("1"), store.mirror)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
        assertEquals(SourcePreferenceSyncResult(0, 0, 0), sync().reconcile(300))
    }

    @Test
    fun `a local change after agreeing is sent`() = runTest {
        store.mirror = SourcePreferenceValue.Text("0")
        coreRecord(version = 4, value = "\"0\"")
        sync().reconcile(100)

        store.mirror = SourcePreferenceValue.Text("2")
        assertEquals(SourcePreferenceSyncResult(1, 0, 0), sync().reconcile(200))
        val command = json.decodeFromString<SyncCommandEnvelope>(
            coordinator.claimReady(200, 1_000, 10).single().payload_json,
        ).command as SyncCommand.SetSourcePreference
        assertEquals(SourcePreferenceValue.Text("2"), command.typedValue)
    }

    @Test
    fun `a pending local change is not overwritten by the older Core value`() = runTest {
        store.mirror = SourcePreferenceValue.Text("0")
        coreRecord(version = 4, value = "\"0\"")
        sync().reconcile(100)
        store.mirror = SourcePreferenceValue.Text("2")
        sync().reconcile(200)

        assertEquals(SourcePreferenceSyncResult(0, 0, 0), sync().reconcile(300))
        assertEquals(SourcePreferenceValue.Text("2"), store.mirror)
    }

    @Test
    fun `a value the installed extension does not offer is kept out`() = runTest {
        store.mirror = SourcePreferenceValue.Text("0")
        coreRecord(version = 4, value = "\"9\"")

        val result = sync().reconcile(100)

        assertEquals(SourcePreferenceSyncResult(0, 0, 1), result)
        assertEquals(SourcePreferenceValue.Text("0"), store.mirror)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `secret keys and unpaired or unsupported Cores send nothing`() = runTest {
        store.extra = OfferedSourcePreference("password", "string", null, SourcePreferenceValue.Text("hunter2"))
        store.mirror = null
        assertEquals(SourcePreferenceSyncResult(0, 0, 0), sync().reconcile(100))

        store.mirror = SourcePreferenceValue.Text("1")
        assertEquals(SourcePreferenceSyncResult(0, 0, 0), sync(gate = TrackingSyncGate { false }).reconcile(100))
        assertEquals(
            SourcePreferenceSyncResult(0, 0, 0),
            sync(scopeProvider = EpigraphSyncScopeProvider { error("not paired") }).reconcile(100),
        )
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `decisions follow the agreed value and Core version`() {
        val agreed = SourcePreferenceAgreement("a", 4)
        assertEquals(
            SourcePreferenceDecision.Emit(SourcePreferenceAgreement("a", 0)),
            decideSourcePreference("a", null, null, null, coreAccepted = false),
        )
        assertEquals(SourcePreferenceDecision.Keep, decideSourcePreference(null, null, null, null, false))
        assertEquals(SourcePreferenceDecision.Keep, decideSourcePreference("a", "a", 4, agreed, true))
        assertEquals(
            SourcePreferenceDecision.Agree(SourcePreferenceAgreement("a", 5)),
            decideSourcePreference("a", "a", 5, agreed, true),
        )
        // First comparison: the Core wins.
        assertEquals(
            SourcePreferenceDecision.ApplyCore(SourcePreferenceAgreement("b", 4)),
            decideSourcePreference("a", "b", 4, null, true),
        )
        // The desktop changed it since: newest wins.
        assertEquals(
            SourcePreferenceDecision.ApplyCore(SourcePreferenceAgreement("b", 5)),
            decideSourcePreference("a", "b", 5, agreed, true),
        )
        // Changed here since the agreement: sent.
        assertEquals(
            SourcePreferenceDecision.Emit(SourcePreferenceAgreement("c", 4)),
            decideSourcePreference("c", "a", 4, agreed, true),
        )
        // The Core value is not offered here: keep the local one without sending it.
        assertEquals(
            SourcePreferenceDecision.Agree(SourcePreferenceAgreement("a", 5)),
            decideSourcePreference("a", "b", 5, agreed, false),
        )
        assertEquals(SourcePreferenceDecision.Keep, decideSourcePreference(null, "b", 5, null, false))
    }

    private fun sync(
        gate: TrackingSyncGate = TrackingSyncGate { true },
        scopeProvider: EpigraphSyncScopeProvider = EpigraphSyncScopeProvider {
            EpigraphSyncScopes(novels = SyncScopeId("novels:profile:main"), comics = SyncScopeId(SCOPE))
        },
    ) = EpigraphSourcePreferenceSync(
        coordinator = coordinator,
        deviceId = DeviceId("phone"),
        mutationIds = ClientMutationIdFactory { ClientMutationId(UUID.randomUUID().toString()) },
        scopeProvider = scopeProvider,
        gate = gate,
        store = store,
    )

    private fun coreRecord(version: Long, value: String) {
        database.aethon_syncQueries.upsertCoreReplicaRecord(
            scopeId = SCOPE,
            entityType = SourcePreferenceRules.ENTITY_TYPE,
            entityId = mirrorId,
            serverVersion = version,
            lamport = version,
            recordJson = """{"preferenceId":"$mirrorId","sourceId":"$SOURCE","key":"$MIRROR",""" +
                """"valueType":"string","value":$value,"updatedAtMs":1,"newerField":true}""",
            payloadSha256 = "0".repeat(64),
        )
    }

    private fun clearOutbox() {
        driver.execute(null, "DELETE FROM aethon_sync_outbox", 0)
    }

    private class FakeStore : SourcePreferenceStore {
        var mirror: SourcePreferenceValue? = null
        var extra: OfferedSourcePreference? = null

        override suspend fun installedSources(): Map<String, List<OfferedSourcePreference>> = mapOf(
            SOURCE to listOfNotNull(
                OfferedSourcePreference(MIRROR, "string", listOf("0", "1", "2"), mirror),
                extra,
            ),
        )

        override suspend fun write(sourceId: String, key: String, value: SourcePreferenceValue): Boolean {
            if (sourceId != SOURCE || key != MIRROR) return false
            mirror = value
            return true
        }
    }

    private companion object {
        const val SCOPE = "comics:profile:main"
        const val SOURCE = "-123456789"
        const val MIRROR = "preferred_mirror"
    }
}
