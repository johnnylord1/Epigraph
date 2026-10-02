use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[path = "process_ownership.rs"]
pub mod ownership;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeLifecycleState {
    #[default]
    Unavailable,
    Starting,
    Ready,
    Maintenance,
    Updating,
    Recovering,
    Incompatible,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: RuntimeLifecycleState,
    pub profile_id: Option<String>,
    pub server_url: Option<String>,
    pub pid: Option<u32>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessIdentity {
    pub pid: u32,
    pub process_creation_time: Option<u64>,
    pub executable_path: Option<String>,
    pub command_line_hash: Option<String>,
    #[serde(default)]
    pub creation_filetime: Option<u64>,
}

impl RuntimeProcessIdentity {
    pub fn for_termination(&self) -> Option<ownership::Identity> {
        let created = self.creation_filetime?;
        let seconds = (created / 10_000_000).checked_sub(11_644_473_600)?;
        if self.process_creation_time != Some(seconds) { return None; }
        Some(ownership::Identity {
            pid: self.pid, created,
            executable: self.executable_path.clone()?, command_hash: self.command_line_hash.clone()?,
        })
    }
}

pub fn capture_process_identity(pid: u32) -> Option<RuntimeProcessIdentity> {
    #[cfg(windows)]
    {
        use ownership::ProcessObject;
        let process = ownership::windows::Process::open(pid, command_line_hash).ok()?;
        let identity = process.identity().ok()?;
        Some(RuntimeProcessIdentity {
            pid, process_creation_time: Some(identity.created / 10_000_000 - 11_644_473_600),
            executable_path: Some(identity.executable), command_line_hash: Some(identity.command_hash),
            creation_filetime: Some(identity.created),
        })
    }
    #[cfg(not(windows))]
    {
        let system = sysinfo::System::new_all();
        let process = system.process(sysinfo::Pid::from_u32(pid))?;
        let args = process.cmd().iter().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>();
        Some(RuntimeProcessIdentity { pid, process_creation_time: Some(process.start_time()),
            executable_path: process.exe().map(|path| path.to_string_lossy().into_owned()),
            command_line_hash: Some(command_line_hash(&args)), creation_filetime: None })
    }
}

/// CommandChild retains SharedChild's original OS child handle. Keep the borrow
/// alive through validation/wait so the PID cannot be recycled during capture.
pub fn stop_spawned_child(child: &tauri_plugin_shell::process::CommandChild) -> Result<(), String> {
    #[cfg(windows)]
    {
        use ownership::ProcessObject;
        let mut process = ownership::windows::Process::open(child.pid(), command_line_hash)?;
        process.identity()?;
        process.terminate()?;
        process.wait(5000)
    }
    #[cfg(not(windows))]
    { let _ = child; Err("Handle-bound cleanup unavailable; child preserved".into()) }
}

/// Confirm completion without granting termination authority. The original
/// CommandChild remains borrowed, so the saved PID cannot identify a new child.
pub fn retained_child_has_exited(
    child: &tauri_plugin_shell::process::CommandChild,
    recorded: &RuntimeProcessIdentity,
    captured_at_spawn: &RuntimeProcessIdentity,
) -> Result<bool, String> {
    if recorded != captured_at_spawn || recorded.pid != child.pid() {
        return Err("Retained completion evidence is inconsistent".into());
    }
    #[cfg(windows)]
    {
        use ownership::ProcessObject;
        let expected = recorded.for_termination().ok_or("Incomplete retained identity")?;
        let process = ownership::windows::Process::open(child.pid(), command_line_hash)?;
        if process.creation_time()? != expected.created { return Err("Retained creation identity changed".into()); }
        Ok(process.wait(0).is_ok())
    }
    #[cfg(not(windows))]
    { Err("Handle-bound completion unavailable".into()) }
}

/// The retained std Child prevents PID recycling while this borrow is alive.
pub fn stop_std_child(child: &std::process::Child) -> Result<(), String> {
    #[cfg(windows)]
    {
        use ownership::ProcessObject;
        let mut process = ownership::windows::Process::open(child.id(), command_line_hash)?;
        process.identity()?;
        process.terminate()?;
        process.wait(5000)
    }
    #[cfg(not(windows))]
    { let _ = child; Err("Handle-bound child cleanup unavailable; process preserved".into()) }
}

/// A durable receipt is written only AFTER waiting for the validated process.
/// The original owner remains intact; a later spawn can replace it only when
/// these exact bytes have a matching confirmation receipt.
pub fn record_confirmed_stop(path: &Path, raw: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let digest = format!("{:x}", Sha256::digest(raw));
    let receipt = path.with_file_name(format!("server.owner.{digest}.stopped"));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&receipt) {
        Ok(mut file) => { file.write_all(raw).and_then(|_| file.sync_all()).map_err(|_| "Could not persist stop confirmation".to_string()) }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if std::fs::read(receipt).ok().as_deref() == Some(raw) { Ok(()) }
            else { Err("Incomplete stop receipt; ownership preserved".into()) }
        }
        Err(_) => Err("Could not persist stop confirmation; ownership preserved".into()),
    }
}

pub fn has_confirmed_stop(path: &Path) -> bool {
    let Ok(raw) = std::fs::read(path) else { return false; };
    let digest = format!("{:x}", Sha256::digest(&raw));
    std::fs::read(path.with_file_name(format!("server.owner.{digest}.stopped"))).ok().as_deref() == Some(raw.as_slice())
}

/// A process that ends without a graceful stop (reboot, logoff, crash) leaves its ownership
/// record without a receipt, which would otherwise block every later start. When the recorded
/// process is proven gone (no such PID, already exited, or the PID now has a different birth),
/// the receipt is recorded for exactly `raw`, the bytes the caller validated. Live, unverifiable
/// or changed records are preserved and `false` is returned.
pub fn confirm_exited_owner(
    path: &Path,
    raw: &[u8],
    pid: u32,
    identity: Option<&RuntimeProcessIdentity>,
) -> bool {
    if has_confirmed_stop(path) {
        return std::fs::read(path).ok().as_deref() == Some(raw);
    }
    if !recorded_process_has_exited(pid, identity)
        || std::fs::read(path).ok().as_deref() != Some(raw)
    {
        return false;
    }
    record_confirmed_stop(path, raw).is_ok()
}

fn recorded_process_has_exited(pid: u32, identity: Option<&RuntimeProcessIdentity>) -> bool {
    if identity.is_some_and(|identity| identity.pid != pid) {
        return false;
    }
    #[cfg(windows)]
    {
        ownership::windows::recorded_process_exited(
            pid,
            identity.and_then(|identity| identity.creation_filetime),
        ) == Some(true)
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, identity);
        false
    }
}

pub fn command_line_hash(args: &[String]) -> String {
    let mut hasher = Sha256::new();
    for arg in args {
        hasher.update(arg.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

/// JVM temp directory owned by one managed Suwayomi profile. Suwayomi keeps its thumbnail
/// and page caches under `java.io.tmpdir/Tachidesk`; with the shared system temp every
/// instance writes `thumbnails/{mangaId}` into the same folder and ids collide.
pub fn managed_java_temp_dir(data_dir: &Path) -> PathBuf {
    let mut key = data_dir.to_string_lossy().replace('/', "\\");
    while key.ends_with('\\') {
        key.pop();
    }
    if cfg!(windows) {
        key = key.to_lowercase();
    }
    let digest = Sha256::digest(key.as_bytes());
    let suffix: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
    std::env::temp_dir().join("epigraph-suwayomi").join(suffix)
}

/// `-Djava.io.tmpdir` flag for a managed Suwayomi spawn, creating the folder first.
pub fn managed_java_temp_dir_flag(data_dir: &Path) -> String {
    let temp_dir = managed_java_temp_dir(data_dir);
    let _ = std::fs::create_dir_all(&temp_dir);
    format!("-Djava.io.tmpdir={}", temp_dir.display())
}

pub fn sanitize_log_line(line: &str, private_paths: &[&Path]) -> String {
    let mut sanitized = line.replace(['\r', '\n'], " ");
    for path in private_paths {
        let path = path.to_string_lossy();
        if !path.is_empty() {
            sanitized = sanitized.replace(path.as_ref(), "<private-path>");
        }
    }

    for key in [
        "authorization",
        "cookie",
        "token",
        "password",
        "apiKey",
        "api-key",
    ] {
        let key_lower = key.to_ascii_lowercase();
        let mut search_from = 0;
        while let Some(relative) = sanitized[search_from..]
            .to_ascii_lowercase()
            .find(&key_lower)
        {
            let start = search_from + relative;
            let Some(equal) = sanitized[start..].find('=') else {
                break;
            };
            let value_start = start + equal + 1;
            let value_end = sanitized[value_start..]
                .find(|character: char| {
                    character.is_whitespace() || character == ',' || character == ';'
                })
                .map(|end| value_start + end)
                .unwrap_or(sanitized.len());
            sanitized.replace_range(value_start..value_end, "<redacted>");
            search_from = value_start + "<redacted>".len();
        }
    }
    sanitized
}

/// Every start adds a full copy of the database, so only the newest automatic copies are kept.
const LOCAL_SERVER_PREFLIGHT_BACKUPS_KEPT: usize = 10;

pub fn backup_local_server_files(data_dir: &Path) -> std::io::Result<Option<PathBuf>> {
    let candidates = ["server.conf", "database.mv.db", "database.trace.db"];
    let existing: Vec<PathBuf> = candidates
        .iter()
        .map(|name| data_dir.join(name))
        .filter(|path| path.exists())
        .collect();

    if existing.is_empty() {
        return Ok(None);
    }

    let backups_root = data_dir.join("epigraph-backups");
    let backup_dir = backups_root.join(format!(
        "preflight-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    ));
    std::fs::create_dir_all(&backup_dir)?;
    for source in existing {
        if let Some(name) = source.file_name() {
            // An incomplete copy must not count as a backup, or rotation would drop a good one for it.
            if let Err(error) = std::fs::copy(&source, backup_dir.join(name)) {
                let _ = std::fs::remove_dir_all(&backup_dir);
                return Err(error);
            }
        }
    }
    prune_local_server_preflight_backups(&backups_root, LOCAL_SERVER_PREFLIGHT_BACKUPS_KEPT);

    Ok(Some(backup_dir))
}

fn prune_local_server_preflight_backups(backups_root: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(backups_root) else {
        return;
    };
    let mut preflights: Vec<(u64, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let stamp = entry
                .file_name()
                .to_str()?
                .strip_prefix("preflight-")?
                .parse::<u64>()
                .ok()?;
            Some((stamp, entry.path()))
        })
        .collect();
    preflights.sort_unstable_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in preflights.into_iter().skip(keep) {
        let _ = std::fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn managed_java_temp_dir_is_stable_and_distinct_per_profile_root() {
        let main = super::managed_java_temp_dir(std::path::Path::new(r"C:\Data\epigraph-main"));
        assert_eq!(
            main,
            super::managed_java_temp_dir(std::path::Path::new(r"C:\Data\epigraph-main\"))
        );
        assert_ne!(
            main,
            super::managed_java_temp_dir(std::path::Path::new(r"C:\Other\epigraph-main"))
        );
        assert!(main.starts_with(std::env::temp_dir().join("epigraph-suwayomi")));
    }

    use super::*;

    #[test]
    fn preflight_backup_copies_the_database_and_keeps_only_the_newest_copies() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("server.conf"), b"server.port = 4567\n").unwrap();
        std::fs::write(temp.path().join("database.mv.db"), b"h2").unwrap();
        let backups_root = temp.path().join("epigraph-backups");
        for stamp in 1..=LOCAL_SERVER_PREFLIGHT_BACKUPS_KEPT as u64 + 2 {
            std::fs::create_dir_all(backups_root.join(format!("preflight-{stamp}"))).unwrap();
        }
        std::fs::create_dir_all(backups_root.join("manual")).unwrap();

        let backup_dir = backup_local_server_files(temp.path()).unwrap().unwrap();

        assert_eq!(
            std::fs::read(backup_dir.join("database.mv.db")).unwrap(),
            b"h2"
        );
        let mut remaining: Vec<String> = std::fs::read_dir(&backups_root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        remaining.sort();
        assert_eq!(remaining.len(), LOCAL_SERVER_PREFLIGHT_BACKUPS_KEPT + 1);
        assert!(remaining.contains(&"manual".to_string()));
        let created = backup_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(remaining.contains(&created));
        assert!(!remaining.contains(&"preflight-1".to_string()));
        assert!(!remaining.contains(&"preflight-3".to_string()));
        assert!(remaining.contains(&"preflight-4".to_string()));
    }

    #[test]
    fn failed_preflight_backup_leaves_existing_copies_in_place() {
        let temp = tempfile::tempdir().unwrap();
        // A directory named like the database makes the copy fail.
        std::fs::create_dir_all(temp.path().join("database.mv.db")).unwrap();
        let backups_root = temp.path().join("epigraph-backups");
        for stamp in 1..=LOCAL_SERVER_PREFLIGHT_BACKUPS_KEPT as u64 + 2 {
            std::fs::create_dir_all(backups_root.join(format!("preflight-{stamp}"))).unwrap();
        }

        assert!(backup_local_server_files(temp.path()).is_err());

        assert_eq!(
            std::fs::read_dir(&backups_root).unwrap().count(),
            LOCAL_SERVER_PREFLIGHT_BACKUPS_KEPT + 2
        );
    }

    #[test]
    fn b1_stop_receipts_never_delete_or_confirm_replacement_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.owner.json");
        let original = b"original owner evidence";
        std::fs::write(&path, original).unwrap();
        assert!(!has_confirmed_stop(&path));
        record_confirmed_stop(&path, original).unwrap();
        assert!(has_confirmed_stop(&path));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::write(&path, b"replacement owner").unwrap();
        assert!(!has_confirmed_stop(&path));
        record_confirmed_stop(&path, original).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement owner");
        assert!(!has_confirmed_stop(&path));
    }

    #[test]
    fn b1_partial_receipts_and_inconsistent_creation_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.owner.json");
        let raw = b"diagnostic evidence";
        std::fs::write(&path, raw).unwrap();
        let digest = format!("{:x}", Sha256::digest(raw));
        std::fs::write(dir.path().join(format!("server.owner.{digest}.stopped")), b"partial").unwrap();
        assert!(record_confirmed_stop(&path, raw).is_err());
        assert!(!has_confirmed_stop(&path));
        assert_eq!(std::fs::read(&path).unwrap(), raw);
        let mut identity = RuntimeProcessIdentity { pid: 42, creation_filetime: Some(133700000001234567),
            process_creation_time: Some(1725526400), executable_path: Some("java.exe".into()),
            command_line_hash: Some("a".repeat(64)) };
        assert!(identity.for_termination().is_some());
        identity.process_creation_time = Some(1);
        assert!(identity.for_termination().is_none());
        identity.creation_filetime = None;
        assert!(identity.for_termination().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn exited_owner_records_are_confirmed_while_live_or_changed_records_are_preserved() {
        use std::os::windows::process::CommandExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.owner.json");

        let live = capture_process_identity(std::process::id()).unwrap();
        let live_raw = b"live owner evidence";
        std::fs::write(&path, live_raw).unwrap();
        assert!(!confirm_exited_owner(
            &path,
            live_raw,
            live.pid,
            Some(&live)
        ));
        assert!(!has_confirmed_stop(&path));

        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let exited = capture_process_identity(child.id());
        child.kill().unwrap();
        child.wait().unwrap();
        let exited = exited.expect("child identity captured while running");
        let exited_raw = b"owner left by a crashed or rebooted process";
        std::fs::write(&path, exited_raw).unwrap();
        assert!(!confirm_exited_owner(
            &path,
            b"bytes the caller never validated",
            exited.pid,
            Some(&exited)
        ));
        assert!(!has_confirmed_stop(&path));
        assert!(confirm_exited_owner(
            &path,
            exited_raw,
            exited.pid,
            Some(&exited)
        ));
        assert!(has_confirmed_stop(&path));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            exited_raw,
            "evidence is retained, never deleted"
        );
        assert!(
            confirm_exited_owner(&path, exited_raw, exited.pid, Some(&exited)),
            "idempotent"
        );
    }

    #[test]
    fn command_hash_is_deterministic_and_ordered() {
        let first = command_line_hash(&["-jar".into(), "server.jar".into()]);
        let second = command_line_hash(&["-jar".into(), "server.jar".into()]);
        let reordered = command_line_hash(&["server.jar".into(), "-jar".into()]);
        assert_eq!(first, second);
        assert_ne!(first, reordered);
    }

    #[test]
    fn logs_redact_private_paths_and_credentials() {
        let path = Path::new("C:\\Users\\test\\AppData");
        let line = "root=C:\\Users\\test\\AppData token=secret cookie=abc123";
        let sanitized = sanitize_log_line(line, &[path]);
        assert!(!sanitized.contains("AppData"));
        assert!(!sanitized.contains("secret"));
        assert!(!sanitized.contains("abc123"));
        assert!(sanitized.contains("<redacted>"));
    }
}
