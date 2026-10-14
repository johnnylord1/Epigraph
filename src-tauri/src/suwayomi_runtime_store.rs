//! Where Suwayomi runtimes live and which one runs.
//!
//! Each installed runtime has its own `versions/<version>` directory, never changed once published, and
//! `runtime-state.json` points at the one in use. An update only ever replaces that small file: it
//! records the candidate as `pending` before trying it and as `confirmed` once it passed, so no
//! directory a running server holds open is ever renamed. Only the maintenance that tries a pending
//! runtime starts it; every other start uses the confirmed one, so an attempt that was abandoned
//! midway can never become the runtime by accident.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const SERVER_JAR: &str = "Suwayomi-Server.jar";
const VERSIONS_DIR: &str = "versions";
const STATE_FILE: &str = "runtime-state.json";
const STATE_SCHEMA_VERSION: u32 = 1;
const LEGACY_CURRENT_DIR: &str = "current";
const LEGACY_PREVIOUS_DIR: &str = "previous";
const LEGACY_PREVIOUS_BACKUP_PREFIX: &str = ".previous-replaced-";
const INCOMING_PREFIX: &str = ".incoming-";
const DIAGNOSTICS_DIR: &str = "diagnostics";

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    pub schema_version: u32,
    /// The runtime every start uses; `None` is the one bundled with the app.
    pub confirmed: Option<String>,
    /// The runtime confirmed before it, kept so it is not collected.
    pub previous_confirmed: Option<String>,
    /// A runtime being tried, by the maintenance that holds the runtime lease.
    pub pending: Option<PendingRuntime>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingRuntime {
    pub operation_id: String,
    pub version: String,
    pub profile_id: String,
    /// The one profile allowed to start the pending runtime, and the one its snapshot restores.
    pub root_dir: String,
    pub server_url: String,
    pub snapshot_path: String,
    pub started_at_ms: u64,
}

impl RuntimeState {
    pub fn new() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            ..Self::default()
        }
    }

    pub fn pending_for(&self, profile_root: &Path) -> Option<&PendingRuntime> {
        self.pending
            .as_ref()
            .filter(|pending| same_path(Path::new(&pending.root_dir), profile_root))
    }
}

pub fn state_path(runtime_root: &Path) -> PathBuf {
    runtime_root.join(STATE_FILE)
}

pub fn version_dir(runtime_root: &Path, version: &str) -> Result<PathBuf, String> {
    validate_version_name(version)?;
    Ok(runtime_root.join(VERSIONS_DIR).join(version))
}

pub fn version_jar(runtime_root: &Path, version: &str) -> Result<PathBuf, String> {
    Ok(version_dir(runtime_root, version)?.join(SERVER_JAR))
}

pub fn legacy_current_jar(runtime_root: &Path) -> PathBuf {
    runtime_root.join(LEGACY_CURRENT_DIR).join(SERVER_JAR)
}

/// A version names a directory, so it may not climb out of `versions/` or carry separators.
fn validate_version_name(version: &str) -> Result<(), String> {
    let valid = !version.is_empty()
        && version.len() <= 64
        && !version.starts_with('.')
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err(format!("Suwayomi runtime version {version:?} is not a valid directory name."))
    }
}

/// The recorded state; `None` while the runtime still has the layout of earlier Epigraph versions.
pub fn read_state(runtime_root: &Path) -> Result<Option<RuntimeState>, String> {
    let path = state_path(runtime_root);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read the Suwayomi runtime state: {error}")),
    };
    let state = serde_json::from_str::<RuntimeState>(&text)
        .map_err(|error| format!("Could not parse the Suwayomi runtime state: {error}"))?;
    if state.schema_version != STATE_SCHEMA_VERSION {
        return Err(format!(
            "The Suwayomi runtime state has unsupported schema {}.",
            state.schema_version
        ));
    }
    for version in [&state.confirmed, &state.previous_confirmed].into_iter().flatten() {
        validate_version_name(version)?;
    }
    if let Some(pending) = &state.pending {
        validate_version_name(&pending.version)?;
    }
    Ok(Some(state))
}

/// Publishes the state in one replace; readers see either the old file or the new one.
pub fn write_state(runtime_root: &Path, state: &RuntimeState) -> Result<(), String> {
    fs::create_dir_all(runtime_root)
        .map_err(|error| format!("Could not create the Suwayomi runtime directory: {error}"))?;
    let mut state = state.clone();
    state.schema_version = STATE_SCHEMA_VERSION;
    state.updated_at_ms = unix_now_ms();
    let bytes = serde_json::to_vec_pretty(&state)
        .map_err(|error| format!("Could not serialize the Suwayomi runtime state: {error}"))?;
    let path = state_path(runtime_root);
    let temp_path = path.with_extension(format!("json.{}.tmp", Uuid::new_v4()));
    let written = File::create(&temp_path).and_then(|mut file| {
        file.write_all(&bytes)?;
        file.sync_all()
    });
    if let Err(error) = written {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("Could not write the Suwayomi runtime state: {error}"));
    }
    crate::suwayomi_maintenance::atomic_replace_file(&temp_path, &path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("Could not publish the Suwayomi runtime state: {error}")
    })
}

/// For writers that hold the runtime lease: a state that cannot be parsed names nothing to keep, so it
/// is moved to `diagnostics/` and the runtime starts over from the bundled one rather than refusing.
pub fn read_state_for_update(runtime_root: &Path) -> Result<RuntimeState, String> {
    match read_state(runtime_root) {
        Ok(Some(state)) => Ok(state),
        Ok(None) => Ok(RuntimeState::new()),
        Err(error) if fs::read(state_path(runtime_root)).is_ok() => {
            set_aside(runtime_root, &state_path(runtime_root), "runtime-state")?;
            eprintln!("[epigraph-suwayomi-runtime] unreadable runtime state set aside: {error}");
            Ok(RuntimeState::new())
        }
        Err(error) => Err(error),
    }
}

fn set_aside(runtime_root: &Path, path: &Path, label: &str) -> Result<(), String> {
    let diagnostics = runtime_root.join(DIAGNOSTICS_DIR);
    fs::create_dir_all(&diagnostics)
        .map_err(|error| format!("Could not create the runtime diagnostics directory: {error}"))?;
    let aside = diagnostics.join(format!("{label}-{}.json", unix_now_ms()));
    fs::rename(path, &aside).map_err(|error| format!("Could not set aside {label}: {error}"))
}

/// The managed runtime JAR a start of `profile_root` should use, or `None` for the bundled one.
/// `maintenance_active` says whether some Epigraph process holds the runtime for maintenance; it is
/// only asked when a pending runtime is for this profile.
pub fn resolve_managed_jar_with(
    runtime_root: &Path,
    profile_root: Option<&Path>,
    maintenance_active: impl FnOnce() -> bool,
) -> Option<PathBuf> {
    let state = match read_state(runtime_root) {
        Ok(Some(state)) => state,
        Ok(None) => {
            let legacy = legacy_current_jar(runtime_root);
            return legacy.is_file().then_some(legacy);
        }
        Err(error) => {
            eprintln!("[epigraph-suwayomi-runtime] runtime state ignored: {error}");
            return None;
        }
    };
    if let Some(pending) = profile_root.and_then(|root| state.pending_for(root)) {
        if maintenance_active() {
            match version_jar(runtime_root, &pending.version) {
                Ok(jar) if jar.is_file() => return Some(jar),
                _ => eprintln!(
                    "[epigraph-suwayomi-runtime] pending runtime {} is missing",
                    pending.version
                ),
            }
        }
    }
    let confirmed = state.confirmed.as_deref()?;
    match version_jar(runtime_root, confirmed) {
        Ok(jar) if jar.is_file() => Some(jar),
        _ => {
            eprintln!(
                "[epigraph-suwayomi-runtime] confirmed runtime {confirmed} is missing; using the bundled one"
            );
            None
        }
    }
}

pub fn resolve_managed_jar(runtime_root: &Path, profile_root: Option<&Path>) -> Option<PathBuf> {
    resolve_managed_jar_with(runtime_root, profile_root, || {
        crate::suwayomi_maintenance::exclusive_maintenance_active()
            || crate::suwayomi_maintenance::exclusive_file_lease_held(runtime_root).unwrap_or(false)
    })
}

/// Every managed JAR that may legitimately be running: the confirmed one, a pending one, and the
/// legacy `current` one while it exists.
pub fn known_managed_jars(runtime_root: &Path) -> Vec<PathBuf> {
    let mut jars = Vec::new();
    if let Ok(Some(state)) = read_state(runtime_root) {
        let versions = [state.confirmed.as_deref(), state.pending.as_ref().map(|p| p.version.as_str())];
        for version in versions.into_iter().flatten() {
            if let Ok(jar) = version_jar(runtime_root, version) {
                if jar.is_file() && !jars.contains(&jar) {
                    jars.push(jar);
                }
            }
        }
    }
    let legacy = legacy_current_jar(runtime_root);
    if legacy.is_file() {
        jars.push(legacy);
    }
    jars
}

/// Makes `versions/<version>` hold the verified JAR from `staging_dir`. Idempotent: a version already
/// published with the same SHA-256 is kept. A damaged copy is replaced unless it is the confirmed
/// runtime, which is never removed here.
pub fn publish_version(
    runtime_root: &Path,
    staging_dir: &Path,
    version: &str,
    expected_sha256: &str,
) -> Result<PathBuf, String> {
    let target = version_dir(runtime_root, version)?;
    let target_jar = target.join(SERVER_JAR);
    if target_jar.is_file() {
        if sha256_file(&target_jar)?.eq_ignore_ascii_case(expected_sha256) {
            let _ = fs::remove_dir_all(staging_dir);
            return Ok(target);
        }
        let confirmed = read_state(runtime_root).ok().flatten().and_then(|state| state.confirmed);
        if confirmed.as_deref() == Some(version) {
            return Err(format!(
                "The installed Suwayomi runtime {version} does not match its certified SHA-256."
            ));
        }
    }
    if target.exists() {
        fs::remove_dir_all(&target)
            .map_err(|error| format!("Could not replace damaged runtime {version}: {error}"))?;
    }
    let staged_jar = staging_dir.join(SERVER_JAR);
    if !sha256_file(&staged_jar)?.eq_ignore_ascii_case(expected_sha256) {
        return Err("Staged Suwayomi JAR does not match its certified SHA-256.".to_string());
    }
    let versions = runtime_root.join(VERSIONS_DIR);
    fs::create_dir_all(&versions)
        .map_err(|error| format!("Could not create the runtime versions directory: {error}"))?;
    // Staging lives on the same volume, so this is a rename of a directory nothing runs from.
    fs::rename(staging_dir, &target)
        .map_err(|error| format!("Could not publish Suwayomi runtime {version}: {error}"))?;
    Ok(target)
}

/// Copies a JAR into `versions/<version>` through a temporary directory, for runtimes that do not come
/// from staging (the legacy `current` directory).
fn import_version(runtime_root: &Path, source_jar: &Path, version: &str) -> Result<(), String> {
    let target = version_dir(runtime_root, version)?;
    let source_sha256 = sha256_file(source_jar)?;
    if target.join(SERVER_JAR).is_file()
        && sha256_file(&target.join(SERVER_JAR))?.eq_ignore_ascii_case(&source_sha256)
    {
        return Ok(());
    }
    let versions = runtime_root.join(VERSIONS_DIR);
    let incoming = versions.join(format!("{INCOMING_PREFIX}{}", Uuid::new_v4()));
    fs::create_dir_all(&incoming)
        .map_err(|error| format!("Could not prepare runtime {version}: {error}"))?;
    let copied = (|| {
        let incoming_jar = incoming.join(SERVER_JAR);
        fs::copy(source_jar, &incoming_jar)
            .map_err(|error| format!("Could not copy runtime {version}: {error}"))?;
        // Windows only flushes through a handle opened for writing.
        fs::OpenOptions::new()
            .write(true)
            .open(&incoming_jar)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Could not sync runtime {version}: {error}"))?;
        if !sha256_file(&incoming_jar)?.eq_ignore_ascii_case(&source_sha256) {
            return Err(format!("Copied runtime {version} failed SHA-256 validation."));
        }
        if target.exists() {
            fs::remove_dir_all(&target)
                .map_err(|error| format!("Could not replace damaged runtime {version}: {error}"))?;
        }
        fs::rename(&incoming, &target)
            .map_err(|error| format!("Could not publish runtime {version}: {error}"))
    })();
    if copied.is_err() {
        let _ = fs::remove_dir_all(&incoming);
    }
    copied
}

/// Moves a runtime left in the layout of earlier Epigraph versions (`current/`, `previous/`) into
/// `versions/` and records it as confirmed. The caller holds the runtime lease, no server runs from
/// the legacy directories it owns, and an interrupted legacy update was already recovered.
/// `jar_version` names the version a JAR reports.
pub fn migrate_legacy_layout(
    runtime_root: &Path,
    jar_version: impl Fn(&Path) -> Option<String>,
) -> Result<RuntimeState, String> {
    if let Some(state) = read_state(runtime_root).ok().flatten() {
        return Ok(state);
    }
    let mut state = read_state_for_update(runtime_root)?;
    let legacy_jar = legacy_current_jar(runtime_root);
    if legacy_jar.is_file() {
        let version = jar_version(&legacy_jar)
            .filter(|version| validate_version_name(version).is_ok())
            .unwrap_or_else(|| "legacy".to_string());
        import_version(runtime_root, &legacy_jar, &version)?;
        state.confirmed = Some(version);
    }
    write_state(runtime_root, &state)?;
    remove_legacy_directories(runtime_root);
    Ok(state)
}

/// Best effort: a directory another profile's server still runs from is retried on the next pass.
fn remove_legacy_directories(runtime_root: &Path) {
    if crate::suwayomi_maintenance::update_journal_path(runtime_root).exists() {
        return;
    }
    for name in [LEGACY_CURRENT_DIR, LEGACY_PREVIOUS_DIR] {
        let _ = fs::remove_dir_all(runtime_root.join(name));
    }
    if let Ok(entries) = fs::read_dir(runtime_root) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(LEGACY_PREVIOUS_BACKUP_PREFIX))
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// Removes runtimes nothing points at any more. Best effort: one a server still runs from stays until
/// the next pass. Returns the versions removed.
pub fn collect_garbage(runtime_root: &Path, state: &RuntimeState) -> Vec<String> {
    let keep = [
        state.confirmed.as_deref(),
        state.previous_confirmed.as_deref(),
        state.pending.as_ref().map(|pending| pending.version.as_str()),
    ];
    let mut removed = Vec::new();
    if let Ok(entries) = fs::read_dir(runtime_root.join(VERSIONS_DIR)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if keep.contains(&Some(name.as_str())) {
                continue;
            }
            if fs::remove_dir_all(entry.path()).is_ok() && !name.starts_with(INCOMING_PREFIX) {
                removed.push(name);
            }
        }
    }
    remove_legacy_directories(runtime_root);
    removed
}

pub fn same_path(left: &Path, right: &Path) -> bool {
    comparable(left) == comparable(right)
}

fn comparable(path: &Path) -> String {
    let normalized = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = normalized.to_string_lossy();
    let value = value.strip_prefix(r"\\?\").unwrap_or(&value).replace('\\', "/");
    let value = value.trim_end_matches('/').to_string();
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Could not open {} for SHA-256: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn stage(runtime: &Path, version: &str, bytes: &[u8]) -> PathBuf {
        let dir = runtime.join("staging").join(version);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SERVER_JAR), bytes).unwrap();
        dir
    }

    fn pending(version: &str, root: &Path) -> PendingRuntime {
        PendingRuntime {
            operation_id: "op".into(),
            version: version.into(),
            profile_id: "main".into(),
            root_dir: root.to_string_lossy().into_owned(),
            server_url: "http://127.0.0.1:4567".into(),
            snapshot_path: String::new(),
            started_at_ms: 1,
        }
    }

    #[test]
    fn state_round_trips_and_damage_is_set_aside_by_writers_only() {
        let temp = tempdir().unwrap();
        let runtime = temp.path();
        assert_eq!(read_state(runtime).unwrap(), None);
        let mut state = RuntimeState::new();
        state.confirmed = Some("v2.3.2243".into());
        state.pending = Some(pending("v2.1.1867", Path::new("C:/profile")));
        write_state(runtime, &state).unwrap();
        let read = read_state(runtime).unwrap().unwrap();
        assert_eq!(read.confirmed, state.confirmed);
        assert_eq!(read.pending, state.pending);
        assert!(read.updated_at_ms > 0);
        // No temp file is left next to the state.
        assert_eq!(fs::read_dir(runtime).unwrap().count(), 1);

        fs::write(state_path(runtime), b"{ torn").unwrap();
        assert!(read_state(runtime).is_err());
        // A reader never moves it; it starts from the bundled runtime.
        assert_eq!(resolve_managed_jar_with(runtime, None, || true), None);
        assert!(state_path(runtime).exists());
        assert_eq!(read_state_for_update(runtime).unwrap(), RuntimeState::new());
        assert!(!state_path(runtime).exists());
        assert_eq!(fs::read_dir(runtime.join(DIAGNOSTICS_DIR)).unwrap().count(), 1);
    }

    #[test]
    fn state_rejects_versions_that_escape_the_versions_directory() {
        let temp = tempdir().unwrap();
        for version in ["..", "../x", "a/b", "a\\b", ".incoming-x", ""] {
            assert!(version_dir(temp.path(), version).is_err(), "{version}");
        }
        fs::write(
            state_path(temp.path()),
            br#"{"schemaVersion":1,"confirmed":"..\\..\\evil","previousConfirmed":null,"pending":null,"updatedAtMs":0}"#,
        )
        .unwrap();
        assert!(read_state(temp.path()).is_err());
    }

    #[test]
    fn resolver_prefers_pending_only_for_its_profile_under_maintenance() {
        let temp = tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let main = temp.path().join("main");
        let other = temp.path().join("other");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&other).unwrap();

        // Nothing installed: bundled.
        assert_eq!(resolve_managed_jar_with(&runtime, Some(&main), || true), None);
        // Legacy layout only: its current JAR.
        fs::create_dir_all(runtime.join(LEGACY_CURRENT_DIR)).unwrap();
        fs::write(legacy_current_jar(&runtime), b"legacy").unwrap();
        assert_eq!(
            resolve_managed_jar_with(&runtime, Some(&main), || true),
            Some(legacy_current_jar(&runtime))
        );

        for (version, bytes) in [("v1", b"one".as_slice()), ("v2", b"two".as_slice())] {
            publish_version(&runtime, &stage(&runtime, version, bytes), version, &sha(bytes)).unwrap();
        }
        let mut state = RuntimeState::new();
        state.confirmed = Some("v1".into());
        state.pending = Some(pending("v2", &main));
        write_state(&runtime, &state).unwrap();
        let v1 = version_jar(&runtime, "v1").unwrap();
        let v2 = version_jar(&runtime, "v2").unwrap();

        // Once a state exists the legacy directory is no longer consulted.
        assert_eq!(resolve_managed_jar_with(&runtime, Some(&main), || true), Some(v2.clone()));
        // Abandoned attempt (no maintenance): the confirmed runtime.
        assert_eq!(resolve_managed_jar_with(&runtime, Some(&main), || false), Some(v1.clone()));
        // Another profile never boots the candidate, and is not even asked about maintenance.
        assert_eq!(
            resolve_managed_jar_with(&runtime, Some(&other), || panic!("not asked")),
            Some(v1.clone())
        );
        assert_eq!(resolve_managed_jar_with(&runtime, None, || panic!("not asked")), Some(v1.clone()));
        let mut known = known_managed_jars(&runtime);
        known.sort();
        assert_eq!(known, vec![legacy_current_jar(&runtime), v1.clone(), v2.clone()]);

        // A confirmed runtime that disappeared falls back to the bundled one instead of failing.
        fs::remove_dir_all(v1.parent().unwrap()).unwrap();
        assert_eq!(resolve_managed_jar_with(&runtime, Some(&other), || false), None);
    }

    #[test]
    fn publish_is_idempotent_and_never_replaces_the_confirmed_runtime() {
        let temp = tempdir().unwrap();
        let runtime = temp.path();
        let good = b"certified";
        let dir = publish_version(runtime, &stage(runtime, "v2", good), "v2", &sha(good)).unwrap();
        assert_eq!(fs::read(dir.join(SERVER_JAR)).unwrap(), good);
        assert!(!runtime.join("staging").join("v2").exists());

        // Republishing the same version (a retried install) keeps it and drops the new staging copy.
        let staging = stage(runtime, "v2", good);
        publish_version(runtime, &staging, "v2", &sha(good)).unwrap();
        assert!(!staging.exists());

        // A staged JAR that does not match is refused and nothing is published.
        assert!(publish_version(runtime, &stage(runtime, "v3", b"evil"), "v3", &sha(good)).is_err());
        assert!(!version_dir(runtime, "v3").unwrap().exists());

        // A damaged copy of a version nothing runs is replaced...
        fs::write(dir.join(SERVER_JAR), b"torn").unwrap();
        publish_version(runtime, &stage(runtime, "v2", good), "v2", &sha(good)).unwrap();
        assert_eq!(fs::read(dir.join(SERVER_JAR)).unwrap(), good);
        // ...but the confirmed runtime is never removed by an install.
        let mut state = RuntimeState::new();
        state.confirmed = Some("v2".into());
        write_state(runtime, &state).unwrap();
        fs::write(dir.join(SERVER_JAR), b"torn").unwrap();
        assert!(publish_version(runtime, &stage(runtime, "v2", good), "v2", &sha(good)).is_err());
        assert_eq!(fs::read(dir.join(SERVER_JAR)).unwrap(), b"torn");
    }

    #[test]
    fn garbage_collection_keeps_every_runtime_the_state_names() {
        let temp = tempdir().unwrap();
        let runtime = temp.path();
        for version in ["v1", "v2", "v3", "v4"] {
            publish_version(runtime, &stage(runtime, version, version.as_bytes()), version, &sha(version.as_bytes()))
                .unwrap();
        }
        fs::create_dir_all(runtime.join(VERSIONS_DIR).join(".incoming-abc")).unwrap();
        fs::create_dir_all(runtime.join(LEGACY_PREVIOUS_DIR)).unwrap();
        fs::create_dir_all(runtime.join(".previous-replaced-op")).unwrap();
        let mut state = RuntimeState::new();
        state.confirmed = Some("v3".into());
        state.previous_confirmed = Some("v2".into());
        state.pending = Some(pending("v4", Path::new("C:/p")));
        let mut removed = collect_garbage(runtime, &state);
        removed.sort();
        assert_eq!(removed, vec!["v1".to_string()]);
        let mut left = fs::read_dir(runtime.join(VERSIONS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        left.sort();
        assert_eq!(left, vec!["v2", "v3", "v4"]);
        assert!(!runtime.join(LEGACY_PREVIOUS_DIR).exists());
        assert!(!runtime.join(".previous-replaced-op").exists());
    }

    #[test]
    fn legacy_layout_migrates_once_and_survives_an_interrupted_pass() {
        let temp = tempdir().unwrap();
        let runtime = temp.path();
        fs::create_dir_all(runtime.join(LEGACY_CURRENT_DIR)).unwrap();
        fs::create_dir_all(runtime.join(LEGACY_PREVIOUS_DIR)).unwrap();
        fs::write(legacy_current_jar(runtime), b"legacy-jar").unwrap();
        fs::write(runtime.join(LEGACY_PREVIOUS_DIR).join(SERVER_JAR), b"older").unwrap();
        // An earlier pass that stopped after copying (no state yet) is simply redone.
        let leftover = runtime.join(VERSIONS_DIR).join(".incoming-crashed");
        fs::create_dir_all(&leftover).unwrap();

        let state = migrate_legacy_layout(runtime, |_| Some("v2.1.1867".into())).unwrap();
        assert_eq!(state.confirmed.as_deref(), Some("v2.1.1867"));
        assert_eq!(fs::read(version_jar(runtime, "v2.1.1867").unwrap()).unwrap(), b"legacy-jar");
        assert!(!runtime.join(LEGACY_CURRENT_DIR).exists());
        assert!(!runtime.join(LEGACY_PREVIOUS_DIR).exists());
        assert_eq!(
            resolve_managed_jar_with(runtime, None, || false),
            Some(version_jar(runtime, "v2.1.1867").unwrap())
        );
        // A second pass changes nothing.
        let again = migrate_legacy_layout(runtime, |_| panic!("not asked")).unwrap();
        assert_eq!(again.confirmed, state.confirmed);
        collect_garbage(runtime, &again);
        assert!(!leftover.exists());
    }

    #[test]
    fn legacy_layout_without_a_runtime_records_the_bundled_one() {
        let temp = tempdir().unwrap();
        let state = migrate_legacy_layout(temp.path(), |_| None).unwrap();
        assert_eq!(state.confirmed, None);
        assert!(state_path(temp.path()).exists());

        // An unreadable JAR version is still kept rather than silently dropped.
        let other = tempdir().unwrap();
        fs::create_dir_all(other.path().join(LEGACY_CURRENT_DIR)).unwrap();
        fs::write(legacy_current_jar(other.path()), b"x").unwrap();
        let state = migrate_legacy_layout(other.path(), |_| Some("not a/version".into())).unwrap();
        assert_eq!(state.confirmed.as_deref(), Some("legacy"));
        assert!(version_jar(other.path(), "legacy").unwrap().is_file());
    }

    #[test]
    fn legacy_directories_wait_for_an_interrupted_legacy_update() {
        let temp = tempdir().unwrap();
        let runtime = temp.path();
        fs::create_dir_all(runtime.join(LEGACY_PREVIOUS_DIR)).unwrap();
        fs::write(crate::suwayomi_maintenance::update_journal_path(runtime), b"{}").unwrap();
        collect_garbage(runtime, &RuntimeState::new());
        assert!(runtime.join(LEGACY_PREVIOUS_DIR).exists());
    }
}
