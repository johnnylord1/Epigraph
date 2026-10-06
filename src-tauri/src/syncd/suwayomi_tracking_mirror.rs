//! Two-way mirror between `comic.tracking` records and the desktop Suwayomi trackers.
//!
//! * Core -> Suwayomi: a tracking record written by a paired device is bound and updated on
//!   the desktop's Suwayomi profile (`bindTrack` / `updateTrack`); a tombstone unbinds it
//!   locally without deleting the remote tracker entry.
//! * Suwayomi -> Core: bindings made on the desktop are emitted as full-state records, and a
//!   mirrored binding that disappears from Suwayomi becomes a tombstone.
//! * Tracker logins stored through `/v1/tracker-credentials` are applied to Suwayomi: AniList
//!   through its implicit-token OAuth login, the other portable trackers by writing the login
//!   into the profile's `settings/tracker.xml` while Suwayomi is stopped (it only reads that file
//!   at startup). Logins made on the desktop are read back from that file and published.
//!
//! Echo loops are prevented by `suwayomi_tracking_mirror_state`, which remembers per entity the
//! Suwayomi fingerprint and the Core `server_version` both sides last agreed on. A side only
//! "changed" when it differs from that agreement; when both changed the Core wins, which is the
//! same rule the mobile applies to tracker logins.
//!
//! Novels: desktop novel tracking lives in the webview (Hardcover through localStorage) and is
//! not reachable from syncd, so `novel.tracking` is stored, validated and served, but not
//! mirrored into the desktop.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::Context;
use serde_json::{json, Map, Value};
use tokio::sync::Notify;

use super::lifecycle::{wait_for_shutdown_request, ShutdownRequest};
use super::models::{
    canonical_portable_work_id, AuthenticatedSession, EventClock, PortableWorkRefV3,
    SharedAppState,
};
use super::routes::suwayomi_catalog;
use super::suwayomi_tracker_prefs;
use super::tracker_credentials::{
    self, CredentialValues, StoredTrackerCredential, DESKTOP_DEVICE_ID,
};
use super::tracking::{self, COMIC_TRACKING};
use super::{db, myanimelist_oauth, suwayomi_process};

const MIRROR_INTERVAL: Duration = Duration::from_secs(60);
const MIN_REQUESTED_INTERVAL: Duration = Duration::from_millis(1_500);
const MIRROR_DEVICE_ID: &str = "epigraph-core-tracking-mirror";
const MIRROR_TOKEN_ID: &str = "epigraph-core-tracking-mirror";
const PAGE_SIZE: i64 = 250;
const MAX_PAGES: usize = 32;
/// Remote tracker calls per profile and tick; the rest stay pending for the next tick.
const MAX_REMOTE_PUSHES_PER_TICK: usize = 24;

/// Portable tracker keys with a Suwayomi tracker. `(trackerKey, Suwayomi id, Suwayomi name)`.
/// Komga/Kavita/Suwayomi are enhanced, device-local trackers and are never mirrored.
const SUWAYOMI_TRACKERS: [(&str, i64, &str); 6] = [
    ("myanimelist", 1, "myanimelist"),
    ("anilist", 2, "anilist"),
    ("kitsu", 3, "kitsu"),
    ("shikimori", 4, "shikimori"),
    ("bangumi", 5, "bangumi"),
    ("mangaupdates", 7, "mangaupdates"),
];

const TRACK_RECORD_FIELDS: &str = "id mangaId trackerId remoteId libraryId title lastChapterRead \
     totalChapters status score remoteUrl startDate finishDate";

const TRACKERS_QUERY: &str = r#"
  query EpigraphTrackingMirrorTrackers {
    trackers {
      nodes { id name isLoggedIn scores }
    }
  }
"#;

const LIBRARY_IDENTITY_QUERY: &str = r#"
  query EpigraphTrackingMirrorLibrary($first: Int!, $offset: Int!) {
    mangas(condition: { inLibrary: true }, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id url sourceId }
    }
  }
"#;

fn track_records_query() -> String {
    format!(
        r#"
  query EpigraphTrackingMirrorRecords($first: Int!, $offset: Int!) {{
    trackRecords(first: $first, offset: $offset) {{
      pageInfo {{ hasNextPage }}
      nodes {{ {TRACK_RECORD_FIELDS} manga {{ id url sourceId }} }}
    }}
  }}
"#
    )
}

fn bind_track_mutation() -> String {
    format!(
        r#"
  mutation EpigraphTrackingMirrorBind($mangaId: Int!, $trackerId: Int!, $remoteId: LongString!) {{
    bindTrack(input: {{ mangaId: $mangaId, trackerId: $trackerId, remoteId: $remoteId }}) {{
      trackRecord {{ {TRACK_RECORD_FIELDS} }}
    }}
  }}
"#
    )
}

fn update_track_mutation() -> String {
    format!(
        r#"
  mutation EpigraphTrackingMirrorUpdate($recordId: Int!, $status: Int, $lastChapterRead: Float, $scoreString: String, $startDate: LongString, $finishDate: LongString) {{
    updateTrack(input: {{ recordId: $recordId, status: $status, lastChapterRead: $lastChapterRead, scoreString: $scoreString, startDate: $startDate, finishDate: $finishDate }}) {{
      trackRecord {{ {TRACK_RECORD_FIELDS} }}
    }}
  }}
"#
    )
}

const UNBIND_TRACK_MUTATION: &str = r#"
  mutation EpigraphTrackingMirrorUnbind($recordId: Int!) {
    unbindTrack(input: { recordId: $recordId, deleteRemoteTrack: false }) {
      trackRecord { id }
    }
  }
"#;

const LOGIN_TRACKER_OAUTH_MUTATION: &str = r#"
  mutation EpigraphTrackingMirrorLogin($trackerId: Int!, $callbackUrl: String!) {
    loginTrackerOAuth(input: { trackerId: $trackerId, callbackUrl: $callbackUrl }) {
      isLoggedIn
    }
  }
"#;

const LOGOUT_TRACKER_MUTATION: &str = r#"
  mutation EpigraphTrackingMirrorLogout($trackerId: Int!) {
    logoutTracker(input: { trackerId: $trackerId }) {
      tracker { id isLoggedIn }
    }
  }
"#;

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// Asks the tracking mirror to run now (a device wrote a tracking record or a login).
pub fn request_immediate_mirror() {
    wake().notify_one();
}

pub fn spawn_tracking_mirror_task(
    state: SharedAppState,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        tracing::info!("Suwayomi tracking mirror started");
        // The first tick waits one interval, like the progress mirror, so Core startup and
        // pairing are not contended; it doubles as the one-time backfill (see `decide`).
        let mut ticker = tokio::time::interval_at(
            tokio::time::Instant::now() + MIRROR_INTERVAL,
            MIRROR_INTERVAL,
        );
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_tick: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = wake().notified() => {
                    let wait = last_tick
                        .map(|at| MIN_REQUESTED_INTERVAL.saturating_sub(at.elapsed()))
                        .unwrap_or_default();
                    if !wait.is_zero() {
                        tokio::select! {
                            _ = tokio::time::sleep(wait) => {}
                            _ = wait_for_shutdown_request(&mut shutdown) => break,
                        }
                    }
                    ticker.reset();
                }
                _ = wait_for_shutdown_request(&mut shutdown) => break,
            }
            match mirror_all_profiles(&state).await {
                Ok(changed) => {
                    tracing::debug!(changed, "Suwayomi tracking mirror tick completed")
                }
                Err(error) => {
                    tracing::warn!(error = %error, "Suwayomi tracking mirror tick failed")
                }
            }
            last_tick = Some(tokio::time::Instant::now());
        }
    });
}

fn mirror_session(profile_id: &str) -> AuthenticatedSession {
    AuthenticatedSession {
        token_id: MIRROR_TOKEN_ID.to_string(),
        device_id: MIRROR_DEVICE_ID.to_string(),
        profile_id: profile_id.to_string(),
        scopes: BTreeSet::from([format!("comics:profile:{profile_id}")]),
        mutation_receipt: None,
    }
}

async fn mirror_all_profiles(state: &SharedAppState) -> anyhow::Result<usize> {
    let instances = suwayomi_process::attach_owned_instances();
    if instances.is_empty() {
        return Ok(0);
    }
    myanimelist_oauth::renew_stored_login_if_due(&state.config.data_dir).await;
    let pending_credentials = pending_desktop_credentials(state).await;
    let mut credential_failures: HashSet<String> = HashSet::new();
    let mut changed = 0usize;
    for instance in &instances {
        let session = mirror_session(&instance.profile_key);
        if !pending_credentials.is_empty() {
            for key in apply_credentials_to_profile(state, &session, &pending_credentials).await {
                credential_failures.insert(key);
            }
        }
        match mirror_profile(state, &session).await {
            Ok(count) => changed += count,
            Err(error) => tracing::warn!(
                profile = %instance.profile_key,
                error = %error,
                "Suwayomi tracking mirror skipped profile"
            ),
        }
    }
    if !pending_credentials.is_empty() {
        credential_failures.extend(apply_file_logins(state, &pending_credentials).await);
    }
    for credential in &pending_credentials {
        if credential_failures.contains(&credential.tracker_key) {
            continue;
        }
        let key = credential.tracker_key.clone();
        let revision = credential.revision;
        let marked = tracker_credentials::update_vault(&state.config.data_dir, |vault| {
            let changed = vault.mark_desktop_applied(&key, revision);
            Ok((changed, changed))
        })
        .await;
        if let Err(error) = marked {
            tracing::warn!(error = %error, "could not record an applied tracker login");
        }
    }
    publish_desktop_logins(state).await;
    Ok(changed)
}

// ---------------------------------------------------------------------------------------------
// Tracker logins (Core -> desktop Suwayomi)
// ---------------------------------------------------------------------------------------------

/// What the desktop can do with a stored login it has not applied yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialAction {
    /// Log Suwayomi in with this synthesized OAuth callback URL (kept out of `Debug` output).
    LoginOAuth { tracker_id: i64, callback_url: RedactedUrl },
    /// Log Suwayomi out of this tracker.
    Logout { tracker_id: i64 },
    /// Nothing to do on the desktop (non-injectable tracker, or a logout of a login the desktop
    /// never received from the Core).
    Skip,
}

#[derive(Clone, PartialEq, Eq)]
pub struct RedactedUrl(pub String);

impl std::fmt::Debug for RedactedUrl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<redacted callback>")
    }
}

pub fn credential_action(credential: &StoredTrackerCredential) -> CredentialAction {
    // AniList's implicit-token login is replayed through Suwayomi, which also fetches the
    // user's score format. The other trackers go through `file_login_change`.
    if credential.tracker_key != "anilist" {
        return CredentialAction::Skip;
    }
    let tracker_id = 2;
    if credential.deleted {
        // A logout only follows a login that came from (or was published by) the desktop.
        if credential.desktop_revision == 0 {
            return CredentialAction::Skip;
        }
        return CredentialAction::Logout { tracker_id };
    }
    match tracker_credentials::anilist_access_token(credential) {
        Some(token) => CredentialAction::LoginOAuth {
            tracker_id,
            callback_url: RedactedUrl(tracker_credentials::anilist_oauth_callback_url(&token)),
        },
        None => CredentialAction::Skip,
    }
}

async fn pending_desktop_credentials(state: &SharedAppState) -> Vec<StoredTrackerCredential> {
    if !tracker_credentials::is_supported() {
        return Vec::new();
    }
    match tracker_credentials::load_vault(&state.config.data_dir).await {
        Ok(vault) => vault
            .credentials
            .into_values()
            .filter(|credential| credential.revision != credential.desktop_revision)
            .collect(),
        Err(error) => {
            tracing::warn!(error = %error, "tracker credential vault unavailable for the mirror");
            Vec::new()
        }
    }
}

/// Applies pending logins to one profile; returns the tracker keys that failed and must retry.
async fn apply_credentials_to_profile(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    pending: &[StoredTrackerCredential],
) -> Vec<String> {
    let trackers = match fetch_trackers(state, session).await {
        Ok(trackers) => trackers,
        Err(_) => return pending.iter().map(|c| c.tracker_key.clone()).collect(),
    };
    let mut failures = Vec::new();
    for credential in pending {
        let action = credential_action(credential);
        let result = match &action {
            CredentialAction::Skip => Ok(()),
            CredentialAction::LoginOAuth {
                tracker_id,
                callback_url,
            } => {
                if !verified_tracker(&trackers, &credential.tracker_key, *tracker_id) {
                    Err(anyhow::anyhow!("tracker id is not verified"))
                } else {
                    suwayomi_catalog::execute_graphql_document(
                        state,
                        session,
                        LOGIN_TRACKER_OAUTH_MUTATION,
                        json!({ "trackerId": tracker_id, "callbackUrl": callback_url.0 }),
                        true,
                    )
                    .await
                    .map_err(|_| anyhow::anyhow!("Suwayomi rejected the tracker login"))
                    .and_then(|data| {
                        data.pointer("/loginTrackerOAuth/isLoggedIn")
                            .and_then(Value::as_bool)
                            .filter(|logged_in| *logged_in)
                            .map(|_| ())
                            .context("Suwayomi did not log the tracker in")
                    })
                }
            }
            CredentialAction::Logout { tracker_id } => {
                let logged_in = trackers
                    .iter()
                    .find(|tracker| tracker.id == *tracker_id)
                    .is_some_and(|tracker| tracker.is_logged_in);
                if !logged_in || !verified_tracker(&trackers, &credential.tracker_key, *tracker_id) {
                    Ok(())
                } else {
                    suwayomi_catalog::execute_graphql_document(
                        state,
                        session,
                        LOGOUT_TRACKER_MUTATION,
                        json!({ "trackerId": tracker_id }),
                        true,
                    )
                    .await
                    .map(|_| ())
                    .map_err(|_| anyhow::anyhow!("Suwayomi rejected the tracker logout"))
                }
            }
        };
        match result {
            Ok(()) => {
                if action != CredentialAction::Skip {
                    tracing::info!(
                        profile = %session.profile_id,
                        tracker_key = %credential.tracker_key,
                        revision = credential.revision,
                        logout = credential.deleted,
                        "applied a synced tracker login to Suwayomi"
                    );
                }
            }
            Err(error) => {
                tracing::warn!(
                    profile = %session.profile_id,
                    tracker_key = %credential.tracker_key,
                    error = %error,
                    "could not apply a synced tracker login; will retry"
                );
                failures.push(credential.tracker_key.clone());
            }
        }
    }
    failures
}

/// What a pending login means for the main profile's `tracker.xml`: the Suwayomi tracker id
/// and the login to write (`None` removes it). AniList is replayed through OAuth instead, and a
/// logout of a login the desktop never had leaves the desktop's own login alone.
pub fn file_login_change(
    credential: &StoredTrackerCredential,
) -> Option<(i64, Option<CredentialValues>)> {
    let (_, tracker_id, _) = SUWAYOMI_TRACKERS
        .iter()
        .find(|(key, _, _)| *key == credential.tracker_key && *key != "anilist")?;
    if credential.deleted {
        return (credential.desktop_revision != 0).then_some((*tracker_id, None));
    }
    // Suwayomi, like the phone, is logged in only with a username and a password; a leftover
    // token alone is a logout.
    if credential.username.is_empty() || credential.password.is_empty() {
        return Some((*tracker_id, None));
    }
    Some((
        *tracker_id,
        Some(CredentialValues {
            username: credential.username.clone(),
            password: credential.password.clone(),
            token: credential.token.clone(),
        }),
    ))
}

/// Writes pending logins into the main profile's `tracker.xml`, restarting its Suwayomi only
/// when the file does not already hold them; returns the tracker keys that must retry.
async fn apply_file_logins(
    state: &SharedAppState,
    pending: &[StoredTrackerCredential],
) -> Vec<String> {
    let changes: Vec<(&str, i64, Option<CredentialValues>)> = pending
        .iter()
        .filter_map(|credential| {
            file_login_change(credential)
                .map(|(tracker_id, login)| (credential.tracker_key.as_str(), tracker_id, login))
        })
        .collect();
    if changes.is_empty() {
        return Vec::new();
    }
    let all_keys = || {
        changes
            .iter()
            .map(|(key, _, _)| key.to_string())
            .collect::<Vec<_>>()
    };
    let Some(main) = suwayomi_process::attach_main_owned_instance() else {
        return all_keys();
    };
    let trackers = match fetch_trackers(state, &mirror_session(&main.profile_key)).await {
        Ok(trackers) => trackers,
        Err(_) => return all_keys(),
    };
    let (verified, unverified): (Vec<_>, Vec<_>) = changes
        .iter()
        .partition(|(key, tracker_id, _)| verified_tracker(&trackers, key, *tracker_id));
    let mut failures: Vec<String> = unverified
        .iter()
        .map(|(key, _, _)| key.to_string())
        .collect();
    for key in &failures {
        tracing::warn!(tracker_key = %key, "synced tracker login targets an unverified Suwayomi tracker; will retry");
    }
    let apply = |entries: &mut Vec<(String, String)>| {
        verified
            .iter()
            .fold(false, |dirty, (_, tracker_id, login)| {
                suwayomi_tracker_prefs::set_credential(entries, *tracker_id, login.as_ref())
                    || dirty
            })
    };
    let mut entries = match suwayomi_tracker_prefs::read_entries(&main.root_dir) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(error = %error, "could not read the desktop tracker logins; will retry");
            return all_keys();
        }
    };
    if !apply(&mut entries) {
        return failures;
    }
    let keys: Vec<&str> = verified.iter().map(|(key, _, _)| *key).collect();
    tracing::info!(trackers = ?keys, "restarting the desktop Suwayomi to apply synced tracker logins");
    let written = suwayomi_process::edit_main_profile_while_stopped(|root| {
        // Suwayomi may have written the file since it was read above.
        let mut entries = suwayomi_tracker_prefs::read_entries(root)?;
        apply(&mut entries);
        suwayomi_process::write_profile_file(
            &suwayomi_tracker_prefs::tracker_prefs_path(root),
            suwayomi_tracker_prefs::render(&entries)?.as_bytes(),
        )
    })
    .await;
    match written {
        Ok(()) => tracing::info!(trackers = ?keys, "applied synced tracker logins to Suwayomi"),
        Err(error) => {
            tracing::warn!(
                trackers = ?keys,
                error = %crate::suwayomi_runtime::sanitize_log_line(&error, &[]),
                "could not apply synced tracker logins; will retry"
            );
            failures.extend(keys.iter().map(|key| key.to_string()));
        }
    }
    failures
}

// ---------------------------------------------------------------------------------------------
// Tracker logins (desktop Suwayomi -> Core)
// ---------------------------------------------------------------------------------------------

/// The vault write a desktop login implies: `Some(Some(_))` publishes a login, `Some(None)` a
/// logout. Nothing while a Core login is still pending for the desktop (the Core wins), or
/// when the desktop already matches the Core.
pub fn desktop_login_change(
    stored: Option<&StoredTrackerCredential>,
    desktop: Option<&CredentialValues>,
) -> Option<Option<CredentialValues>> {
    if stored.is_some_and(|stored| stored.revision != stored.desktop_revision) {
        return None;
    }
    let current = stored
        .filter(|stored| !stored.deleted)
        .map(|stored| CredentialValues {
            username: stored.username.clone(),
            password: stored.password.clone(),
            token: stored.token.clone(),
        });
    match (current, desktop) {
        (current, Some(desktop)) if current.as_ref() != Some(desktop) => {
            Some(Some(desktop.clone()))
        }
        (Some(_), None) => Some(None),
        _ => None,
    }
}

/// Publishes logins made (or refreshed, or logged out) in the desktop Suwayomi, so paired
/// devices log in without asking the user again.
async fn publish_desktop_logins(state: &SharedAppState) {
    if !tracker_credentials::is_supported() {
        return;
    }
    let Some(main) = suwayomi_process::attach_main_owned_instance() else {
        return;
    };
    let Ok(trackers) = fetch_trackers(state, &mirror_session(&main.profile_key)).await else {
        return;
    };
    let entries = match suwayomi_tracker_prefs::read_entries(&main.root_dir) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(error = %error, "could not read the desktop tracker logins");
            return;
        }
    };
    let verified = verified_tracker_map(&trackers);
    for (tracker_key, tracker_id, _) in SUWAYOMI_TRACKERS {
        if !verified.contains_key(tracker_key) {
            continue;
        }
        let desktop = suwayomi_tracker_prefs::credential(&entries, tracker_id);
        let now_ms = db::now_ms();
        let outcome = tracker_credentials::update_vault(&state.config.data_dir, |vault| {
            let Some(change) =
                desktop_login_change(vault.credentials.get(tracker_key), desktop.as_ref())
            else {
                return Ok((None, false));
            };
            let base_revision = vault.current_revision(tracker_key);
            let view = match change {
                Some(values) => vault.put(
                    tracker_key,
                    base_revision,
                    values,
                    DESKTOP_DEVICE_ID,
                    now_ms,
                )?,
                None => vault.delete(tracker_key, base_revision, DESKTOP_DEVICE_ID, now_ms)?,
            };
            // Suwayomi on this desktop already holds this login; nothing to apply back.
            vault.mark_desktop_applied(tracker_key, view.revision);
            Ok((Some((view.revision, view.deleted)), true))
        })
        .await;
        match outcome {
            Ok(Ok(Some((revision, logout)))) => tracing::info!(
                tracker_key = %tracker_key,
                revision,
                logout,
                "desktop tracker login published"
            ),
            Ok(Ok(None)) => {}
            Ok(Err(error)) => {
                tracing::warn!(tracker_key = %tracker_key, error = ?error, "desktop tracker login was not published")
            }
            Err(error) => {
                tracing::warn!(error = %error, "tracker credential vault unavailable for the mirror")
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Trackers and key mapping
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct SuwayomiTracker {
    pub id: i64,
    pub name: String,
    pub is_logged_in: bool,
    pub scores: Vec<String>,
}

#[cfg(test)]
pub fn suwayomi_tracker_id_for_key(tracker_key: &str) -> Option<i64> {
    SUWAYOMI_TRACKERS
        .iter()
        .find(|(key, _, _)| *key == tracker_key)
        .map(|(_, id, _)| *id)
}

pub fn tracker_key_for_suwayomi_id(tracker_id: i64) -> Option<&'static str> {
    SUWAYOMI_TRACKERS
        .iter()
        .find(|(_, id, _)| *id == tracker_id)
        .map(|(key, _, _)| *key)
}

fn normalized_tracker_name(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

/// The fixed id is only trusted when the running Suwayomi reports the expected tracker name
/// for it, so a Suwayomi that renumbers trackers can never receive another tracker's data.
pub fn verified_tracker(trackers: &[SuwayomiTracker], tracker_key: &str, tracker_id: i64) -> bool {
    let Some((_, expected_id, expected_name)) = SUWAYOMI_TRACKERS
        .iter()
        .find(|(key, _, _)| *key == tracker_key)
    else {
        return false;
    };
    *expected_id == tracker_id
        && trackers.iter().any(|tracker| {
            tracker.id == tracker_id && normalized_tracker_name(&tracker.name) == *expected_name
        })
}

/// trackerKey -> verified Suwayomi tracker.
pub fn verified_tracker_map(trackers: &[SuwayomiTracker]) -> HashMap<&'static str, SuwayomiTracker> {
    SUWAYOMI_TRACKERS
        .iter()
        .filter_map(|(key, id, _)| {
            verified_tracker(trackers, key, *id).then(|| {
                let tracker = trackers.iter().find(|tracker| tracker.id == *id)?;
                Some((*key, tracker.clone()))
            })?
        })
        .collect()
}

async fn fetch_trackers(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> anyhow::Result<Vec<SuwayomiTracker>> {
    let data = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        TRACKERS_QUERY,
        json!({}),
        false,
    )
    .await
    .map_err(|error| anyhow::anyhow!("trackers query failed: {error:?}"))?;
    let nodes = data
        .pointer("/trackers/nodes")
        .and_then(Value::as_array)
        .context("invalid trackers response")?;
    Ok(nodes
        .iter()
        .filter_map(|node| {
            Some(SuwayomiTracker {
                id: node.get("id").and_then(Value::as_i64)?,
                name: node.get("name").and_then(Value::as_str)?.to_string(),
                is_logged_in: node.get("isLoggedIn").and_then(Value::as_bool).unwrap_or(false),
                scores: node
                    .get("scores")
                    .and_then(Value::as_array)
                    .map(|scores| {
                        scores
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------------------------

/// Mirrors Suwayomi/Mihon `indexToScore`: the internal score a `scores[index]` choice stores.
pub fn index_to_score(tracker_key: &str, scores: &[String], index: usize) -> Option<f64> {
    let i = index as f64;
    match tracker_key {
        "anilist" => Some(match scores.len() {
            11 => i * 10.0,
            6 if index == 0 => 0.0,
            6 => i * 20.0 - 10.0,
            4 if index == 0 => 0.0,
            4 => i * 25.0 + 10.0,
            _ => i,
        }),
        "kitsu" => Some(if index > 0 { (i + 1.0) / 2.0 } else { 0.0 }),
        "mangaupdates" => scores.get(index)?.trim().parse::<f64>().ok(),
        _ => Some(i),
    }
}

/// The `scoreString` whose internal score is nearest to `desired`, or `None` when the current
/// Suwayomi score already equals that nearest choice (so no score update is sent).
pub fn score_string_for(
    tracker_key: &str,
    scores: &[String],
    desired: f64,
    current: f64,
) -> Option<String> {
    if !desired.is_finite() || scores.is_empty() {
        return None;
    }
    let (index, value) = (0..scores.len())
        .filter_map(|index| Some((index, index_to_score(tracker_key, scores, index)?)))
        .min_by(|(_, left), (_, right)| {
            (left - desired)
                .abs()
                .partial_cmp(&(right - desired).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })?;
    if (value - current).abs() < 1e-6 {
        return None;
    }
    Some(scores[index].clone())
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct SuwayomiTrackRecord {
    pub id: i64,
    pub manga_id: i64,
    pub tracker_id: i64,
    pub remote_id: i64,
    pub library_id: Option<i64>,
    pub title: String,
    pub remote_url: String,
    pub status: i64,
    pub last_chapter_read: f64,
    pub total_chapters: i64,
    pub score: f64,
    pub start_date: i64,
    pub finish_date: i64,
}

fn long_value(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().filter(|v| v.is_finite()).map(|v| v as i64)),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn float_value(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|value| value.is_finite())
}

pub fn parse_track_record(node: &Value) -> Option<SuwayomiTrackRecord> {
    Some(SuwayomiTrackRecord {
        id: long_value(node.get("id")).filter(|id| *id > 0)?,
        manga_id: long_value(node.get("mangaId"))
            .or_else(|| long_value(node.pointer("/manga/id")))
            .filter(|id| *id > 0)?,
        tracker_id: long_value(node.get("trackerId"))?,
        remote_id: long_value(node.get("remoteId"))?,
        library_id: long_value(node.get("libraryId")),
        title: node.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
        remote_url: node
            .get("remoteUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        status: long_value(node.get("status")).unwrap_or(0),
        last_chapter_read: float_value(node.get("lastChapterRead")).unwrap_or(0.0),
        total_chapters: long_value(node.get("totalChapters")).unwrap_or(0),
        score: float_value(node.get("score")).unwrap_or(0.0),
        start_date: long_value(node.get("startDate")).unwrap_or(0).max(0),
        finish_date: long_value(node.get("finishDate")).unwrap_or(0).max(0),
    })
}

/// Stable fingerprint of the Suwayomi-side binding, used to detect desktop changes.
pub fn suwayomi_fingerprint(record: &SuwayomiTrackRecord) -> String {
    json!([
        record.remote_id,
        record.library_id,
        record.status,
        record.last_chapter_read,
        record.total_chapters,
        record.score,
        record.start_date,
        record.finish_date,
        record.title,
        record.remote_url,
    ])
    .to_string()
}

/// The full-state wire record for a Suwayomi binding (same shape the mobile emits).
pub fn core_record_from_suwayomi(
    comic_id: &str,
    tracker_key: &str,
    record: &SuwayomiTrackRecord,
    updated_at_ms: i64,
) -> Value {
    json!({
        "trackingId": tracking::tracking_entity_id(COMIC_TRACKING, comic_id, tracker_key),
        "comicId": comic_id,
        "trackerKey": tracker_key,
        "remoteId": record.remote_id,
        "libraryId": record.library_id,
        "title": record.title,
        "remoteUrl": record.remote_url,
        "status": record.status,
        "progress": record.last_chapter_read,
        "totalChapters": record.total_chapters,
        "score": record.score,
        "startedAtMs": record.start_date,
        "finishedAtMs": record.finish_date,
        "updatedAtMs": updated_at_ms,
    })
}

/// The fields of a Core record the desktop can push into Suwayomi.
#[derive(Debug, Clone, PartialEq)]
pub struct CoreTrackingFields {
    pub remote_id: i64,
    pub status: i64,
    pub progress: f64,
    pub score: f64,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
}

pub fn core_tracking_fields(record: &Value) -> Option<CoreTrackingFields> {
    Some(CoreTrackingFields {
        remote_id: long_value(record.get("remoteId")).filter(|id| *id != 0)?,
        status: long_value(record.get("status")).unwrap_or(0),
        progress: float_value(record.get("progress")).unwrap_or(0.0),
        score: float_value(record.get("score")).unwrap_or(0.0),
        started_at_ms: long_value(record.get("startedAtMs")).unwrap_or(0).max(0),
        finished_at_ms: long_value(record.get("finishedAtMs")).unwrap_or(0).max(0),
    })
}

/// `updateTrack` variables that bring `current` to the Core values; `None` when nothing differs.
pub fn update_track_variables(
    tracker_key: &str,
    scores: &[String],
    core: &CoreTrackingFields,
    current: &SuwayomiTrackRecord,
) -> Option<Value> {
    let mut variables = Map::new();
    if core.status != current.status {
        variables.insert("status".to_string(), json!(core.status));
    }
    if (core.progress - current.last_chapter_read).abs() > 1e-6 {
        variables.insert("lastChapterRead".to_string(), json!(core.progress));
    }
    if let Some(score) = score_string_for(tracker_key, scores, core.score, current.score) {
        variables.insert("scoreString".to_string(), json!(score));
    }
    if core.started_at_ms != current.start_date {
        variables.insert("startDate".to_string(), json!(core.started_at_ms.to_string()));
    }
    if core.finished_at_ms != current.finish_date {
        variables.insert("finishDate".to_string(), json!(core.finished_at_ms.to_string()));
    }
    if variables.is_empty() {
        return None;
    }
    variables.insert("recordId".to_string(), json!(current.id));
    Some(Value::Object(variables))
}

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreSide {
    Live,
    Tombstone,
    Absent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Nothing,
    /// Bind/update Suwayomi from the Core record.
    PushLive,
    /// Unbind the Suwayomi record (remote tracker entry kept).
    PushUnbind,
    /// Write the Suwayomi binding to the Core.
    EmitRecord,
    /// Tombstone the Core record (binding removed on the desktop).
    EmitTombstone,
    /// Neither side has the binding any more; drop the agreement.
    ForgetState,
}

/// `state` is the last agreement `(suwayomi fingerprint, core server_version)`; `None` means the
/// entity was never mirrored, which is the one-time backfill: the Core wins where both sides
/// have a binding, and each side's lone binding is copied to the other.
pub fn decide(
    core: CoreSide,
    core_version: i64,
    suwayomi_fingerprint: Option<&str>,
    state: Option<(Option<&str>, i64)>,
) -> Decision {
    let Some((agreed_fingerprint, agreed_version)) = state else {
        return match (core, suwayomi_fingerprint) {
            (CoreSide::Live, _) => Decision::PushLive,
            (_, Some(_)) => Decision::EmitRecord,
            (_, None) => Decision::Nothing,
        };
    };
    let core_changed = core_version != agreed_version;
    let suwayomi_changed = suwayomi_fingerprint != agreed_fingerprint;
    if core_changed {
        return match (core, suwayomi_fingerprint) {
            (CoreSide::Live, _) => Decision::PushLive,
            (_, Some(_)) => Decision::PushUnbind,
            (_, None) => Decision::ForgetState,
        };
    }
    if suwayomi_changed {
        return match (core, suwayomi_fingerprint) {
            (_, Some(_)) => Decision::EmitRecord,
            (CoreSide::Live, None) => Decision::EmitTombstone,
            (_, None) => Decision::ForgetState,
        };
    }
    if core != CoreSide::Live && suwayomi_fingerprint.is_none() {
        return Decision::ForgetState;
    }
    Decision::Nothing
}

/// An event clock that orders a desktop observation after the record it is based on. The
/// caller already proved the Core record did not change since the last agreement, so the
/// desktop edit is the newer fact even when a paired device's clock runs ahead.
pub fn mirror_event_clock(current: Option<(i64, i64)>, now_ms: i64) -> EventClock {
    let (physical_ms, logical) = match current {
        Some((physical, logical)) if physical >= now_ms => (physical, logical.saturating_add(1)),
        _ => (now_ms, 0),
    };
    EventClock {
        physical_ms,
        logical,
        device_generation_id: MIRROR_DEVICE_ID.to_string(),
    }
}

pub fn comic_id_for(source_id: &str, manga_url: &str) -> Option<String> {
    let reference = PortableWorkRefV3::comic(source_id, manga_url);
    reference.validate().ok()?;
    Some(canonical_portable_work_id(&reference))
}

fn scalar_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

struct CoreEntity {
    side: CoreSide,
    version: i64,
    fields: Option<CoreTrackingFields>,
    tracker_key: String,
    comic_id: String,
}

async fn mirror_profile(state: &SharedAppState, session: &AuthenticatedSession) -> anyhow::Result<usize> {
    let profile_id = session.profile_id.as_str();
    let scope_id = format!("comics:profile:{profile_id}");

    let trackers = fetch_trackers(state, session).await?;
    let tracker_map = verified_tracker_map(&trackers);
    let (suwayomi_records, mut manga_by_comic) = fetch_track_records(state, session).await?;
    for (comic_id, manga_id) in fetch_library_identities(state, session).await? {
        manga_by_comic.entry(comic_id).or_insert(manga_id);
    }

    // entity id -> Suwayomi binding
    let mut suwayomi: HashMap<String, SuwayomiTrackRecord> = HashMap::new();
    for (comic_id, record) in suwayomi_records {
        let Some(tracker_key) = tracker_key_for_suwayomi_id(record.tracker_id) else {
            continue;
        };
        if !tracker_map.contains_key(tracker_key) {
            continue;
        }
        let entity_id = tracking::tracking_entity_id(COMIC_TRACKING, &comic_id, tracker_key);
        suwayomi.entry(entity_id).or_insert(record);
    }

    let mut core: HashMap<String, CoreEntity> = HashMap::new();
    for row in db::list_tracking_records(&state.pool, &scope_id, COMIC_TRACKING).await? {
        let record: Value = serde_json::from_str(&row.record_json).unwrap_or(Value::Null);
        core.insert(
            row.entity_id.clone(),
            CoreEntity {
                side: CoreSide::Live,
                version: row.record_server_version,
                fields: core_tracking_fields(&record),
                tracker_key: row.tracker_key,
                comic_id: row.work_id,
            },
        );
    }
    for row in db::list_tracking_tombstones(&state.pool, &scope_id, COMIC_TRACKING).await? {
        if core.contains_key(&row.entity_id) {
            continue;
        }
        let Some(identity) = tracking::parse_tracking_entity_id(COMIC_TRACKING, &row.entity_id)
        else {
            continue;
        };
        core.insert(
            row.entity_id.clone(),
            CoreEntity {
                side: CoreSide::Tombstone,
                version: row.server_version,
                fields: None,
                tracker_key: identity.tracker_key,
                comic_id: identity.work_id,
            },
        );
    }
    let agreements: HashMap<String, (Option<String>, i64)> =
        db::list_suwayomi_tracking_mirror_state(&state.pool, profile_id)
            .await?
            .into_iter()
            .map(|row| (row.entity_id, (row.suwayomi_fingerprint, row.core_server_version)))
            .collect();

    let mut entity_ids: Vec<String> = core
        .keys()
        .chain(suwayomi.keys())
        .chain(agreements.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    // Core -> Suwayomi first, so a device's edit is not overwritten by a stale desktop read.
    entity_ids.sort_by_key(|entity_id| !core.contains_key(entity_id));

    let mut changed = 0usize;
    let mut remote_pushes = 0usize;
    for entity_id in entity_ids {
        let Some(identity) = tracking::parse_tracking_entity_id(COMIC_TRACKING, &entity_id) else {
            continue;
        };
        let core_entity = core.get(&entity_id);
        let side = core_entity.map(|entity| entity.side).unwrap_or(CoreSide::Absent);
        let core_version = core_entity.map(|entity| entity.version).unwrap_or(0);
        let suwayomi_record = suwayomi.get(&entity_id);
        let fingerprint = suwayomi_record.map(suwayomi_fingerprint);
        let agreement = agreements.get(&entity_id);
        let decision = decide(
            side,
            core_version,
            fingerprint.as_deref(),
            agreement.map(|(fingerprint, version)| (fingerprint.as_deref(), *version)),
        );
        let tracker_key = core_entity
            .map(|entity| entity.tracker_key.as_str())
            .unwrap_or(identity.tracker_key.as_str());
        let comic_id = core_entity
            .map(|entity| entity.comic_id.as_str())
            .unwrap_or(identity.work_id.as_str());
        let result = match decision {
            Decision::Nothing => Ok(false),
            Decision::ForgetState => {
                db::delete_suwayomi_tracking_mirror_state(&state.pool, profile_id, &entity_id)
                    .await?;
                Ok(false)
            }
            Decision::PushLive | Decision::PushUnbind => {
                // A tracker that is unknown, unverified or logged out keeps the record pending.
                let Some(tracker) = tracker_map.get(tracker_key).filter(|t| t.is_logged_in) else {
                    continue;
                };
                if remote_pushes >= MAX_REMOTE_PUSHES_PER_TICK {
                    continue;
                }
                remote_pushes += 1;
                if decision == Decision::PushUnbind {
                    push_unbind(state, session, suwayomi_record, &entity_id, core_version).await
                } else {
                    let Some(fields) = core_entity.and_then(|entity| entity.fields.clone()) else {
                        continue;
                    };
                    let manga_id = match manga_by_comic.get(comic_id) {
                        Some(manga_id) => Some(*manga_id),
                        None => bound_manga_id(state, profile_id, comic_id).await?,
                    };
                    let Some(manga_id) = manga_id else {
                        // The title is not on this desktop yet; retry once it is.
                        continue;
                    };
                    push_live(
                        state,
                        session,
                        tracker_key,
                        tracker,
                        manga_id,
                        &fields,
                        suwayomi_record,
                        &entity_id,
                        core_version,
                    )
                    .await
                }
            }
            Decision::EmitRecord => {
                let Some(record) = suwayomi_record else {
                    continue;
                };
                emit_record(
                    state,
                    session,
                    &scope_id,
                    &entity_id,
                    comic_id,
                    tracker_key,
                    record,
                    core_version,
                    agreement.is_some(),
                )
                .await
            }
            Decision::EmitTombstone => {
                emit_tombstone(state, session, &scope_id, &entity_id, core_version).await
            }
        };
        match result {
            Ok(true) => changed += 1,
            Ok(false) => {}
            Err(error) => tracing::warn!(
                profile = %profile_id,
                tracker_key = %tracker_key,
                error = %error,
                "tracking mirror could not reconcile a binding; will retry"
            ),
        }
    }
    Ok(changed)
}

#[allow(clippy::too_many_arguments)]
async fn push_live(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    tracker_key: &str,
    tracker: &SuwayomiTracker,
    manga_id: i64,
    fields: &CoreTrackingFields,
    existing: Option<&SuwayomiTrackRecord>,
    entity_id: &str,
    core_version: i64,
) -> anyhow::Result<bool> {
    let mut current = existing.cloned();
    if let Some(record) = current.as_ref() {
        if record.remote_id != fields.remote_id || record.manga_id != manga_id {
            unbind_record(state, session, record.id).await?;
            current = None;
        }
    }
    let mut touched = false;
    let mut current = match current {
        Some(record) => record,
        None => {
            let data = suwayomi_catalog::execute_graphql_document(
                state,
                session,
                &bind_track_mutation(),
                json!({
                    "mangaId": manga_id,
                    "trackerId": tracker.id,
                    "remoteId": fields.remote_id.to_string(),
                }),
                true,
            )
            .await
            .map_err(|error| anyhow::anyhow!("bindTrack failed: {error:?}"))?;
            touched = true;
            data.pointer("/bindTrack/trackRecord")
                .and_then(parse_track_record)
                .context("bindTrack returned no record")?
        }
    };
    if let Some(variables) = update_track_variables(tracker_key, &tracker.scores, fields, &current) {
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            &update_track_mutation(),
            variables,
            true,
        )
        .await
        .map_err(|error| anyhow::anyhow!("updateTrack failed: {error:?}"))?;
        touched = true;
        if let Some(updated) = data
            .pointer("/updateTrack/trackRecord")
            .and_then(parse_track_record)
        {
            current = updated;
        }
    }
    db::upsert_suwayomi_tracking_mirror_state(
        &state.pool,
        &session.profile_id,
        entity_id,
        Some(&suwayomi_fingerprint(&current)),
        core_version,
    )
    .await?;
    Ok(touched)
}

async fn push_unbind(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    existing: Option<&SuwayomiTrackRecord>,
    entity_id: &str,
    core_version: i64,
) -> anyhow::Result<bool> {
    let Some(record) = existing else {
        db::delete_suwayomi_tracking_mirror_state(&state.pool, &session.profile_id, entity_id)
            .await?;
        return Ok(false);
    };
    unbind_record(state, session, record.id).await?;
    db::upsert_suwayomi_tracking_mirror_state(
        &state.pool,
        &session.profile_id,
        entity_id,
        None,
        core_version,
    )
    .await?;
    Ok(true)
}

async fn unbind_record(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    record_id: i64,
) -> anyhow::Result<()> {
    suwayomi_catalog::execute_graphql_document(
        state,
        session,
        UNBIND_TRACK_MUTATION,
        json!({ "recordId": record_id }),
        true,
    )
    .await
    .map(|_| ())
    .map_err(|error| anyhow::anyhow!("unbindTrack failed: {error:?}"))
}

#[derive(sqlx::FromRow)]
struct ClockRow {
    physical_ms: i64,
    logical: i64,
}

async fn current_core_version(
    state: &SharedAppState,
    scope_id: &str,
    entity_id: &str,
) -> anyhow::Result<i64> {
    let live: Option<i64> = sqlx::query_scalar(
        "SELECT record_server_version FROM tracking_records WHERE scope_id = ? AND entity_type = ? AND entity_id = ?",
    )
    .bind(scope_id)
    .bind(COMIC_TRACKING)
    .bind(entity_id)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(version) = live {
        return Ok(version);
    }
    let tombstone: Option<i64> = sqlx::query_scalar(
        "SELECT server_version FROM tombstones WHERE scope_id = ? AND entity_type = ? AND entity_id = ?",
    )
    .bind(scope_id)
    .bind(COMIC_TRACKING)
    .bind(entity_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(tombstone.unwrap_or(0))
}

async fn current_clock(
    state: &SharedAppState,
    scope_id: &str,
    entity_id: &str,
) -> anyhow::Result<Option<(i64, i64)>> {
    Ok(sqlx::query_as::<_, ClockRow>(
        "SELECT physical_ms, logical FROM entity_event_clocks WHERE scope_id = ? AND entity_type = ? AND entity_id = ?",
    )
    .bind(scope_id)
    .bind(COMIC_TRACKING)
    .bind(entity_id)
    .fetch_optional(&state.pool)
    .await?
    .map(|row| (row.physical_ms, row.logical)))
}

fn applied_version(outcome: &db::CausalMutationWriteOutcome) -> Option<i64> {
    match outcome {
        db::CausalMutationWriteOutcome::Applied(applied) => Some(applied.envelope.server_version),
        db::CausalMutationWriteOutcome::Superseded { .. } => None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn emit_record(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    comic_id: &str,
    tracker_key: &str,
    record: &SuwayomiTrackRecord,
    expected_core_version: i64,
    has_agreement: bool,
) -> anyhow::Result<bool> {
    let now = db::now_ms();
    let patch = core_record_from_suwayomi(comic_id, tracker_key, record, now);
    let identity = tracking::validate_tracking_patch(COMIC_TRACKING, entity_id, &patch)
        .map_err(|error| anyhow::anyhow!("mirrored tracking record is invalid: {}", error.code))?;
    let fingerprint = suwayomi_fingerprint(record);

    let _writer_guard = state.mutation_gate.lock().await;
    let current_version = current_core_version(state, scope_id, entity_id).await?;
    if has_agreement && current_version != expected_core_version {
        // A device wrote this binding meanwhile; the next tick resolves it (Core wins).
        return Ok(false);
    }
    let clock = mirror_event_clock(current_clock(state, scope_id, entity_id).await?, now);
    let outcome = db::apply_tracking_record_mutation(
        &state.pool,
        session,
        scope_id,
        COMIC_TRACKING,
        entity_id,
        &identity.work_id,
        &identity.tracker_key,
        &patch,
        0,
        Some(&clock),
        state.config.retention_window,
    )
    .await?;
    let version = applied_version(&outcome);
    if let db::CausalMutationWriteOutcome::Applied(applied) = &outcome {
        let _ = state.change_sender.send(applied.envelope.clone());
    }
    db::upsert_suwayomi_tracking_mirror_state(
        &state.pool,
        &session.profile_id,
        entity_id,
        Some(&fingerprint),
        version.unwrap_or(current_version),
    )
    .await?;
    Ok(version.is_some())
}

async fn emit_tombstone(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    scope_id: &str,
    entity_id: &str,
    expected_core_version: i64,
) -> anyhow::Result<bool> {
    let now = db::now_ms();
    let _writer_guard = state.mutation_gate.lock().await;
    let current_version = current_core_version(state, scope_id, entity_id).await?;
    if current_version != expected_core_version {
        return Ok(false);
    }
    let clock = mirror_event_clock(current_clock(state, scope_id, entity_id).await?, now);
    let outcome = db::delete_tracking_record_mutation(
        &state.pool,
        session,
        scope_id,
        COMIC_TRACKING,
        entity_id,
        0,
        Some(&clock),
        state.config.retention_window,
    )
    .await?;
    let version = applied_version(&outcome);
    if let db::CausalMutationWriteOutcome::Applied(applied) = &outcome {
        let _ = state.change_sender.send(applied.envelope.clone());
    }
    db::upsert_suwayomi_tracking_mirror_state(
        &state.pool,
        &session.profile_id,
        entity_id,
        None,
        version.unwrap_or(current_version),
    )
    .await?;
    Ok(version.is_some())
}

async fn bound_manga_id(
    state: &SharedAppState,
    profile_id: &str,
    comic_id: &str,
) -> anyhow::Result<Option<i64>> {
    let Some(binding) = db::load_portable_work_binding(&state.pool, profile_id, comic_id).await?
    else {
        return Ok(None);
    };
    if binding.ecosystem != "SUWAYOMI" || binding.resolution_state != "BOUND" {
        return Ok(None);
    }
    Ok(binding
        .local_reference
        .as_deref()
        .and_then(|reference| reference.parse::<i64>().ok())
        .filter(|id| *id > 0))
}

/// Every Suwayomi track record with the portable comic id of its manga, plus the manga ids.
async fn fetch_track_records(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> anyhow::Result<(Vec<(String, SuwayomiTrackRecord)>, HashMap<String, i64>)> {
    let document = track_records_query();
    let mut records = Vec::new();
    let mut manga_by_comic = HashMap::new();
    for page in 0..MAX_PAGES {
        let offset = (page as i64).saturating_mul(PAGE_SIZE);
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            &document,
            json!({ "first": PAGE_SIZE, "offset": offset }),
            false,
        )
        .await
        .map_err(|error| anyhow::anyhow!("trackRecords query failed: {error:?}"))?;
        let connection = data.get("trackRecords").context("invalid trackRecords response")?;
        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .context("invalid trackRecords nodes")?;
        for node in nodes {
            let Some(record) = parse_track_record(node) else {
                continue;
            };
            let Some(manga) = node.get("manga") else {
                continue;
            };
            let (Some(source_id), Some(url)) = (
                scalar_text(manga.get("sourceId")),
                manga.get("url").and_then(Value::as_str),
            ) else {
                continue;
            };
            let Some(comic_id) = comic_id_for(&source_id, url) else {
                continue;
            };
            manga_by_comic.entry(comic_id.clone()).or_insert(record.manga_id);
            records.push((comic_id, record));
        }
        let has_next = connection
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_next {
            break;
        }
    }
    Ok((records, manga_by_comic))
}

async fn fetch_library_identities(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> anyhow::Result<Vec<(String, i64)>> {
    let mut identities = Vec::new();
    for page in 0..MAX_PAGES {
        let offset = (page as i64).saturating_mul(PAGE_SIZE);
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            LIBRARY_IDENTITY_QUERY,
            json!({ "first": PAGE_SIZE, "offset": offset }),
            false,
        )
        .await
        .map_err(|error| anyhow::anyhow!("library identity query failed: {error:?}"))?;
        let connection = data.get("mangas").context("invalid library response")?;
        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .context("invalid library nodes")?;
        for node in nodes {
            let Some(manga_id) = long_value(node.get("id")).filter(|id| *id > 0) else {
                continue;
            };
            let (Some(source_id), Some(url)) = (
                scalar_text(node.get("sourceId")),
                node.get("url").and_then(Value::as_str),
            ) else {
                continue;
            };
            if let Some(comic_id) = comic_id_for(&source_id, url) {
                identities.push((comic_id, manga_id));
            }
        }
        let has_next = connection
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_next {
            break;
        }
    }
    Ok(identities)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scores(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn tracker(id: i64, name: &str, logged_in: bool) -> SuwayomiTracker {
        SuwayomiTracker {
            id,
            name: name.to_string(),
            is_logged_in: logged_in,
            scores: Vec::new(),
        }
    }

    fn suwayomi_record() -> SuwayomiTrackRecord {
        SuwayomiTrackRecord {
            id: 9,
            manga_id: 3,
            tracker_id: 2,
            remote_id: 4242,
            library_id: Some(77),
            title: "Title".to_string(),
            remote_url: "https://anilist.co/manga/4242".to_string(),
            status: 1,
            last_chapter_read: 12.5,
            total_chapters: 100,
            score: 80.0,
            start_date: 1_700_000_000_000,
            finish_date: 0,
        }
    }

    #[test]
    fn tracker_keys_round_trip_and_require_a_verified_name() {
        for (key, id, _) in SUWAYOMI_TRACKERS {
            assert_eq!(suwayomi_tracker_id_for_key(key), Some(id));
            assert_eq!(tracker_key_for_suwayomi_id(id), Some(key));
        }
        assert_eq!(suwayomi_tracker_id_for_key("komga"), None);
        assert_eq!(suwayomi_tracker_id_for_key("hardcover"), None);
        assert_eq!(tracker_key_for_suwayomi_id(6), None);

        let trackers = vec![
            tracker(1, "MyAnimeList", true),
            tracker(2, "AniList", true),
            tracker(3, "Komga", false),
            tracker(7, "MangaUpdates", false),
        ];
        assert!(verified_tracker(&trackers, "anilist", 2));
        assert!(!verified_tracker(&trackers, "kitsu", 3));
        assert!(!verified_tracker(&trackers, "anilist", 1));
        let map = verified_tracker_map(&trackers);
        assert_eq!(
            map.keys().copied().collect::<BTreeSet<_>>(),
            BTreeSet::from(["anilist", "mangaupdates", "myanimelist"])
        );
    }

    #[test]
    fn score_strings_follow_suwayomi_index_to_score() {
        let point_100: Vec<String> = (0..=100).map(|i| i.to_string()).collect();
        assert_eq!(score_string_for("anilist", &point_100, 85.0, 0.0).as_deref(), Some("85"));
        assert_eq!(score_string_for("anilist", &point_100, 85.0, 85.0), None);

        let point_10: Vec<String> = (0..=10).map(|i| i.to_string()).collect();
        assert_eq!(score_string_for("anilist", &point_10, 72.0, 0.0).as_deref(), Some("7"));

        let stars = scores(&["", "1 ★", "2 ★", "3 ★", "4 ★", "5 ★"]);
        // 5 stars stores 90 (5*20-10).
        assert_eq!(score_string_for("anilist", &stars, 90.0, 0.0).as_deref(), Some("5 ★"));
        let smileys = scores(&["", ":(", ":|", ":)"]);
        // Smileys store 35/60/85.
        assert_eq!(score_string_for("anilist", &smileys, 60.0, 0.0).as_deref(), Some(":|"));
        assert_eq!(score_string_for("anilist", &smileys, 80.0, 0.0).as_deref(), Some(":)"));

        let kitsu: Vec<String> = std::iter::once("0".to_string())
            .chain((2..=20).map(|i| format!("{:.1}", i as f64 / 2.0)))
            .collect();
        assert_eq!(score_string_for("kitsu", &kitsu, 7.5, 0.0).as_deref(), Some("7.5"));

        let mangaupdates = scores(&["0.0", "1.0", "5.5", "10.0"]);
        assert_eq!(
            score_string_for("mangaupdates", &mangaupdates, 5.4, 0.0).as_deref(),
            Some("5.5")
        );
        let mal: Vec<String> = (0..=10).map(|i| i.to_string()).collect();
        assert_eq!(score_string_for("myanimelist", &mal, 8.0, 3.0).as_deref(), Some("8"));
        assert_eq!(score_string_for("myanimelist", &mal, f64::NAN, 3.0), None);
    }

    #[test]
    fn parses_suwayomi_records_and_builds_valid_core_records() {
        let node = json!({
            "id": 9, "mangaId": 3, "trackerId": 2, "remoteId": "4242", "libraryId": "77",
            "title": "Title", "lastChapterRead": 12.5, "totalChapters": 100, "status": 1,
            "score": 80.0, "remoteUrl": "https://anilist.co/manga/4242",
            "startDate": "1700000000000", "finishDate": "0",
            "manga": { "id": 3, "url": "/manga/1", "sourceId": "123" }
        });
        let record = parse_track_record(&node).unwrap();
        assert_eq!(record, suwayomi_record());

        let comic_id = comic_id_for("123", "/manga/1").unwrap();
        assert!(comic_id.starts_with("comic:"));
        let entity_id = tracking::tracking_entity_id(COMIC_TRACKING, &comic_id, "anilist");
        let patch = core_record_from_suwayomi(&comic_id, "anilist", &record, 5);
        let identity = tracking::validate_tracking_patch(COMIC_TRACKING, &entity_id, &patch).unwrap();
        assert_eq!(identity.work_id, comic_id);
        assert_eq!(patch["remoteId"], 4242);
        assert_eq!(patch["progress"], 12.5);
        assert_eq!(patch["startedAtMs"], 1_700_000_000_000_i64);
        assert!(tracking::credential_field_name(&patch).is_none());

        let fields = core_tracking_fields(&patch).unwrap();
        assert_eq!(fields.remote_id, 4242);
        assert_eq!(fields.score, 80.0);
    }

    #[test]
    fn update_variables_only_carry_differences() {
        let current = suwayomi_record();
        let point_100: Vec<String> = (0..=100).map(|i| i.to_string()).collect();
        let same = CoreTrackingFields {
            remote_id: 4242,
            status: 1,
            progress: 12.5,
            score: 80.0,
            started_at_ms: 1_700_000_000_000,
            finished_at_ms: 0,
        };
        assert_eq!(update_track_variables("anilist", &point_100, &same, &current), None);
        let changed = CoreTrackingFields {
            status: 2,
            progress: 20.0,
            score: 90.0,
            finished_at_ms: 1_800_000_000_000,
            ..same
        };
        let variables = update_track_variables("anilist", &point_100, &changed, &current).unwrap();
        assert_eq!(
            variables,
            json!({
                "recordId": 9, "status": 2, "lastChapterRead": 20.0, "scoreString": "90",
                "finishDate": "1800000000000"
            })
        );
    }

    #[test]
    fn fingerprint_ignores_record_ids_but_tracks_content() {
        let record = suwayomi_record();
        let mut moved = record.clone();
        moved.id = 99;
        assert_eq!(suwayomi_fingerprint(&record), suwayomi_fingerprint(&moved));
        let mut progressed = record.clone();
        progressed.last_chapter_read = 13.0;
        assert_ne!(suwayomi_fingerprint(&record), suwayomi_fingerprint(&progressed));
    }

    #[test]
    fn backfill_prefers_core_and_copies_lone_bindings() {
        assert_eq!(decide(CoreSide::Live, 5, Some("fp"), None), Decision::PushLive);
        assert_eq!(decide(CoreSide::Live, 5, None, None), Decision::PushLive);
        assert_eq!(decide(CoreSide::Absent, 0, Some("fp"), None), Decision::EmitRecord);
        assert_eq!(decide(CoreSide::Tombstone, 4, Some("fp"), None), Decision::EmitRecord);
        assert_eq!(decide(CoreSide::Tombstone, 4, None, None), Decision::Nothing);
        assert_eq!(decide(CoreSide::Absent, 0, None, None), Decision::Nothing);
    }

    #[test]
    fn agreement_detects_the_changed_side_and_core_wins_conflicts() {
        let agreed = Some((Some("fp"), 5));
        // Nothing changed: no echo.
        assert_eq!(decide(CoreSide::Live, 5, Some("fp"), agreed), Decision::Nothing);
        // A device changed the record.
        assert_eq!(decide(CoreSide::Live, 6, Some("fp"), agreed), Decision::PushLive);
        // A device unbound it.
        assert_eq!(decide(CoreSide::Tombstone, 6, Some("fp"), agreed), Decision::PushUnbind);
        // The desktop changed it.
        assert_eq!(decide(CoreSide::Live, 5, Some("fp2"), agreed), Decision::EmitRecord);
        // The desktop unbound it.
        assert_eq!(decide(CoreSide::Live, 5, None, agreed), Decision::EmitTombstone);
        // Both changed: Core wins.
        assert_eq!(decide(CoreSide::Live, 6, Some("fp2"), agreed), Decision::PushLive);
        assert_eq!(decide(CoreSide::Tombstone, 6, None, agreed), Decision::ForgetState);
        // After a push/emit the new agreement is quiet.
        assert_eq!(
            decide(CoreSide::Tombstone, 6, None, Some((None, 6))),
            Decision::ForgetState
        );
        assert_eq!(decide(CoreSide::Live, 7, Some("fp3"), Some((Some("fp3"), 7))), Decision::Nothing);
    }

    #[test]
    fn mirror_clock_orders_after_the_stored_clock() {
        let clock = mirror_event_clock(None, 1_000);
        assert_eq!((clock.physical_ms, clock.logical), (1_000, 0));
        let clock = mirror_event_clock(Some((500, 3)), 1_000);
        assert_eq!((clock.physical_ms, clock.logical), (1_000, 0));
        let clock = mirror_event_clock(Some((5_000, 3)), 1_000);
        assert_eq!((clock.physical_ms, clock.logical), (5_000, 4));
        assert_eq!(clock.device_generation_id, MIRROR_DEVICE_ID);
    }

    #[test]
    fn credential_actions_only_replay_anilist() {
        let login = StoredTrackerCredential {
            tracker_key: "anilist".to_string(),
            revision: 2,
            username: "4242".to_string(),
            password: "tok.en".to_string(),
            token: r#"{"access_token":"tok.en","token_type":"Bearer"}"#.to_string(),
            ..Default::default()
        };
        match credential_action(&login) {
            CredentialAction::LoginOAuth { tracker_id, callback_url } => {
                assert_eq!(tracker_id, 2);
                assert!(callback_url.0.contains("#access_token=tok.en&"));
                assert!(!format!("{callback_url:?}").contains("tok.en"));
            }
            other => panic!("unexpected {other:?}"),
        }
        let tombstone_never_applied = StoredTrackerCredential {
            deleted: true,
            password: String::new(),
            token: String::new(),
            ..login.clone()
        };
        assert_eq!(credential_action(&tombstone_never_applied), CredentialAction::Skip);
        let tombstone = StoredTrackerCredential {
            desktop_revision: 1,
            ..tombstone_never_applied
        };
        assert_eq!(
            credential_action(&tombstone),
            CredentialAction::Logout { tracker_id: 2 }
        );
        let mal = StoredTrackerCredential {
            tracker_key: "myanimelist".to_string(),
            ..login
        };
        assert_eq!(credential_action(&mal), CredentialAction::Skip);
    }

    #[test]
    fn file_logins_cover_every_suwayomi_tracker_but_anilist() {
        let login = |key: &str| StoredTrackerCredential {
            tracker_key: key.to_string(),
            revision: 3,
            username: "u".to_string(),
            password: "p".to_string(),
            token: "t".to_string(),
            ..Default::default()
        };
        for (key, id) in [
            ("myanimelist", 1),
            ("kitsu", 3),
            ("shikimori", 4),
            ("bangumi", 5),
            ("mangaupdates", 7),
        ] {
            let (tracker_id, values) = file_login_change(&login(key)).unwrap();
            assert_eq!(tracker_id, id);
            let values = values.unwrap();
            assert_eq!(
                (
                    values.username.as_str(),
                    values.password.as_str(),
                    values.token.as_str()
                ),
                ("u", "p", "t")
            );
        }
        for key in ["anilist", "komga", "hardcover", "novelupdates"] {
            assert!(file_login_change(&login(key)).is_none(), "{key}");
        }
        let never_applied_logout = StoredTrackerCredential {
            deleted: true,
            ..login("kitsu")
        };
        assert!(file_login_change(&never_applied_logout).is_none());
        let logout = StoredTrackerCredential {
            desktop_revision: 2,
            ..never_applied_logout
        };
        assert_eq!(file_login_change(&logout), Some((3, None)));
        let token_only = StoredTrackerCredential {
            username: String::new(),
            password: String::new(),
            ..login("mangaupdates")
        };
        assert_eq!(file_login_change(&token_only), Some((7, None)));
    }

    #[test]
    fn desktop_logins_publish_only_differences_and_yield_to_pending_core_logins() {
        let values = |token: &str| CredentialValues {
            username: "u".to_string(),
            password: "p".to_string(),
            token: token.to_string(),
        };
        let stored = StoredTrackerCredential {
            tracker_key: "myanimelist".to_string(),
            revision: 4,
            desktop_revision: 4,
            username: "u".to_string(),
            password: "p".to_string(),
            token: "a".to_string(),
            ..Default::default()
        };
        assert_eq!(desktop_login_change(None, None), None);
        assert_eq!(
            desktop_login_change(None, Some(&values("a"))),
            Some(Some(values("a")))
        );
        assert_eq!(
            desktop_login_change(Some(&stored), Some(&values("a"))),
            None
        );
        assert_eq!(
            desktop_login_change(Some(&stored), Some(&values("b"))),
            Some(Some(values("b")))
        );
        assert_eq!(desktop_login_change(Some(&stored), None), Some(None));
        let tombstone = StoredTrackerCredential {
            deleted: true,
            ..stored.clone()
        };
        assert_eq!(desktop_login_change(Some(&tombstone), None), None);
        assert_eq!(
            desktop_login_change(Some(&tombstone), Some(&values("a"))),
            Some(Some(values("a")))
        );
        let pending = StoredTrackerCredential {
            revision: 5,
            ..stored
        };
        assert_eq!(
            desktop_login_change(Some(&pending), Some(&values("b"))),
            None
        );
        assert_eq!(desktop_login_change(Some(&pending), None), None);
    }
}
