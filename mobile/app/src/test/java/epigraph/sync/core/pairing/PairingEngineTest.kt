package epigraph.sync.core.pairing

import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PairingEngineTest {
    private val now = 1_800_000_000_000L
    private val clock = PairingClock { now }
    private val device = PairingDevice("android-device", "Pixel")

    @Test
    fun `claims waits for desktop approval then claims again to receive token`() = runTest {
        val transport = FakeTransport(
            claims = listOf(pending(), approved()),
            events = flowOf(
                event(PairingStatusEventType.HELLO, PairingSessionStatus.CLAIMED),
                event(PairingStatusEventType.SUBSCRIBED, PairingSessionStatus.CLAIMED),
                event(PairingStatusEventType.STATUS_CHANGED, PairingSessionStatus.APPROVED),
                event(PairingStatusEventType.FINAL_TOKEN_READY, PairingSessionStatus.APPROVED),
            ),
        )
        val states = mutableListOf<PairingState>()

        val result = engine(transport).pair(bundle(), device, states::add)

        val success = assertInstanceOf(PairingResult.Success::class.java, result)
        assertEquals("secret-token", success.session.token.accessToken)
        assertEquals(2, transport.claimsSeen.size)
        assertEquals(1, transport.subscriptionsSeen.size)
        assertEquals(PairingPlatform.ANDROID, transport.claimsSeen.first().platform)
        assertEquals(EPIGRAPH_SYNCD_PROTOCOL_VERSION, transport.claimsSeen.first().clientProtocolVersion)
        assertEquals(
            listOf(
                PairingState.ValidatingBundle::class,
                PairingState.Claiming::class,
                PairingState.AwaitingDesktopApproval::class,
                PairingState.ApprovalObserved::class,
                PairingState.ExchangingToken::class,
                PairingState.Paired::class,
            ),
            states.map { it::class },
        )
    }

    @Test
    fun `accepts a directly approved idempotent claim without opening live status`() = runTest {
        val transport = FakeTransport(listOf(approved()))

        val result = engine(transport).pair(bundle(), device)

        assertInstanceOf(PairingResult.Success::class.java, result)
        assertEquals(1, transport.claimsSeen.size)
        assertTrue(transport.subscriptionsSeen.isEmpty())
    }

    @Test
    fun `maps rejection and never asks for a token`() = runTest {
        val transport = FakeTransport(
            claims = listOf(pending()),
            events = flowOf(event(PairingStatusEventType.REJECTED, PairingSessionStatus.REJECTED)),
        )

        val result = engine(transport).pair(bundle(), device)

        assertFailure(PairingErrorCode.REJECTED, result)
        assertEquals(1, transport.claimsSeen.size)
    }

    @Test
    fun `expired bundle performs no network operation`() = runTest {
        val transport = FakeTransport(emptyList())

        val result = engine(transport).pair(bundle(expiresAtMs = now), device)

        assertFailure(PairingErrorCode.INVALID_BUNDLE, result)
        assertTrue(transport.claimsSeen.isEmpty())
    }

    @Test
    fun `rejects mismatched live session rather than exchanging a token`() = runTest {
        val mismatched = event(PairingStatusEventType.APPROVED, PairingSessionStatus.APPROVED)
            .copy(sessionId = "bootstrap-00000000-0000-0000-0000-000000000000")
        val transport = FakeTransport(listOf(pending()), flowOf(mismatched))

        val result = engine(transport).pair(bundle(), device)

        assertFailure(PairingErrorCode.INVALID_RESPONSE, result)
        assertEquals(1, transport.claimsSeen.size)
    }

    @Test
    fun `approved response without token is rejected`() = runTest {
        val transport = FakeTransport(listOf(approved().copy(token = null)))

        val result = engine(transport).pair(bundle(), device)

        assertFailure(PairingErrorCode.INVALID_RESPONSE, result)
    }

    @Test
    fun `transport exposes fixed domain failures without fake success`() = runTest {
        val transport = object : PairingTransport {
            override suspend fun claim(
                endpoint: SyncdEndpoint,
                tlsCertSha256: String,
                request: PairingClaimRequest,
            ): PairingClaimResponse {
                throw PairingTransportException(PairingError(PairingErrorCode.TLS_MISMATCH))
            }

            override fun statusEvents(
                subscription: PairingStatusSubscription,
                tlsCertSha256: String,
            ): Flow<PairingStatusEvent> = flowOf()
        }

        val result = engine(transport).pair(bundle(), device)

        assertFailure(PairingErrorCode.TLS_MISMATCH, result)
    }

    @Test
    fun `maps syncd structured errors to fixed pairing failures`() {
        assertEquals(
            PairingErrorCode.ALREADY_CLAIMED,
            PairingTransportErrorMapper.fromCore(409, "PAIRING_SESSION_ALREADY_CLAIMED").code,
        )
        assertEquals(
            PairingErrorCode.PROTOCOL_MISMATCH,
            PairingTransportErrorMapper.fromCore(426, "PROTOCOL_VERSION_MISMATCH").code,
        )
        assertEquals(
            PairingErrorCode.EXPIRED,
            PairingTransportErrorMapper.fromCore(410, null).code,
        )
    }

    @Test
    fun `coroutine cancellation closes pairing and emits cancelled state`() = runTest {
        val transport = FakeTransport(
            claims = listOf(pending()),
            events = flow { awaitCancellation() },
        )
        val states = mutableListOf<PairingState>()
        val job = launch { engine(transport).pair(bundle(), device, states::add) }
        runCurrent()

        job.cancelAndJoin()

        assertTrue(job.isCancelled)
        assertInstanceOf(PairingState.Cancelled::class.java, states.last())
        assertFalse(states.any { it is PairingState.Paired })
    }

    @Test
    fun `serializes complete handshakes because approved claims rotate the token`() = runTest {
        val activeClaims = AtomicInteger()
        val maxActiveClaims = AtomicInteger()
        val transport = object : PairingTransport {
            override suspend fun claim(
                endpoint: SyncdEndpoint,
                tlsCertSha256: String,
                request: PairingClaimRequest,
            ): PairingClaimResponse {
                val active = activeClaims.incrementAndGet()
                maxActiveClaims.updateAndGet { previous -> maxOf(previous, active) }
                delay(10)
                activeClaims.decrementAndGet()
                return approved()
            }

            override fun statusEvents(
                subscription: PairingStatusSubscription,
                tlsCertSha256: String,
            ): Flow<PairingStatusEvent> = flowOf()
        }
        val pairingEngine = engine(transport)

        val first = async { pairingEngine.pair(bundle(), device) }
        val second = async { pairingEngine.pair(bundle(), device) }

        assertInstanceOf(PairingResult.Success::class.java, first.await())
        assertInstanceOf(PairingResult.Success::class.java, second.await())
        assertEquals(1, maxActiveClaims.get())
    }

    private fun engine(transport: PairingTransport) = EpigraphCorePairingEngine(
        transport = transport,
        parser = BootstrapBundleParser(clock),
        clock = clock,
    )

    private fun pending() = PairingClaimResponse(
        status = PairingClaimStatus.PENDING_APPROVAL,
        sessionId = SESSION_ID,
        profileId = "main",
        claimedDeviceId = device.id,
        expiresAtMs = now + 60_000,
    )

    private fun approved() = PairingClaimResponse(
        status = PairingClaimStatus.APPROVED,
        sessionId = SESSION_ID,
        profileId = "main",
        claimedDeviceId = device.id,
        expiresAtMs = now + 60_000,
        token = PairingTokenResponse(
            accessToken = "secret-token",
            tokenId = "token-id",
            profileId = "main",
            scopes = listOf("books:global", "comics:profile:main"),
            inactivityExpiresAtMs = now + 2_000_000,
            grantedVia = PairingGrantVia.QR,
        ),
    )

    private fun event(type: PairingStatusEventType, status: PairingSessionStatus) =
        PairingStatusEvent(
            type = type,
            sessionId = SESSION_ID,
            profileId = "main",
            status = status,
            expiresAtMs = now + 60_000,
            claimedDeviceId = device.id,
        )

    private fun bundle(expiresAtMs: Long = now + 60_000): String = """
        {
          "pairingSessionId":"$SESSION_ID",
          "pairingCode":"019F777E758B",
          "syncdBaseUrl":"https://192.168.1.20:4777",
          "profileId":"main",
          "expiresAtMs":$expiresAtMs,
          "tlsCertSha256":"$FINGERPRINT"
        }
    """.trimIndent()

    private fun assertFailure(expected: PairingErrorCode, result: PairingResult) {
        val failure = assertInstanceOf(PairingResult.Failure::class.java, result)
        assertEquals(expected, failure.error.code)
    }

    private class FakeTransport(
        claims: List<PairingClaimResponse>,
        private val events: Flow<PairingStatusEvent> = flowOf(),
    ) : PairingTransport {
        private val responses = ArrayDeque(claims)
        val claimsSeen = mutableListOf<PairingClaimRequest>()
        val subscriptionsSeen = mutableListOf<PairingStatusSubscription>()

        override suspend fun claim(
            endpoint: SyncdEndpoint,
            tlsCertSha256: String,
            request: PairingClaimRequest,
        ): PairingClaimResponse {
            claimsSeen += request
            return responses.removeFirst()
        }

        override fun statusEvents(
            subscription: PairingStatusSubscription,
            tlsCertSha256: String,
        ): Flow<PairingStatusEvent> {
            subscriptionsSeen += subscription
            return events
        }
    }

    private companion object {
        const val SESSION_ID = "bootstrap-019f57b6-1c7b-7862-bc7b-15d17593f9d3"
        const val FINGERPRINT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
}
