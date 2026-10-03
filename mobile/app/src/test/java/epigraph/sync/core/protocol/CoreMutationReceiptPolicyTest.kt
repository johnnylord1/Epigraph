package epigraph.sync.core.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class CoreMutationReceiptPolicyTest {
    @Test
    fun `reconciles mixed non-atomic batch one result at a time`() {
        val response = CoreMutationsResponse(
            requestId = "batch",
            currentServerVersion = 9,
            results = listOf(
                result("a", CoreMutationResultStatus.APPLIED, canonical = "canonical-a"),
                result("b", CoreMutationResultStatus.REJECTED, error = CoreErrorDetail("STALE_PROGRESS", "stale")),
                result(
                    "c",
                    CoreMutationResultStatus.REJECTED,
                    error = CoreErrorDetail("TEMPORARY", "try again", retryable = true),
                ),
            ),
        )

        val decisions = CoreMutationReceiptPolicy.reconcile(listOf("a", "b", "c", "d"), response)

        assertEquals(
            listOf(
                CoreMutationDisposition.ACKNOWLEDGE,
                CoreMutationDisposition.BLOCK,
                CoreMutationDisposition.RETRY,
                CoreMutationDisposition.RETRY,
            ),
            decisions.map { it.disposition },
        )
        assertEquals("canonical-a", decisions[0].canonicalEntityId)
        assertEquals("CORE_RESULT_MISSING", decisions[3].errorCode)
    }

    @Test
    fun `rejects duplicate result IDs because associateBy would hide protocol corruption`() {
        val response = CoreMutationsResponse(
            requestId = "batch",
            currentServerVersion = 1,
            results = listOf(result("a", CoreMutationResultStatus.APPLIED), result("a", CoreMutationResultStatus.APPLIED)),
        )

        assertThrows(IllegalArgumentException::class.java) {
            CoreMutationReceiptPolicy.reconcile(listOf("a"), response)
        }
    }

    private fun result(
        id: String,
        status: CoreMutationResultStatus,
        canonical: String? = null,
        error: CoreErrorDetail? = null,
    ) = CoreMutationResult(
        clientMutationId = id,
        entityType = "book.entry",
        entityId = "book-a",
        canonicalEntityId = canonical,
        scopeId = "books:global",
        op = CoreMutationOperation.MERGE,
        status = status,
        appliedServerVersion = if (status == CoreMutationResultStatus.APPLIED) 1 else null,
        appliedLamport = if (status == CoreMutationResultStatus.APPLIED) 1 else null,
        error = error,
    )
}
