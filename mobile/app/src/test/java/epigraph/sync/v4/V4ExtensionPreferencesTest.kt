package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.SourcePreferenceValue
import epigraph.sync.OfferedSourcePreference
import epigraph.sync.SourcePreferenceStore
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter

class V4ExtensionPreferencesTest {
    private class FixedStore(private val offered: Map<String, List<OfferedSourcePreference>>) : SourcePreferenceStore {
        override suspend fun installedSources() = offered
        override suspend fun write(sourceId: String, key: String, value: SourcePreferenceValue) = false
    }

    @Test
    fun `two exports with different clocks give equal digests`() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            Database.Schema.create(driver)
            val db = Database(
                driver = driver,
                chaptersAdapter = Chapters.Adapter(memoAdapter = memoColumnAdapter),
                mangasAdapter = Mangas.Adapter(memoAdapter = memoColumnAdapter),
            )
            val comic = FixedStore(
                mapOf(
                    "123456" to listOf(
                        OfferedSourcePreference(
                            key = "orientation",
                            valueType = SourcePreferenceValue.Text("").valueType,
                            entryValues = listOf("ltr", "rtl"),
                            current = SourcePreferenceValue.Text("rtl"),
                        ),
                    ),
                ),
            )
            val novel = FixedStore(
                mapOf(
                    "novel-plugin" to listOf(
                        OfferedSourcePreference(
                            key = "fontSize",
                            valueType = SourcePreferenceValue.Flag(false).valueType,
                            entryValues = null,
                            current = SourcePreferenceValue.Flag(true),
                        ),
                    ),
                ),
            )
            val bridge = V4ExtensionPreferences(AndroidDatabaseHandler(db, driver), comic, novel)

            val digestsBefore = bridge.digestSnapshot("srv", "main")
            val early = bridge.exportLocalSnapshot("srv", "main", V4HlcClock("phone-1", wallClockMs = { 100L }))
            val late = bridge.exportLocalSnapshot("srv", "main", V4HlcClock("phone-1", wallClockMs = { 9_000_000L }))

            assertTrue(digestsBefore.isNotEmpty())
            assertTrue(early.map { it.hlc } != late.map { it.hlc }, "Test clocks must actually differ")
            assertEquals(early.map { it.payload }, late.map { it.payload })
            assertEquals(digestsBefore, bridge.digestSnapshot("srv", "main"))
        }
    }
}
