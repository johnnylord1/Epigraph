use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const WAL_SCHEMA_VERSION: u32 = 1;
static MIGRATION_JOURNAL_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum MigrationWalState {
    Prepared,
    Committed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationWriteAheadLog {
    schema_version: u32,
    operation_id: String,
    state: MigrationWalState,
    previous_sha256: Option<String>,
    next_sha256: String,
    contents: String,
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn file_sha256(path: &Path) -> Result<Option<String>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(sha256_bytes(&bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Could not hash migration journal {}: {error}",
            path.display()
        )),
    }
}

fn wal_path(path: &Path) -> PathBuf {
    path.with_extension("json.wal")
}

fn lock_path(path: &Path) -> PathBuf {
    path.with_extension("json.lock")
}

fn acquire_file_lock(path: &Path) -> Result<File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create migration journal directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(lock_path(path))
        .map_err(|error| format!("Could not open migration journal lock: {error}"))?;
    lock_file
        .lock_exclusive()
        .map_err(|error| format!("Could not acquire migration journal lock: {error}"))?;
    Ok(lock_file)
}

fn temp_path(path: &Path, operation_id: &str) -> PathBuf {
    path.with_extension(format!("json.{operation_id}.tmp"))
}

fn validate_journal_json(contents: &str) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| format!("Migration journal JSON is invalid: {error}"))?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "Migration journal is missing its schema version.".to_string())?;
    if version != 1 && version != 2 {
        return Err(format!(
            "Migration journal schema version {version} is unsupported."
        ));
    }
    Ok(())
}

fn write_synced_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = File::create(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("Could not sync {}: {error}", path.display()))
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    crate::suwayomi_maintenance::atomic_replace_file(from, to)
        .map_err(|error| format!("Could not publish {}: {error}", to.display()))
}

fn write_wal(path: &Path, wal: &MigrationWriteAheadLog) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(wal)
        .map_err(|error| format!("Could not serialize migration WAL: {error}"))?;
    let temporary = path.with_extension(format!("wal.{}.tmp", wal.operation_id));
    write_synced_file(&temporary, &bytes)?;
    replace_file(&temporary, path)
}

fn publish_contents(path: &Path, operation_id: &str, contents: &str) -> Result<(), String> {
    let temporary = temp_path(path, operation_id);
    write_synced_file(&temporary, contents.as_bytes())?;
    replace_file(&temporary, path)
}

fn read_wal(path: &Path) -> Result<Option<MigrationWriteAheadLog>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not read migration WAL {}: {error}",
                path.display()
            ))
        }
    };
    let wal: MigrationWriteAheadLog = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Migration WAL is corrupt: {error}"))?;
    if wal.schema_version != WAL_SCHEMA_VERSION {
        return Err(format!(
            "Migration WAL schema version {} is unsupported.",
            wal.schema_version
        ));
    }
    validate_journal_json(&wal.contents)?;
    if sha256_bytes(wal.contents.as_bytes()) != wal.next_sha256 {
        return Err("Migration WAL payload hash does not match its manifest.".to_string());
    }
    Ok(Some(wal))
}

fn recover_locked(path: &Path) -> Result<(), String> {
    let wal_file = wal_path(path);
    let Some(mut wal) = read_wal(&wal_file)? else {
        return Ok(());
    };

    let current_sha256 = file_sha256(path)?;
    if current_sha256.as_deref() == Some(wal.next_sha256.as_str()) {
        fs::remove_file(&wal_file).map_err(|error| {
            format!(
                "Could not remove committed migration WAL {}: {error}",
                wal_file.display()
            )
        })?;
        return Ok(());
    }

    if wal.state == MigrationWalState::Prepared && current_sha256 == wal.previous_sha256 {
        publish_contents(path, &wal.operation_id, &wal.contents)?;
        wal.state = MigrationWalState::Committed;
        write_wal(&wal_file, &wal)?;
        fs::remove_file(&wal_file).map_err(|error| {
            format!(
                "Could not finalize migration WAL {}: {error}",
                wal_file.display()
            )
        })?;
        return Ok(());
    }

    Err(format!(
        "Migration journal recovery stopped because the persisted hash does not match either WAL revision (operation {}).",
        wal.operation_id
    ))
}

pub fn read(path: &Path) -> Result<Option<String>, String> {
    let _guard = MIGRATION_JOURNAL_WRITE_LOCK
        .lock()
        .map_err(|_| "Migration journal lock is poisoned.".to_string())?;
    let _file_lock = acquire_file_lock(path)?;
    recover_locked(path)?;
    match fs::read_to_string(path) {
        Ok(contents) => {
            validate_journal_json(&contents)?;
            Ok(Some(contents))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Could not read migration journal {}: {error}",
            path.display()
        )),
    }
}

pub fn write(path: &Path, contents: &str, expected_sha256: Option<&str>) -> Result<(), String> {
    validate_journal_json(contents)?;
    let _guard = MIGRATION_JOURNAL_WRITE_LOCK
        .lock()
        .map_err(|_| "Migration journal lock is poisoned.".to_string())?;
    let _file_lock = acquire_file_lock(path)?;
    recover_locked(path)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create migration journal directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let current_sha256 = file_sha256(path)?;
    if current_sha256.as_deref() != expected_sha256 {
        return Err(
            "Migration journal changed since it was read; reload before retrying the operation."
                .to_string(),
        );
    }

    let operation_id = uuid::Uuid::now_v7().to_string();
    let mut wal = MigrationWriteAheadLog {
        schema_version: WAL_SCHEMA_VERSION,
        operation_id: operation_id.clone(),
        state: MigrationWalState::Prepared,
        previous_sha256: current_sha256,
        next_sha256: sha256_bytes(contents.as_bytes()),
        contents: contents.to_string(),
    };
    let wal_file = wal_path(path);

    write_wal(&wal_file, &wal)?;
    publish_contents(path, &operation_id, contents)?;
    wal.state = MigrationWalState::Committed;
    write_wal(&wal_file, &wal)?;
    fs::remove_file(&wal_file).map_err(|error| {
        format!(
            "Could not remove committed migration WAL {}: {error}",
            wal_file.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(version: u32, marker: &str) -> String {
        format!(r#"{{"version":{version},"marker":"{marker}"}}"#)
    }

    #[test]
    fn writes_and_reads_a_synced_journal_without_residual_wal() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal-state.json");

        write(&path, &state(2, "committed"), None).unwrap();

        assert_eq!(read(&path).unwrap(), Some(state(2, "committed")));
        assert!(!wal_path(&path).exists());
    }

    #[test]
    fn completes_a_prepared_write_after_interruption() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal-state.json");
        fs::write(&path, state(1, "old")).unwrap();
        let next = state(2, "new");
        let wal = MigrationWriteAheadLog {
            schema_version: WAL_SCHEMA_VERSION,
            operation_id: "recover-prepared".to_string(),
            state: MigrationWalState::Prepared,
            previous_sha256: file_sha256(&path).unwrap(),
            next_sha256: sha256_bytes(next.as_bytes()),
            contents: next.clone(),
        };
        write_wal(&wal_path(&path), &wal).unwrap();

        assert_eq!(read(&path).unwrap(), Some(next));
        assert!(!wal_path(&path).exists());
    }

    #[test]
    fn refuses_recovery_when_neither_revision_matches() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal-state.json");
        fs::write(&path, state(2, "unexpected")).unwrap();
        let next = state(2, "new");
        let wal = MigrationWriteAheadLog {
            schema_version: WAL_SCHEMA_VERSION,
            operation_id: "recover-corrupt".to_string(),
            state: MigrationWalState::Prepared,
            previous_sha256: Some(sha256_bytes(state(1, "old").as_bytes())),
            next_sha256: sha256_bytes(next.as_bytes()),
            contents: next,
        };
        write_wal(&wal_path(&path), &wal).unwrap();

        let error = read(&path).unwrap_err();
        assert!(error.contains("does not match either WAL revision"));
        assert!(wal_path(&path).exists());
    }

    #[test]
    fn rejects_a_stale_compare_and_swap_write() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal-state.json");
        let initial = state(2, "initial");
        write(&path, &initial, None).unwrap();

        let error = write(
            &path,
            &state(2, "stale"),
            Some(&sha256_bytes(state(2, "different").as_bytes())),
        )
        .unwrap_err();

        assert!(error.contains("changed since it was read"));
        assert_eq!(read(&path).unwrap(), Some(initial));
    }

    #[test]
    fn rejects_corrupt_or_unknown_journal_schemas() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal-state.json");
        fs::write(&path, "{not-json").unwrap();
        assert!(read(&path).unwrap_err().contains("invalid"));

        fs::write(&path, state(7, "future")).unwrap();
        assert!(read(&path).unwrap_err().contains("unsupported"));
    }
}
