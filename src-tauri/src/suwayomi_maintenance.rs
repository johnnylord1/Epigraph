use fs2::FileExt;
#[path = "restore_operation.rs"]
pub mod restore_operation;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const UPDATE_LOCK_FILE: &str = "update.lock";
const UPDATE_JOURNAL_FILE: &str = "update-journal.json";
const UPDATE_JOURNAL_SCHEMA_VERSION: u32 = 1;
const DEFAULT_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const FILE_LOCK_RETRY_DELAY: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MaintenancePhase {
    #[default]
    Ready,
    Draining,
    Updating,
    Recovering,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UpdateJournalState {
    CurrentStopped,
    RuntimePromoted,
    ProfileMigrated,
    PostCheckRunning,
    Committed,
    RollbackRunning,
    RolledBack,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuwayomiUpdateJournal {
    pub schema_version: u32,
    pub operation_id: String,
    pub state: UpdateJournalState,
    pub profile_id: String,
    pub root_dir: String,
    pub server_url: String,
    pub staged_version: String,
    pub snapshot_path: String,
    pub current_dir: String,
    pub previous_dir: String,
    pub previous_backup_dir: String,
    pub staging_dir: String,
    pub had_current: bool,
    pub started_at_ms: u128,
    pub updated_at_ms: u128,
}

impl SuwayomiUpdateJournal {
    pub fn transition(&mut self, state: UpdateJournalState) {
        self.state = state;
        self.updated_at_ms = unix_now_ms();
    }
}

struct ActiveOperation {
    _scope: String,
    _file_lease: SharedFileLease,
}

#[derive(Default)]
struct CoordinatorState {
    phase: MaintenancePhase,
    owner: Option<String>,
    started_at_ms: Option<u128>,
    generation: u64,
    operations: HashMap<String, ActiveOperation>,
}

struct Coordinator {
    state: Mutex<CoordinatorState>,
    changed: Condvar,
}

static COORDINATOR: OnceLock<Coordinator> = OnceLock::new();

/// The coordinator is process-global. Tests that move its phase must not interleave, or a
/// transient `Draining` phase from one test rejects operations started by another.
#[cfg(test)]
pub(crate) static COORDINATOR_TEST_LOCK: Mutex<()> = Mutex::new(());

fn coordinator() -> &'static Coordinator {
    COORDINATOR.get_or_init(|| Coordinator {
        state: Mutex::new(CoordinatorState::default()),
        changed: Condvar::new(),
    })
}

pub struct SharedFileLease {
    file: File,
}

impl Drop for SharedFileLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

pub struct ExclusiveFileLease {
    file: File,
}

impl Drop for ExclusiveFileLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

pub struct ExclusiveMaintenanceGuard {
    _file_lease: ExclusiveFileLease,
}

impl Drop for ExclusiveMaintenanceGuard {
    fn drop(&mut self) {
        let coordinator = coordinator();
        if let Ok(mut state) = coordinator.state.lock() {
            state.phase = MaintenancePhase::Ready;
            state.owner = None;
            state.started_at_ms = None;
            state.generation = state.generation.saturating_add(1);
            coordinator.changed.notify_all();
        }
    }
}

pub fn default_runtime_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    let data_root = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| PathBuf::from("C:\\ProgramData")));
    #[cfg(not(target_os = "windows"))]
    let data_root = dirs::data_dir().unwrap_or_else(|| PathBuf::from("/tmp"));

    data_root.join("epigraph").join("suwayomi-runtime")
}

pub fn update_journal_path(runtime_root: &Path) -> PathBuf {
    runtime_root.join(UPDATE_JOURNAL_FILE)
}

fn update_lock_path(runtime_root: &Path) -> PathBuf {
    runtime_root.join(UPDATE_LOCK_FILE)
}

fn open_lock_file(runtime_root: &Path) -> Result<File, String> {
    fs::create_dir_all(runtime_root)
        .map_err(|error| format!("Could not create Suwayomi runtime lock directory: {error}"))?;
    OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(update_lock_path(runtime_root))
        .map_err(|error| format!("Could not open Suwayomi runtime lock: {error}"))
}

pub fn try_acquire_shared_file_lease(runtime_root: &Path) -> Result<SharedFileLease, String> {
    let file = open_lock_file(runtime_root)?;
    file.try_lock_shared().map_err(|_| {
        "Suwayomi is temporarily unavailable while its runtime is maintained.".to_string()
    })?;
    Ok(SharedFileLease { file })
}

fn acquire_exclusive_file_lease(
    runtime_root: &Path,
    timeout: Duration,
) -> Result<ExclusiveFileLease, String> {
    let file = open_lock_file(runtime_root)?;
    let started = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(ExclusiveFileLease { file }),
            Err(_) if started.elapsed() < timeout => thread::sleep(FILE_LOCK_RETRY_DELAY),
            Err(_) => {
                return Err(
                    "Suwayomi is busy in another Epigraph session. Try the update again shortly."
                        .to_string(),
                )
            }
        }
    }
}

pub fn begin_operation(runtime_root: &Path, scope: &str) -> Result<String, String> {
    let file_lease = try_acquire_shared_file_lease(runtime_root)?;
    let coordinator = coordinator();
    let mut state = coordinator
        .state
        .lock()
        .map_err(|_| "Suwayomi maintenance state is unavailable.".to_string())?;
    if state.phase != MaintenancePhase::Ready {
        return Err(
            "Suwayomi is temporarily unavailable while its runtime is maintained.".to_string(),
        );
    }
    let token = Uuid::new_v4().to_string();
    state.operations.insert(
        token.clone(),
        ActiveOperation {
            _scope: scope.trim().to_string(),
            _file_lease: file_lease,
        },
    );
    Ok(token)
}

pub fn end_operation(token: &str) -> bool {
    let coordinator = coordinator();
    let Ok(mut state) = coordinator.state.lock() else {
        return false;
    };
    let removed = state.operations.remove(token).is_some();
    if removed {
        coordinator.changed.notify_all();
    }
    removed
}

pub fn begin_exclusive_maintenance(
    runtime_root: &Path,
    owner: &str,
    phase: MaintenancePhase,
) -> Result<ExclusiveMaintenanceGuard, String> {
    if !matches!(
        phase,
        MaintenancePhase::Updating | MaintenancePhase::Recovering
    ) {
        return Err(
            "Exclusive Suwayomi maintenance requires an updating or recovering phase.".to_string(),
        );
    }

    let coordinator = coordinator();
    let started = Instant::now();
    let mut state = coordinator
        .state
        .lock()
        .map_err(|_| "Suwayomi maintenance state is unavailable.".to_string())?;
    if state.phase != MaintenancePhase::Ready {
        return Err("Another Suwayomi maintenance operation is already running.".to_string());
    }
    state.phase = MaintenancePhase::Draining;
    state.owner = Some(owner.to_string());
    state.started_at_ms = Some(unix_now_ms());

    while !state.operations.is_empty() {
        let remaining = DEFAULT_DRAIN_TIMEOUT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            state.phase = MaintenancePhase::Ready;
            state.owner = None;
            state.started_at_ms = None;
            return Err(format!(
                "Suwayomi still has {} active operation(s); maintenance was cancelled safely.",
                state.operations.len()
            ));
        }
        let (next, wait) = coordinator
            .changed
            .wait_timeout(state, remaining)
            .map_err(|_| "Suwayomi maintenance drain failed.".to_string())?;
        state = next;
        if wait.timed_out() && !state.operations.is_empty() {
            state.phase = MaintenancePhase::Ready;
            state.owner = None;
            state.started_at_ms = None;
            return Err(
                "Suwayomi maintenance timed out while waiting for active operations.".to_string(),
            );
        }
    }
    drop(state);

    let file_lease = match acquire_exclusive_file_lease(runtime_root, DEFAULT_DRAIN_TIMEOUT) {
        Ok(lease) => lease,
        Err(error) => {
            if let Ok(mut state) = coordinator.state.lock() {
                state.phase = MaintenancePhase::Ready;
                state.owner = None;
                state.started_at_ms = None;
            }
            return Err(error);
        }
    };

    if let Err(error) = restore_operation::refuse_unresolved(runtime_root) {
        if let Ok(mut state) = coordinator.state.lock() {
            state.phase = MaintenancePhase::Ready;
            state.owner = None;
            state.started_at_ms = None;
        }
        return Err(error);
    }
    let mut state = coordinator
        .state
        .lock()
        .map_err(|_| "Suwayomi maintenance state is unavailable.".to_string())?;
    state.phase = phase;
    drop(state);
    Ok(ExclusiveMaintenanceGuard {
        _file_lease: file_lease,
    })
}

pub fn new_update_journal(
    operation_id: String,
    profile_id: String,
    root_dir: String,
    server_url: String,
    staged_version: String,
    snapshot_path: String,
    current_dir: String,
    previous_dir: String,
    previous_backup_dir: String,
    staging_dir: String,
    had_current: bool,
) -> SuwayomiUpdateJournal {
    let now = unix_now_ms();
    SuwayomiUpdateJournal {
        schema_version: UPDATE_JOURNAL_SCHEMA_VERSION,
        operation_id,
        state: UpdateJournalState::CurrentStopped,
        profile_id,
        root_dir,
        server_url,
        staged_version,
        snapshot_path,
        current_dir,
        previous_dir,
        previous_backup_dir,
        staging_dir,
        had_current,
        started_at_ms: now,
        updated_at_ms: now,
    }
}

pub fn read_update_journal(path: &Path) -> Result<Option<SuwayomiUpdateJournal>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read Suwayomi update journal: {error}")),
    };
    let journal: SuwayomiUpdateJournal = serde_json::from_str(&text)
        .map_err(|error| format!("Could not parse Suwayomi update journal: {error}"))?;
    if journal.schema_version != UPDATE_JOURNAL_SCHEMA_VERSION {
        return Err("Suwayomi update journal has an unsupported schema.".to_string());
    }
    Ok(Some(journal))
}

pub fn write_update_journal(path: &Path, journal: &SuwayomiUpdateJournal) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create Suwayomi journal directory: {error}"))?;
    }
    let temp_path = path.with_extension(format!("json.{}.tmp", journal.operation_id));
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| format!("Could not serialize Suwayomi update journal: {error}"))?;
    let mut file = File::create(&temp_path)
        .map_err(|error| format!("Could not create Suwayomi update journal: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Could not write Suwayomi update journal: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not sync Suwayomi update journal: {error}"))?;
    atomic_replace_file(&temp_path, path)
        .map_err(|error| format!("Could not publish Suwayomi update journal: {error}"))
}

pub fn remove_update_journal(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove Suwayomi update journal: {error}")),
    }
}

fn unix_now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(windows)]
pub(crate) fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from_w = win32_long_path(from)?;
    let to_w = win32_long_path(to)?;
    let result = unsafe {
        MoveFileExW(
            from_w.as_ptr(),
            to_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// `MoveFileExW` receives raw paths, so unlike `std::fs` it fails with "path not found" once a
/// path exceeds MAX_PATH, as restore inputs and imported books do under longer profile paths.
/// Paths are normalized and passed in the `\\?\` form, which lifts that limit.
#[cfg(windows)]
fn win32_long_path(path: &Path) -> std::io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;

    let absolute = std::path::absolute(path)?;
    let wide: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    let separator = u16::from(b'\\');
    let verbatim_or_device = wide.len() >= 4
        && wide[0] == separator
        && wide[1] == separator
        && (wide[2] == u16::from(b'?') || wide[2] == u16::from(b'.'))
        && wide[3] == separator;
    let mut long: Vec<u16> = Vec::with_capacity(wide.len() + 9);
    if verbatim_or_device {
        long.extend_from_slice(&wide);
    } else if wide.starts_with(&[separator, separator]) {
        long.extend(r"\\?\UNC".encode_utf16());
        long.extend_from_slice(&wide[1..]);
    } else {
        long.extend(r"\\?\".encode_utf16());
        long.extend_from_slice(&wide);
    }
    long.push(0);
    Ok(long)
}

#[cfg(not(windows))]
pub(crate) fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn shared_leases_block_exclusive_maintenance_until_released() {
        let temp = tempdir().unwrap();
        let shared = try_acquire_shared_file_lease(temp.path()).unwrap();
        assert!(acquire_exclusive_file_lease(temp.path(), Duration::from_millis(10)).is_err());
        drop(shared);
        assert!(acquire_exclusive_file_lease(temp.path(), Duration::from_millis(10)).is_ok());
    }

    #[test]
    fn atomic_replace_works_beyond_max_path() {
        let temp = tempdir().unwrap();
        let deep = temp.path().join("a".repeat(120)).join("b".repeat(120));
        fs::create_dir_all(&deep).unwrap();
        let target = deep.join(format!("{}.bin", "c".repeat(64)));
        let temporary = target.with_extension(format!("{}.tmp", Uuid::new_v4()));
        assert!(temporary.as_os_str().len() > 260);
        fs::write(&temporary, b"new").unwrap();
        fs::write(&target, b"old").unwrap();

        atomic_replace_file(&temporary, &target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!temporary.exists());

        // Relative and ordinary paths keep working.
        let near = temp.path().join("near.json");
        fs::write(temp.path().join("near.tmp"), b"1").unwrap();
        atomic_replace_file(&temp.path().join("near.tmp"), &near).unwrap();
        assert_eq!(fs::read(&near).unwrap(), b"1");
    }

    #[test]
    fn maintenance_drains_active_operations_and_rejects_new_writes() {
        let _coordinator = COORDINATOR_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let temp = tempdir().unwrap();
        let token = begin_operation(temp.path(), "migration").unwrap();
        let releaser = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            assert!(end_operation(&token));
        });

        let maintenance =
            begin_exclusive_maintenance(temp.path(), "update-test", MaintenancePhase::Updating)
                .unwrap();
        releaser.join().unwrap();
        assert!(begin_operation(temp.path(), "mutation").is_err());

        drop(maintenance);
        let next = begin_operation(temp.path(), "mutation").unwrap();
        assert!(end_operation(&next));
    }

    #[test]
    fn journal_round_trips_and_rejects_corruption() {
        let temp = tempdir().unwrap();
        let path = update_journal_path(temp.path());
        let mut journal = new_update_journal(
            "operation".into(),
            "main".into(),
            "C:/profile".into(),
            "http://127.0.0.1:4567".into(),
            "v2.3.2243".into(),
            "C:/snapshot".into(),
            "C:/runtime/current".into(),
            "C:/runtime/previous".into(),
            "C:/runtime/backup".into(),
            "C:/runtime/staging/v2.3.2243".into(),
            true,
        );
        journal.transition(UpdateJournalState::ProfileMigrated);
        write_update_journal(&path, &journal).unwrap();
        assert_eq!(read_update_journal(&path).unwrap(), Some(journal));

        fs::write(&path, b"not-json").unwrap();
        assert!(read_update_journal(&path).unwrap_err().contains("parse"));
    }
}
