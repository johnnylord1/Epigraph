package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter

class V4ExtensionInventoryBridgeTest {
    private fun createDb(): Pair<JdbcSqliteDriver, Database> {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        Database.Schema.create(driver)
        val db = Database(
            driver = driver,
            chaptersAdapter = Chapters.Adapter(memoAdapter = memoColumnAdapter),
            mangasAdapter = Mangas.Adapter(memoAdapter = memoColumnAdapter),
        )
        return driver to db
    }

    @Test
    fun `two exports with different clocks give equal digests`() = runTest {
        val (driver, db) = createDb()
        driver.use {
            db.extension_reposQueries.upsert(
                base_url = "https://raw.githubusercontent.com/keiyoushi/extensions/repo",
                name = "Keiyoushi",
                short_name = "Kei",
                website = "https://keiyoushi.github.io",
                fingerprint = "abcdef1234",
            )
            val bridge = V4ExtensionInventoryBridge(
                handler = AndroidDatabaseHandler(db, driver),
                installedExtensionsProvider = {
                    listOf(
                        V4InstalledExtensionDescriptor(
                            kind = "comic",
                            packageId = "eu.kanade.tachiyomi.extension.en.toonily",
                            name = "Toonily",
                            versionName = "1.4.42",
                            versionCode = 42,
                            lang = "en",
                            signatureHash = "sig1",
                        ),
                    )
                },
            )

            val digestsBefore = bridge.digestSnapshot("srv", "main")
            val early = bridge.exportLocalSnapshot("srv", "main", V4HlcClock("phone-1", wallClockMs = { 100L }))
            val late = bridge.exportLocalSnapshot("srv", "main", V4HlcClock("phone-1", wallClockMs = { 9_000_000L }))

            assertTrue(digestsBefore.isNotEmpty())
            assertTrue(early.map { it.hlc } != late.map { it.hlc }, "Test clocks must actually differ")
            assertEquals(early.map { it.payload }, late.map { it.payload })
            assertEquals(digestsBefore, bridge.digestSnapshot("srv", "main"))
        }
    }

    @Test
    fun `round-trips comic repos, novel repos, and installed extension descriptors without network`() = runTest {
        val (srcDriver, srcDb) = createDb()
        val (dstDriver, dstDb) = createDb()
        srcDriver.use {
            dstDriver.use {
                srcDb.extension_reposQueries.upsert(
                    base_url = "https://raw.githubusercontent.com/keiyoushi/extensions/repo",
                    name = "Keiyoushi",
                    short_name = "Kei",
                    website = "https://keiyoushi.github.io",
                    fingerprint = "abcdef1234",
                )
                srcDb.novel_reposQueries.insert(
                    "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
                    "LNReader Official",
                )

                val srcBridge = V4ExtensionInventoryBridge(
                    handler = AndroidDatabaseHandler(srcDb, srcDriver),
                    installedExtensionsProvider = {
                        listOf(
                            V4InstalledExtensionDescriptor(
                                kind = "comic",
                                packageId = "eu.kanade.tachiyomi.extension.en.toonily",
                                name = "Toonily",
                                versionName = "1.4.42",
                                versionCode = 42,
                                lang = "en",
                                signatureHash = "sig1",
                            ),
                            V4InstalledExtensionDescriptor(
                                kind = "novel",
                                packageId = "novelfull",
                                name = "NovelFull",
                                versionName = "1.0.5",
                                lang = "en",
                            ),
                        )
                    },
                )

                val clock = V4HlcClock("phone-1", wallClockMs = { 10_000L })
                val exported = srcBridge.exportLocalSnapshot("srv", "main", clock)
                assertEquals(4, exported.size)

                val wire = exported.mapIndexed { idx, item ->
                    V4WireRecord(
                        serverSeq = idx + 1L,
                        domain = item.domain,
                        entityType = item.entityType,
                        entityKey = item.entityKey,
                        deleted = item.deleted,
                        hlc = item.hlc,
                        originDeviceId = "phone-1",
                        payload = item.payload,
                        updatedAtMs = 10_000L,
                    )
                }

                val dstBridge = V4ExtensionInventoryBridge(AndroidDatabaseHandler(dstDb, dstDriver))
                dstBridge.applyRemoteRecords("srv", "main", wire)

                val comicRepos = dstDb.extension_reposQueries.findAll().executeAsList()
                val novelRepos = dstDb.novel_reposQueries.findAll().executeAsList()
                assertEquals(1, comicRepos.size)
                assertEquals("Keiyoushi", comicRepos.first().name)
                assertEquals("abcdef1234", comicRepos.first().signing_key_fingerprint)
                assertEquals(1, novelRepos.size)
                assertEquals("LNReader Official", novelRepos.first().name)

                // Delete tombstone removes repo cleanly.
                val deleteWire = listOf(
                    V4WireRecord(
                        serverSeq = 10L,
                        domain = V4ExtensionInventoryBridge.DOMAIN,
                        entityType = V4ExtensionInventoryBridge.REPO,
                        entityKey = "novel:https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
                        deleted = true,
                        hlc = V4Hlc(20_000L, 0L, "phone-1"),
                        originDeviceId = "phone-1",
                        updatedAtMs = 20_000L,
                    ),
                )
                dstBridge.applyRemoteRecords("srv", "main", deleteWire)
                assertTrue(dstDb.novel_reposQueries.findAll().executeAsList().isEmpty())
            }
        }
    }
}
