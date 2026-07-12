use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const RUNTIME_MANIFEST_SCHEMA_VERSION: u32 = 1;
const RUNTIME_MANIFEST_FILE_NAME: &str = "runtime.json";
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncdRuntimeManifest {
    pub schema_version: u32,
    pub pid: u32,
    pub server_id: String,
    pub port: u16,
    pub fingerprint: String,
    pub exe: String,
    pub started_at_ms: u128,
}

impl SyncdRuntimeManifest {
    pub fn new(
        pid: u32,
        server_id: impl Into<String>,
        port: u16,
        fingerprint: impl Into<String>,
        exe: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
            pid,
            server_id: server_id.into(),
            port,
            fingerprint: fingerprint.into(),
            exe: exe.into(),
            started_at_ms: unix_now_millis(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != RUNTIME_MANIFEST_SCHEMA_VERSION {
            return Err(format!(
                "unsupported syncd runtime manifest schema version {}",
                self.schema_version
            ));
        }
        if self.pid == 0 {
            return Err("syncd runtime manifest has an invalid PID".to_string());
        }
        if self.server_id.trim().is_empty() {
            return Err("syncd runtime manifest is missing serverId".to_string());
        }
        if self.port == 0 {
            return Err("syncd runtime manifest has an invalid port".to_string());
        }
        if !is_sha256_hex(&self.fingerprint) {
            return Err("syncd runtime manifest has an invalid fingerprint".to_string());
        }
        if self.exe.trim().is_empty() || !Path::new(&self.exe).is_absolute() {
            return Err("syncd runtime manifest has an invalid executable path".to_string());
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct RuntimeManifestLease {
    path: PathBuf,
    pid: u32,
    server_id: String,
}

impl RuntimeManifestLease {
    pub fn publish(data_dir: &Path, manifest: &SyncdRuntimeManifest) -> io::Result<Self> {
        manifest
            .validate()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let path = runtime_manifest_path(data_dir);
        let payload = serde_json::to_vec_pretty(manifest)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        atomic_write(&path, &payload)?;
        Ok(Self {
            path,
            pid: manifest.pid,
            server_id: manifest.server_id.clone(),
        })
    }
}

impl Drop for RuntimeManifestLease {
    fn drop(&mut self) {
        let Ok(current) = read_runtime_manifest_path(&self.path) else {
            return;
        };
        if current.pid == self.pid && current.server_id == self.server_id {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub fn runtime_manifest_path(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNTIME_MANIFEST_FILE_NAME)
}

#[allow(dead_code)]
pub fn read_runtime_manifest(data_dir: &Path) -> Result<SyncdRuntimeManifest, String> {
    read_runtime_manifest_path(&runtime_manifest_path(data_dir))
}

fn read_runtime_manifest_path(path: &Path) -> Result<SyncdRuntimeManifest, String> {
    let payload =
        fs::read(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let manifest: SyncdRuntimeManifest = serde_json::from_slice(&payload)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
    manifest.validate()?;
    Ok(manifest)
}

fn atomic_write(path: &Path, payload: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime manifest path has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;

    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".{RUNTIME_MANIFEST_FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));

    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        file.write_all(payload)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temp_path, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn unix_now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn manifest(pid: u32, server_id: &str) -> SyncdRuntimeManifest {
        SyncdRuntimeManifest::new(
            pid,
            server_id,
            4777,
            "a".repeat(64),
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        )
    }

    #[test]
    fn manifest_serializes_required_attach_identity() {
        let value = serde_json::to_value(manifest(42, "server-a")).unwrap();
        assert_eq!(value["pid"], 42);
        assert_eq!(value["serverId"], "server-a");
        assert_eq!(value["port"], 4777);
        assert_eq!(value["fingerprint"], "a".repeat(64));
        assert!(value["exe"].as_str().unwrap().contains("aethon"));
    }

    #[test]
    fn atomic_publish_replaces_previous_manifest() {
        let temp = tempdir().unwrap();
        let first = RuntimeManifestLease::publish(temp.path(), &manifest(41, "server-a")).unwrap();
        let second = RuntimeManifestLease::publish(temp.path(), &manifest(42, "server-a")).unwrap();

        assert_eq!(read_runtime_manifest(temp.path()).unwrap().pid, 42);
        let temporary_files = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0);

        drop(first);
        assert_eq!(read_runtime_manifest(temp.path()).unwrap().pid, 42);
        drop(second);
        assert!(!runtime_manifest_path(temp.path()).exists());
    }

    #[test]
    fn validation_rejects_unpinnable_fingerprint() {
        let mut invalid = manifest(42, "server-a");
        invalid.fingerprint = "not-a-sha256".to_string();
        assert!(invalid.validate().unwrap_err().contains("fingerprint"));
    }
}
