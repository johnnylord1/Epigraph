package epigraph.sync.core.pairing

import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import epigraph.sync.core.policy.DeviceSyncSelectionStore
import io.mockk.Runs
import io.mockk.confirmVerified
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Test

class EpigraphCorePairingControllerTest {
    @Test
    fun `disconnect removes only the session and does not schedule destructive reconciliation`() = runTest {
        val credentials = mockk<CoreCredentialStore>()
        val scheduler = mockk<CoreBackgroundSyncScheduler>()
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
        verify(exactly = 1) { credentials.delete() }
        confirmVerified(credentials, scheduler)
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

        val withoutResolver = controller(null)
        withoutResolver.resolvePinAndPrepare(host, "377299")
        assertEquals(
            CorePairingUiState.PairingFailed(PairingErrorCode.HOST_NOT_FOUND),
            withoutResolver.state.value,
        )
    }
}
