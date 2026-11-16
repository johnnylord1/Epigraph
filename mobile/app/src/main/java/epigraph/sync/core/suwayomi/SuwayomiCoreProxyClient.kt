package epigraph.sync.core.suwayomi

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.EpigraphCoreHttpClient
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiGraphqlRequest
import epigraph.sync.core.protocol.SuwayomiGraphqlResponse
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiCatalogResponse
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiCommandResponse

/**
 * Session-aware comics gateway. It borrows the token for one request and never stores it in the
 * gateway or in a request queue.
 */
interface SuwayomiMutationGateway {
    suspend fun command(
        session: CoreCredentialSession,
        request: SuwayomiCommandRequest,
    ): CoreHttpResult<SuwayomiCommandResponse>

    suspend fun graphql(
        session: CoreCredentialSession,
        request: SuwayomiGraphqlRequest,
    ): CoreHttpResult<SuwayomiGraphqlResponse>

    suspend fun catalog(
        session: CoreCredentialSession,
        operation: SuwayomiCatalogOperation,
        pageSize: Long = 100,
        offset: Long = 0,
        mangaId: Long? = null,
    ): CoreHttpResult<SuwayomiCatalogResponse>

    /** A [catalog] library page with each title's chapter and unread counts. */
    suspend fun libraryWithCounts(
        session: CoreCredentialSession,
        pageSize: Long,
        offset: Long,
    ): CoreHttpResult<SuwayomiCatalogResponse> = catalog(session, SuwayomiCatalogOperation.LIBRARY, pageSize, offset)

}

class SuwayomiCoreProxyClient(
    private val http: EpigraphCoreHttpClient,
) : SuwayomiMutationGateway {
    override
    suspend fun command(
        session: CoreCredentialSession,
        request: SuwayomiCommandRequest,
    ): CoreHttpResult<SuwayomiCommandResponse> {
        require("comics:profile:${session.profileId}" in session.scopes) {
            "paired session does not grant the comics scope"
        }
        return session.withAccessTokenString { accessToken ->
            http.suwayomiCommand(accessToken, session.profileId, request)
        }
    }

    override
    suspend fun graphql(
        session: CoreCredentialSession,
        request: SuwayomiGraphqlRequest,
    ): CoreHttpResult<SuwayomiGraphqlResponse> {
        val expectedScope = "comics:profile:${session.profileId}"
        require(expectedScope in session.scopes) {
            "paired session does not grant the comics scope"
        }
        return session.withAccessTokenString { accessToken ->
            http.suwayomiGraphql(accessToken, session.profileId, request)
        }
    }

    override
    suspend fun catalog(
        session: CoreCredentialSession,
        operation: SuwayomiCatalogOperation,
        pageSize: Long,
        offset: Long,
        mangaId: Long?,
    ): CoreHttpResult<SuwayomiCatalogResponse> {
        require("comics:profile:${session.profileId}" in session.scopes) {
            "paired session does not grant the comics scope"
        }
        return session.withAccessTokenString { accessToken ->
            http.suwayomiCatalog(
                accessToken = accessToken,
                profileId = session.profileId,
                operation = operation,
                pageSize = pageSize,
                offset = offset,
                mangaId = mangaId,
            )
        }
    }

    override
    suspend fun libraryWithCounts(
        session: CoreCredentialSession,
        pageSize: Long,
        offset: Long,
    ): CoreHttpResult<SuwayomiCatalogResponse> {
        require("comics:profile:${session.profileId}" in session.scopes) {
            "paired session does not grant the comics scope"
        }
        return session.withAccessTokenString { accessToken ->
            http.suwayomiCatalog(
                accessToken = accessToken,
                profileId = session.profileId,
                operation = SuwayomiCatalogOperation.LIBRARY,
                pageSize = pageSize,
                offset = offset,
                withCounts = true,
            )
        }
    }

}
