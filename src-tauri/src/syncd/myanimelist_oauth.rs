//! Epigraph's own MyAnimeList OAuth client (PKCE), the same one the mobile app uses.
//!
//! MyAnimeList access tokens last about a month, and a refresh only works with the client id that
//! issued the login. Suwayomi refreshes with its own client and only once the token expired, so a
//! login shared between the desktop and paired devices must come from one client and be renewed
//! before Suwayomi or the phone would try. Desktop logins made here use the Epigraph client, and
//! syncd renews the stored login ahead of expiry; the renewed login reaches Suwayomi through
//! `tracker.xml` and paired devices through `/v1/tracker-credentials`.
//!
//! Nothing here logs a code, verifier or token.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::Context;
use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;
use uuid::Uuid;

use super::db;
use super::tracker_credentials::{
    self, CredentialValues, StoredTrackerCredential, DESKTOP_DEVICE_ID,
};

pub const TRACKER_KEY: &str = "myanimelist";
/// Epigraph's MyAnimeList API client. Its registered redirect is `epigraph://myanimelist-auth`.
const CLIENT_ID: &str = "ffcb367c66a1e8a3ebc17e56f8a401a4";
const AUTHORIZE_URL: &str = "https://myanimelist.net/v1/oauth2/authorize";
const TOKEN_URL: &str = "https://myanimelist.net/v1/oauth2/token";
const USER_URL: &str = "https://api.myanimelist.net/v2/users/@me";
const REDIRECT_SCHEME: &str = "epigraph";
const REDIRECT_HOST: &str = "myanimelist-auth";
const PENDING_LOGIN_TTL_MS: i64 = 15 * 60 * 1000;
const MAX_PENDING_LOGINS: usize = 8;
/// How long before expiry the stored login is renewed (tokens last about 31 days).
const RENEW_BEFORE_EXPIRY_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Retry delay after MyAnimeList could not be reached.
const RENEW_RETRY_MS: i64 = 30 * 60 * 1000;

struct PendingLogin {
    verifier: String,
    created_at_ms: i64,
}

/// Logins started by the desktop shell, by OAuth `state`.
static PENDING_LOGINS: Mutex<BTreeMap<String, PendingLogin>> = Mutex::new(BTreeMap::new());
/// `(revision, retry_at_ms)` of the last renewal that failed.
static RENEWAL_BACKOFF: Mutex<Option<(i64, i64)>> = Mutex::new(None);

/// Starts a login and returns the authorization URL for the login window.
pub fn start_login(now_ms: i64) -> String {
    // Two v4 UUIDs: 64 characters from the OS random source, inside PKCE's 43..=128 range.
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let state = Uuid::new_v4().simple().to_string();
    let url = authorize_url(&verifier, &state);
    let mut pending = PENDING_LOGINS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    pending.retain(|_, login| now_ms - login.created_at_ms < PENDING_LOGIN_TTL_MS);
    while pending.len() >= MAX_PENDING_LOGINS {
        let Some(oldest) = pending
            .iter()
            .min_by_key(|(_, login)| login.created_at_ms)
            .map(|(state, _)| state.clone())
        else {
            break;
        };
        pending.remove(&oldest);
    }
    pending.insert(
        state,
        PendingLogin {
            verifier,
            created_at_ms: now_ms,
        },
    );
    url
}

/// MyAnimeList only supports the `plain` PKCE method, so the challenge is the verifier itself.
pub fn authorize_url(verifier: &str, state: &str) -> String {
    let mut url = Url::parse(AUTHORIZE_URL).expect("static MyAnimeList authorize URL");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("code_challenge", verifier)
        .append_pair("code_challenge_method", "plain")
        .append_pair("state", state);
    url.into()
}

/// Whether a URL is the Epigraph client's MyAnimeList redirect carrying an authorization code.
pub fn is_login_callback(url: &Url) -> bool {
    callback_params(url).is_some()
}

/// `(code, state)` of an `epigraph://myanimelist-auth?code=...` redirect.
fn callback_params(url: &Url) -> Option<(String, Option<String>)> {
    if !url.scheme().eq_ignore_ascii_case(REDIRECT_SCHEME)
        || !url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case(REDIRECT_HOST))
    {
        return None;
    }
    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if !value.is_empty() => code = Some(value.into_owned()),
            "state" if !value.is_empty() => state = Some(value.into_owned()),
            _ => {}
        }
    }
    code.map(|code| (code, state))
}

/// The code and verifier of a pending login this callback completes. A callback without `state`
/// (pasted by hand) completes the only pending login.
fn take_pending_login(callback_url: &str, now_ms: i64) -> Option<(String, String)> {
    let url = Url::parse(callback_url.trim()).ok()?;
    let (code, state) = callback_params(&url)?;
    let mut pending = PENDING_LOGINS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    pending.retain(|_, login| now_ms - login.created_at_ms < PENDING_LOGIN_TTL_MS);
    let state = match state {
        Some(state) => state,
        None if pending.len() == 1 => pending.keys().next()?.clone(),
        None => return None,
    };
    pending.remove(&state).map(|login| (code, login.verifier))
}

#[derive(Debug)]
pub enum LoginError {
    /// The callback does not belong to a login started here (or it expired).
    UnknownLogin,
    /// MyAnimeList refused the code or could not be reached.
    Rejected,
}

/// Completes a login started by [`start_login`]: the Mihon/Suwayomi credential shape.
pub async fn complete_login(callback_url: &str, now_ms: i64) -> Result<CredentialValues, LoginError> {
    let (code, verifier) = take_pending_login(callback_url, now_ms).ok_or(LoginError::UnknownLogin)?;
    let token = request_token(&[
        ("client_id", CLIENT_ID),
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("code_verifier", &verifier),
    ])
    .await
    .map_err(|_| LoginError::Rejected)?;
    let username = fetch_username(&token.access_token)
        .await
        .map_err(|_| LoginError::Rejected)?;
    Ok(credential_values(&username, &token, now_ms))
}

#[derive(Deserialize)]
struct TokenResponse {
    token_type: String,
    expires_in: i64,
    access_token: String,
    refresh_token: String,
}

enum TokenError {
    /// MyAnimeList answered and refused (bad code, revoked login, another client's token).
    Refused,
    /// No usable answer; worth retrying later.
    Unavailable,
}

fn http_client() -> Result<reqwest::Client, TokenError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| TokenError::Unavailable)
}

async fn request_token(form: &[(&str, &str)]) -> Result<TokenResponse, TokenError> {
    let response = http_client()?
        .post(TOKEN_URL)
        .header("accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|_| TokenError::Unavailable)?;
    let status = response.status();
    if status.is_client_error() {
        return Err(TokenError::Refused);
    }
    if !status.is_success() {
        return Err(TokenError::Unavailable);
    }
    let token: TokenResponse = response.json().await.map_err(|_| TokenError::Unavailable)?;
    if token.access_token.is_empty() || token.refresh_token.is_empty() || token.expires_in <= 0 {
        return Err(TokenError::Unavailable);
    }
    Ok(token)
}

async fn fetch_username(access_token: &str) -> anyhow::Result<String> {
    let response = http_client()
        .map_err(|_| anyhow::anyhow!("MyAnimeList client unavailable"))?
        .get(USER_URL)
        .bearer_auth(access_token)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("MyAnimeList user request failed"))?;
    if !response.status().is_success() {
        anyhow::bail!("MyAnimeList user request returned {}", response.status().as_u16());
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| anyhow::anyhow!("MyAnimeList user response is not JSON"))?;
    payload
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .context("MyAnimeList user response has no name")
}

/// Mihon/Suwayomi's MyAnimeList preference shape: username, password = access token, token =
/// `MALOAuth` JSON (`created_at` in milliseconds, `expires_in` in seconds).
fn credential_values(username: &str, token: &TokenResponse, now_ms: i64) -> CredentialValues {
    CredentialValues {
        username: username.to_string(),
        password: token.access_token.clone(),
        token: json!({
            "refresh_token": token.refresh_token,
            "access_token": token.access_token,
            "token_type": token.token_type,
            "created_at": now_ms,
            "expires_in": token.expires_in,
        })
        .to_string(),
    }
}

/// The refresh token of a stored MyAnimeList login that is due for renewal.
fn renewal_refresh_token(credential: &StoredTrackerCredential, now_ms: i64) -> Option<String> {
    if credential.tracker_key != TRACKER_KEY || credential.deleted || credential.username.is_empty() {
        return None;
    }
    let token: Value = serde_json::from_str(&credential.token).ok()?;
    let created_at = token.get("created_at").and_then(Value::as_i64)?;
    let expires_in = token.get("expires_in").and_then(Value::as_i64)?;
    let refresh_token = token
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let expires_at = created_at.saturating_add(expires_in.saturating_mul(1000));
    (expires_at - now_ms < RENEW_BEFORE_EXPIRY_MS).then(|| refresh_token.to_string())
}

/// Renews the stored MyAnimeList login when it expires within a week. The new login is stored as
/// a desktop write that Suwayomi has not applied yet, so the tracking mirror writes it into
/// `tracker.xml`, and paired devices pick it up as a newer revision.
pub async fn renew_stored_login_if_due(data_dir: &Path) {
    if !tracker_credentials::is_supported() {
        return;
    }
    let now_ms = db::now_ms();
    let Ok(vault) = tracker_credentials::load_vault(data_dir).await else {
        return;
    };
    let Some(stored) = vault.credentials.get(TRACKER_KEY) else {
        return;
    };
    let Some(refresh_token) = renewal_refresh_token(stored, now_ms) else {
        return;
    };
    let revision = stored.revision;
    {
        let backoff = RENEWAL_BACKOFF.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if backoff.is_some_and(|(failed_revision, retry_at)| failed_revision == revision && now_ms < retry_at) {
            return;
        }
    }
    let username = stored.username.clone();
    let token = match request_token(&[
        ("client_id", CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh_token),
    ])
    .await
    {
        Ok(token) => token,
        Err(error) => {
            let retry_at = match error {
                TokenError::Refused => {
                    tracing::warn!(
                        revision,
                        "MyAnimeList refused to renew the stored login; log in to MyAnimeList again from Epigraph"
                    );
                    i64::MAX
                }
                TokenError::Unavailable => {
                    tracing::warn!(revision, "could not reach MyAnimeList to renew the stored login; will retry");
                    now_ms + RENEW_RETRY_MS
                }
            };
            *RENEWAL_BACKOFF.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
                Some((revision, retry_at));
            return;
        }
    };
    let values = credential_values(&username, &token, now_ms);
    let outcome = tracker_credentials::update_vault(data_dir, |vault| {
        // A login written meanwhile (by a device or the desktop) wins over this renewal.
        if vault.current_revision(TRACKER_KEY) != revision {
            return Ok((None, false));
        }
        let view = vault.put(TRACKER_KEY, revision, values, DESKTOP_DEVICE_ID, now_ms)?;
        Ok((Some(view.revision), true))
    })
    .await;
    match outcome {
        Ok(Ok(Some(new_revision))) => tracing::info!(
            revision = new_revision,
            "renewed the MyAnimeList login before it expired"
        ),
        Ok(Ok(None)) => {}
        Ok(Err(error)) => {
            tracing::warn!(error = ?error, "renewed MyAnimeList login was not stored")
        }
        Err(error) => {
            tracing::warn!(error = %error, "tracker credential vault unavailable for the MyAnimeList renewal")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(token: Value) -> StoredTrackerCredential {
        StoredTrackerCredential {
            tracker_key: TRACKER_KEY.to_string(),
            revision: 3,
            username: "reader".to_string(),
            password: "access".to_string(),
            token: token.to_string(),
            desktop_revision: 3,
            ..Default::default()
        }
    }

    #[test]
    fn authorize_url_uses_the_epigraph_client_with_a_plain_pkce_challenge() {
        let url = Url::parse(&authorize_url(&"v".repeat(64), "state-1")).unwrap();
        let params: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("myanimelist.net"));
        assert_eq!(params["client_id"], CLIENT_ID);
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["code_challenge"], "v".repeat(64));
        assert_eq!(params["code_challenge_method"], "plain");
        assert_eq!(params["state"], "state-1");
        assert!(!params.contains_key("redirect_uri"));
    }

    #[test]
    fn recognizes_only_the_epigraph_redirect_with_a_code() {
        let callback = |raw: &str| is_login_callback(&Url::parse(raw).unwrap());
        assert!(callback("epigraph://myanimelist-auth?code=abc&state=s"));
        assert!(!callback("epigraph://myanimelist-auth?error=access_denied"));
        assert!(!callback("epigraph://anilist-auth?code=abc"));
        assert!(!callback("https://myanimelist-auth/?code=abc"));
    }

    #[test]
    fn a_pending_login_completes_once_and_only_with_its_state() {
        let now = 1_000_000;
        let url = Url::parse(&start_login(now)).unwrap();
        let state = url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned())
            .unwrap();
        assert!(take_pending_login("epigraph://myanimelist-auth?code=c&state=other", now).is_none());
        let callback = format!("epigraph://myanimelist-auth?code=c&state={state}");
        let (code, verifier) = take_pending_login(&callback, now + 1).unwrap();
        assert_eq!(code, "c");
        assert_eq!(verifier.len(), 64);
        assert!(take_pending_login(&callback, now + 2).is_none());
    }

    #[test]
    fn stores_the_mihon_shape_and_renews_only_within_a_week_of_expiry() {
        let now = 10_000_000_000;
        let values = credential_values(
            "reader",
            &TokenResponse {
                token_type: "Bearer".to_string(),
                expires_in: 2_678_400,
                access_token: "access".to_string(),
                refresh_token: "refresh".to_string(),
            },
            now,
        );
        assert_eq!(values.username, "reader");
        assert_eq!(values.password, "access");
        let token: Value = serde_json::from_str(&values.token).unwrap();
        assert_eq!(token["created_at"], now);
        assert_eq!(token["expires_in"], 2_678_400);
        assert_eq!(token["refresh_token"], "refresh");

        let credential = stored(token);
        let day = 24 * 60 * 60 * 1000;
        assert_eq!(renewal_refresh_token(&credential, now + 23 * day), None);
        assert_eq!(
            renewal_refresh_token(&credential, now + 25 * day).as_deref(),
            Some("refresh")
        );
        assert_eq!(
            renewal_refresh_token(&credential, now + 40 * day).as_deref(),
            Some("refresh")
        );

        let mut logged_out = credential.clone();
        logged_out.deleted = true;
        assert_eq!(renewal_refresh_token(&logged_out, now + 25 * day), None);
        let mut other = credential;
        other.tracker_key = "anilist".to_string();
        assert_eq!(renewal_refresh_token(&other, now + 25 * day), None);
    }
}
