package epigraph.sync.core.assets
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.session.CoreSessionTransportFactory
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import io.mockk.mockk
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class BookAssetCoordinatorTest {
    @TempDir
    lateinit var directory: File

    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also(Database.Schema::create)
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
    private val coordinator by lazy {
        BookAssetCoordinator(
            database = handler,
            credentials = mockk<CoreCredentialStore>(),
            endpoints = mockk<CoreEndpointResolver>(),
            transports = mockk<CoreSessionTransportFactory>(),
            coverStorageDirectory = File(directory, "covers"),
            maxAssetBytes = 1024,
        )
    }

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `pending publication uploads before becoming available`() = runTest {
        val bytes = "immutable epub".toByteArray()
        val sha256 = sha256(bytes)
        val source = File(directory, "$sha256.epub").apply { writeBytes(bytes) }
        insertPending(sha256, bytes.size.toLong(), source.absolutePath)
        val client = RecordingUploadClient(sha256)

        val report = session().use { credentials ->
            coordinator.drainPendingUploads(client, credentials, nowEpochMillis = 2_000)
        }

        assertEquals(BookAssetDrainReport(1, 1, 0, 0), report)
        assertArrayEquals(bytes, client.uploadedBytes)
        val manifest = database.aethon_syncQueries.selectAssetManifest(sha256).executeAsOne()
        assertEquals("AVAILABLE", manifest.state)
        assertEquals(true, manifest.remote_available)
        assertEquals(source.absolutePath, manifest.local_uri)
    }

    @Test
    fun `network failure keeps publication pending for a later wake`() = runTest {
        val bytes = "retry epub".toByteArray()
        val sha256 = sha256(bytes)
        val source = File(directory, "$sha256.epub").apply { writeBytes(bytes) }
        insertPending(sha256, bytes.size.toLong(), source.absolutePath)

        val report = session().use { credentials ->
            coordinator.drainPendingUploads(FailingClient, credentials, nowEpochMillis = 2_000)
        }

        assertEquals(BookAssetDrainReport(1, 0, 1, 0), report)
        val manifest = database.aethon_syncQueries.selectAssetManifest(sha256).executeAsOne()
        assertEquals("PENDING_UPLOAD", manifest.state)
        assertEquals(false, manifest.remote_available)
    }

    @Test
    fun `missing local publication is blocked without publishing metadata`() = runTest {
        val sha256 = "a".repeat(64)
        insertPending(sha256, 123, File(directory, "missing.epub").absolutePath)

        val report = session().use { credentials ->
            coordinator.drainPendingUploads(RecordingUploadClient(sha256), credentials, nowEpochMillis = 2_000)
        }

        assertEquals(BookAssetDrainReport(1, 0, 0, 1), report)
        val manifest = database.aethon_syncQueries.selectAssetManifest(sha256).executeAsOne()
        assertEquals("ERROR", manifest.state)
        assertEquals(false, manifest.remote_available)
        // A missing local file is a terminal, user-recoverable state. Keeping it in the ready
        // count would wake WorkManager forever without any bytes that could be uploaded.
        assertEquals(0, database.aethon_syncQueries.pendingAssetUploadCount().executeAsOne())
    }

    private fun insertPending(sha256: String, size: Long, localUri: String) {
        database.aethon_syncQueries.insertAssetManifest(
            sha256 = sha256,
            contentType = "EPUB",
            byteSize = size,
            mimeType = "application/epub+zip",
            localUri = localUri,
            remoteAvailable = false,
            state = "PENDING_UPLOAD",
            updatedAt = 1_000,
        )
    }

    private fun session() = CoreCredentialSession(
        origin = "https://127.0.0.1:4777",
        tlsCertSha256 = "b".repeat(64),
        pairingSessionId = "pairing",
        profileId = "main",
        tokenId = "token",
        scopes = listOf("books:global"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        serverId = "server",
        accessTokenUtf8 = "ephemeral-token".toByteArray(),
    )

    private class RecordingUploadClient(
        private val sha256: String,
    ) : CoreAssetHttpClient {
        var uploadedBytes = ByteArray(0)

        override suspend fun execute(
            request: CoreAssetHttpRequest,
            uploadBody: CoreAssetUploadBody?,
        ): CoreAssetHttpResponse = when (request.method) {
            CoreAssetMethod.HEAD -> CoreAssetHttpResponse(404)
            CoreAssetMethod.PUT -> {
                uploadedBytes = requireNotNull(uploadBody).openStream().use { it.readBytes() }
                CoreAssetHttpResponse(
                    statusCode = 201,
                    headers = mapOf(
                        "ETag" to "\"$sha256\"",
                        "X-Aethon-Asset-Sha256" to sha256,
                        "Accept-Ranges" to "bytes",
                    ),
                )
            }
            CoreAssetMethod.GET -> error("Upload test must not issue GET")
        }
    }

    private object FailingClient : CoreAssetHttpClient {
        override suspend fun execute(
            request: CoreAssetHttpRequest,
            uploadBody: CoreAssetUploadBody?,
        ): CoreAssetHttpResponse = throw IOException("offline")
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { "%02x".format(it) }
}
