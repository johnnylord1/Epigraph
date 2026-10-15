//! Undoing what a Suwayomi update left half done, shared by the desktop and the Core. The Core is the
//! process that outlives an update of the main profile, so it recovers that profile itself, even with
//! the desktop closed. Free of Tauri so both binaries build it.
//!
//! Every step is idempotent: running it again after an interruption restores the same snapshot.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::suwayomi_maintenance;
use crate::suwayomi_runtime_store::{self, PendingRestoreError, PendingRuntime};

pub const SUWAYOMI_SNAPSHOT_MANIFEST: &str = "snapshot-manifest.json";
pub const SUWAYOMI_SNAPSHOT_VERSION: &str = "2";
pub const SUWAYOMI_SNAPSHOT_ALLOWLIST: &[&str] = &[
    "server.conf",
    "database.mv.db",
    "database.trace.db",
    "server.owner.json",
];
pub const SUWAYOMI_SNAPSHOT_DIRECTORY_ALLOWLIST: &[&str] = &["extensions", "settings"];
const EXTENSION_BATCH_JOURNAL: &str = "extension-update-journal.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiSnapshotFile {
    pub name: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// The part of a snapshot manifest a restore reads.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotContents {
    schema_version: u32,
    snapshot_version: String,
    source_root: String,
    pub files: Vec<SuwayomiSnapshotFile>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExtensionBatchJournalState {
    Prepared,
    SnapshotCreated,
    Certifying,
    Activating,
    Committed,
    RollbackRunning,
    RolledBack,
}

impl ExtensionBatchJournalState {
    /// The batch may have changed its profile, which only its snapshot puts back. `Prepared` never
    /// touched the profile, and `Committed` and `RolledBack` are settled: they leave only the
    /// candidate profile to remove.
    pub fn needs_restore(self) -> bool {
        matches!(
            self,
            Self::SnapshotCreated | Self::Certifying | Self::Activating | Self::RollbackRunning
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionBatchJournal {
    pub schema_version: u32,
    pub operation_id: String,
    pub state: ExtensionBatchJournalState,
    pub profile_id: String,
    pub root_dir: String,
    pub server_url: String,
    pub runtime_version: String,
    pub snapshot_path: String,
    pub batch_root: String,
    pub candidate_profile_id: String,
    pub candidate_root_dir: String,
    pub candidate_server_url: String,
    pub updated_at_ms: u128,
}

impl ExtensionBatchJournal {
    pub fn transition(&mut self, state: ExtensionBatchJournalState) {
        self.state = state;
        self.updated_at_ms = u128::from(suwayomi_runtime_store::unix_now_ms());
    }
}

pub fn extension_batch_journal_path(runtime_root: &Path) -> PathBuf {
    runtime_root.join(EXTENSION_BATCH_JOURNAL)
}

pub fn write_extension_batch_journal_at(
    path: &Path,
    journal: &ExtensionBatchJournal,
) -> Result<(), String> {
    fs::create_dir_all(path.parent().unwrap_or_else(|| Path::new(".")))
        .map_err(|error| format!("Could not create extension journal directory: {error}"))?;
    let temp_path = path.with_extension(format!("{}.tmp", journal.operation_id));
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("Could not serialize extension update journal: {error}"))?;
    let mut file = File::create(&temp_path)
        .map_err(|error| format!("Could not create extension update journal: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Could not write extension update journal: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush extension update journal: {error}"))?;
    suwayomi_maintenance::atomic_replace_file(&temp_path, path)
        .map_err(|error| format!("Could not publish extension update journal: {error}"))
}

pub fn read_extension_batch_journal_at(path: &Path) -> Result<Option<ExtensionBatchJournal>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read extension update journal: {error}")),
    };
    let journal = serde_json::from_str::<ExtensionBatchJournal>(&text)
        .map_err(|error| format!("Could not parse extension update journal: {error}"))?;
    if journal.schema_version != 1 {
        return Err("Extension update journal has an unsupported schema.".to_string());
    }
    Ok(Some(journal))
}

/// The extension batch interrupted on `profile_root` before it settled, if any.
fn unsettled_extension_batch(runtime_root: &Path, profile_root: &Path) -> Option<ExtensionBatchJournal> {
    read_extension_batch_journal_at(&extension_batch_journal_path(runtime_root))
        .ok()
        .flatten()
        .filter(|journal| {
            journal.state.needs_restore()
                && suwayomi_runtime_store::same_path(Path::new(&journal.root_dir), profile_root)
        })
}

/// Whether an update left the profile `profile_id` running something unverified: an attempt still
/// pending or an extension batch that never settled. Whoever gets past the runtime's shared lease knows
/// nobody is maintaining it, so that work was abandoned and is about to be undone; writes made in the
/// meantime would be lost with it. Unreadable state reads as "nothing", since recovery reads it again.
pub fn abandoned_work_for_profile(runtime_root: &Path, profile_id: &str) -> bool {
    let pending = suwayomi_runtime_store::read_state(runtime_root)
        .ok()
        .flatten()
        .and_then(|state| state.pending)
        .is_some_and(|pending| pending.profile_id == profile_id);
    pending
        || read_extension_batch_journal_at(&extension_batch_journal_path(runtime_root))
            .ok()
            .flatten()
            .is_some_and(|journal| journal.state.needs_restore() && journal.profile_id == profile_id)
}

/// Whether `profile_root` has abandoned work for [`roll_back_abandoned_work`] to undo.
pub fn abandoned_work_at(runtime_root: &Path, profile_root: &Path) -> bool {
    let pending = suwayomi_runtime_store::read_state(runtime_root)
        .ok()
        .flatten()
        .is_some_and(|state| state.pending_for(profile_root).is_some());
    pending || unsettled_extension_batch(runtime_root, profile_root).is_some()
}

/// Puts `profile_root` back as it was before the update that abandoned work on it: an unsettled
/// extension batch is restored and marked `RolledBack` (the desktop removes its candidate later), and
/// a pending runtime attempt is restored and cleared, so the confirmed runtime starts again. The caller
/// holds the runtime's exclusive lease and has stopped the profile's server. Returns whether anything
/// was undone.
pub fn roll_back_abandoned_work(runtime_root: &Path, profile_root: &Path) -> Result<bool, String> {
    let mut undone = false;
    if let Some(mut journal) = unsettled_extension_batch(runtime_root, profile_root) {
        roll_back_extension_batch(runtime_root, &mut journal, profile_root)?;
        undone = true;
    }
    let pending = suwayomi_runtime_store::read_state(runtime_root)?
        .is_some_and(|state| state.pending_for(profile_root).is_some());
    if pending {
        suwayomi_runtime_store::roll_back_pending(runtime_root, restore_pending_attempt)?;
        undone = true;
    }
    Ok(undone)
}

/// Restores the profile of an abandoned runtime attempt from the snapshot taken before it.
pub fn restore_pending_attempt(pending: &PendingRuntime) -> Result<(), PendingRestoreError> {
    if pending.snapshot_path.is_empty() {
        return Err(PendingRestoreError::Unusable(
            "The update recorded no snapshot.".to_string(),
        ));
    }
    restore_usable_snapshot(Path::new(&pending.snapshot_path), Path::new(&pending.root_dir))
}

/// Restores the snapshot of an extension batch that never settled and marks it `RolledBack`. A
/// snapshot that can never be restored would keep the profile from starting for good, so the batch is
/// marked rolled back anyway and the reason logged. The caller holds the runtime's exclusive lease and
/// has stopped the profile's server.
pub fn roll_back_extension_batch(
    runtime_root: &Path,
    journal: &mut ExtensionBatchJournal,
    profile_root: &Path,
) -> Result<(), String> {
    let path = extension_batch_journal_path(runtime_root);
    journal.transition(ExtensionBatchJournalState::RollbackRunning);
    write_extension_batch_journal_at(&path, journal)?;
    match restore_usable_snapshot(Path::new(&journal.snapshot_path), profile_root) {
        Ok(()) => {}
        Err(PendingRestoreError::Retry(error)) => return Err(error),
        Err(PendingRestoreError::Unusable(error)) => eprintln!(
            "[epigraph-suwayomi-update] extension batch {} could not restore its snapshot: {error}",
            journal.operation_id
        ),
    }
    journal.transition(ExtensionBatchJournalState::RolledBack);
    write_extension_batch_journal_at(&path, journal)
}

/// A snapshot that does not validate or belongs elsewhere can never be restored; a copy that fails
/// (a file in use) can be retried.
fn restore_usable_snapshot(snapshot_dir: &Path, root_dir: &Path) -> Result<(), PendingRestoreError> {
    let contents = usable_snapshot(snapshot_dir, root_dir).map_err(PendingRestoreError::Unusable)?;
    copy_snapshot_to_root(snapshot_dir, &contents, root_dir).map_err(PendingRestoreError::Retry)
}

pub fn validate_snapshot_for_restore(snapshot_dir: &Path) -> Result<SnapshotContents, String> {
    if !snapshot_dir.is_dir() {
        return Err("Rollback snapshot directory does not exist.".to_string());
    }
    let manifest_path = snapshot_dir.join(SUWAYOMI_SNAPSHOT_MANIFEST);
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Could not read rollback snapshot manifest: {error}"))?;
    let contents: SnapshotContents = serde_json::from_str(&text)
        .map_err(|error| format!("Could not parse rollback snapshot manifest: {error}"))?;
    let supported = (contents.schema_version == 1 && contents.snapshot_version == "1")
        || (contents.schema_version == 2 && contents.snapshot_version == SUWAYOMI_SNAPSHOT_VERSION);
    if !supported {
        return Err("Rollback snapshot manifest has an unsupported schema.".to_string());
    }
    validate_snapshot_files(snapshot_dir, &contents.files)?;
    Ok(contents)
}

fn usable_snapshot(snapshot_dir: &Path, root_dir: &Path) -> Result<SnapshotContents, String> {
    let contents = validate_snapshot_for_restore(snapshot_dir)?;
    if !suwayomi_runtime_store::same_path(Path::new(&contents.source_root), root_dir) {
        return Err("Rollback snapshot belongs to a different Suwayomi root.".to_string());
    }
    Ok(contents)
}

pub fn restore_snapshot_to_root(snapshot_dir: &Path, root_dir: &Path) -> Result<(), String> {
    let contents = usable_snapshot(snapshot_dir, root_dir)?;
    copy_snapshot_to_root(snapshot_dir, &contents, root_dir)
}

fn copy_snapshot_to_root(
    snapshot_dir: &Path,
    contents: &SnapshotContents,
    root_dir: &Path,
) -> Result<(), String> {
    let snapshot_names = contents
        .files
        .iter()
        .map(|file| file.name.as_str())
        .collect::<HashSet<_>>();
    for name in SUWAYOMI_SNAPSHOT_ALLOWLIST {
        let target = root_dir.join(name);
        if !snapshot_names.contains(name) && target.exists() {
            fs::remove_file(&target)
                .map_err(|error| format!("Could not remove restored-absent {name}: {error}"))?;
        }
    }
    remove_snapshot_directory_extras(root_dir, &snapshot_names)?;
    for file in &contents.files {
        validate_snapshot_relative_path(&file.name)?;
        let source = snapshot_dir.join(&file.name);
        let target = root_dir.join(&file.name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Could not create restore parent for {}: {error}", file.name)
            })?;
        }
        let temp_target = target.with_extension(format!("{}.restore.tmp", Uuid::new_v4()));
        fs::copy(&source, &temp_target)
            .map_err(|error| format!("Could not restore {} from snapshot: {error}", file.name))?;
        OpenOptions::new()
            .write(true)
            .open(&temp_target)
            .and_then(|restored| restored.sync_all())
            .map_err(|error| format!("Could not sync restored {}: {error}", file.name))?;
        let restored_sha256 = sha256_file(&temp_target)?;
        if restored_sha256 != file.sha256 {
            let _ = fs::remove_file(&temp_target);
            return Err(format!(
                "Restored snapshot file {} failed SHA-256 validation.",
                file.name
            ));
        }
        suwayomi_maintenance::atomic_replace_file(&temp_target, &target)
            .map_err(|error| format!("Could not publish restored {}: {error}", file.name))?;
    }
    Ok(())
}

pub fn validate_snapshot_files(
    snapshot_dir: &Path,
    files: &[SuwayomiSnapshotFile],
) -> Result<(), String> {
    for file in files {
        validate_snapshot_relative_path(&file.name)?;
        let path = snapshot_dir.join(&file.name);
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not validate snapshot file {}: {error}", file.name))?;
        if !metadata.is_file() || metadata.len() != file.size_bytes {
            return Err(format!(
                "Snapshot file {} did not validate after copy.",
                file.name
            ));
        }
        let actual_sha256 = sha256_file(&path)?;
        if !actual_sha256.eq_ignore_ascii_case(&file.sha256) {
            return Err(format!(
                "Snapshot file {} failed SHA-256 validation.",
                file.name
            ));
        }
    }
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Could not open {} for SHA-256: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn relative_path_string(path: &Path) -> Result<String, String> {
    validate_snapshot_relative_path(&path.to_string_lossy())?;
    Ok(path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

pub fn validate_snapshot_relative_path(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("Snapshot manifest contains an unsafe relative path.".to_string());
    }
    Ok(())
}

fn remove_snapshot_directory_extras(
    root_dir: &Path,
    snapshot_names: &HashSet<&str>,
) -> Result<(), String> {
    for directory in SUWAYOMI_SNAPSHOT_DIRECTORY_ALLOWLIST {
        let directory_root = root_dir.join(directory);
        if !directory_root.exists() {
            continue;
        }
        let entries = WalkDir::new(&directory_root)
            .follow_links(false)
            .contents_first(true)
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not inspect restore directory {directory}: {error}"))?;
        for entry in entries {
            if entry.file_type().is_symlink() {
                return Err(format!(
                    "Restore directory {directory} contains an unsupported symbolic link."
                ));
            }
            if entry.file_type().is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root_dir)
                    .map_err(|_| "Restore file escaped the Suwayomi profile.".to_string())?;
                let name = relative_path_string(relative)?;
                if !snapshot_names.contains(name.as_str()) {
                    fs::remove_file(entry.path()).map_err(|error| {
                        format!("Could not remove restored-absent {name}: {error}")
                    })?;
                }
            } else if entry.file_type().is_dir()
                && entry.path() != directory_root
                && fs::read_dir(entry.path())
                    .map(|mut children| children.next().is_none())
                    .unwrap_or(false)
            {
                let _ = fs::remove_dir(entry.path());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::suwayomi_runtime_store::RuntimeState;
    use tempfile::tempdir;

    struct Layout {
        _temp: tempfile::TempDir,
        runtime: PathBuf,
        profile: PathBuf,
        snapshot: PathBuf,
    }

    /// A profile changed by an update (`new`), and the snapshot taken before it (`old`).
    fn layout() -> Layout {
        let temp = tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let profile = temp.path().join("main");
        let snapshot = temp.path().join("snapshot");
        fs::create_dir_all(profile.join("extensions")).unwrap();
        fs::write(profile.join("database.mv.db"), b"new").unwrap();
        fs::write(profile.join("extensions").join("new.apk"), b"new").unwrap();
        let files = [("database.mv.db", &b"old"[..]), ("extensions/old.apk", &b"old"[..])];
        fs::create_dir_all(snapshot.join("extensions")).unwrap();
        let mut entries = Vec::new();
        for (name, bytes) in files {
            fs::write(snapshot.join(name), bytes).unwrap();
            entries.push(SuwayomiSnapshotFile {
                name: name.to_string(),
                size_bytes: bytes.len() as u64,
                sha256: Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect(),
            });
        }
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "snapshotVersion": SUWAYOMI_SNAPSHOT_VERSION,
            "sourceRoot": profile.to_string_lossy(),
            "files": entries,
        });
        fs::write(snapshot.join(SUWAYOMI_SNAPSHOT_MANIFEST), manifest.to_string()).unwrap();
        Layout { _temp: temp, runtime, profile, snapshot }
    }

    fn journal(layout: &Layout, state: ExtensionBatchJournalState) -> ExtensionBatchJournal {
        let journal = ExtensionBatchJournal {
            schema_version: 1,
            operation_id: "batch".into(),
            state,
            profile_id: "main".into(),
            root_dir: layout.profile.to_string_lossy().into_owned(),
            server_url: "http://127.0.0.1:4567".into(),
            runtime_version: "v2.3.2243".into(),
            snapshot_path: layout.snapshot.to_string_lossy().into_owned(),
            batch_root: String::new(),
            candidate_profile_id: "candidate".into(),
            candidate_root_dir: String::new(),
            candidate_server_url: String::new(),
            updated_at_ms: 0,
        };
        write_extension_batch_journal_at(&extension_batch_journal_path(&layout.runtime), &journal)
            .unwrap();
        journal
    }

    fn journal_state(layout: &Layout) -> ExtensionBatchJournalState {
        read_extension_batch_journal_at(&extension_batch_journal_path(&layout.runtime))
            .unwrap()
            .unwrap()
            .state
    }

    fn pending(layout: &Layout, snapshot_path: &Path) {
        let mut state = RuntimeState::new();
        state.confirmed = Some("v2.3.2243".into());
        state.pending = Some(PendingRuntime {
            operation_id: "op".into(),
            version: "v2.4.0".into(),
            profile_id: "main".into(),
            root_dir: layout.profile.to_string_lossy().into_owned(),
            server_url: "http://127.0.0.1:4567".into(),
            snapshot_path: snapshot_path.to_string_lossy().into_owned(),
            started_at_ms: 1,
        });
        suwayomi_runtime_store::write_state(&layout.runtime, &state).unwrap();
    }

    fn database(layout: &Layout) -> Vec<u8> {
        fs::read(layout.profile.join("database.mv.db")).unwrap()
    }

    #[test]
    fn only_unsettled_batches_of_the_profile_are_abandoned() {
        let layout = layout();
        assert!(!abandoned_work_at(&layout.runtime, &layout.profile));
        assert!(!abandoned_work_for_profile(&layout.runtime, "main"));
        for state in [
            ExtensionBatchJournalState::Prepared,
            ExtensionBatchJournalState::Committed,
            ExtensionBatchJournalState::RolledBack,
        ] {
            journal(&layout, state);
            assert!(!abandoned_work_at(&layout.runtime, &layout.profile), "{state:?}");
            assert!(!abandoned_work_for_profile(&layout.runtime, "main"), "{state:?}");
        }
        for state in [
            ExtensionBatchJournalState::SnapshotCreated,
            ExtensionBatchJournalState::Certifying,
            ExtensionBatchJournalState::Activating,
            ExtensionBatchJournalState::RollbackRunning,
        ] {
            journal(&layout, state);
            assert!(abandoned_work_at(&layout.runtime, &layout.profile), "{state:?}");
            assert!(abandoned_work_for_profile(&layout.runtime, "main"), "{state:?}");
            // Another profile keeps working.
            assert!(!abandoned_work_for_profile(&layout.runtime, "other"), "{state:?}");
            assert!(!abandoned_work_at(&layout.runtime, &layout.runtime), "{state:?}");
        }
    }

    #[test]
    fn abandoned_extension_batch_is_restored_once() {
        let layout = layout();
        journal(&layout, ExtensionBatchJournalState::Activating);
        assert!(roll_back_abandoned_work(&layout.runtime, &layout.profile).unwrap());
        assert_eq!(database(&layout), b"old");
        assert!(layout.profile.join("extensions").join("old.apk").exists());
        assert!(!layout.profile.join("extensions").join("new.apk").exists());
        assert_eq!(journal_state(&layout), ExtensionBatchJournalState::RolledBack);
        assert!(!abandoned_work_at(&layout.runtime, &layout.profile));

        // What the profile writes afterwards survives another pass.
        fs::write(layout.profile.join("database.mv.db"), b"later").unwrap();
        assert!(!roll_back_abandoned_work(&layout.runtime, &layout.profile).unwrap());
        assert_eq!(database(&layout), b"later");
    }

    #[test]
    fn interrupted_rollback_restores_again() {
        let layout = layout();
        journal(&layout, ExtensionBatchJournalState::RollbackRunning);
        assert!(roll_back_abandoned_work(&layout.runtime, &layout.profile).unwrap());
        assert_eq!(database(&layout), b"old");
        assert_eq!(journal_state(&layout), ExtensionBatchJournalState::RolledBack);
    }

    #[test]
    fn unusable_extension_snapshot_still_settles_the_batch() {
        let layout = layout();
        let mut journal = journal(&layout, ExtensionBatchJournalState::Certifying);
        journal.snapshot_path = layout.runtime.join("missing").to_string_lossy().into_owned();
        write_extension_batch_journal_at(&extension_batch_journal_path(&layout.runtime), &journal)
            .unwrap();
        assert!(roll_back_abandoned_work(&layout.runtime, &layout.profile).unwrap());
        assert_eq!(database(&layout), b"new");
        assert_eq!(journal_state(&layout), ExtensionBatchJournalState::RolledBack);
        assert!(!abandoned_work_at(&layout.runtime, &layout.profile));
    }

    #[test]
    fn snapshot_of_another_profile_is_never_restored() {
        let layout = layout();
        let other = layout.runtime.join("other");
        fs::create_dir_all(&other).unwrap();
        assert!(restore_snapshot_to_root(&layout.snapshot, &other).is_err());
        assert!(matches!(
            restore_usable_snapshot(&layout.snapshot, &other),
            Err(PendingRestoreError::Unusable(_))
        ));
        assert!(!other.join("database.mv.db").exists());
    }

    #[test]
    fn abandoned_runtime_attempt_is_restored_and_cleared() {
        let layout = layout();
        pending(&layout, &layout.snapshot);
        assert!(abandoned_work_at(&layout.runtime, &layout.profile));
        assert!(abandoned_work_for_profile(&layout.runtime, "main"));
        assert!(!abandoned_work_for_profile(&layout.runtime, "other"));
        assert!(!abandoned_work_at(&layout.runtime, &layout.runtime));

        assert!(roll_back_abandoned_work(&layout.runtime, &layout.profile).unwrap());
        assert_eq!(database(&layout), b"old");
        let state = suwayomi_runtime_store::read_state(&layout.runtime).unwrap().unwrap();
        assert_eq!(state.pending, None);
        assert_eq!(state.confirmed.as_deref(), Some("v2.3.2243"));
        assert!(!abandoned_work_at(&layout.runtime, &layout.profile));
        assert!(!roll_back_abandoned_work(&layout.runtime, &layout.profile).unwrap());
    }

    #[test]
    fn runtime_attempt_without_a_usable_snapshot_is_cleared() {
        let layout = layout();
        pending(&layout, Path::new(""));
        assert!(roll_back_abandoned_work(&layout.runtime, &layout.profile).unwrap());
        assert_eq!(database(&layout), b"new");
        let state = suwayomi_runtime_store::read_state(&layout.runtime).unwrap().unwrap();
        assert_eq!(state.pending, None);
    }

    #[test]
    fn runtime_attempt_and_extension_batch_are_both_undone() {
        let layout = layout();
        journal(&layout, ExtensionBatchJournalState::Activating);
        pending(&layout, &layout.snapshot);
        assert!(roll_back_abandoned_work(&layout.runtime, &layout.profile).unwrap());
        assert_eq!(database(&layout), b"old");
        assert_eq!(journal_state(&layout), ExtensionBatchJournalState::RolledBack);
        assert_eq!(
            suwayomi_runtime_store::read_state(&layout.runtime).unwrap().unwrap().pending,
            None
        );
    }
}
