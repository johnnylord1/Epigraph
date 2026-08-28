use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessesToUpdate, System};
use url::Url;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

const MAIN_PROFILE_KEY: &str = "main";
const MAIN_SERVER_PORT: u16 = 4567;
const STARTUP_PROBE_INTERVAL: Duration = Duration::from_millis(500);
const STARTUP_PROBE_TIMEOUT_EMPTY: Duration = Duration::from_secs(240);
const STARTUP_PROBE_TIMEOUT_EXISTING: Duration = Duration::from_secs(360);
const PROBE_TIMEOUT: Duration = Duration::from_millis(2_500);
const STALE_LOCK_AGE: Duration = Duration::from_secs(120);
const SUPERVISOR_HEALTH_INTERVAL: Duration = Duration::from_secs(15);
const SUPERVISOR_RETRY_INTERVAL: Duration = Duration::from_secs(5);
const JAVA_TOOL_OPTIONS: &str = "-Djava.awt.headless=true -Xms256m -Xmx1536m -XX:+UseG1GC";
const DEFAULT_SERVER_CONF: &str = r#"server.ip = "127.0.0.1"
server.port = 4567
server.webUIEnabled = false
server.initialOpenInBrowserEnabled = false
server.systemTrayEnabled = false
server.webUIInterface = "browser"
server.webUIFlavor = "WebUI"
server.webUIChannel = "stable"
server.electronPath = ""
server.kcefEnabled = false
server.debugLogsEnabled = false
server.downloadAsCbz = true
server.autoDownloadNewChapters = false
server.globalUpdateInterval = 0
server.webUIUpdateCheckInterval = 0
server.maxSourcesInParallel = 2
"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerOwner {
    profile_key: String,
    root_dir: String,
    app_pid: u32,
    java_pid: u32,
    port: u16,
    server_url: String,
    started_at: u64,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    process_identity: Option<crate::suwayomi_runtime::RuntimeProcessIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachedSuwayomi {
    pub profile_key: String,
    pub root_dir: PathBuf,
    pub java_pid: u32,
    pub server_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HeadlessSuwayomiOutcome {
    Attached(AttachedSuwayomi),
    Started(AttachedSuwayomi),
    NotConfigured,
}

struct RuntimeInvocation {
    java: PathBuf,
    jar: PathBuf,
    working_dir: PathBuf,
}

struct SpawnLock {
    path: PathBuf,
    _file: File,
}

impl Drop for SpawnLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl SpawnLock {
    fn refresh(&mut self) -> Result<(), String> {
        self._file
            .set_len(0)
            .and_then(|_| writeln!(self._file, "pid={}", std::process::id()))
            .and_then(|_| writeln!(self._file, "timestamp={}", unix_now_secs()))
            .and_then(|_| self._file.sync_all())
            .map_err(|error| format!("failed to refresh Suwayomi spawn lock: {error}"))
    }
}

pub fn start_headless_supervisor(
    mut shutdown: tokio::sync::watch::Receiver<Option<super::lifecycle::ShutdownRequest>>,
) {
    tokio::spawn(async move {
        loop {
            if shutdown.borrow().is_some() {
                return;
            }

            let delay = match ensure_main_owned_instance().await {
                Ok(HeadlessSuwayomiOutcome::Attached(_)) => SUPERVISOR_HEALTH_INTERVAL,
                Ok(HeadlessSuwayomiOutcome::Started(instance)) => {
                    tracing::info!(
                        profile = instance.profile_key,
                        pid = instance.java_pid,
                        endpoint = instance.server_url,
                        root = %instance.root_dir.display(),
                        "headless Core restored owned Suwayomi"
                    );
                    SUPERVISOR_HEALTH_INTERVAL
                }
                Ok(HeadlessSuwayomiOutcome::NotConfigured) => SUPERVISOR_HEALTH_INTERVAL,
                Err(error) => {
                    tracing::warn!(
                        error = %crate::suwayomi_runtime::sanitize_log_line(&error, &[]),
                        "headless Core could not ensure owned Suwayomi"
                    );
                    SUPERVISOR_RETRY_INTERVAL
                }
            };

            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                changed = shutdown.changed() => {
                    if changed.is_err() || shutdown.borrow().is_some() {
                        return;
                    }
                }
            }
        }
    });
}

pub async fn ensure_main_owned_instance() -> Result<HeadlessSuwayomiOutcome, String> {
    let root = main_profile_root();
    if !managed_profile_is_configured(&root) {
        return Ok(HeadlessSuwayomiOutcome::NotConfigured);
    }

    if let Some(instance) = attach_owned_instance(&root) {
        if probe_server(MAIN_SERVER_PORT).await {
            return Ok(HeadlessSuwayomiOutcome::Attached(instance));
        }
        if process_age_secs(instance.java_pid).unwrap_or_default()
            < STARTUP_PROBE_TIMEOUT_EXISTING.as_secs()
        {
            return Err("managed Suwayomi is still starting".to_string());
        }
        stop_owned_instance(&instance, Duration::from_secs(5)).await?;
    }

    std::fs::create_dir_all(&root)
        .map_err(|error| format!("failed to prepare managed Suwayomi profile: {error}"))?;
    let mut spawn_lock = acquire_spawn_lock(&root)?;

    // Another Epigraph process may have completed startup while this process was
    // waiting for the cross-process lease.
    if let Some(instance) = attach_owned_instance(&root) {
        return Ok(HeadlessSuwayomiOutcome::Attached(instance));
    }

    remove_stale_owner(&root)?;
    if let Some(java_pid) = find_java_pid_for_root(&root) {
        if probe_server(MAIN_SERVER_PORT).await {
            let instance = publish_reconstructed_owner(&root, java_pid)?;
            return Ok(HeadlessSuwayomiOutcome::Attached(instance));
        }
        return Err(format!(
            "owned Suwayomi PID {java_pid} is running for the managed profile but is not ready"
        ));
    }

    ensure_port_available(MAIN_SERVER_PORT)?;
    seed_headless_server_conf(&root)?;
    let invocation = resolve_headless_runtime(&std::env::current_exe().map_err(|error| {
        format!("failed to resolve Epigraph Core executable for Suwayomi startup: {error}")
    })?)?;
    let had_database = root.join("database.mv.db").exists();
    let mut child = spawn_hidden_runtime(&root, &invocation)?;
    let java_pid = child.id();

    // Publish identity immediately. If Core is interrupted while readiness is
    // pending, the next startup can safely reattach instead of creating a
    // second JVM for the same profile.
    let instance = match publish_reconstructed_owner(&root, java_pid) {
        Ok(instance) => instance,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            remove_owner_files(&root);
            return Err(error);
        }
    };
    let timeout = if had_database {
        STARTUP_PROBE_TIMEOUT_EXISTING
    } else {
        STARTUP_PROBE_TIMEOUT_EMPTY
    };
    if let Err(error) = wait_for_spawned_runtime(&root, &mut child, &mut spawn_lock, timeout).await
    {
        let _ = child.kill();
        let _ = child.wait();
        remove_owner_files(&root);
        return Err(error);
    }

    Ok(HeadlessSuwayomiOutcome::Started(instance))
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

    // `System::new()` does not request command-line metadata on Windows.
    // Ownership verification depends on the exact Suwayomi rootDir argument,
    // so use a complete snapshot before accepting the recorded PID.
    let mut system = System::new_all();
    let pid = Pid::from_u32(owner.java_pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let process = system.process(pid)?;
    if !java_process_matches_root(process, root) || !process_identity_matches(&owner, process) {
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
    // Keep the same command-line-aware snapshot used while attaching. Without
    // it Windows reports an empty `Process::cmd()` and a valid owned process
    // can neither be verified nor stopped safely.
    let mut system = System::new_all();
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

fn main_profile_root() -> PathBuf {
    std::env::var_os("EPIGRAPH_LOCAL_SERVER_MAIN_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("epigraph-main")
        })
}

fn managed_profile_is_configured(root: &Path) -> bool {
    root.join("server.conf").exists()
        || root.join("database.mv.db").exists()
        || root.join("server.owner.json").exists()
        || root.join("extensions").is_dir()
}

fn acquire_spawn_lock(root: &Path) -> Result<SpawnLock, String> {
    let path = root.join("server.spawn.lock");
    for attempt in 0..=1 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                writeln!(file, "pid={}", std::process::id())
                    .and_then(|_| writeln!(file, "rootDir={}", root.display()))
                    .and_then(|_| writeln!(file, "timestamp={}", unix_now_secs()))
                    .and_then(|_| file.sync_all())
                    .map_err(|error| format!("failed to publish Suwayomi spawn lock: {error}"))?;
                return Ok(SpawnLock { path, _file: file });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                if !spawn_lock_is_stale(&path) {
                    return Err("another Epigraph process is starting managed Suwayomi".to_string());
                }
                std::fs::remove_file(&path).map_err(|error| {
                    format!("failed to remove stale Suwayomi spawn lock: {error}")
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err("another Epigraph process is starting managed Suwayomi".to_string());
            }
            Err(error) => {
                return Err(format!("failed to acquire Suwayomi spawn lock: {error}"));
            }
        }
    }
    Err("failed to acquire Suwayomi spawn lock".to_string())
}

fn spawn_lock_is_stale(path: &Path) -> bool {
    let owner_pid = std::fs::read_to_string(path).ok().and_then(|contents| {
        contents.lines().find_map(|line| {
            line.strip_prefix("pid=")
                .and_then(|value| value.trim().parse::<u32>().ok())
        })
    });
    if owner_pid.is_some_and(process_is_alive) {
        return false;
    }
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age >= STALE_LOCK_AGE)
        .unwrap_or(owner_pid.is_some())
}

fn remove_stale_owner(root: &Path) -> Result<(), String> {
    let owner_path = root.join("server.owner.json");
    if !owner_path.exists() {
        let _ = std::fs::remove_file(root.join("server.owner.json.tmp"));
        return Ok(());
    }
    let owner = std::fs::read(&owner_path)
        .ok()
        .and_then(|payload| serde_json::from_slice::<ServerOwner>(&payload).ok());
    if owner
        .as_ref()
        .is_some_and(|owner| process_is_alive(owner.java_pid))
    {
        return Err(
            "managed Suwayomi owner references a live but unverifiable process".to_string(),
        );
    }
    remove_owner_files(root);
    Ok(())
}

fn resolve_headless_runtime(core_executable: &Path) -> Result<RuntimeInvocation, String> {
    let managed_jar = crate::suwayomi_maintenance::default_runtime_root()
        .join("current")
        .join("Suwayomi-Server.jar");
    resolve_headless_runtime_with_managed(core_executable, &managed_jar)
}

fn resolve_headless_runtime_with_managed(
    core_executable: &Path,
    managed_jar: &Path,
) -> Result<RuntimeInvocation, String> {
    for bundle in runtime_bundle_candidates(core_executable) {
        let java = bundled_java_path(&bundle);
        let bundled_jar = bundle.join("bin").join("Suwayomi-Server.jar");
        if !java.exists() {
            continue;
        }
        let jar = if managed_jar.exists() {
            managed_jar.to_path_buf()
        } else if bundled_jar.exists() {
            bundled_jar
        } else {
            continue;
        };
        let working_dir = jar
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| bundle.clone());
        return Ok(RuntimeInvocation {
            java,
            jar,
            working_dir,
        });
    }
    Err("managed Suwayomi runtime bundle was not found beside Epigraph Core".to_string())
}

fn runtime_bundle_candidates(core_executable: &Path) -> Vec<PathBuf> {
    let Some(directory) = core_executable.parent() else {
        return Vec::new();
    };
    let mut candidates = vec![
        directory.join("binaries").join("suwayomi-bundle"),
        directory
            .join("resources")
            .join("binaries")
            .join("suwayomi-bundle"),
    ];
    if let Some(parent) = directory.parent() {
        candidates.push(
            parent
                .join("Resources")
                .join("binaries")
                .join("suwayomi-bundle"),
        );
    }
    candidates.sort_by(|left, right| normalize_path(left).cmp(&normalize_path(right)));
    candidates.dedup_by(|left, right| paths_identical(left, right));
    candidates
}

fn bundled_java_path(bundle: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let javaw = bundle.join("jre").join("bin").join("javaw.exe");
        if javaw.exists() {
            return javaw;
        }
        bundle.join("jre").join("bin").join("java.exe")
    }
    #[cfg(not(windows))]
    {
        bundle.join("jre").join("bin").join("java")
    }
}

fn seed_headless_server_conf(root: &Path) -> Result<(), String> {
    let path = root.join("server.conf");
    let contents = if path.exists() {
        std::fs::read_to_string(&path)
            .map_err(|error| format!("failed to read managed Suwayomi configuration: {error}"))?
    } else {
        DEFAULT_SERVER_CONF.to_string()
    };
    let mut patched = patch_conf_key(contents, "server.webUIEnabled", "false");
    patched = patch_conf_key(patched, "server.initialOpenInBrowserEnabled", "false");
    patched = patch_conf_key(patched, "server.systemTrayEnabled", "false");
    // The Core-owned runtime is a catalog/GraphQL daemon and has no interactive WebView.
    // Keeping KCEF enabled starts an unnecessary native Chromium tree which can terminate the
    // parent JVM on headless Windows builds. Web authentication remains an explicit foreground
    // desktop/mobile flow; the persistent daemon must favor availability.
    patched = patch_conf_key(patched, "server.kcefEnabled", "false");
    patched = patch_conf_key(patched, "server.webUIUpdateCheckInterval", "0");
    patched = patch_conf_key(patched, "server.globalUpdateInterval", "0");
    patched = patch_conf_key(patched, "server.autoDownloadNewChapters", "false");
    patched = patch_conf_key(patched, "server.ip", "\"127.0.0.1\"");
    patched = patch_conf_key(patched, "server.port", &MAIN_SERVER_PORT.to_string());
    write_file_atomic(&path, patched.as_bytes())
        .map_err(|error| format!("failed to update managed Suwayomi configuration: {error}"))
}

fn patch_conf_key(contents: String, key: &str, value: &str) -> String {
    let replacement = format!("{key} = {value}");
    let mut found = false;
    let mut output = contents
        .lines()
        .map(|line| {
            if !found && line.trim_start().starts_with(key) {
                found = true;
                replacement.clone()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !output.ends_with('\n') {
        output.push('\n');
    }
    if !found {
        output.push_str(&replacement);
        output.push('\n');
    }
    output
}

fn open_spawn_logs(root: &Path) -> Option<(std::fs::File, std::fs::File)> {
    let log_dir = root.join("logs");
    std::fs::create_dir_all(&log_dir).ok()?;
    let open = |name: &str| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join(name))
            .ok()
    };
    Some((
        open("suwayomi-spawn-out.log")?,
        open("suwayomi-spawn-err.log")?,
    ))
}

fn spawn_hidden_runtime(root: &Path, invocation: &RuntimeInvocation) -> Result<Child, String> {
    let root_argument = format!(
        "-Dsuwayomi.tachidesk.config.server.rootDir={}",
        root.display()
    );
    let mut command = Command::new(&invocation.java);
    command.arg(root_argument);
    command.args([
        "-Djava.awt.headless=true",
        "-Xms256m",
        "-Xmx1536m",
        "-XX:+UseG1GC",
        "-noverify",
    ]);
    // Extension overlay (PR #1885 child-first classloader): our patched classes precede
    // the official jar so new-API extensions load without touching upstream releases.
    match std::env::var("EPIGRAPH_SYNCD_EXT_OVERLAY")
        .ok()
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
    {
        Some(dir) => {
            command
                .args([
                    "-cp",
                    &format!("{};{}", dir.display(), invocation.jar.display()),
                ])
                .arg("suwayomi.tachidesk.MainKt");
        }
        None => {
            command.args(["-jar"]).arg(&invocation.jar);
        }
    }
    command
        .current_dir(&invocation.working_dir)
        .env("JAVA_TOOL_OPTIONS", JAVA_TOOL_OPTIONS)
        .stdin(Stdio::null());

    // Capture child output instead of discarding it: startup exits (the historical
    // "exited before becoming ready" loop) must stay diagnosable.
    match open_spawn_logs(root) {
        Some((out, err)) => {
            command.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        None => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map_err(|error| format!("failed to start managed Suwayomi headlessly: {error}"))
}

async fn wait_for_spawned_runtime(
    root: &Path,
    child: &mut Child,
    spawn_lock: &mut SpawnLock,
    timeout: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    loop {
        spawn_lock.refresh()?;
        if child
            .try_wait()
            .map_err(|error| format!("failed to inspect managed Suwayomi process: {error}"))?
            .is_some()
        {
            return Err("managed Suwayomi exited before becoming ready".to_string());
        }
        if probe_server(MAIN_SERVER_PORT).await {
            let listener = listener_pid_for_port(MAIN_SERVER_PORT);
            if listener.is_some_and(|pid| pid != child.id()) {
                return Err(format!(
                    "managed Suwayomi port {MAIN_SERVER_PORT} belongs to PID {} instead of spawned PID {}",
                    listener.unwrap_or_default(),
                    child.id()
                ));
            }
            if listener_matches_spawned_process(listener, child.id())
                && java_pid_matches_root(child.id(), root)
            {
                return Ok(());
            }
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "managed Suwayomi did not become ready within {} seconds",
                timeout.as_secs()
            ));
        }
        tokio::time::sleep(STARTUP_PROBE_INTERVAL).await;
    }
}

async fn probe_server(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .post(format!("http://127.0.0.1:{port}/api/graphql"))
        .json(&serde_json::json!({ "query": "query EpigraphHeadlessReady { __typename }" }))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

fn ensure_port_available(port: u16) -> Result<(), String> {
    TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
        .map(|listener| drop(listener))
        .map_err(|_| format!("local Suwayomi port {port} is occupied by an unowned process"))
}

fn publish_reconstructed_owner(root: &Path, java_pid: u32) -> Result<AttachedSuwayomi, String> {
    let server_url = format!("http://127.0.0.1:{MAIN_SERVER_PORT}");
    let process_identity = runtime_process_identity_with_retry(java_pid).ok_or_else(|| {
        format!("could not establish process identity for managed Suwayomi PID {java_pid}")
    })?;
    let owner = ServerOwner {
        profile_key: MAIN_PROFILE_KEY.to_string(),
        root_dir: root.to_string_lossy().into_owned(),
        app_pid: std::process::id(),
        java_pid,
        port: MAIN_SERVER_PORT,
        server_url: server_url.clone(),
        started_at: unix_now_secs(),
        run_id: Some(uuid::Uuid::new_v4().to_string()),
        process_identity: Some(process_identity),
    };
    write_file_atomic(
        &root.join("server.owner.json"),
        &serde_json::to_vec_pretty(&owner)
            .map_err(|error| format!("failed to serialize managed Suwayomi owner: {error}"))?,
    )
    .map_err(|error| format!("failed to publish managed Suwayomi owner: {error}"))?;
    Ok(AttachedSuwayomi {
        profile_key: owner.profile_key,
        root_dir: root.to_path_buf(),
        java_pid,
        server_url,
    })
}

fn runtime_process_identity(pid: u32) -> Option<crate::suwayomi_runtime::RuntimeProcessIdentity> {
    let system = System::new_all();
    let process = system.process(Pid::from_u32(pid))?;
    let args = process
        .cmd()
        .iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    Some(crate::suwayomi_runtime::RuntimeProcessIdentity {
        pid,
        process_creation_time: Some(process.start_time()),
        executable_path: process
            .exe()
            .map(|path| path.to_string_lossy().into_owned()),
        command_line_hash: Some(crate::suwayomi_runtime::command_line_hash(&args)),
    })
}

fn runtime_process_identity_with_retry(
    pid: u32,
) -> Option<crate::suwayomi_runtime::RuntimeProcessIdentity> {
    for _ in 0..20 {
        if let Some(identity) = runtime_process_identity(pid) {
            return Some(identity);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn process_identity_matches(owner: &ServerOwner, process: &sysinfo::Process) -> bool {
    let Some(expected) = owner.process_identity.as_ref() else {
        return true;
    };
    let args = process
        .cmd()
        .iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    expected.pid == process.pid().as_u32()
        && expected.process_creation_time == Some(process.start_time())
        && expected.executable_path
            == process
                .exe()
                .map(|path| path.to_string_lossy().into_owned())
        && expected.command_line_hash == Some(crate::suwayomi_runtime::command_line_hash(&args))
}

fn process_is_alive(pid: u32) -> bool {
    let mut system = System::new_all();
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some()
}

fn process_age_secs(pid: u32) -> Option<u64> {
    let mut system = System::new_all();
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let started_at = system.process(pid)?.start_time();
    Some(unix_now_secs().saturating_sub(started_at))
}

fn find_java_pid_for_root(root: &Path) -> Option<u32> {
    let system = System::new_all();
    system
        .processes()
        .values()
        .find(|process| java_process_matches_root(process, root))
        .map(|process| process.pid().as_u32())
}

fn java_pid_matches_root(pid: u32, root: &Path) -> bool {
    let mut system = System::new_all();
    let pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system
        .process(pid)
        .is_some_and(|process| java_process_matches_root(process, root))
}

#[cfg(windows)]
fn listener_pid_for_port(port: u16) -> Option<u32> {
    let output = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    parse_windows_listener_pid(&String::from_utf8_lossy(&output.stdout), port)
}

#[cfg(not(windows))]
fn listener_pid_for_port(_port: u16) -> Option<u32> {
    None
}

fn parse_windows_listener_pid(output: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    output.lines().find_map(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        (fields.len() >= 5
            && fields[0].eq_ignore_ascii_case("TCP")
            && fields[1].ends_with(&suffix)
            && fields[3].eq_ignore_ascii_case("LISTENING"))
        .then(|| fields[4].parse::<u32>().ok())
        .flatten()
    })
}

#[cfg(windows)]
fn listener_matches_spawned_process(listener: Option<u32>, expected_pid: u32) -> bool {
    listener == Some(expected_pid)
}

#[cfg(not(windows))]
fn listener_matches_spawned_process(_listener: Option<u32>, _expected_pid: u32) -> bool {
    true
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn write_file_atomic(path: &Path, payload: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("new")
    ));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    {
        let mut file = File::create(&temporary)?;
        file.write_all(payload)?;
        file.sync_all()?;
    }
    atomic_replace_file(&temporary, path)
}

#[cfg(windows)]
fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    let from = from
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let to = to
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
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
    let mut roots = vec![base.join("epigraph-main"), base.join("epigraph")];
    roots.extend(
        [
            "EPIGRAPH_LOCAL_SERVER_MAIN_ROOT",
            "EPIGRAPH_LOCAL_SERVER_TEST_ROOT",
        ]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from),
    );
    if let Ok(entries) = std::fs::read_dir(&base) {
        roots.extend(
            entries
                .flatten()
                .take(128)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("epigraph-profile-"))
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
            run_id: None,
            process_identity: None,
        }
    }

    #[test]
    fn owner_must_match_root_and_loopback_endpoint() {
        let root = PathBuf::from(r"C:\Users\test\AppData\Roaming\epigraph-main");
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
        let expected = r"-Dsuwayomi.tachidesk.config.server.rootDir=C:\Data\epigraph-main";
        assert!(root_flag_matches(expected, expected));
        assert!(!root_flag_matches(
            r"-Dsuwayomi.tachidesk.config.server.rootDir=C:\Data\other",
            expected
        ));
    }

    #[test]
    fn headless_runtime_resolution_uses_bundle_beside_core() {
        let temp = tempfile::tempdir().unwrap();
        let core = temp.path().join("epigraph-syncd.exe");
        let bundle = temp.path().join("binaries").join("suwayomi-bundle");
        let java = bundled_java_path(&bundle);
        let jar = bundle.join("bin").join("Suwayomi-Server.jar");
        std::fs::create_dir_all(java.parent().unwrap()).unwrap();
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        std::fs::write(&core, b"core").unwrap();
        std::fs::write(&java, b"java").unwrap();
        std::fs::write(&jar, b"jar").unwrap();

        let resolved = resolve_headless_runtime_with_managed(
            &core,
            &temp.path().join("missing-managed-runtime.jar"),
        )
        .unwrap();
        assert!(paths_identical(&resolved.java, &java));
        assert!(paths_identical(&resolved.jar, &jar));
        assert!(paths_identical(
            &resolved.working_dir,
            jar.parent().unwrap()
        ));
    }

    #[test]
    fn unconfigured_profile_is_not_created_by_headless_supervisor() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("never-managed");
        assert!(!managed_profile_is_configured(&root));
        assert!(!root.exists());
    }

    #[test]
    fn configured_profile_requires_managed_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        std::fs::create_dir_all(&root).unwrap();
        assert!(!managed_profile_is_configured(&root));
        std::fs::write(root.join("server.conf"), b"server.port = 4567\n").unwrap();
        assert!(managed_profile_is_configured(&root));
    }

    #[test]
    fn headless_configuration_preserves_unknown_preferences() {
        let patched = patch_conf_key(
            "server.port = 9999\ncustom.preference = true\n".to_string(),
            "server.port",
            "4567",
        );
        assert!(patched.contains("server.port = 4567"));
        assert!(patched.contains("custom.preference = true"));
        assert_eq!(patched.matches("server.port =").count(), 1);
    }

    #[test]
    fn headless_configuration_disables_native_kcef_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::write(
            root.join("server.conf"),
            b"server.port = 9999\nserver.kcefEnabled = true\ncustom.preference = true\n",
        )
        .unwrap();

        seed_headless_server_conf(root).unwrap();

        let patched = std::fs::read_to_string(root.join("server.conf")).unwrap();
        assert!(patched.contains("server.kcefEnabled = false"));
        assert_eq!(patched.matches("server.kcefEnabled =").count(), 1);
        assert!(patched.contains("custom.preference = true"));
    }

    #[test]
    fn listener_parser_requires_exact_listening_port() {
        let output = "\
  TCP    127.0.0.1:4567     0.0.0.0:0      LISTENING       1234\n\
  TCP    127.0.0.1:14567    0.0.0.0:0      LISTENING       5678\n";
        assert_eq!(parse_windows_listener_pid(output, 4567), Some(1234));
        assert_eq!(parse_windows_listener_pid(output, 9999), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_readiness_requires_the_spawned_listener_pid() {
        assert!(listener_matches_spawned_process(Some(1234), 1234));
        assert!(!listener_matches_spawned_process(Some(5678), 1234));
        assert!(!listener_matches_spawned_process(None, 1234));
    }

    #[test]
    fn spawn_lock_is_exclusive_and_released_by_owner() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        std::fs::create_dir_all(&root).unwrap();
        let first = acquire_spawn_lock(&root).unwrap();
        assert!(!spawn_lock_is_stale(&root.join("server.spawn.lock")));
        assert!(acquire_spawn_lock(&root).is_err());
        drop(first);
        assert!(acquire_spawn_lock(&root).is_ok());
    }

    #[test]
    fn owner_identity_fields_round_trip_without_breaking_legacy_payloads() {
        let root = PathBuf::from(r"C:\Data\epigraph-main");
        let legacy = serde_json::json!({
            "profileKey": "main",
            "rootDir": root,
            "appPid": 10,
            "javaPid": 11,
            "port": 4567,
            "serverUrl": "http://127.0.0.1:4567",
            "startedAt": 12
        });
        let parsed: ServerOwner = serde_json::from_value(legacy).unwrap();
        assert!(parsed.run_id.is_none());
        assert!(parsed.process_identity.is_none());

        let serialized = serde_json::to_value(parsed).unwrap();
        assert_eq!(serialized["profileKey"], "main");
        assert_eq!(serialized["port"], 4567);
    }
}
