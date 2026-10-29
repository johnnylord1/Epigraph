//! Native authority for the shared restore journal. No caller-provided paths.
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::fs;
use std::sync::{Mutex, OnceLock};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use crate::suwayomi_maintenance::restore_operation::{self, JournalRead, OperationLease};

// Restore-only exclusion. The OS handle is the lifetime; no durable local UNKNOWN.
fn open_restore_session(root: &Path, profile: &str) -> Result<fs::File, String> {
    if crate::sanitize_custom_profile_key(profile).as_deref() != Some(profile) { return Err("RESTORE_PROFILE_INVALID".into()); }
    let directory = root.join("restore-sessions");
    let path = directory.join(format!("{}.lock", digest(profile.as_bytes())));
    ensure_internal_path(root, &path)?;
    fs::create_dir_all(&directory).map_err(|_| "RESTORE_SESSION_UNAVAILABLE")?;
    let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(|_| "RESTORE_SESSION_UNAVAILABLE")?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| "RESTORE_CONFLICT")?;
    Ok(file)
}

fn restore_sessions() -> &'static Mutex<HashMap<String, fs::File>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, fs::File>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}

#[tauri::command]
pub(crate) fn restore_session_admit(profile_id: String) -> Result<String, String> {
    let file = open_restore_session(&crate::suwayomi_maintenance::default_runtime_root(), &profile_id)?;
    let token = Uuid::new_v4().to_string();
    restore_sessions().lock().map_err(|_| "RESTORE_SESSION_UNAVAILABLE")?.insert(token.clone(), file);
    Ok(token)
}

#[tauri::command]
pub(crate) fn restore_session_release(token: String) -> Result<(), String> {
    restore_sessions().lock().map_err(|_| "RESTORE_SESSION_UNAVAILABLE")?.remove(&token).ok_or("RESTORE_SESSION_TOKEN_INVALID")?;
    Ok(())
}

fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

fn operation_path(root: &Path, operation_id: &str) -> Result<PathBuf, String> {
    let id = Uuid::parse_str(operation_id).map_err(|_| "RESTORE_OPERATION_ID_INVALID")?;
    if id.is_nil() || id.to_string() != operation_id { return Err("RESTORE_OPERATION_ID_INVALID".into()); }
    let path = root.join("operations").join(operation_id).join("journal.json");
    ensure_internal_path(root, &path)?;
    Ok(path)
}

fn ensure_internal_path(root: &Path, path: &Path) -> Result<(), String> {
    if !root.is_absolute() || !path.starts_with(root) { return Err("RESTORE_PATH_INVALID".into()); }
    let relative = path.strip_prefix(root).map_err(|_| "RESTORE_PATH_INVALID")?;
    if relative.components().any(|part| !matches!(part, std::path::Component::Normal(_))) { return Err("RESTORE_PATH_INVALID".into()); }
    // Inspect all existing ancestors as well as the leaf. Windows junctions are
    // reparse points even when Rust does not classify them as symbolic links.
    let mut ancestors: Vec<_> = path.ancestors().collect();
    ancestors.reverse();
    for ancestor in ancestors {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 };
                #[cfg(not(windows))]
                let reparse = false;
                if metadata.file_type().is_symlink() || reparse || (ancestor != path && !metadata.is_dir()) {
                    return Err("RESTORE_PATH_UNTRUSTED".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("RESTORE_PATH_UNAVAILABLE".into()),
        }
    }
    Ok(())
}

fn require_desktop_target(profile: &str, url: &str, status: &crate::suwayomi_runtime::RuntimeStatus) -> Result<(), String> {
    if crate::sanitize_custom_profile_key(profile).as_deref() != Some(profile)
        || status.profile_id.as_deref() != Some(profile)
        || status.server_url.as_deref().map(|value| value.trim_end_matches('/')) != Some(url.trim_end_matches('/'))
        || status.state != crate::suwayomi_runtime::RuntimeLifecycleState::Ready {
        return Err("RESTORE_DESKTOP_TARGET_UNVERIFIED".into());
    }
    let endpoint = url::Url::parse(url).map_err(|_| "RESTORE_ENDPOINT_INVALID")?;
    if endpoint.scheme() != "http" || endpoint.host_str() != Some("127.0.0.1")
        || !endpoint.username().is_empty() || endpoint.password().is_some()
        || endpoint.query().is_some() || endpoint.fragment().is_some() || endpoint.path() != "/" {
        return Err("RESTORE_ENDPOINT_UNSUPPORTED".into());
    }
    Ok(())
}

fn validate_owner(root: &Path, profile: &str, url: &str, before: &[u8], after: &[u8], actual: Option<&crate::suwayomi_runtime::RuntimeProcessIdentity>) -> Result<String, String> {
    if before != after { return Err("RESTORE_OWNER_CHANGED".into()); }
    let owner: crate::ServerOwner = serde_json::from_slice(before).map_err(|_| "RESTORE_OWNER_MALFORMED")?;
    let run = owner.run_id.as_deref().and_then(|run| Uuid::parse_str(run).ok()).filter(|run| !run.is_nil()).ok_or("RESTORE_RUN_UNVERIFIED")?;
    let recorded = owner.process_identity.as_ref().ok_or("RESTORE_IDENTITY_MISSING")?;
    if owner.profile_key != profile || owner.root_dir != root.to_string_lossy()
        || owner.server_url.trim_end_matches('/') != url.trim_end_matches('/')
        || url::Url::parse(url).ok().and_then(|url| url.port_or_known_default()) != Some(owner.port)
        || owner.java_pid != recorded.pid || Some(recorded) != actual
        || recorded.process_creation_time.is_none() || recorded.executable_path.as_deref().is_none_or(str::is_empty)
        || recorded.command_line_hash.as_deref().is_none_or(str::is_empty) {
        return Err("RESTORE_IDENTITY_UNVERIFIED".into());
    }
    #[cfg(windows)]
    if recorded.for_termination().is_none() { return Err("RESTORE_IDENTITY_INCOMPLETE".into()); }
    // Native serialization preserves u64 FILETIME; only this digest crosses IPC.
    Ok(digest(&serde_json::to_vec(&(run.to_string(), recorded)).map_err(|_| "RESTORE_IDENTITY_INVALID")?))
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreTarget {
    profile_id: String,
    storage_scope: String,
    connection_generation: String,
    backend_generation: String,
    runtime_identity_digest: String,
}

#[derive(Clone)]
struct Context { profile: String, endpoint: String, root: PathBuf, target: RestoreTarget }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextResult { context_id: String, target: RestoreTarget }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionResult { token: String, reconciliation_only: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult { matches: bool, current_target: RestoreTarget }
#[derive(Serialize)]
pub struct SettlementResult { retained: bool }

struct LiveAdmission { lease: OperationLease, scope: String, active: bool }
#[derive(Default)]
struct Registry { contexts: HashMap<String, Context>, admissions: HashMap<String, LiveAdmission> }
fn registry() -> &'static Mutex<Registry> { static STATE: OnceLock<Mutex<Registry>> = OnceLock::new(); STATE.get_or_init(Default::default) }
fn context(id: &str) -> Result<Context, String> {
    registry().lock().map_err(|_| "RESTORE_REGISTRY_UNAVAILABLE")?.contexts.get(id).cloned().ok_or("RESTORE_CONTEXT_INVALID".into())
}

/// The desktop supervisor only reports runtimes the desktop spawned. In a normal install the main
/// profile's Suwayomi belongs to the persistent Core, so the supervisor never reports it ready and
/// every restore was refused. Its readiness is proven from the Core's owner record instead: the
/// persistent-Core target, spawned by Core, same profile and endpoint, and the recorded birth
/// identity equal to the live process. `validate_owner` still re-verifies the full record.
fn core_owned_runtime_status(
    profile: &str,
    endpoint: &str,
    owner_raw: &[u8],
    live: Option<&crate::suwayomi_runtime::RuntimeProcessIdentity>,
) -> Option<crate::suwayomi_runtime::RuntimeStatus> {
    let port = url::Url::parse(endpoint).ok()?.port_or_known_default()?;
    if crate::managed_startup_owner(profile, port) != crate::ManagedStartupOwner::PersistentCore { return None; }
    let spawned_by_core = serde_json::from_slice::<Value>(owner_raw).ok()?["spawnedByCore"] == Value::Bool(true);
    let owner: crate::ServerOwner = serde_json::from_slice(owner_raw).ok()?;
    if !spawned_by_core || owner.profile_key != profile || owner.port != port
        || owner.server_url.trim_end_matches('/') != endpoint.trim_end_matches('/')
        || owner.process_identity.is_none() || owner.process_identity.as_ref() != live {
        return None;
    }
    Some(crate::suwayomi_runtime::RuntimeStatus {
        state: crate::suwayomi_runtime::RuntimeLifecycleState::Ready,
        profile_id: Some(profile.into()),
        server_url: Some(endpoint.trim_end_matches('/').into()),
        pid: Some(owner.java_pid),
        message: None,
    })
}

fn core_owned_runtime_status_from_disk(
    profile: &str,
    endpoint: &str,
) -> Option<crate::suwayomi_runtime::RuntimeStatus> {
    let owner_path = crate::server_owner_path(&crate::local_server_root_for_profile_key(profile));
    let raw = fs::read(owner_path).ok()?;
    let pid = serde_json::from_slice::<crate::ServerOwner>(&raw).ok()?.java_pid;
    let live = crate::suwayomi_runtime::capture_process_identity(pid);
    core_owned_runtime_status(profile, endpoint, &raw, live.as_ref())
}

fn capture_target(
    profile: &str,
    endpoint: &str,
    supervisor: &crate::suwayomi_runtime::RuntimeStatus,
) -> Result<RestoreTarget, String> {
    let core_owned = require_desktop_target(profile, endpoint, supervisor)
        .is_err()
        .then(|| core_owned_runtime_status_from_disk(profile, endpoint))
        .flatten();
    let status = core_owned.as_ref().unwrap_or(supervisor);
    require_desktop_target(profile, endpoint, status)?;
    let profile_root = crate::local_server_root_for_profile_key(profile);
    let owner_path = crate::server_owner_path(&profile_root);
    ensure_internal_path(&profile_root, &owner_path)?;
    if crate::suwayomi_runtime::has_confirmed_stop(&owner_path) { return Err("RESTORE_BACKEND_STOPPED".into()); }
    let before = fs::read(&owner_path).map_err(|_| "RESTORE_OWNER_UNAVAILABLE")?;
    let owner: crate::ServerOwner = serde_json::from_slice(&before).map_err(|_| "RESTORE_OWNER_MALFORMED")?;
    let actual = crate::suwayomi_runtime::capture_process_identity(owner.java_pid);
    let after = fs::read(&owner_path).map_err(|_| "RESTORE_OWNER_UNAVAILABLE")?;
    let identity = validate_owner(&profile_root, profile, endpoint, &before, &after, actual.as_ref())?;
    if status.pid != Some(owner.java_pid) { return Err("RESTORE_DESKTOP_IDENTITY_CHANGED".into()); }
    let storage_scope = digest(&serde_json::to_vec(&(profile, profile_root.to_string_lossy())).map_err(|_| "RESTORE_SCOPE_INVALID")?);
    let connection_generation = digest(&serde_json::to_vec(&(profile, endpoint.trim_end_matches('/'), &identity)).map_err(|_| "RESTORE_SCOPE_INVALID")?);
    Ok(RestoreTarget { profile_id: profile.into(), storage_scope, connection_generation, backend_generation: identity.clone(), runtime_identity_digest: identity })
}

fn bound_payload(context: &Context, contents: &str, operation_id: &str) -> Result<Value, String> {
    let payload = restore_operation::validated_payload(contents)?;
    if payload["operationId"].as_str() != Some(operation_id)
        || payload["target"]["profileId"].as_str() != Some(context.profile.as_str())
        || payload["target"]["storageScope"].as_str() != Some(context.target.storage_scope.as_str()) {
        return Err("RESTORE_JOURNAL_AUTHORITY_MISMATCH".into());
    }
    Ok(payload)
}
fn read_bound(context: &Context, operation_id: &str) -> Result<Option<JournalRead>, String> {
    let path = operation_path(&context.root, operation_id)?;
    let entry = restore_operation::read_journal(&path)?;
    if let Some(entry) = &entry { bound_payload(context, &entry.contents, operation_id)?; }
    Ok(entry)
}
fn target_matches(payload: &Value, target: &RestoreTarget) -> Result<bool, String> {
    Ok(payload["target"] == serde_json::to_value(target).map_err(|_| "RESTORE_TARGET_INVALID")?)
}
fn has_attempts(payload: &Value) -> bool {
    payload["units"].as_array().is_some_and(|units| units.iter().any(|unit| unit["attempts"].as_array().is_some_and(|attempts| !attempts.is_empty())))
}
fn check_inputs(context: &Context, payload: &Value) -> Result<(), String> {
    for input in payload["inputs"].as_array().ok_or("RESTORE_INPUTS_INVALID")? {
        let sha = input["digest"].as_str().ok_or("RESTORE_INPUT_DIGEST_INVALID")?;
        let size = input["size"].as_u64().ok_or("RESTORE_INPUT_SIZE_INVALID")?;
        ensure_internal_path(&context.root, &context.root.join("inputs").join(format!("{sha}.bin")))?;
        restore_operation::read_input(&context.root, sha, size)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn restore_context(profile_id: String, server_url: String, state: tauri::State<'_, crate::RuntimeSupervisorState>) -> Result<ContextResult, String> {
    let status = state.0.lock().map_err(|_| "RESTORE_DESKTOP_STATE_UNAVAILABLE")?.clone();
    let target = capture_target(&profile_id, &server_url, &status)?;
    let root = crate::suwayomi_maintenance::default_runtime_root().join("restore-operations").join(&target.storage_scope);
    ensure_internal_path(&root, &root)?;
    let id = Uuid::new_v4().to_string();
    let mut registry = registry().lock().map_err(|_| "RESTORE_REGISTRY_UNAVAILABLE")?;
    if registry.contexts.len() >= 1024 { return Err("RESTORE_CONTEXT_LIMIT".into()); }
    registry.contexts.insert(id.clone(), Context { profile: profile_id, endpoint: server_url, root, target: target.clone() });
    Ok(ContextResult { context_id: id, target })
}

#[tauri::command]
pub(crate) fn restore_input_put(context_id: String, digest: String, size: u64, base64: String) -> Result<(), String> {
    let context = context(&context_id)?;
    if size > 1024 * 1024 * 1024 || base64.len() as u64 > (size + 2) / 3 * 4 { return Err("RESTORE_INPUT_TOO_LARGE".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).map_err(|_| "RESTORE_INPUT_ENCODING_INVALID")?;
    ensure_internal_path(&context.root, &context.root.join("inputs").join(format!("{digest}.bin")))?;
    ensure_internal_path(&context.root, &context.root.join("inputs").join(format!("{digest}.input.lock")))?;
    restore_operation::put_input(&context.root, &digest, size, &bytes)
}

#[tauri::command]
pub(crate) fn restore_input_read(context_id: String, operation_id: String, digest: String) -> Result<String, String> {
    let context = context(&context_id)?;
    let entry = read_bound(&context, &operation_id)?.ok_or("RESTORE_JOURNAL_MISSING")?;
    let payload = bound_payload(&context, &entry.contents, &operation_id)?;
    let size = payload["inputs"].as_array().and_then(|inputs| inputs.iter().find(|input| input["digest"].as_str() == Some(&digest)))
        .and_then(|input| input["size"].as_u64()).ok_or("RESTORE_INPUT_NOT_DECLARED")?;
    ensure_internal_path(&context.root, &context.root.join("inputs").join(format!("{digest}.bin")))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(restore_operation::read_input(&context.root, &digest, size)?))
}

#[tauri::command]
pub(crate) fn restore_journal_list(context_id: String) -> Result<Vec<JournalRead>, String> {
    let context = context(&context_id)?;
    let directory = context.root.join("operations");
    ensure_internal_path(&context.root, &directory)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("RESTORE_DISCOVERY_UNAVAILABLE".into()),
    };
    let mut journals = vec![];
    for entry in entries {
        let entry = entry.map_err(|_| "RESTORE_DISCOVERY_UNAVAILABLE")?;
        let id = entry.file_name().to_str().ok_or("RESTORE_DISCOVERY_MALFORMED")?.to_string();
        journals.push(read_bound(&context, &id)?.ok_or("RESTORE_DISCOVERY_INCOMPLETE")?);
    }
    Ok(journals)
}

#[tauri::command]
pub(crate) fn restore_journal_read(context_id: String, operation_id: String) -> Result<Option<JournalRead>, String> {
    read_bound(&context(&context_id)?, &operation_id)
}

#[tauri::command]
pub(crate) fn restore_journal_cas(context_id: String, operation_id: String, expected_sha256: Option<String>, contents: String) -> Result<JournalRead, String> {
    let context = context(&context_id)?;
    let path = operation_path(&context.root, &operation_id)?;
    ensure_internal_path(&context.root, &path.with_extension("restore.lock"))?;
    let payload = bound_payload(&context, &contents, &operation_id)?;
    let old = read_bound(&context, &operation_id)?;
    if old.is_none() {
        if payload["phase"] != "inspected" || !target_matches(&payload, &context.target)? { return Err("RESTORE_INITIAL_AUTHORITY_INVALID".into()); }
        check_inputs(&context, &payload)?;
    }
    let registry = registry().lock().map_err(|_| "RESTORE_REGISTRY_UNAVAILABLE")?;
    let admission = registry.admissions.get(&operation_id);
    let old_execution = old.as_ref().map(|entry| bound_payload(&context, &entry.contents, &operation_id))
        .transpose()?.is_some_and(|prior| prior["phase"] == "running" || has_attempts(&prior));
    if old_execution || payload["phase"] == "running" || has_attempts(&payload) {
        let admission = admission.filter(|admission| admission.active && admission.scope == context.target.storage_scope).ok_or("RESTORE_EXECUTOR_NOT_ADMITTED")?;
        admission.lease.validate_token(admission.lease.token())?;
    }
    restore_operation::compare_and_swap_journal(&path, &contents, expected_sha256.as_deref())
}

#[tauri::command]
pub(crate) fn restore_operation_admit(context_id: String, operation_id: String, expected_sha256: String, state: tauri::State<'_, crate::RuntimeSupervisorState>) -> Result<AdmissionResult, String> {
    let context = context(&context_id)?;
    let status = state.0.lock().map_err(|_| "RESTORE_DESKTOP_STATE_UNAVAILABLE")?.clone();
    let current = capture_target(&context.profile, &context.endpoint, &status)?;
    let path = operation_path(&context.root, &operation_id)?;
    let journal = read_bound(&context, &operation_id)?.ok_or("RESTORE_JOURNAL_MISSING")?;
    if journal.sha256 != expected_sha256 { return Err("RESTORE_JOURNAL_CAS_CONFLICT".into()); }
    let payload = bound_payload(&context, &journal.contents, &operation_id)?;
    if matches!(payload["phase"].as_str(), Some("completed" | "cancelled")) { return Err("RESTORE_ALREADY_TERMINAL".into()); }
    check_inputs(&context, &payload)?;
    let reconciliation_only = !target_matches(&payload, &current)?;
    let mut registry = registry().lock().map_err(|_| "RESTORE_REGISTRY_UNAVAILABLE")?;
    if let Some(admission) = registry.admissions.get_mut(&operation_id) {
        if admission.active || admission.scope != context.target.storage_scope { return Err("RESTORE_EXECUTOR_BUSY".into()); }
        admission.lease.validate_token(admission.lease.token())?;
        admission.active = true;
        return Ok(AdmissionResult { token: admission.lease.token().into(), reconciliation_only });
    }
    let runtime_root = crate::suwayomi_maintenance::default_runtime_root();
    let marker = runtime_root.join("restore-scopes").join(digest(context.target.storage_scope.as_bytes())).join("unresolved.json");
    ensure_internal_path(&runtime_root, &marker)?;
    let resume = match fs::symlink_metadata(&marker) {
        Ok(_) => true, Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("RESTORE_MARKER_UNAVAILABLE".into()),
    };
    // An execution journal without its previously published marker is not safe
    // to adopt. Never turn missing ownership into fresh mutation authority.
    if !resume && (has_attempts(&payload) || !matches!(payload["phase"].as_str(), Some("inspected" | "ready" | "waiting_for_dependencies"))) {
        return Err("RESTORE_MARKER_MISSING".into());
    }
    let lease = restore_operation::begin_operation(&runtime_root, &context.target.storage_scope, &path, &expected_sha256, resume)?;
    let token = lease.token().into();
    registry.admissions.insert(operation_id, LiveAdmission { lease, scope: context.target.storage_scope, active: true });
    Ok(AdmissionResult { token, reconciliation_only })
}

#[tauri::command]
pub(crate) fn restore_operation_validate(context_id: String, operation_id: String, token: String, state: tauri::State<'_, crate::RuntimeSupervisorState>) -> Result<ValidationResult, String> {
    let context = context(&context_id)?;
    let registry = registry().lock().map_err(|_| "RESTORE_REGISTRY_UNAVAILABLE")?;
    let admission = registry.admissions.get(&operation_id).filter(|admission| admission.active && admission.scope == context.target.storage_scope).ok_or("RESTORE_EXECUTOR_NOT_ADMITTED")?;
    admission.lease.validate_token(&token)?;
    let status = state.0.lock().map_err(|_| "RESTORE_DESKTOP_STATE_UNAVAILABLE")?.clone();
    let current_target = capture_target(&context.profile, &context.endpoint, &status)?;
    let journal = read_bound(&context, &operation_id)?.ok_or("RESTORE_JOURNAL_MISSING")?;
    let payload = bound_payload(&context, &journal.contents, &operation_id)?;
    Ok(ValidationResult { matches: target_matches(&payload, &current_target)?, current_target })
}

#[tauri::command]
pub(crate) fn restore_operation_settle(context_id: String, operation_id: String, token: String, expected_sha256: String) -> Result<SettlementResult, String> {
    let context = context(&context_id)?;
    let mut registry = registry().lock().map_err(|_| "RESTORE_REGISTRY_UNAVAILABLE")?;
    let admission = registry.admissions.get_mut(&operation_id).filter(|admission| admission.active && admission.scope == context.target.storage_scope).ok_or("RESTORE_EXECUTOR_NOT_ADMITTED")?;
    admission.lease.validate_token(&token)?;
    admission.active = false;
    let journal = read_bound(&context, &operation_id)?.ok_or("RESTORE_JOURNAL_MISSING")?;
    if journal.sha256 != expected_sha256 { return Err("RESTORE_JOURNAL_CAS_CONFLICT".into()); }
    let payload = bound_payload(&context, &journal.contents, &operation_id)?;
    if matches!(payload["phase"].as_str(), Some("completed" | "cancelled")) || restore_operation::confirmed_external_terminal(&payload) {
        admission.lease.finish(&operation_path(&context.root, &operation_id)?, &expected_sha256)?;
        registry.admissions.remove(&operation_id);
        Ok(SettlementResult { retained: false })
    } else {
        admission.active = false;
        Ok(SettlementResult { retained: true })
    }
}

#[tauri::command]
pub(crate) fn restore_operation_settle_terminal(context_id: String, operation_id: String, expected_sha256: String) -> Result<SettlementResult, String> {
    let context = context(&context_id)?;
    let mut registry = registry().lock().map_err(|_| "RESTORE_REGISTRY_UNAVAILABLE")?;
    let path = operation_path(&context.root, &operation_id)?;
    if let Some(admission) = registry.admissions.get(&operation_id) {
        if admission.active || admission.scope != context.target.storage_scope { return Err("RESTORE_SCOPE_BUSY".into()); }
        admission.lease.finish(&path, &expected_sha256)?;
        registry.admissions.remove(&operation_id);
    } else {
        restore_operation::settle_terminal(&crate::suwayomi_maintenance::default_runtime_root(), &context.target.storage_scope, &path, &expected_sha256)?;
    }
    Ok(SettlementResult { retained: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::suwayomi_runtime::{RuntimeLifecycleState, RuntimeStatus};
    use std::fs;
    use uuid::Uuid;

    fn disposable() -> PathBuf {
        let root = std::env::temp_dir().join(format!("epigraph-restore-adapter-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn restore_session_excludes_same_profile_and_releases_on_handle_drop() {
        let root = disposable();
        let first = open_restore_session(&root, "test").unwrap();
        assert!(open_restore_session(&root, "test").is_err());
        let other = open_restore_session(&root, "main").unwrap();
        drop(first);
        assert!(open_restore_session(&root, "test").is_ok());
        assert!(open_restore_session(&root, "../foreign").is_err());
        drop(other);
    }

    #[test]
    fn restore_session_child_probe() {
        let Some(root) = std::env::var_os("EPIGRAPH_RESTORE_LOCK_TEST_ROOT") else { return; };
        let expected_busy = std::env::var_os("EPIGRAPH_RESTORE_LOCK_TEST_BUSY").is_some();
        assert_eq!(open_restore_session(Path::new(&root), "test").is_err(), expected_busy);
    }

    #[test]
    fn restore_session_lock_is_visible_to_another_process() {
        let root = disposable();
        let held = open_restore_session(&root, "test").unwrap();
        let child = |busy: bool| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "restore_commands::tests::restore_session_child_probe", "--nocapture"])
                .env("EPIGRAPH_RESTORE_LOCK_TEST_ROOT", &root);
            if busy { command.env("EPIGRAPH_RESTORE_LOCK_TEST_BUSY", "1"); }
            else { command.env_remove("EPIGRAPH_RESTORE_LOCK_TEST_BUSY"); }
            assert!(command.output().unwrap().status.success());
        };
        child(true);
        drop(held);
        child(false);
    }

    #[test]
    fn operation_authority_is_canonical_uuid_only() {
        let root = disposable();
        let id = Uuid::new_v4().to_string();
        assert_eq!(operation_path(&root, &id).unwrap(), root.join("operations").join(&id).join("journal.json"));
        for bad in ["../other", "C:\\elsewhere", "", "00000000-0000-0000-0000-000000000000", "123"] {
            assert!(operation_path(&root, bad).is_err(), "accepted {bad}");
        }
        assert!(operation_path(&root, &id.to_uppercase()).is_err());
    }

    #[test]
    fn trusted_path_checks_do_not_create_or_repair_files() {
        let root = disposable();
        let path = root.join("missing").join("journal.json");
        ensure_internal_path(&root, &path).unwrap();
        assert!(!path.parent().unwrap().exists());
        assert!(ensure_internal_path(&root, &root.join("..").join("foreign")).is_err());
        fs::write(root.join("blocked"), b"preserve").unwrap();
        assert!(ensure_internal_path(&root, &root.join("blocked").join("child")).is_err());
        assert_eq!(fs::read(root.join("blocked")).unwrap(), b"preserve");
    }

    #[test]
    fn requested_profile_and_url_are_not_desktop_authority() {
        let status = RuntimeStatus { state: RuntimeLifecycleState::Ready, profile_id: Some("test".into()), server_url: Some("http://127.0.0.1:4667".into()), pid: Some(123), message: None };
        require_desktop_target("test", "http://127.0.0.1:4667", &status).unwrap();
        assert!(require_desktop_target("main", "http://127.0.0.1:4567", &status).is_err());
        assert!(require_desktop_target("test", "http://127.0.0.1:4567", &status).is_err());
        assert!(require_desktop_target("TEST", "http://127.0.0.1:4667", &status).is_err());
        assert!(require_desktop_target("test", "http://127.0.0.1:4667", &RuntimeStatus::default()).is_err());
    }

    #[test]
    fn a_reused_desktop_server_is_a_restore_target() {
        let status = crate::reused_server_runtime_status("test", "http://127.0.0.1:4667", 123);
        require_desktop_target("test", "http://127.0.0.1:4667/", &status).unwrap();
        assert_eq!(status.pid, Some(123));
        let starting = RuntimeStatus { state: RuntimeLifecycleState::Starting, ..status };
        assert_eq!(require_desktop_target("test", "http://127.0.0.1:4667", &starting).unwrap_err(), "RESTORE_DESKTOP_TARGET_UNVERIFIED");
    }

    #[test]
    fn core_owned_main_runtime_is_a_restore_target_only_with_its_live_identity() {
        let identity = crate::suwayomi_runtime::RuntimeProcessIdentity {
            pid: 321, process_creation_time: Some(1_700_000_000), executable_path: Some("fixture-javaw.exe".into()),
            command_line_hash: Some("b".repeat(64)), creation_filetime: Some(133_444_736_000_000_000),
        };
        let owner = |profile: &str, port: u16, spawned_by_core: bool| serde_json::to_vec(&serde_json::json!({
            "profileKey": profile, "rootDir": "C:/fixture/main", "appPid": 654, "javaPid": 321, "port": port,
            "serverUrl": format!("http://127.0.0.1:{port}"), "startedAt": 1_700_000_000u64,
            "runId": Uuid::new_v4().to_string(), "processIdentity": identity, "spawnedByCore": spawned_by_core,
        })).unwrap();
        let main = owner("main", 4567, true);

        let status =
            core_owned_runtime_status("main", "http://127.0.0.1:4567/", &main, Some(&identity))
                .unwrap();
        require_desktop_target("main", "http://127.0.0.1:4567", &status).unwrap();
        assert_eq!(status.pid, Some(321));

        let mut reused = identity.clone();
        reused.creation_filetime = Some(133_444_736_000_000_001);
        assert!(
            core_owned_runtime_status("main", "http://127.0.0.1:4567", &main, Some(&reused))
                .is_none()
        );
        assert!(core_owned_runtime_status("main", "http://127.0.0.1:4567", &main, None).is_none());
        assert!(core_owned_runtime_status(
            "main",
            "http://127.0.0.1:4567",
            &owner("main", 4567, false),
            Some(&identity)
        )
        .is_none());
        assert!(core_owned_runtime_status(
            "test",
            "http://127.0.0.1:4667",
            &owner("test", 4667, true),
            Some(&identity)
        )
        .is_none());
        assert!(
            core_owned_runtime_status("main", "http://127.0.0.1:4667", &main, Some(&identity))
                .is_none()
        );
        assert!(
            core_owned_runtime_status("main", "http://127.0.0.1:4567", b"{", Some(&identity))
                .is_none()
        );
    }

    #[test]
    fn owner_generation_requires_unchanged_record_and_full_live_identity() {
        let root = disposable();
        let identity = crate::suwayomi_runtime::RuntimeProcessIdentity {
            pid: 123, process_creation_time: Some(1_700_000_000), executable_path: Some("fixture-java.exe".into()),
            command_line_hash: Some("a".repeat(64)), creation_filetime: Some(133_444_736_000_000_000),
        };
        let owner = crate::ServerOwner { profile_key: "test".into(), root_dir: root.to_string_lossy().into_owned(), app_pid: 456, java_pid: 123,
            port: 4667, server_url: "http://127.0.0.1:4667".into(), started_at: 1_700_000_000,
            run_id: Some(Uuid::new_v4().to_string()), process_identity: Some(identity.clone()), spawned_by_app: false };
        let raw = serde_json::to_vec(&owner).unwrap();
        assert_eq!(validate_owner(&root, "test", &owner.server_url, &raw, &raw, Some(&identity)).unwrap().len(), 64);
        assert!(validate_owner(&root, "test", &owner.server_url, &raw, b"changed", Some(&identity)).is_err());
        assert!(validate_owner(&root, "test", &owner.server_url, &raw, &raw, None).is_err());
        let mut reused = identity.clone(); reused.creation_filetime = Some(133_444_736_000_000_001);
        assert!(validate_owner(&root, "test", &owner.server_url, &raw, &raw, Some(&reused)).is_err());
        let mut missing = owner.clone(); missing.run_id = None;
        let missing = serde_json::to_vec(&missing).unwrap();
        assert!(validate_owner(&root, "test", &owner.server_url, &missing, &missing, Some(&identity)).is_err());
        assert!(validate_owner(&root, "main", &owner.server_url, &raw, &raw, Some(&identity)).is_err());
        assert!(validate_owner(&root, "test", &owner.server_url, b"{", b"{", Some(&identity)).is_err());
    }
}
