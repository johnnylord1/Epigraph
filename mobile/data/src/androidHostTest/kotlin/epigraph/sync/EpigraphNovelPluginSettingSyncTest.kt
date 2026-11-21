package epigraph.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.NovelPluginSettingRules
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
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

/**
 * The novel plugin kind of [EpigraphSourcePreferenceSync], with the settings WTR-LAB declares:
 * `preferredMode` (Select ai, webplus, web, custom), `fallbackToWeb` (Switch) and its
 * `sessionCookie`, which never travels.
 */
class EpigraphNovelPluginSettingSyncTest {
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
    private val store = FakeWtrLab()
    private val modeId = NovelPluginSettingRules.entityIdFor(PLUGIN, MODE)

    @AfterEach
    fun closeDriver() {
        driver.close()
    }

    @Test
    fun `a chosen translation is sent in the novels scope and the session cookie never is`() = runTest {
        store.mode = SourcePreferenceValue.Text("web")
        store.cookie = SourcePreferenceValue.Text("cf_clearance=abc")

        val first = sync().reconcile(100)
        assertEquals(SourcePreferenceSyncResult(emitted = 1, applied = 0, agreed = 0), first)
        val queued = coordinator.claimReady(100, 1_000, 10).single()
        assertEquals(NovelPluginSettingRules.ENTITY_TYPE, queued.entity_type)
        assertEquals(NOVEL_SCOPE, queued.scope_id)
        assertEquals(modeId, queued.entity_id)
        val command = json.decodeFromString<SyncCommandEnvelope>(queued.payload_json).command
        command as SyncCommand.SetNovelPluginSetting
        assertEquals(PLUGIN, command.pluginId)
        assertEquals(SourcePreferenceValue.Text("web"), command.typedValue)

        clearOutbox()
        coreRecord(version = 3, value = "\"web\"")
        assertEquals(SourcePreferenceSyncResult(0, 0, 1), sync().reconcile(200))
        assertEquals(SourcePreferenceSyncResult(0, 0, 0), sync().reconcile(300))
    }

    @Test
    fun `a desktop choice is applied to the plugin and never sent back`() = runTest {
        store.mode = SourcePreferenceValue.Text("ai")
        coreRecord(version = 4, value = "\"ai\"")
        sync().reconcile(100)

        coreRecord(version = 7, value = "\"webplus\"")
        assertEquals(SourcePreferenceSyncResult(emitted = 0, applied = 1, agreed = 0), sync().reconcile(200))
        assertEquals(SourcePreferenceValue.Text("webplus"), store.mode)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
        assertEquals(SourcePreferenceSyncResult(0, 0, 0), sync().reconcile(300))
    }

    @Test
    fun `a desktop value the plugin does not offer is not applied`() = runTest {
        store.mode = SourcePreferenceValue.Text("ai")
        coreRecord(version = 4, value = "\"ai\"")
        sync().reconcile(100)

        coreRecord(version = 5, value = "\"fast\"")
        sync().reconcile(200)
        assertEquals(SourcePreferenceValue.Text("ai"), store.mode)
    }

    @Test
    fun `nothing is sent while the Core does not advertise plugin settings`() = runTest {
        store.mode = SourcePreferenceValue.Text("web")
        val comicsOnly = TrackingSyncGate { it.value != NovelPluginSettingRules.ENTITY_TYPE }
        assertEquals(SourcePreferenceSyncResult(0, 0, 0), sync(gate = comicsOnly).reconcile(100))
        assertNull(coordinator.claimReady(100, 1_000, 10).firstOrNull())
    }

    private fun sync(
        gate: TrackingSyncGate = TrackingSyncGate { true },
        scopeProvider: EpigraphSyncScopeProvider = EpigraphSyncScopeProvider {
            EpigraphSyncScopes(novels = SyncScopeId(NOVEL_SCOPE), comics = SyncScopeId("comics:profile:main"))
        },
    ) = EpigraphSourcePreferenceSync(
        coordinator = coordinator,
        deviceId = DeviceId("phone"),
        mutationIds = ClientMutationIdFactory { ClientMutationId(UUID.randomUUID().toString()) },
        scopeProvider = scopeProvider,
        gate = gate,
        store = store,
        kind = SourcePreferenceKind.NovelPlugin,
    )

    private fun coreRecord(version: Long, value: String) {
        database.aethon_syncQueries.upsertCoreReplicaRecord(
            scopeId = NOVEL_SCOPE,
            entityType = NovelPluginSettingRules.ENTITY_TYPE,
            entityId = modeId,
            serverVersion = version,
            lamport = version,
            recordJson = """{"settingId":"$modeId","pluginId":"$PLUGIN","key":"$MODE",""" +
                """"valueType":"string","value":$value,"updatedAtMs":1}""",
            payloadSha256 = "0".repeat(64),
        )
    }

    private fun clearOutbox() {
        driver.execute(null, "DELETE FROM aethon_sync_outbox", 0)
    }

    private class FakeWtrLab : SourcePreferenceStore {
        var mode: SourcePreferenceValue? = null
        var cookie: SourcePreferenceValue? = null

        override suspend fun installedSources(): Map<String, List<OfferedSourcePreference>> = mapOf(
            PLUGIN to listOf(
                OfferedSourcePreference(MODE, "string", listOf("ai", "webplus", "web", "custom"), mode),
                OfferedSourcePreference("fallbackToWeb", "boolean", null, null),
                OfferedSourcePreference("sessionCookie", "string", null, cookie),
            ),
        )

        override suspend fun write(sourceId: String, key: String, value: SourcePreferenceValue): Boolean {
            if (sourceId != PLUGIN || key != MODE) return false
            mode = value
            return true
        }
    }

    private companion object {
        const val NOVEL_SCOPE = "novels:profile:main"
        const val PLUGIN = "wtrlab"
        const val MODE = "preferredMode"
    }
}
