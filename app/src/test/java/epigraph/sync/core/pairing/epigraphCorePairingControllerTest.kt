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
}
