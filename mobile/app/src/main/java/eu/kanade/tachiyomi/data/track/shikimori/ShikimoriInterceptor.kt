package eu.kanade.tachiyomi.data.track.shikimori

import eu.kanade.tachiyomi.BuildConfig
import eu.kanade.tachiyomi.data.track.shikimori.dto.SMOAuth
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.Response
import yokai.util.koin.injectLazy

class ShikimoriInterceptor(val shikimori: Shikimori) : Interceptor {

    private val json: Json by injectLazy()

    /**
     * OAuth object used for authenticated requests.
     */
    private var oauth: SMOAuth? = shikimori.restoreToken()

    override fun intercept(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()

        // A login installed without this interceptor (Epigraph Core tracker sync) is only in the preferences.
        val currAuth = oauth ?: shikimori.restoreToken()?.also { oauth = it }
            ?: throw Exception("Not authenticated with Shikimori")

        val refreshToken = currAuth.refreshToken!!

        // Refresh access token if expired.
        if (currAuth.isExpired()) {
            val response = chain.proceed(ShikimoriApi.refreshTokenRequest(refreshToken))
            if (response.isSuccessful) {
                newAuth(json.decodeFromString<SMOAuth>(response.body.string()))
            } else {
                response.close()
            }
        }
        // Add the authorization header to the original request.
        val authRequest = originalRequest.newBuilder()
            .addHeader("Authorization", "Bearer ${oauth!!.accessToken}")
            .header("User-Agent", "Epigraph/${BuildConfig.VERSION_NAME} (${BuildConfig.APPLICATION_ID})")
            .build()

        return chain.proceed(authRequest)
    }

    fun newAuth(oauth: SMOAuth?) {
        this.oauth = oauth
        shikimori.saveToken(oauth)
    }
}
