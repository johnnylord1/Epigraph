package epigraph.sync.core.pairing

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import epigraph.sync.core.policy.DeviceSyncSelectionStore
import epigraph.sync.core.session.CoreSessionEnder
import epigraph.sync.core.work.InMemoryCoreSyncPause
import io.mockk.Runs
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.confirmVerified
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.verify
import io.mockk.verifyOrder
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EpigraphCorePairingControllerTest {
    @Test
    fun `disconnect removes only the session and does not schedule destructive reconciliation`() = runTest {
        val credentials = mockk<CoreCredentialStore>()
        val scheduler = mockk<CoreBackgroundSyncScheduler>()
        every { credentials.load() } returns null
        every { credentials.delete() } just Runs
        val controller = EpigraphCorePairingController(
            activation = mockk(),
            credentials = credentials,
            deviceProvider = mockk(),
            syncScheduler = scheduler,
            selections = mockk<DeviceSyncSelectionStore>(),
            endpoints = mockk(),
            ioDispatcher = StandardTestDispatcher(testScheduler),
        )

        controller.disconnect()

        assertSame(CorePairingUiState.Unpaired, controller.state.value)
        verify(exactly = 1) { credentials.load() }
        verify(exactly = 1) { credentials.delete() }
        confirmVerified(credentials, scheduler)
    }

    @Test
    fun `forgetting tells the desktop first and still forgets when the desktop cannot be reached`() = runTest {
        val credentials = mockk<CoreCredentialStore>()
        val session = mockk<CoreCredentialSession>(relaxed = true)
        val ender = mockk<CoreSessionEnder>()
        every { credentials.load() } returns session
        every { credentials.delete() } just Runs
        val pause = InMemoryCoreSyncPause(paused = true)
        fun controller() = EpigraphCorePairingController(
            activation = mockk(),
            credentials = credentials,
            deviceProvider = mockk(),
            syncScheduler = mockk(),
            selections = mockk<DeviceSyncSelectionStore>(),
            endpoints = mockk(),
            ioDispatcher = StandardTestDispatcher(testScheduler),
            sessionEnder = ender,
            syncPause = pause,
        )

        coEvery { ender.endSession(session) } just Runs
        controller().disconnect()

        verifyOrder {
            credentials.load()
            session.close()
            credentials.delete()
        }
        coVerify(exactly = 1) { ender.endSession(session) }
        // A later pairing starts connected, not still disconnected from before.
        assertFalse(pause.paused.value)

        coEvery { ender.endSession(session) } throws IllegalStateException("desktop unreachable")
        val unreachable = controller()
        unreachable.disconnect()

        assertSame(CorePairingUiState.Unpaired, unreachable.state.value)
        verify(exactly = 2) { credentials.delete() }
    }

    @Test
    fun `disconnecting sync keeps the pairing and reconnecting asks for a sync`() = runTest {
        val credentials = mockk<CoreCredentialStore>()
        val scheduler = mockk<CoreBackgroundSyncScheduler>()
        every { scheduler.enqueue(any()) } just Runs
        val pause = InMemoryCoreSyncPause()
        val controller = EpigraphCorePairingController(
            activation = mockk(),
            credentials = credentials,
            deviceProvider = mockk(),
            syncScheduler = scheduler,
            selections = mockk<DeviceSyncSelectionStore>(),
            endpoints = mockk(),
            ioDispatcher = StandardTestDispatcher(testScheduler),
            syncPause = pause,
        )

        controller.setSyncPaused(true)
        advanceUntilIdle()
        assertTrue(controller.syncPaused.value)
        verify(exactly = 0) { scheduler.enqueue(any()) }

        controller.setSyncPaused(false)
        advanceUntilIdle()
        assertFalse(controller.syncPaused.value)
        verify(exactly = 1) { scheduler.enqueue(CoreBackgroundSyncReason.OUTBOX_PENDING) }
        confirmVerified(credentials)
    }

    @Test
    fun `PIN pairing shows the host verification code and maps desktop failures`() = runTest {
        val fingerprint = "a".repeat(64)
        val host = DiscoveredCoreHost(
            instanceName = "epigraph-syncd-a",
            serverId = "server-a",
            tlsCertSha256 = fingerprint,
            origins = listOf("https://192.168.1.20:4777"),
        )
        val payload = BootstrapPayloadResponse(
            schemaVersion = 2,
            serverId = "server-a",
            pairingSessionId = "bootstrap-019f57b6-1c7b-7862-bc7b-15d17593f9d3",
            pairingCode = "0192A7C4E5F1",
            syncdBaseUrl = "https://192.168.1.20:4777",
            claimUrl = "https://192.168.1.20:4777/v1/pairing/claim",
            profileId = "main",
            expiresAtMs = 99_999,
            tlsCertSha256 = fingerprint,
            mdnsServiceName = "_epigraph-sync._tcp.local.",
            deviceName = "DESKTOP-EPIGRAPH",
        )
        val activation = mockk<EpigraphCorePairingActivation>()
        every { activation.inspectBootstrap(any()) } returns payload.toBundle()
        var pinFailure: PairingErrorCode? = PairingErrorCode.PIN_LOCKED
        fun controller(resolver: PairingPinResolver?) = EpigraphCorePairingController(
            activation = activation,
            credentials = mockk(),
            deviceProvider = mockk(),
            syncScheduler = mockk(),
            selections = mockk(),
            endpoints = mockk(),
            ioDispatcher = StandardTestDispatcher(testScheduler),
            pinResolver = resolver,
        )
        val resolver = PairingPinResolver(
            PairingPinTransport { _, _, _ ->
                pinFailure?.let { throw PairingTransportException(PairingError(it)) }
                payload
            },
        )

        val locked = controller(resolver)
        locked.resolvePinAndPrepare(host, "377299")
        assertEquals(CorePairingUiState.PairingFailed(PairingErrorCode.PIN_LOCKED), locked.state.value)

        pinFailure = null
        val accepted = controller(resolver)
        accepted.resolvePinAndPrepare(host, "377299")
        assertEquals(
            CorePairingUiState.Selecting(
                serverId = "server-a",
                profileId = "main",
                expiresAtMs = 99_999,
                verificationCode = "4341",
                desktopName = "DESKTOP-EPIGRAPH",
            ),
            accepted.state.value,
        )

        val expired = EpigraphCorePairingController(
            activation = activation,
            credentials = mockk { every { load() } returns null },
            deviceProvider = mockk(),
            syncScheduler = mockk(),
            selections = mockk(),
            endpoints = mockk(),
            ioDispatcher = StandardTestDispatcher(testScheduler),
            pinResolver = resolver,
            nowMs = { 100_000 },
        )
        expired.resolvePinAndPrepare(host, "377299")
        expired.refresh()
        assertSame(CorePairingUiState.Unpaired, expired.state.value)

        // The Core screen recreated after the QR scanner refreshes while "what to sync" is open.
        val live = EpigraphCorePairingController(
            activation = activation,
            credentials = mockk { every { load() } returns null },
            deviceProvider = mockk(),
            syncScheduler = mockk(),
            selections = mockk(),
            endpoints = mockk(),
            ioDispatcher = StandardTestDispatcher(testScheduler),
            pinResolver = resolver,
            nowMs = { 50_000 },
        )
        live.resolvePinAndPrepare(host, "377299")
        live.refresh()
        assertEquals(accepted.state.value, live.state.value)

        val withoutResolver = controller(null)
        withoutResolver.resolvePinAndPrepare(host, "377299")
        assertEquals(
            CorePairingUiState.PairingFailed(PairingErrorCode.HOST_NOT_FOUND),
            withoutResolver.state.value,
        )
    }

    @Test
    fun `typed address adds the answering desktop or reports that nothing answered`() = runTest {
        val probed = DiscoveredCoreHost(
            instanceName = "192.168.15.3:4787",
            serverId = "server-a",
            tlsCertSha256 = "a".repeat(64),
            origins = listOf("https://192.168.15.3:4787"),
        )
        val probedOrigins = mutableListOf<String>()
        var answer: DiscoveredCoreHost? = null
        val controller = EpigraphCorePairingController(
            activation = mockk(),
            credentials = mockk(),
            deviceProvider = mockk(),
            syncScheduler = mockk(),
            selections = mockk(),
            endpoints = mockk(),
            ioDispatcher = StandardTestDispatcher(testScheduler),
            hostProbe = CoreHostProbe { origin -> probedOrigins += origin; answer },
        )

        controller.probeHostAddress("not an address")
        assertEquals(CoreHostDiscoveryState.Found(emptyList(), addressFailed = true), controller.discovery.value)

        controller.probeHostAddress("192.168.15.3:4787")
        testScheduler.advanceUntilIdle()
        assertEquals(CoreHostDiscoveryState.Found(emptyList(), addressFailed = true), controller.discovery.value)

        answer = probed
        controller.probeHostAddress("192.168.15.3:4787")
        assertSame(CoreHostDiscoveryState.Searching, controller.discovery.value)
        testScheduler.advanceUntilIdle()
        assertEquals(CoreHostDiscoveryState.Found(listOf(probed)), controller.discovery.value)
        assertEquals(listOf("https://192.168.15.3:4787", "https://192.168.15.3:4787"), probedOrigins)
    }
}
