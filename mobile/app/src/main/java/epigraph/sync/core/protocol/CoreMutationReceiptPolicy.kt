package epigraph.sync.core.protocol

enum class CoreMutationDisposition {
    ACKNOWLEDGE,
    RETRY,
    BLOCK,
}

data class CoreMutationReceiptDecision(
    val clientMutationId: String,
    val disposition: CoreMutationDisposition,
    val canonicalEntityId: String? = null,
    val errorCode: String? = null,
)

object CoreMutationReceiptPolicy {
    /**
     * A Syncd batch is not atomic. Each result is reconciled independently and
     * an omitted result is retried rather than inferred from HTTP success.
     */
    fun reconcile(
        requestedMutationIds: List<String>,
        response: CoreMutationsResponse,
    ): List<CoreMutationReceiptDecision> {
        require(requestedMutationIds.distinct().size == requestedMutationIds.size) {
            "mutation request contains duplicate client IDs"
        }
        val results = response.results.associateBy { it.clientMutationId }
        require(results.size == response.results.size) { "Core response contains duplicate client IDs" }

        return requestedMutationIds.map { mutationId ->
            val result = results[mutationId]
                ?: return@map CoreMutationReceiptDecision(
                    clientMutationId = mutationId,
                    disposition = CoreMutationDisposition.RETRY,
                    errorCode = "CORE_RESULT_MISSING",
                )

            when (result.status) {
                CoreMutationResultStatus.APPLIED,
                CoreMutationResultStatus.SUPERSEDED -> CoreMutationReceiptDecision(
                    clientMutationId = mutationId,
                    disposition = CoreMutationDisposition.ACKNOWLEDGE,
                    canonicalEntityId = result.canonicalEntityId,
                )

                CoreMutationResultStatus.RETRY -> CoreMutationReceiptDecision(
                    clientMutationId = mutationId,
                    disposition = CoreMutationDisposition.RETRY,
                    errorCode = result.error?.code ?: "CORE_MUTATION_RETRY",
                )

                CoreMutationResultStatus.CONFLICT -> CoreMutationReceiptDecision(
                    clientMutationId = mutationId,
                    disposition = CoreMutationDisposition.BLOCK,
                    errorCode = result.error?.code ?: "CORE_MUTATION_CONFLICT",
                )

                CoreMutationResultStatus.REJECTED -> CoreMutationReceiptDecision(
                    clientMutationId = mutationId,
                    disposition = if (result.error?.retryable == true) {
                        CoreMutationDisposition.RETRY
                    } else {
                        CoreMutationDisposition.BLOCK
                    },
                    errorCode = result.error?.code ?: "CORE_MUTATION_REJECTED",
                )
            }
        }
    }
}
