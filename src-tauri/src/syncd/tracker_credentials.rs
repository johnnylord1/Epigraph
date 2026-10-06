//! Tracker login vault (`/v1/tracker-credentials`).
//!
//! Credentials are kept out of the replica database entirely.  They live in one
//! file in the syncd data directory, sealed with Windows DPAPI (machine and
//! user bound), and are only ever returned on the authenticated, paired
//! session.  Nothing in this module logs a username, password or token.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::tracking::is_valid_tracker_key;

pub const TRACKER_CREDENTIALS_FILE: &str = "tracker-credentials-v1.bin";
pub const TRACKER_CREDENTIALS_SCHEMA_VERSION: u32 = 1;
/// Per-value limit from the contract (UTF-8 bytes).
pub const MAX_CREDENTIAL_VALUE_BYTES: usize = 8 * 1024;
const MAX_DEVICE_ID_BYTES: usize = 256;
/// Device id recorded for logins published by the desktop shell itself.
pub const DESKTOP_DEVICE_ID: &str = "epigraph-desktop";
/// Mihon's AniList OAuth lifetime (`AnilistApi.createOAuth`): one year.
const ANILIST_OAUTH_LIFETIME_MS: i64 = 31_536_000_000;
const DPAPI_DESCRIPTION: &str = "Epigraph tracker credentials";

/// Serializes every read-modify-write of the vault file.
static VAULT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Whether credentials can be sealed at rest on this platform.
pub fn is_supported() -> bool {
    cfg!(windows)
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredTrackerCredential {
    pub tracker_key: String,
    pub revision: i64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub updated_at_ms: i64,
    /// Audit only.  Never returned to devices.
    #[serde(default)]
    pub updated_by_device_id: String,
    /// The revision the desktop's own Suwayomi trackers reflect.  The tracking
    /// mirror applies a credential to Suwayomi while this differs from `revision`.
    #[serde(default)]
    pub desktop_revision: i64,
}

impl fmt::Debug for StoredTrackerCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoredTrackerCredential")
            .field("tracker_key", &self.tracker_key)
            .field("revision", &self.revision)
            .field("deleted", &self.deleted)
            .field("username", &"<redacted>")
            .field("password", &"<redacted>")
            .field("token", &"<redacted>")
            .field("updated_at_ms", &self.updated_at_ms)
            .field("desktop_revision", &self.desktop_revision)
            .finish()
    }
}

/// The wire view: everything except the audit device id and desktop bookkeeping.
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackerCredentialView {
    pub tracker_key: String,
    pub revision: i64,
    pub deleted: bool,
    pub username: String,
    pub password: String,
    pub token: String,
    pub updated_at_ms: i64,
}

impl fmt::Debug for TrackerCredentialView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TrackerCredentialView")
            .field("tracker_key", &self.tracker_key)
            .field("revision", &self.revision)
            .field("deleted", &self.deleted)
            .finish_non_exhaustive()
    }
}

impl From<&StoredTrackerCredential> for TrackerCredentialView {
    fn from(stored: &StoredTrackerCredential) -> Self {
        Self {
            tracker_key: stored.tracker_key.clone(),
            revision: stored.revision,
            deleted: stored.deleted,
            username: stored.username.clone(),
            password: stored.password.clone(),
            token: stored.token.clone(),
            updated_at_ms: stored.updated_at_ms,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackerCredentialVault {
    pub schema_version: u32,
    #[serde(default)]
    pub credentials: BTreeMap<String, StoredTrackerCredential>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialWriteError {
    InvalidKey,
    InvalidValue(&'static str),
    Stale { current_revision: i64 },
}

#[derive(Clone, PartialEq, Eq)]
pub struct CredentialValues {
    pub username: String,
    pub password: String,
    pub token: String,
}

impl fmt::Debug for CredentialValues {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialValues(<redacted>)")
    }
}

impl TrackerCredentialVault {
    pub fn views(&self) -> Vec<TrackerCredentialView> {
        self.credentials
            .values()
            .map(TrackerCredentialView::from)
            .collect()
    }

    pub fn current_revision(&self, tracker_key: &str) -> i64 {
        self.credentials
            .get(tracker_key)
            .map(|credential| credential.revision)
            .unwrap_or(0)
    }

    /// Compare-and-set login write.  On success the revision is `base + 1`.
    pub fn put(
        &mut self,
        tracker_key: &str,
        base_revision: i64,
        values: CredentialValues,
        device_id: &str,
        now_ms: i64,
    ) -> Result<TrackerCredentialView, CredentialWriteError> {
        validate_key_and_device(tracker_key, device_id)?;
        for (name, value) in [
            ("username", &values.username),
            ("password", &values.password),
            ("token", &values.token),
        ] {
            if value.len() > MAX_CREDENTIAL_VALUE_BYTES || value.contains('\0') {
                return Err(CredentialWriteError::InvalidValue(name));
            }
        }
        self.check_base(tracker_key, base_revision)?;
        let stored = StoredTrackerCredential {
            tracker_key: tracker_key.to_string(),
            revision: base_revision + 1,
            deleted: false,
            username: values.username,
            password: values.password,
            token: values.token,
            updated_at_ms: now_ms,
            updated_by_device_id: device_id.to_string(),
            desktop_revision: self
                .credentials
                .get(tracker_key)
                .map(|credential| credential.desktop_revision)
                .unwrap_or(0),
        };
        let view = TrackerCredentialView::from(&stored);
        self.credentials.insert(tracker_key.to_string(), stored);
        Ok(view)
    }

    /// Compare-and-set logout.  The tombstone keeps (and advances) the revision
    /// so every device converges on the logout.
    pub fn delete(
        &mut self,
        tracker_key: &str,
        base_revision: i64,
        device_id: &str,
        now_ms: i64,
    ) -> Result<TrackerCredentialView, CredentialWriteError> {
        validate_key_and_device(tracker_key, device_id)?;
        self.check_base(tracker_key, base_revision)?;
        let stored = StoredTrackerCredential {
            tracker_key: tracker_key.to_string(),
            revision: base_revision + 1,
            deleted: true,
            username: String::new(),
            password: String::new(),
            token: String::new(),
            updated_at_ms: now_ms,
            updated_by_device_id: device_id.to_string(),
            desktop_revision: self
                .credentials
                .get(tracker_key)
                .map(|credential| credential.desktop_revision)
                .unwrap_or(0),
        };
        let view = TrackerCredentialView::from(&stored);
        self.credentials.insert(tracker_key.to_string(), stored);
        Ok(view)
    }

    pub fn mark_desktop_applied(&mut self, tracker_key: &str, revision: i64) -> bool {
        match self.credentials.get_mut(tracker_key) {
            Some(credential) if credential.revision == revision => {
                credential.desktop_revision = revision;
                true
            }
            _ => false,
        }
    }

    fn check_base(&self, tracker_key: &str, base_revision: i64) -> Result<(), CredentialWriteError> {
        let current_revision = self.current_revision(tracker_key);
        if base_revision != current_revision {
            return Err(CredentialWriteError::Stale { current_revision });
        }
        Ok(())
    }
}

fn validate_key_and_device(tracker_key: &str, device_id: &str) -> Result<(), CredentialWriteError> {
    if !is_valid_tracker_key(tracker_key) {
        return Err(CredentialWriteError::InvalidKey);
    }
    if device_id.len() > MAX_DEVICE_ID_BYTES || device_id.contains('\0') {
        return Err(CredentialWriteError::InvalidValue("deviceId"));
    }
    Ok(())
}

pub fn vault_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TRACKER_CREDENTIALS_FILE)
}

async fn read_vault_unlocked(data_dir: &Path) -> anyhow::Result<TrackerCredentialVault> {
    let path = vault_path(data_dir);
    let sealed = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TrackerCredentialVault {
                schema_version: TRACKER_CREDENTIALS_SCHEMA_VERSION,
                credentials: BTreeMap::new(),
            });
        }
        Err(error) => return Err(error).context("failed to read the tracker credential vault"),
    };
    let opened = tokio::task::spawn_blocking(move || dpapi::unprotect(&sealed))
        .await
        .context("tracker credential vault unseal task failed")?;
    let vault = match opened.and_then(|plain| {
        serde_json::from_slice::<TrackerCredentialVault>(&plain)
            .context("tracker credential vault is not valid JSON")
    }) {
        Ok(vault) => vault,
        Err(_) => {
            // A vault sealed for another Windows user/machine, or a damaged file,
            // cannot be recovered.  Keep it aside for diagnosis (it stays sealed)
            // and start over; devices then converge on the next login they publish.
            let quarantine = path.with_extension("bin.unreadable");
            let _ = tokio::fs::rename(&path, &quarantine).await;
            tracing::warn!("tracker credential vault could not be unsealed; starting empty");
            TrackerCredentialVault {
                schema_version: TRACKER_CREDENTIALS_SCHEMA_VERSION,
                credentials: BTreeMap::new(),
            }
        }
    };
    if vault.schema_version != TRACKER_CREDENTIALS_SCHEMA_VERSION {
        bail!("unsupported tracker credential vault schema");
    }
    Ok(vault)
}

async fn write_vault_unlocked(data_dir: &Path, vault: &TrackerCredentialVault) -> anyhow::Result<()> {
    let plain = serde_json::to_vec(vault).context("failed to encode tracker credential vault")?;
    let sealed = tokio::task::spawn_blocking(move || dpapi::protect(&plain))
        .await
        .context("tracker credential vault seal task failed")??;
    tokio::fs::create_dir_all(data_dir)
        .await
        .context("failed to create syncd data directory")?;
    let path = vault_path(data_dir);
    let temp = path.with_extension("bin.tmp");
    tokio::fs::write(&temp, &sealed)
        .await
        .context("failed to write tracker credential vault")?;
    tokio::fs::rename(&temp, &path)
        .await
        .context("failed to replace tracker credential vault")?;
    Ok(())
}

pub async fn load_vault(data_dir: &Path) -> anyhow::Result<TrackerCredentialVault> {
    let _guard = VAULT_LOCK.lock().await;
    read_vault_unlocked(data_dir).await
}

/// Runs one read-modify-write transaction.  The closure's `Ok(Some(_))`
/// persists the vault; `Ok(None)` leaves the file untouched.
pub async fn update_vault<T>(
    data_dir: &Path,
    update: impl FnOnce(&mut TrackerCredentialVault) -> Result<(T, bool), CredentialWriteError>,
) -> anyhow::Result<Result<T, CredentialWriteError>> {
    let _guard = VAULT_LOCK.lock().await;
    let mut vault = read_vault_unlocked(data_dir).await?;
    match update(&mut vault) {
        Ok((value, changed)) => {
            if changed {
                write_vault_unlocked(data_dir, &vault).await?;
            }
            Ok(Ok(value))
        }
        Err(error) => Ok(Err(error)),
    }
}

/// Mihon/Tachiyomi's AniList preference shape, which the mobile applies verbatim:
/// username = numeric viewer id, password = access token, token = `ALOAuth` JSON.
pub fn mihon_anilist_credential(viewer_id: i64, access_token: &str, now_ms: i64) -> CredentialValues {
    CredentialValues {
        username: viewer_id.to_string(),
        password: access_token.to_string(),
        token: json!({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires": now_ms + ANILIST_OAUTH_LIFETIME_MS,
            "expires_in": ANILIST_OAUTH_LIFETIME_MS,
        })
        .to_string(),
    }
}

/// The access token of an AniList credential, preferring the OAuth JSON.
pub fn anilist_access_token(credential: &StoredTrackerCredential) -> Option<String> {
    serde_json::from_str::<Value>(&credential.token)
        .ok()
        .and_then(|token| {
            token
                .get("access_token")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| Some(credential.password.clone()))
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty() && is_safe_oauth_token(token))
}

/// AniList tokens are JWTs; anything with URL syntax characters would corrupt
/// the synthesized callback URL, so it is refused instead of escaped.
pub fn is_safe_oauth_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= MAX_CREDENTIAL_VALUE_BYTES
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'+' | b'/' | b'='))
}

/// The callback Suwayomi's AniList `authCallback` parses (`access_token=` fragment).
pub fn anilist_oauth_callback_url(access_token: &str) -> String {
    format!(
        "https://suwayomi.org/tracker-oauth#access_token={access_token}&token_type=Bearer&expires_in={}",
        ANILIST_OAUTH_LIFETIME_MS / 1000
    )
}

/// Resolves the AniList viewer id for an access token (`{ Viewer { id } }`).
pub async fn fetch_anilist_viewer_id(access_token: &str) -> anyhow::Result<i64> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .context("failed to build AniList client")?;
    let response = client
        .post("https://graphql.anilist.co")
        .bearer_auth(access_token)
        .header("accept", "application/json")
        .json(&json!({ "query": "{ Viewer { id } }" }))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("AniList viewer request failed"))?;
    if !response.status().is_success() {
        bail!("AniList viewer request returned {}", response.status().as_u16());
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| anyhow::anyhow!("AniList viewer response is not JSON"))?;
    payload
        .pointer("/data/Viewer/id")
        .and_then(Value::as_i64)
        .context("AniList viewer response has no id")
}

#[cfg(windows)]
mod dpapi {
    use anyhow::bail;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// Binds the blob to this application on top of the user/machine key.
    const ENTROPY: &[u8] = b"app.epigraph.desktop/syncd/tracker-credentials/v1";

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    fn take_output(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if output.pbData.is_null() {
            return Vec::new();
        }
        // SAFETY: DPAPI returned `cbData` bytes at `pbData`, allocated with LocalAlloc.
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        // SAFETY: the buffer is owned by us and freed exactly once.
        unsafe {
            LocalFree(output.pbData as _);
        }
        bytes
    }

    pub fn protect(plain: &[u8]) -> anyhow::Result<Vec<u8>> {
        if plain.len() > u32::MAX as usize {
            bail!("tracker credential vault is too large");
        }
        let description: Vec<u16> = super::DPAPI_DESCRIPTION
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let input = blob(plain);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: every pointer refers to a live buffer for the duration of the call.
        let ok = unsafe {
            CryptProtectData(
                &input,
                description.as_ptr(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            bail!("DPAPI could not seal the tracker credential vault");
        }
        Ok(take_output(output))
    }

    pub fn unprotect(sealed: &[u8]) -> anyhow::Result<Vec<u8>> {
        if sealed.len() > u32::MAX as usize {
            bail!("tracker credential vault is too large");
        }
        let input = blob(sealed);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: every pointer refers to a live buffer for the duration of the call.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            bail!("DPAPI could not unseal the tracker credential vault");
        }
        Ok(take_output(output))
    }
}

#[cfg(not(windows))]
mod dpapi {
    // Credentials are only stored where a machine-bound key exists.  The
    // capability is not advertised on other platforms (`is_supported`).
    pub fn protect(_plain: &[u8]) -> anyhow::Result<Vec<u8>> {
        anyhow::bail!("tracker credentials require Windows DPAPI")
    }

    pub fn unprotect(_sealed: &[u8]) -> anyhow::Result<Vec<u8>> {
        anyhow::bail!("tracker credentials require Windows DPAPI")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn values(token: &str) -> CredentialValues {
        CredentialValues {
            username: "user".to_string(),
            password: "pw".to_string(),
            token: token.to_string(),
        }
    }

    #[test]
    fn cas_revisions_start_at_one_and_tombstones_keep_revision() {
        let mut vault = TrackerCredentialVault::default();
        let first = vault.put("anilist", 0, values("t1"), "phone", 10).unwrap();
        assert_eq!(first.revision, 1);
        assert!(!first.deleted);
        assert_eq!(
            vault.put("anilist", 0, values("t2"), "phone", 11),
            Err(CredentialWriteError::Stale { current_revision: 1 })
        );
        let second = vault.put("anilist", 1, values("t2"), "tablet", 12).unwrap();
        assert_eq!(second.revision, 2);
        let tombstone = vault.delete("anilist", 2, "phone", 13).unwrap();
        assert_eq!(tombstone.revision, 3);
        assert!(tombstone.deleted);
        assert!(tombstone.token.is_empty() && tombstone.password.is_empty());
        assert_eq!(
            vault.delete("anilist", 2, "phone", 14),
            Err(CredentialWriteError::Stale { current_revision: 3 })
        );
        assert_eq!(vault.current_revision("anilist"), 3);
        assert_eq!(vault.views().len(), 1);
        let relogin = vault.put("anilist", 3, values("t3"), "phone", 15).unwrap();
        assert_eq!(relogin.revision, 4);
    }

    #[test]
    fn rejects_invalid_keys_and_oversized_values() {
        let mut vault = TrackerCredentialVault::default();
        assert_eq!(
            vault.put("AniList", 0, values("t"), "phone", 1),
            Err(CredentialWriteError::InvalidKey)
        );
        let big = "x".repeat(MAX_CREDENTIAL_VALUE_BYTES + 1);
        assert_eq!(
            vault.put("anilist", 0, values(&big), "phone", 1),
            Err(CredentialWriteError::InvalidValue("token"))
        );
        let exact = "x".repeat(MAX_CREDENTIAL_VALUE_BYTES);
        assert!(vault.put("anilist", 0, values(&exact), "phone", 1).is_ok());
    }

    #[test]
    fn views_never_include_audit_device_id() {
        let mut vault = TrackerCredentialVault::default();
        vault
            .put("anilist", 0, values("t"), "phone-secret-device", 1)
            .unwrap();
        let encoded = serde_json::to_string(&vault.views()).unwrap();
        assert!(!encoded.contains("phone-secret-device"));
        assert!(!encoded.contains("desktopRevision"));
        assert!(!format!("{:?}", vault).contains("pw"));
    }

    #[test]
    fn desktop_revision_tracks_only_the_current_revision() {
        let mut vault = TrackerCredentialVault::default();
        vault.put("anilist", 0, values("t"), "phone", 1).unwrap();
        assert!(!vault.mark_desktop_applied("anilist", 2));
        assert!(vault.mark_desktop_applied("anilist", 1));
        vault.put("anilist", 1, values("t2"), "phone", 2).unwrap();
        assert_eq!(vault.credentials["anilist"].desktop_revision, 1);
    }

    #[test]
    fn builds_mihon_anilist_shape_and_callback() {
        let credential = mihon_anilist_credential(12345, "eyJ.abc-_", 1_000);
        assert_eq!(credential.username, "12345");
        assert_eq!(credential.password, "eyJ.abc-_");
        let token: Value = serde_json::from_str(&credential.token).unwrap();
        assert_eq!(token["access_token"], "eyJ.abc-_");
        assert_eq!(token["token_type"], "Bearer");
        assert_eq!(token["expires"], 1_000 + 31_536_000_000_i64);
        assert_eq!(token["expires_in"], 31_536_000_000_i64);

        let stored = StoredTrackerCredential {
            tracker_key: "anilist".to_string(),
            revision: 1,
            password: "fallback".to_string(),
            token: credential.token,
            ..Default::default()
        };
        assert_eq!(anilist_access_token(&stored).as_deref(), Some("eyJ.abc-_"));
        let fallback = StoredTrackerCredential {
            password: "fallback".to_string(),
            token: "not json".to_string(),
            ..stored.clone()
        };
        assert_eq!(anilist_access_token(&fallback).as_deref(), Some("fallback"));
        let unsafe_token = StoredTrackerCredential {
            password: "a&b=c#d".to_string(),
            token: String::new(),
            ..stored
        };
        assert_eq!(anilist_access_token(&unsafe_token), None);

        assert_eq!(
            anilist_oauth_callback_url("abc"),
            "https://suwayomi.org/tracker-oauth#access_token=abc&token_type=Bearer&expires_in=31536000"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn dpapi_round_trip_keeps_plaintext_off_disk() {
        let temp = tempdir().unwrap();
        let outcome = update_vault(temp.path(), |vault| {
            vault
                .put("anilist", 0, values("plain-token-value"), "phone", 1)
                .map(|view| (view, true))
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(outcome.revision, 1);

        let on_disk = std::fs::read(vault_path(temp.path())).unwrap();
        let haystack = String::from_utf8_lossy(&on_disk);
        assert!(!haystack.contains("plain-token-value"));
        assert!(!haystack.contains("anilist"));

        let reloaded = load_vault(temp.path()).await.unwrap();
        assert_eq!(reloaded.credentials["anilist"].token, "plain-token-value");
        assert_eq!(reloaded.credentials["anilist"].updated_by_device_id, "phone");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn unreadable_vault_is_quarantined() {
        let temp = tempdir().unwrap();
        std::fs::write(vault_path(temp.path()), b"not a dpapi blob").unwrap();
        let vault = load_vault(temp.path()).await.unwrap();
        assert!(vault.credentials.is_empty());
        assert!(temp.path().join("tracker-credentials-v1.bin.unreadable").exists());
    }
}
