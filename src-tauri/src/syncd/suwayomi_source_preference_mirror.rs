//! Desktop -> Core mirror for extension source preferences (`comic.source_preference`).
//!
//! Core -> Suwayomi runs through the projection outbox (`UpdateSourcePreference`). This task
//! publishes what is chosen on the desktop: it reads each source's `settings/source_<id>.xml` in
//! the profile root to learn which keys the desktop stores explicitly (defaults never travel),
//! asks Suwayomi for the typed values of those keys, and publishes the ones that changed.
//!
//! Echo loops are prevented by `suwayomi_source_preference_mirror_state`, which remembers per
//! preference the desktop value and Core version both sides last agreed on, as the tracking
//! mirror does. Values the desktop already held the first time the mirror looked at a profile
//! are remembered, not published, so a stale desktop value never overrides the phone's choice;
//! when both sides changed the Core wins (see `source_preferences::decide`).

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::Notify;

use super::lifecycle::{wait_for_shutdown_request, ShutdownRequest};
use super::models::{AppError, AuthenticatedSession, EventClock, SharedAppState};
use super::routes::suwayomi_catalog;
use super::source_preferences::{
    self, DesktopValue, MirrorAgreement, MirrorDecision, MirrorObservation, COMIC_SOURCE_PREFERENCE,
};
use super::{db, suwayomi_process, suwayomi_tracker_prefs};

const MIRROR_INTERVAL: Duration = Duration::from_secs(60);
const MIN_REQUESTED_INTERVAL: Duration = Duration::from_millis(1_500);
const MIRROR_DEVICE_ID: &str = "epigraph-core-source-preference-mirror";
pub(crate) const MIRROR_TOKEN_ID: &str = "epigraph-core-source-preference-mirror";
/// Settings files larger than this are not preference files a user filled in by hand.
const MAX_SETTINGS_FILE_BYTES: u64 = 1024 * 1024;
/// Bounds one tick: a profile with many configured sources is covered over several ticks.
const MAX_SOURCES_READ_PER_TICK: usize = 64;

fn wake() -> &'static Notify {
    static WAKE: OnceLock<Notify> = OnceLock::new();
    WAKE.get_or_init(Notify::new)
}

/// Asks the mirror to look now (a source preference was projected into Suwayomi).
pub fn request_immediate_mirror() {
    wake().notify_one();
}

/// What a source looked like the last time the mirror read it to the end, so an unchanged
/// source is not read from Suwayomi again every tick.
fn scanned_sources() -> &'static Mutex<HashMap<(String, String), String>> {
    static SCANNED: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    SCANNED.get_or_init(Default::default)
}

pub fn spawn_source_preference_mirror_task(
    state: SharedAppState,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        tracing::info!("Suwayomi source preference mirror started");
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
            for instance in suwayomi_process::attach_owned_instances() {
                match mirror_profile(&state, &instance.profile_key, &instance.root_dir).await {
                    Ok(published) if published > 0 => tracing::debug!(
                        published,
                        "Suwayomi source preference mirror published changes"
                    ),
                    Ok(_) => {}
                    Err(error) => tracing::warn!(
                        profile = %instance.profile_key,
                        error = %error,
                        "Suwayomi source preference mirror skipped profile"
                    ),
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

/// A source settings file and the syncable keys it stores explicitly.
struct SettingsFile {
    source_id: String,
    explicit_keys: BTreeSet<String>,
    /// Changes whenever the file is rewritten.
    stamp: String,
}

/// The `settings/source_<id>.xml` files of a profile that store at least one syncable key.
pub fn source_settings_files(root_dir: &Path) -> Vec<(String, BTreeSet<String>, String)> {
    let Ok(entries) = std::fs::read_dir(root_dir.join("settings")) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(source_id) = file_name
            .to_str()
            .and_then(source_preferences::source_id_from_settings_file)
            .map(str::to_string)
        else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_SETTINGS_FILE_BYTES {
            continue;
        }
        let Ok(stored) = suwayomi_tracker_prefs::read_properties_file(&entry.path()) else {
            continue;
        };
        let explicit_keys: BTreeSet<String> = stored
            .into_iter()
            .map(|(key, _)| key)
            .filter(|key| source_preferences::is_syncable_key(key))
            .collect();
        if explicit_keys.is_empty() {
            continue;
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
            .map(|at| at.as_nanos())
            .unwrap_or_default();
        files.push((source_id, explicit_keys, format!("{modified}:{}", metadata.len())));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

async fn mirror_profile(
    state: &SharedAppState,
    profile_id: &str,
    root_dir: &Path,
) -> anyhow::Result<usize> {
    if crate::syncd::v4::db::load_watermark(&state.pool, profile_id)
        .await
        .map(|w| w.current_seq > 0)
        .unwrap_or(false)
    {
        return Ok(0);
    }
    let files: Vec<SettingsFile> = source_settings_files(root_dir)
        .into_iter()
        .map(|(source_id, explicit_keys, stamp)| SettingsFile {
            source_id,
            explicit_keys,
            stamp,
        })
        .collect();
    let session = mirror_session(profile_id);
    let scope_id = format!("comics:profile:{profile_id}");
    let profile_baselined = is_profile_baselined(state, profile_id).await?;
    let mut complete = true;
    let mut published = 0usize;
    let mut reads = 0usize;
    for file in &files {
        let core = load_core_side(state, &scope_id, profile_id, &file.source_id).await?;
        let signature = format!("{}|{}|{}", profile_baselined, file.stamp, core.signature());
        let cache_key = (profile_id.to_string(), file.source_id.clone());
        if scanned_sources().lock().ok().and_then(|cache| cache.get(&cache_key).cloned())
            == Some(signature.clone())
        {
            continue;
        }
        if reads == MAX_SOURCES_READ_PER_TICK {
            complete = false;
            break;
        }
        reads += 1;
        let values = match read_desktop_values(state, &session, &file.source_id, &file.explicit_keys)
            .await
        {
            Ok(values) => values,
            Err(error) => {
                tracing::debug!(error = ?error, "source preferences could not be read");
                complete = false;
                continue;
            }
        };
        let mut settled = true;
        for value in &values {
            match mirror_preference(
                state,
                &session,
                &scope_id,
                &file.source_id,
                value,
                &core,
                profile_baselined,
            )
            .await?
            {
                PreferenceOutcome::Published => published += 1,
                PreferenceOutcome::Settled => {}
                PreferenceOutcome::Unsettled => settled = false,
            }
        }
        if settled {
            if let Ok(mut cache) = scanned_sources().lock() {
                // Agreements written above change nothing in the signature, so the next tick
                // skips this source until its file or a Core record changes.
                cache.insert(cache_key, signature);
            }
        }
    }
    if complete && !profile_baselined {
        mark_profile_baselined(state, profile_id).await?;
        // Values remembered on the first look are now agreements; a later file change is read
        // against them.
        if let Ok(mut cache) = scanned_sources().lock() {
            cache.retain(|(profile, _), _| profile != profile_id);
        }
    }
    Ok(published)
}

/// The desktop values of one source, or `Ok(empty)` when Suwayomi does not know the source (its
/// extension was removed and only the settings file is left).
async fn read_desktop_values(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    source_id: &str,
    explicit_keys: &BTreeSet<String>,
) -> Result<Vec<DesktopValue>, AppError> {
    let answer = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        &source_preferences::source_preferences_query(),
        json!({ "id": source_id }),
        false,
    )
    .await;
    let data = match answer {
        Ok(data) => data,
        Err(AppError::ServiceUnavailable(detail)) if detail.retryable == Some(false) => {
            return Ok(Vec::new());
        }
        Err(error) => return Err(error),
    };
    let Some(source) = data.get("source").filter(|source| !source.is_null()) else {
        return Ok(Vec::new());
    };
    let offered = source_preferences::parse_offered_preferences(source.get("preferences"));
    Ok(source_preferences::desktop_values(&offered, explicit_keys))
}

/// The Core side of one source's preferences.
#[derive(Default)]
struct CoreSide {
    /// entity id -> (fingerprint of the live record, version of the record or its tombstone)
    entries: HashMap<String, (Option<String>, i64)>,
    pending: BTreeSet<String>,
    agreements: HashMap<String, MirrorAgreement>,
}

impl CoreSide {
    fn signature(&self) -> String {
        let mut entries: Vec<_> = self
            .entries
            .iter()
            .map(|(entity_id, (_, version))| format!("{entity_id}={version}"))
            .collect();
        entries.sort();
        let pending: Vec<&str> = self.pending.iter().map(String::as_str).collect();
        format!("{}#{}", entries.join(","), pending.join(","))
    }
}

#[derive(sqlx::FromRow)]
struct CoreRow {
    entity_id: String,
    record_json: String,
    record_server_version: i64,
}

#[derive(sqlx::FromRow)]
struct AgreementRow {
    entity_id: String,
    agreed_fingerprint: Option<String>,
    core_server_version: i64,
}

fn entity_pattern(source_id: &str) -> String {
    // Source ids are digits with an optional leading '-', so they hold no LIKE wildcards.
    format!("{}%", source_preferences::entity_id_for(source_id, ""))
}

async fn load_core_side(
    state: &SharedAppState,
    scope_id: &str,
    profile_id: &str,
    source_id: &str,
) -> anyhow::Result<CoreSide> {
    let pattern = entity_pattern(source_id);
    let mut side = CoreSide::default();
    let tombstones: Vec<(String, i64)> = sqlx::query_as(
        "SELECT entity_id, server_version FROM tombstones \
         WHERE scope_id = ? AND entity_type = ? AND entity_id LIKE ?",
    )
    .bind(scope_id)
    .bind(COMIC_SOURCE_PREFERENCE)
    .bind(&pattern)
    .fetch_all(&state.pool)
    .await?;
    for (entity_id, version) in tombstones {
        side.entries.insert(entity_id, (None, version));
    }
    let live: Vec<CoreRow> = sqlx::query_as(
        "SELECT entity_id, record_json, record_server_version FROM comic_sync_state \
         WHERE scope_id = ? AND entity_type = ? AND entity_id LIKE ?",
    )
    .bind(scope_id)
    .bind(COMIC_SOURCE_PREFERENCE)
    .bind(&pattern)
    .fetch_all(&state.pool)
    .await?;
    for row in live {
        let fingerprint = serde_json::from_str::<Value>(&row.record_json)
            .ok()
            .and_then(|record| source_preferences::record_value(&row.entity_id, &record))
            .map(|value| value.fingerprint());
        side.entries.insert(row.entity_id, (fingerprint, row.record_server_version));
    }
    side.pending = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT entity_id FROM suwayomi_projection_outbox \
         WHERE profile_id = ? AND entity_type = ? AND entity_id LIKE ? \
         AND status IN ('pending', 'retry', 'in_flight')",
    )
    .bind(profile_id)
    .bind(COMIC_SOURCE_PREFERENCE)
    .bind(&pattern)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .collect();
    let agreements: Vec<AgreementRow> = sqlx::query_as(
        "SELECT entity_id, agreed_fingerprint, core_server_version \
         FROM suwayomi_source_preference_mirror_state WHERE profile_id = ? AND entity_id LIKE ?",
    )
    .bind(profile_id)
    .bind(&pattern)
    .fetch_all(&state.pool)
    .await?;
    side.agreements = agreements
        .into_iter()
        .map(|row| {
            (
                row.entity_id,
                MirrorAgreement {
                    fingerprint: row.agreed_fingerprint,
                    core_server_version: row.core_server_version,
                },
            )
        })
        .collect();
    Ok(side)
}

enum PreferenceOutcome {
    Published,
    Settled,
    /// Waiting on a projection, or a device wrote meanwhile: look again on a later tick.
    Unsettled,
}

async fn mirror_preference(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    scope_id: &str,
    source_id: &str,
    desktop: &DesktopValue,
    core: &CoreSide,
    profile_baselined: bool,
) -> anyhow::Result<PreferenceOutcome> {
    let entity_id = source_preferences::entity_id_for(source_id, &desktop.key);
    let fingerprint = desktop.value.fingerprint();
    let (core_fingerprint, core_version) =
        core.entries.get(&entity_id).cloned().unwrap_or((None, 0));
    let decision = source_preferences::decide(MirrorObservation {
        desktop: Some(&fingerprint),
        desktop_is_default: desktop.is_default,
        agreement: core.agreements.get(&entity_id),
        core: core_fingerprint.as_deref(),
        core_version,
        projection_pending: core.pending.contains(&entity_id),
        profile_baselined,
    });
    match decision {
        MirrorDecision::Nothing => Ok(PreferenceOutcome::Settled),
        MirrorDecision::Wait => Ok(PreferenceOutcome::Unsettled),
        MirrorDecision::Baseline | MirrorDecision::Agree => {
            upsert_agreement(state, &session.profile_id, &entity_id, &fingerprint, core_version)
                .await?;
            Ok(PreferenceOutcome::Settled)
        }
        MirrorDecision::Emit => {
            emit(state, session, scope_id, source_id, &entity_id, desktop, core_version).await
        }
    }
}

async fn emit(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    scope_id: &str,
    source_id: &str,
    entity_id: &str,
    desktop: &DesktopValue,
    expected_core_version: i64,
) -> anyhow::Result<PreferenceOutcome> {
    let now = db::now_ms();
    let record = source_preferences::core_record(source_id, &desktop.key, &desktop.value, now);
    if source_preferences::validate_patch(entity_id, &record).is_err() {
        // Not a value sync carries (for example one that looks like a secret): keep it local.
        upsert_agreement(
            state,
            &session.profile_id,
            entity_id,
            &desktop.value.fingerprint(),
            expected_core_version,
        )
        .await?;
        return Ok(PreferenceOutcome::Settled);
    }

    let _writer_guard = state.mutation_gate.lock().await;
    if current_core_version(state, scope_id, entity_id).await? != expected_core_version {
        // A device wrote this preference meanwhile; the next tick resolves it (Core wins).
        return Ok(PreferenceOutcome::Unsettled);
    }
    let clock = mirror_event_clock(current_clock(state, scope_id, entity_id).await?, now);
    let outcome = db::apply_mirrored_comic_sync_state_mutation(
        &state.pool,
        session,
        scope_id,
        COMIC_SOURCE_PREFERENCE,
        entity_id,
        &record,
        now,
        Some(&clock),
        state.config.retention_window,
    )
    .await?;
    let applied = match &outcome {
        db::CausalMutationWriteOutcome::Applied(applied) => {
            let _ = state.change_sender.send(applied.envelope.clone());
            Some(applied.envelope.server_version)
        }
        db::CausalMutationWriteOutcome::Superseded { .. } => None,
    };
    let Some(version) = applied else {
        return Ok(PreferenceOutcome::Unsettled);
    };
    upsert_agreement(
        state,
        &session.profile_id,
        entity_id,
        &desktop.value.fingerprint(),
        version,
    )
    .await?;
    Ok(PreferenceOutcome::Published)
}

/// Orders a desktop observation after the record it is based on; see the tracking mirror.
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

async fn current_core_version(
    state: &SharedAppState,
    scope_id: &str,
    entity_id: &str,
) -> anyhow::Result<i64> {
    let live: Option<i64> = sqlx::query_scalar(
        "SELECT record_server_version FROM comic_sync_state \
         WHERE scope_id = ? AND entity_type = ? AND entity_id = ?",
    )
    .bind(scope_id)
    .bind(COMIC_SOURCE_PREFERENCE)
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
    .bind(COMIC_SOURCE_PREFERENCE)
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
    Ok(sqlx::query_as::<_, (i64, i64)>(
        "SELECT physical_ms, logical FROM entity_event_clocks \
         WHERE scope_id = ? AND entity_type = ? AND entity_id = ?",
    )
    .bind(scope_id)
    .bind(COMIC_SOURCE_PREFERENCE)
    .bind(entity_id)
    .fetch_optional(&state.pool)
    .await?)
}

async fn upsert_agreement(
    state: &SharedAppState,
    profile_id: &str,
    entity_id: &str,
    fingerprint: &str,
    core_server_version: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO suwayomi_source_preference_mirror_state \
         (profile_id, entity_id, agreed_fingerprint, core_server_version, updated_at_ms) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(profile_id, entity_id) DO UPDATE SET \
         agreed_fingerprint = excluded.agreed_fingerprint, \
         core_server_version = excluded.core_server_version, \
         updated_at_ms = excluded.updated_at_ms",
    )
    .bind(profile_id)
    .bind(entity_id)
    .bind(fingerprint)
    .bind(core_server_version)
    .bind(db::now_ms())
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn is_profile_baselined(state: &SharedAppState, profile_id: &str) -> anyhow::Result<bool> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM suwayomi_source_preference_mirror_profiles WHERE profile_id = ?",
    )
    .bind(profile_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(found.is_some())
}

async fn mark_profile_baselined(state: &SharedAppState, profile_id: &str) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO suwayomi_source_preference_mirror_profiles \
         (profile_id, baselined_at_ms) VALUES (?, ?)",
    )
    .bind(profile_id)
    .bind(db::now_ms())
    .execute(&state.pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_files_list_sources_with_syncable_keys() {
        let root = std::env::temp_dir().join(format!(
            "epigraph-source-pref-mirror-{}-{}",
            std::process::id(),
            db::now_ms()
        ));
        let settings = root.join("settings");
        std::fs::create_dir_all(&settings).unwrap();
        let file = |name: &str, entries: &[(&str, &str)]| {
            let body: String = entries
                .iter()
                .map(|(key, value)| format!("<entry key=\"{key}\">{value}</entry>\n"))
                .collect();
            std::fs::write(
                settings.join(name),
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
                     <!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">\n\
                     <properties>\n{body}</properties>\n"
                ),
            )
            .unwrap();
        };
        file(
            "source_2528986671771677900.xml",
            &[("preferred_mirror", "1"), ("fetchedMirrors", "a,b"), ("password", "x")],
        );
        file("source_-7.xml", &[("hasSanitizedUuids_en", "true")]);
        file("source_abc.xml", &[("preferred_mirror", "1")]);
        file("tracker.xml", &[("preferred_mirror", "1")]);

        let files = source_settings_files(&root);
        std::fs::remove_dir_all(&root).ok();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "2528986671771677900");
        assert_eq!(files[0].1, BTreeSet::from(["preferred_mirror".to_string()]));
        assert!(source_settings_files(&root).is_empty());
    }

    #[test]
    fn entity_pattern_matches_only_that_source() {
        let pattern = entity_pattern("-12");
        assert_eq!(pattern, "comic.source_preference::-12::%");
        assert!(source_preferences::entity_id_for("-12", "key").starts_with(&pattern[..pattern.len() - 1]));
        assert!(!source_preferences::entity_id_for("-123", "key").starts_with(&pattern[..pattern.len() - 1]));
    }

    #[tokio::test]
    async fn mirror_profile_skips_v4_active_profiles() {
        let temp = tempfile::TempDir::new().unwrap();
        let mut config = crate::syncd::config::SyncdConfig::from_env();
        config.data_dir = temp.path().to_path_buf();
        config.db_path = temp.path().join("syncd.sqlite");
        let pool = db::connect(&config).await.unwrap();
        let advertised =
            crate::syncd::config::SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let descriptor =
            crate::syncd::discovery::SyncdDiscoveryDescriptorProvider::from_config(&config)
                .unwrap();
        let manager =
            crate::syncd::discovery::SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let initial_status = manager.initial_status(&config, &advertised);
        let (change_sender, _) = tokio::sync::broadcast::channel(16);
        let (pairing_status_sender, _) = tokio::sync::broadcast::channel(16);
        let state = std::sync::Arc::new(crate::syncd::models::AppState {
            config,
            advertised_endpoint_resolver: advertised,
            discovery_descriptor_provider: descriptor,
            client_discovery_contract_provider: Default::default(),
            client_discovery_guidance_provider: Default::default(),
            discovery_provider_manager: manager,
            discovery_provider_state: std::sync::Arc::new(tokio::sync::RwLock::new(initial_status)),
            discovery_provider_runtime: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            pool: pool.clone(),
            change_sender,
            pairing_status_sender,
            mutation_gate: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            tls_cert_sha256: "test".to_string(),
            device_presence: Default::default(),
            own_echoes: Default::default(),
        });

        sqlx::query(
            "INSERT INTO v4_profile_watermarks (profile_id, current_seq, updated_at_ms) VALUES (?, ?, ?)",
        )
        .bind("main")
        .bind(3_i64)
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();

        let published = mirror_profile(&state, "main", temp.path()).await.unwrap();
        assert_eq!(published, 0);
    }

    #[test]
    fn mirror_clock_follows_the_record() {
        assert_eq!(mirror_event_clock(None, 100).physical_ms, 100);
        let ahead = mirror_event_clock(Some((500, 2)), 100);
        assert_eq!((ahead.physical_ms, ahead.logical), (500, 3));
        assert_eq!(ahead.device_generation_id, MIRROR_DEVICE_ID);
    }
}
