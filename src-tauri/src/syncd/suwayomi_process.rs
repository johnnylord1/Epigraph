use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;
use sysinfo::{Pid, ProcessesToUpdate, System};
use url::Url;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerOwner {
    profile_key: String,
    root_dir: String,
    app_pid: u32,
    java_pid: u32,
    port: u16,
    server_url: String,
    started_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachedSuwayomi {
    pub profile_key: String,
    pub root_dir: PathBuf,
    pub java_pid: u32,
    pub server_url: String,
}

pub fn attach_owned_instances() -> Vec<AttachedSuwayomi> {
    owned_profile_roots()
        .into_iter()
        .filter_map(|root| attach_owned_instance(&root))
        .collect()
}

pub async fn stop_owned_instances(timeout: Duration) -> Result<Vec<AttachedSuwayomi>, String> {
    let instances = attach_owned_instances();
    for instance in &instances {
        stop_owned_instance(instance, timeout).await?;
    }
    Ok(instances)
}

fn attach_owned_instance(root: &Path) -> Option<AttachedSuwayomi> {
    let owner_path = root.join("server.owner.json");
    let owner: ServerOwner = serde_json::from_slice(&std::fs::read(owner_path).ok()?).ok()?;
    if !owner_matches_root_and_endpoint(&owner, root) {
        return None;
    }

    let mut system = System::new();
    let pid = Pid::from_u32(owner.java_pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let process = system.process(pid)?;
    if !java_process_matches_root(process, root) {
        return None;
    }

    let _ = (owner.app_pid, owner.started_at);
    Some(AttachedSuwayomi {
        profile_key: owner.profile_key,
        root_dir: root.to_path_buf(),
        java_pid: owner.java_pid,
        server_url: owner.server_url.trim_end_matches('/').to_string(),
    })
}

async fn stop_owned_instance(instance: &AttachedSuwayomi, timeout: Duration) -> Result<(), String> {
    let pid = Pid::from_u32(instance.java_pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let Some(process) = system.process(pid) else {
        remove_owner_files(&instance.root_dir);
        return Ok(());
    };
    if !java_process_matches_root(process, &instance.root_dir) {
        return Err(format!(
            "refusing to stop PID {} because it no longer matches Suwayomi root {}",
            instance.java_pid,
            instance.root_dir.display()
        ));
    }
    if !process.kill() {
        return Err(format!(
            "failed to stop owned Suwayomi PID {}",
            instance.java_pid
        ));
    }

    let started = Instant::now();
    loop {
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        if system.process(pid).is_none() {
            remove_owner_files(&instance.root_dir);
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "timed out waiting for owned Suwayomi PID {} to stop",
                instance.java_pid
            ));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

fn owner_matches_root_and_endpoint(owner: &ServerOwner, root: &Path) -> bool {
    if owner.java_pid == 0
        || owner.profile_key.trim().is_empty()
        || !paths_identical(Path::new(&owner.root_dir), root)
    {
        return false;
    }
    let Ok(url) = Url::parse(owner.server_url.trim_end_matches('/')) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url.port_or_known_default() == Some(owner.port)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
}

fn java_process_matches_root(process: &sysinfo::Process, root: &Path) -> bool {
    let name = process.name().to_string_lossy().to_ascii_lowercase();
    if !name.contains("java") {
        return false;
    }
    let expected = format!(
        "-Dsuwayomi.tachidesk.config.server.rootDir={}",
        root.to_string_lossy()
    );
    process
        .cmd()
        .iter()
        .any(|argument| root_flag_matches(&argument.to_string_lossy(), &expected))
}

fn root_flag_matches(argument: &str, expected: &str) -> bool {
    let argument = argument.trim().trim_matches('"');
    let expected = expected.trim().trim_matches('"');
    #[cfg(windows)]
    {
        argument.eq_ignore_ascii_case(expected)
    }
    #[cfg(not(windows))]
    {
        argument == expected
    }
}

fn owned_profile_roots() -> Vec<PathBuf> {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut roots = vec![base.join("aethon-main"), base.join("aethon")];
    if let Ok(entries) = std::fs::read_dir(&base) {
        roots.extend(
            entries
                .flatten()
                .take(128)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("aethon-profile-"))
                }),
        );
    }
    roots.sort_by(|left, right| normalize_path(left).cmp(&normalize_path(right)));
    roots.dedup_by(|left, right| paths_identical(left, right));
    roots
}

fn remove_owner_files(root: &Path) {
    for name in [
        "server.owner.json",
        "server.owner.json.tmp",
        "server.spawn.lock",
    ] {
        let _ = std::fs::remove_file(root.join(name));
    }
}

fn paths_identical(left: &Path, right: &Path) -> bool {
    normalize_path(left) == normalize_path(right)
}

fn normalize_path(path: &Path) -> String {
    let normalized = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(windows)]
    {
        normalized
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', r"\")
            .to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized.to_string_lossy().into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(root: &Path) -> ServerOwner {
        ServerOwner {
            profile_key: "main".to_string(),
            root_dir: root.to_string_lossy().into_owned(),
            app_pid: 1,
            java_pid: 2,
            port: 4567,
            server_url: "http://127.0.0.1:4567".to_string(),
            started_at: 1,
        }
    }

    #[test]
    fn owner_must_match_root_and_loopback_endpoint() {
        let root = PathBuf::from(r"C:\Users\test\AppData\Roaming\aethon-main");
        assert!(owner_matches_root_and_endpoint(&owner(&root), &root));

        let mut remote = owner(&root);
        remote.server_url = "http://192.168.1.10:4567".to_string();
        assert!(!owner_matches_root_and_endpoint(&remote, &root));

        let mut wrong_port = owner(&root);
        wrong_port.server_url = "http://127.0.0.1:9999".to_string();
        assert!(!owner_matches_root_and_endpoint(&wrong_port, &root));

        let mut with_credentials = owner(&root);
        with_credentials.server_url = "http://admin:secret@127.0.0.1:4567".to_string();
        assert!(!owner_matches_root_and_endpoint(&with_credentials, &root));

        let mut with_path = owner(&root);
        with_path.server_url = "http://127.0.0.1:4567/proxy".to_string();
        assert!(!owner_matches_root_and_endpoint(&with_path, &root));
    }

    #[test]
    fn root_flag_match_is_exact() {
        let expected = r"-Dsuwayomi.tachidesk.config.server.rootDir=C:\Data\aethon-main";
        assert!(root_flag_matches(expected, expected));
        assert!(!root_flag_matches(
            r"-Dsuwayomi.tachidesk.config.server.rootDir=C:\Data\other",
            expected
        ));
    }
}
