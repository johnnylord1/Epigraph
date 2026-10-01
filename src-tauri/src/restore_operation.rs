//! B2 durable restore storage and admission. Callers supply trusted internal paths.

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_JOURNAL_BYTES: usize = 16 * 1024 * 1024;
const SCOPES_DIRECTORY: &str = "restore-scopes";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRead {
    pub contents: String,
    /// Digest of exact on-disk envelope bytes, not the canonical payload digest.
    pub sha256: String,
}

fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

/// JSON keys use JavaScript UTF-16 ordering. Journal numbers are safe integers;
/// floats are refused rather than silently assigning a different cross-language digest.
fn canonical_json(value: &Value) -> Result<Vec<u8>, String> {
    fn append(value: &Value, output: &mut String) -> Result<(), String> {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                output.push('{');
                for (index, key) in keys.into_iter().enumerate() {
                    if index != 0 { output.push(','); }
                    output.push_str(&serde_json::to_string(key).map_err(|_| "RESTORE_JSON_INVALID")?);
                    output.push(':');
                    append(&map[key], output)?;
                }
                output.push('}');
            }
            Value::Array(items) => {
                output.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index != 0 { output.push(','); }
                    append(item, output)?;
                }
                output.push(']');
            }
            Value::Number(number) => {
                let integer = number.as_i64().ok_or("RESTORE_UNSAFE_JSON_NUMBER")?;
                if integer.unsigned_abs() > 9_007_199_254_740_991 { return Err("RESTORE_UNSAFE_JSON_NUMBER".into()); }
                output.push_str(&integer.to_string());
            }
            _ => output.push_str(&serde_json::to_string(value).map_err(|_| "RESTORE_JSON_INVALID")?),
        }
        Ok(())
    }
    let mut output = String::new();
    append(value, &mut output)?;
    Ok(output.into_bytes())
}

fn timestamp_valid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24 || bytes.iter().enumerate().any(|(index, byte)| match index {
        4 | 7 => *byte != b'-', 10 => *byte != b'T', 13 | 16 => *byte != b':',
        19 => *byte != b'.', 23 => *byte != b'Z', _ => !byte.is_ascii_digit(),
    }) { return false; }
    let number = |start: usize, end: usize| value[start..end].parse::<u32>().unwrap_or(u32::MAX);
    let (year, month, day) = (number(0, 4), number(5, 7), number(8, 10));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month { 1 | 3 | 5 | 7 | 8 | 10 | 12 => 31, 4 | 6 | 9 | 11 => 30, 2 => if leap { 29 } else { 28 }, _ => 0 };
    day > 0 && day <= days && number(11, 13) < 24 && number(14, 16) < 60 && number(17, 19) < 60
}

fn contract_matches(value: &Value, kind: &str, definitions: &Value) -> bool {
    if let Some(inner) = kind.strip_prefix('?') { return value.is_null() || contract_matches(value, inner, definitions); }
    if let Some(inner) = kind.strip_prefix("[]") { return value.as_array().is_some_and(|items| items.iter().all(|item| contract_matches(item, inner, definitions))); }
    if kind.contains('|') { return value.as_str().is_some_and(|text| kind.split('|').any(|variant| variant == text)); }
    match kind {
        "one" => return value.as_u64() == Some(1),
        "uint" => return value.as_u64().is_some_and(|number| number <= 9_007_199_254_740_991),
        "domain" => return matches!(value.as_str(), Some("manga" | "books" | "novels" | "app")),
        "text" => return value.as_str().is_some_and(|text| !text.is_empty()),
        "digest" => return value.as_str().is_some_and(|text| text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))),
        "uuid" => return value.as_str().is_some_and(|text| {
            let bytes = text.as_bytes();
            bytes.len() == 36 && bytes.iter().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) { *byte == b'-' }
                else if index == 14 { (b'1'..=b'8').contains(byte) }
                else if index == 19 { matches!(*byte, b'8' | b'9' | b'a' | b'b') }
                else { byte.is_ascii_digit() || (b'a'..=b'f').contains(byte) }
            })
        }),
        "timestamp" => return value.as_str().is_some_and(timestamp_valid),
        _ => {},
    }
    let Some(object) = value.as_object() else { return false; };
    if kind == "booleanMap" { return object.values().all(Value::is_boolean); }
    let Some(fields) = definitions.get(kind).and_then(Value::as_object) else { return false; };
    object.keys().all(|key| (fields.contains_key(key) && !key.ends_with('?')) || fields.contains_key(&format!("{key}?")))
        && fields.iter().all(|(key, descriptor)| {
            let Some(descriptor) = descriptor.as_str() else { return false; };
            if let Some(key) = key.strip_suffix('?') {
                object.get(key).is_none_or(|entry| contract_matches(entry, descriptor, definitions))
            } else { object.get(key).is_some_and(|entry| contract_matches(entry, descriptor, definitions)) }
        })
}

pub(crate) fn validated_payload(contents: &str) -> Result<Value, String> {
    if contents.len() > MAX_JOURNAL_BYTES { return Err("RESTORE_JOURNAL_TOO_LARGE".into()); }
    let envelope: Value = serde_json::from_str(contents).map_err(|_| "RESTORE_JOURNAL_MALFORMED")?;
    static CONTRACT: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let contract = CONTRACT.get_or_init(|| serde_json::from_str(include_str!("../../src/lib/backup/restoreJournalContract.json")).expect("checked-in restore contract"));
    if !contract_matches(&envelope, "envelope", &contract["definitions"]) || canonical_json(&envelope)? != contents.as_bytes() {
        return Err("RESTORE_JOURNAL_SCHEMA_INVALID".into());
    }
    let payload = envelope.get("payload").ok_or("RESTORE_JOURNAL_PAYLOAD_MISSING")?;
    let checksum = envelope.get("checksum").and_then(Value::as_str).ok_or("RESTORE_JOURNAL_CHECKSUM_MISSING")?;
    if checksum != digest(&canonical_json(payload)?) { return Err("RESTORE_JOURNAL_CHECKSUM_MISMATCH".into()); }
    if payload.get("schemaVersion").and_then(Value::as_u64) != Some(1) { return Err("RESTORE_JOURNAL_SCHEMA_UNSUPPORTED".into()); }
    Uuid::parse_str(payload.get("operationId").and_then(Value::as_str).ok_or("RESTORE_OPERATION_ID_MISSING")?)
        .map_err(|_| "RESTORE_OPERATION_ID_INVALID")?;
    let revision = payload.get("revision").and_then(Value::as_u64).ok_or("RESTORE_REVISION_INVALID")?;
    let previous = payload.get("previousRevision").ok_or("RESTORE_PREVIOUS_REVISION_MISSING")?;
    if (revision == 0 && !previous.is_null()) || (revision > 0 && previous.as_u64() != Some(revision - 1)) {
        return Err("RESTORE_REVISION_CHAIN_INVALID".into());
    }
    let inputs: std::collections::HashSet<_> = payload["inputs"].as_array().unwrap().iter().map(|input| input["digest"].as_str().unwrap()).collect();
    let mut unit_ids = std::collections::HashSet::new();
    let units = payload["units"].as_array().unwrap();
    for unit in units {
        let unit_id = unit["unitId"].as_str().unwrap();
        if unit_ids.contains(unit_id) || !inputs.contains(unit["inputDigest"].as_str().unwrap())
            || unit["dependsOn"].as_array().unwrap().iter().any(|id| !unit_ids.contains(id.as_str().unwrap())) {
            return Err("RESTORE_JOURNAL_UNIT_IDENTITY_INVALID".into());
        }
        unit_ids.insert(unit_id);
        let attempts = unit["attempts"].as_array().unwrap();
        let attempt_ids: std::collections::HashSet<_> = attempts.iter().map(|attempt| attempt["attemptId"].as_str().unwrap()).collect();
        if attempt_ids.len() != attempts.len() { return Err("RESTORE_JOURNAL_ATTEMPT_DUPLICATED".into()); }
        if let Some(intent) = unit.get("submissionIntent") {
            if intent["operationId"] != payload["operationId"] || intent["unitId"] != unit["unitId"]
                || intent["inputDigest"] != unit["inputDigest"] || intent["clientMutationId"] != intent["attemptId"]
                || !attempt_ids.contains(intent["attemptId"].as_str().unwrap()) || intent["target"] != payload["target"] {
                return Err("RESTORE_JOURNAL_INTENT_INVALID".into());
            }
        }
    }
    if (payload["phase"] == "completed" && (units.is_empty() || units.iter().any(|unit| !matches!(unit["status"].as_str(), Some("succeeded" | "skipped")))))
        || (payload["outcome"] == "PASS" && payload["phase"] != "completed") { return Err("RESTORE_JOURNAL_OUTCOME_INVALID".into()); }
    Ok(payload.clone())
}

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("RESTORE_STORAGE_READ_FAILED".into()),
    }
}

/// Read does not repair, remove, or quarantine malformed evidence.
pub fn read_journal(path: &Path) -> Result<Option<JournalRead>, String> {
    let Some(bytes) = read_bytes(path)? else { return Ok(None); };
    let contents = String::from_utf8(bytes).map_err(|_| "RESTORE_JOURNAL_INVALID_UTF8")?;
    validated_payload(&contents)?;
    Ok(Some(JournalRead { sha256: digest(contents.as_bytes()), contents }))
}

fn open_lock(path: &Path) -> Result<File, String> {
    let parent = path.parent().ok_or("RESTORE_STORAGE_PARENT_MISSING")?;
    fs::create_dir_all(parent).map_err(|_| "RESTORE_STORAGE_DIRECTORY_FAILED")?;
    OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path)
        .map_err(|_| "RESTORE_LOCK_OPEN_FAILED".into())
}

fn atomic_publish(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary)
        .map_err(|_| "RESTORE_TEMP_CREATE_FAILED")?;
    file.write_all(bytes).map_err(|_| "RESTORE_TEMP_WRITE_FAILED")?;
    file.sync_all().map_err(|_| "RESTORE_TEMP_SYNC_FAILED")?;
    drop(file);
    if super::atomic_replace_file(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("RESTORE_ATOMIC_REPLACE_FAILED".into());
    }
    #[cfg(unix)]
    File::open(path.parent().ok_or("RESTORE_STORAGE_PARENT_MISSING")?)
        .and_then(|file| file.sync_all()).map_err(|_| "RESTORE_DIRECTORY_SYNC_FAILED")?;
    Ok(())
}

fn validate_external_transition(old: &Value, next: &Value) -> Result<(), String> {
    if old["domain"] != "manga" { return Ok(()); }
    let reject = || "RESTORE_EXTERNAL_EVIDENCE_REGRESSED".to_string();
    let before = old["attempts"].as_array().ok_or_else(reject)?;
    let after = next["attempts"].as_array().ok_or_else(reject)?;
    if after.len() < before.len() || after.len() > before.len() + 1 { return Err(reject()); }
    for (index, attempt) in before.iter().enumerate() {
        let candidate = &after[index];
        if attempt["attemptId"] != candidate["attemptId"] || attempt["startedAt"] != candidate["startedAt"]
            || ((index + 1 < before.len() || !attempt["completedAt"].is_null()) && attempt != candidate) { return Err(reject()); }
    }
    if old["status"] == "unknown" && (!matches!(next["status"].as_str(), Some("unknown" | "succeeded" | "failed"))
        || after.len() != before.len() || next["retryPolicy"] == "proven_not_accepted") { return Err(reject()); }
    if old["status"] == "failed" && old != next {
        if !(old["retryPolicy"] == "proven_not_accepted" && old["externalOperationReference"].is_null()
            && next["status"] == "running" && after.len() == before.len() + 1) { return Err(reject()); }
    }
    if after.len() > before.len() && !(next["status"] == "running" && old["externalOperationReference"].is_null()
        && ((old["status"] == "pending" && before.is_empty()) || (old["status"] == "failed" && old["retryPolicy"] == "proven_not_accepted"))) { return Err(reject()); }
    let prior_intent = &old["submissionIntent"];
    if !prior_intent.is_null() && prior_intent != &next["submissionIntent"] {
        let next_intent = &next["submissionIntent"];
        let last = after.last().ok_or_else(reject)?;
        let safe_prior = before.iter().find(|a| a["attemptId"] == prior_intent["attemptId"])
            .is_some_and(|a| !a["completedAt"].is_null());
        if next_intent.is_null() || next["status"] != "running" || !old["externalOperationReference"].is_null()
            || next_intent["attemptId"] != last["attemptId"] || prior_intent["attemptId"] == last["attemptId"] || !safe_prior { return Err(reject()); }
    }
    if !old["externalOperationReference"].is_null() {
        for field in ["restoreId", "clientMutationId", "backendGeneration", "submittedAt"] {
            if old["externalOperationReference"][field] != next["externalOperationReference"][field] { return Err(reject()); }
        }
        let status = &old["externalOperationReference"]["lastStatus"];
        if matches!(status.as_str(), Some("SUCCESS" | "FAILURE")) && status != &next["externalOperationReference"]["lastStatus"] { return Err(reject()); }
    }
    Ok(())
}

/// Nonblocking OS-lock CAS. Busy/stale callers retry a read, never overwrite.
pub fn compare_and_swap_journal(path: &Path, contents: &str, expected_sha256: Option<&str>) -> Result<JournalRead, String> {
    let next = validated_payload(contents)?;
    let lock = open_lock(&path.with_extension("restore.lock"))?;
    lock.try_lock_exclusive().map_err(|_| "RESTORE_JOURNAL_BUSY")?;
    let previous = read_journal(path)?;
    if previous.as_ref().map(|entry| entry.sha256.as_str()) != expected_sha256 { return Err("RESTORE_JOURNAL_CAS_CONFLICT".into()); }
    if let Some(previous) = previous {
        let old = validated_payload(&previous.contents)?;
        if old["operationId"] != next["operationId"] { return Err("RESTORE_OPERATION_ID_CHANGED".into()); }
        if old["revision"].as_u64().and_then(|revision| revision.checked_add(1)) != next["revision"].as_u64() {
            return Err("RESTORE_JOURNAL_REVISION_CONFLICT".into());
        }
        for field in ["target", "inputs"] {
            if old[field] != next[field] { return Err("RESTORE_IDENTITY_CHANGED".into()); }
        }
        let execution_started = !matches!(old["phase"].as_str(), Some("inspected" | "ready" | "waiting_for_dependencies"))
            || old["units"].as_array().is_some_and(|units| units.iter().any(|unit| unit["attempts"].as_array().is_some_and(|attempts| !attempts.is_empty())));
        if execution_started {
            for field in ["planDigest", "selections", "requirements"] {
                if old[field] != next[field] { return Err("RESTORE_PLAN_FROZEN".into()); }
            }
            let old_units = old["units"].as_array().ok_or("RESTORE_UNITS_MISSING")?;
            let next_units = next["units"].as_array().ok_or("RESTORE_UNITS_MISSING")?;
            if old_units.len() != next_units.len() { return Err("RESTORE_PLAN_FROZEN".into()); }
            for (old_unit, next_unit) in old_units.iter().zip(next_units) {
                validate_external_transition(old_unit, next_unit)?;
                for field in ["unitId", "parentUnitId", "kind", "domain", "inputDigest", "identity", "dependsOn"] {
                    if old_unit[field] != next_unit[field] { return Err("RESTORE_PLAN_FROZEN".into()); }
                }
                if matches!(old_unit["status"].as_str(), Some("succeeded" | "skipped" | "cancelled")) && old_unit != next_unit {
                    return Err("RESTORE_TERMINAL_UNIT_CHANGED".into());
                }
            }
        }
    } else if next["revision"].as_u64() != Some(0) { return Err("RESTORE_INITIAL_REVISION_INVALID".into()); }
    atomic_publish(path, contents.as_bytes())?;
    Ok(JournalRead { contents: contents.to_string(), sha256: digest(contents.as_bytes()) })
}

const MAX_INPUT_BYTES: u64 = 1024 * 1024 * 1024;

fn input_path(root: &Path, sha256: &str, size: u64) -> Result<PathBuf, String> {
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("RESTORE_INPUT_DIGEST_INVALID".into());
    }
    if size > MAX_INPUT_BYTES { return Err("RESTORE_INPUT_TOO_LARGE".into()); }
    Ok(root.join("inputs").join(format!("{sha256}.bin")))
}

/// Inputs are private operational data, never verification diagnostics.
pub fn read_input(root: &Path, sha256: &str, size: u64) -> Result<Vec<u8>, String> {
    let path = input_path(root, sha256, size)?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| "RESTORE_INPUT_UNAVAILABLE")?;
    if !metadata.is_file() || metadata.len() != size { return Err("RESTORE_INPUT_CHANGED".into()); }
    let bytes = fs::read(&path).map_err(|_| "RESTORE_INPUT_UNAVAILABLE")?;
    if bytes.len() as u64 != size || digest(&bytes) != sha256 { return Err("RESTORE_INPUT_CHANGED".into()); }
    Ok(bytes)
}

pub fn put_input(root: &Path, sha256: &str, size: u64, bytes: &[u8]) -> Result<(), String> {
    let path = input_path(root, sha256, size)?;
    if bytes.len() as u64 != size || digest(bytes) != sha256 { return Err("RESTORE_INPUT_CHANGED".into()); }
    let lock = open_lock(&path.with_extension("input.lock"))?;
    lock.try_lock_exclusive().map_err(|_| "RESTORE_INPUT_BUSY")?;
    match fs::symlink_metadata(&path) {
        Ok(_) => { read_input(root, sha256, size)?; return Ok(()); }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err("RESTORE_INPUT_UNAVAILABLE".into()),
    }
    atomic_publish(&path, bytes)?;
    read_input(root, sha256, size)?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    schema_version: u32,
    operation_id: String,
    journal_path_digest: String,
    scope_digest: String,
}

fn scope_directory(runtime_root: &Path, scope: &str) -> PathBuf {
    runtime_root.join(SCOPES_DIRECTORY).join(digest(scope.as_bytes()))
}

fn journal_path_digest(path: &Path) -> Result<String, String> {
    let canonical = fs::canonicalize(path).map_err(|_| "RESTORE_JOURNAL_PATH_UNAVAILABLE")?;
    Ok(digest(canonical.to_string_lossy().as_bytes()))
}

/// Ordinary writers hold this across their complete read-modify-write boundary.
/// A shared lock admits other ordinary writers; domain CAS still prevents stale writes.
/// No production writer takes it yet, so it only exists for the tests that prove an operation or unresolved
/// marker keeps writers out; wire a writer to it before dropping the cfg.
#[cfg(test)]
pub struct WriterLease { _scope: File, _maintenance: super::SharedFileLease }

#[cfg(test)]
pub fn try_writer(runtime_root: &Path, scope: &str) -> Result<WriterLease, String> {
    if scope.is_empty() { return Err("RESTORE_SCOPE_MISSING".into()); }
    let maintenance = super::try_acquire_shared_file_lease(runtime_root)?;
    let directory = scope_directory(runtime_root, scope);
    let file = open_lock(&directory.join("admission.lock"))?;
    FileExt::try_lock_shared(&file).map_err(|_| "RESTORE_SCOPE_BUSY")?;
    if read_bytes(&directory.join("unresolved.json"))?.is_some() { return Err("RESTORE_SCOPE_UNRESOLVED".into()); }
    Ok(WriterLease { _scope: file, _maintenance: maintenance })
}

/// Drop releases live handles but intentionally retains durable unresolved evidence.
pub struct OperationLease {
    _scope: File,
    _maintenance: super::SharedFileLease,
    marker_path: PathBuf,
    marker_bytes: Vec<u8>,
    token: String,
    operation_id: String,
    journal_path_digest: String,
}

/// Resume requires the same journal's operation UUID plus caller's exact current CAS digest.
/// This only admits reconciliation; it does not establish success or permission to replay.
pub fn begin_operation(runtime_root: &Path, scope: &str, journal_path: &Path, expected_journal_sha256: &str, resume: bool) -> Result<OperationLease, String> {
    if scope.is_empty() { return Err("RESTORE_SCOPE_MISSING".into()); }
    let maintenance = super::try_acquire_shared_file_lease(runtime_root)?;
    let directory = scope_directory(runtime_root, scope);
    let file = open_lock(&directory.join("admission.lock"))?;
    file.try_lock_exclusive().map_err(|_| "RESTORE_SCOPE_BUSY")?;
    let journal_lock = open_lock(&journal_path.with_extension("restore.lock"))?;
    journal_lock.try_lock_exclusive().map_err(|_| "RESTORE_JOURNAL_BUSY")?;
    let journal = read_journal(journal_path)?.ok_or("RESTORE_JOURNAL_MISSING")?;
    if journal.sha256 != expected_journal_sha256 { return Err("RESTORE_JOURNAL_CAS_CONFLICT".into()); }
    let payload = validated_payload(&journal.contents)?;
    let operation_id = payload["operationId"].as_str().ok_or("RESTORE_OPERATION_ID_MISSING")?.to_string();
    let journal_path_digest = journal_path_digest(journal_path)?;
    let marker_path = directory.join("unresolved.json");
    let existing = read_bytes(&marker_path)?;
    let marker_bytes = if let Some(bytes) = existing {
        if !resume { return Err("RESTORE_SCOPE_UNRESOLVED".into()); }
        let marker: Marker = serde_json::from_slice(&bytes).map_err(|_| "RESTORE_MARKER_MALFORMED")?;
        if marker.schema_version != 1 || marker.operation_id != operation_id || marker.journal_path_digest != journal_path_digest || marker.scope_digest != digest(scope.as_bytes()) {
            return Err("RESTORE_MARKER_IDENTITY_MISMATCH".into());
        }
        bytes
    } else {
        if resume { return Err("RESTORE_MARKER_MISSING".into()); }
        let marker = Marker { schema_version: 1, operation_id: operation_id.clone(), journal_path_digest: journal_path_digest.clone(), scope_digest: digest(scope.as_bytes()) };
        let bytes = serde_json::to_vec(&marker).map_err(|_| "RESTORE_MARKER_SERIALIZATION_FAILED")?;
        atomic_publish(&marker_path, &bytes)?;
        bytes
    };
    Ok(OperationLease { _scope: file, _maintenance: maintenance, marker_path, marker_bytes, token: Uuid::new_v4().to_string(), operation_id, journal_path_digest })
}

impl OperationLease {
    pub fn token(&self) -> &str { &self.token }
    /// Caller must retain this lease while performing the admitted mutation.
    pub fn validate_token(&self, token: &str) -> Result<(), String> {
        if token != self.token { return Err("RESTORE_ADMISSION_TOKEN_INVALID".into()); }
        if read_bytes(&self.marker_path)?.as_deref() != Some(self.marker_bytes.as_slice()) { return Err("RESTORE_MARKER_CHANGED".into()); }
        Ok(())
    }

    /// Only a confirmed terminal journal may clear the marker. Failures retain evidence.
    pub fn finish(&self, journal_path: &Path, expected_journal_sha256: &str) -> Result<(), String> {
        self.validate_token(&self.token)?;
        if journal_path_digest(journal_path)? != self.journal_path_digest { return Err("RESTORE_MARKER_IDENTITY_MISMATCH".into()); }
        let journal_lock = open_lock(&journal_path.with_extension("restore.lock"))?;
        journal_lock.try_lock_exclusive().map_err(|_| "RESTORE_JOURNAL_BUSY")?;
        let journal = read_journal(journal_path)?.ok_or("RESTORE_JOURNAL_MISSING")?;
        if journal.sha256 != expected_journal_sha256 { return Err("RESTORE_JOURNAL_CAS_CONFLICT".into()); }
        let payload = validated_payload(&journal.contents)?;
        if payload["operationId"].as_str() != Some(&self.operation_id) { return Err("RESTORE_MARKER_IDENTITY_MISMATCH".into()); }
        if confirmed_external_terminal(&payload) {
            fs::remove_file(&self.marker_path).map_err(|_| "RESTORE_MARKER_REMOVE_FAILED")?;
            return Ok(());
        }
        let units = payload["units"].as_array().ok_or("RESTORE_UNITS_MISSING")?;
        if payload["phase"] != "cancelled" || units.iter().any(|unit| unit["status"] != "cancelled"
            || unit["attempts"].as_array().is_none_or(|a| !a.is_empty()) || !unit["submissionIntent"].is_null() || !unit["externalOperationReference"].is_null()) {
            return Err("RESTORE_NOT_CONFIRMED_TERMINAL".into());
        }
        // Holding the exclusive scope lease and journal lock prevents an admitted writer
        // from changing the proof between validation and marker removal.
        fs::remove_file(&self.marker_path).map_err(|_| "RESTORE_MARKER_REMOVE_FAILED")?;
        Ok(())
    }
}

/// An attributed server FAILURE is terminal too; it does not grant replay authority.
pub fn confirmed_external_terminal(payload: &Value) -> bool {
    let Some(units) = payload["units"].as_array() else { return false; };
    if units.len() != 1 || !matches!(payload["phase"].as_str(), Some("completed" | "nonretryable_failure")) { return false; }
    let unit = &units[0];
    let expected = match (unit["status"].as_str(), unit["resultCode"].as_str()) {
        (Some("succeeded"), Some("BACKEND_RESTORE_SUCCESS")) => "SUCCESS",
        (Some("failed"), Some("BACKEND_RESTORE_FAILURE")) => "FAILURE", _ => return false,
    };
    let Some(attempt) = unit["attempts"].as_array().and_then(|a| a.last()) else { return false; };
    let intent = &unit["submissionIntent"]; let reference = &unit["externalOperationReference"];
    unit["domain"] == "manga" && !attempt["completedAt"].is_null() && !unit["completedAt"].is_null()
        && attempt["completedAt"] == unit["completedAt"] && attempt["resultCode"] == unit["resultCode"]
        && attempt["errorCode"] == unit["errorCode"]
        && (if expected == "SUCCESS" { payload["phase"] == "completed" && unit["errorCode"].is_null() }
            else { payload["phase"] == "nonretryable_failure" && unit["errorCode"] == "BACKEND_RESTORE_FAILURE" })
        && intent["operationId"] == payload["operationId"] && intent["unitId"] == unit["unitId"]
        && intent["inputDigest"] == unit["inputDigest"] && intent["target"] == payload["target"]
        && intent["attemptId"] == attempt["attemptId"] && intent["clientMutationId"] == attempt["attemptId"]
        && reference["clientMutationId"] == attempt["attemptId"] && reference["backendGeneration"] == payload["target"]["backendGeneration"]
        && reference["lastStatus"] == expected && !reference["lastObservedAt"].is_null()
}

/// Historical settlement acquires no execution capability and never creates a marker.
pub fn settle_terminal(runtime_root: &Path, scope: &str, journal_path: &Path, expected: &str) -> Result<(), String> {
    let _maintenance = super::try_acquire_shared_file_lease(runtime_root)?;
    let directory = scope_directory(runtime_root, scope);
    let scope_lock = open_lock(&directory.join("admission.lock"))?;
    scope_lock.try_lock_exclusive().map_err(|_| "RESTORE_SCOPE_BUSY")?;
    let journal_lock = open_lock(&journal_path.with_extension("restore.lock"))?;
    journal_lock.try_lock_exclusive().map_err(|_| "RESTORE_JOURNAL_BUSY")?;
    let journal = read_journal(journal_path)?.ok_or("RESTORE_JOURNAL_MISSING")?;
    if journal.sha256 != expected { return Err("RESTORE_JOURNAL_CAS_CONFLICT".into()); }
    let payload = validated_payload(&journal.contents)?;
    if !confirmed_external_terminal(&payload) { return Err("RESTORE_NOT_CONFIRMED_TERMINAL".into()); }
    let marker_path = directory.join("unresolved.json");
    let Some(bytes) = read_bytes(&marker_path)? else { return Ok(()); };
    let marker: Marker = serde_json::from_slice(&bytes).map_err(|_| "RESTORE_MARKER_MALFORMED")?;
    if marker.schema_version != 1 || Some(marker.operation_id.as_str()) != payload["operationId"].as_str()
        || marker.scope_digest != digest(scope.as_bytes()) || marker.journal_path_digest != journal_path_digest(journal_path)? {
        return Err("RESTORE_MARKER_IDENTITY_MISMATCH".into());
    }
    fs::remove_file(marker_path).map_err(|_| "RESTORE_MARKER_REMOVE_FAILED".into())
}

/// Call while holding exclusive runtime maintenance lock, so no marker can be
/// published concurrently. Any unreadable or malformed evidence refuses maintenance.
pub fn refuse_unresolved(runtime_root: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(runtime_root.join(SCOPES_DIRECTORY)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("RESTORE_MARKERS_UNREADABLE".into()),
    };
    for entry in entries {
        let entry = entry.map_err(|_| "RESTORE_MARKERS_UNREADABLE")?;
        if !entry.file_type().map_err(|_| "RESTORE_MARKERS_UNREADABLE")?.is_dir() { return Err("RESTORE_MARKERS_UNEXPECTED_ENTRY".into()); }
        if read_bytes(&entry.path().join("unresolved.json"))?.is_some() { return Err("RESTORE_SCOPE_UNRESOLVED".into()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn encode_payload(payload: Value) -> String {
        let checksum = digest(&canonical_json(&payload).unwrap());
        String::from_utf8(canonical_json(&json!({ "payload": payload, "checksum": checksum })).unwrap()).unwrap()
    }

    fn external_fixture() -> Value {
        let fixtures: Value = serde_json::from_str(include_str!("../../src/lib/backup/fixtures/restoreJournalParity.json")).unwrap();
        serde_json::from_str::<Value>(fixtures["cases"][1]["raw"].as_str().unwrap()).unwrap()["payload"].clone()
    }

    #[test]
    fn unknown_external_evidence_cannot_be_erased_or_replayed() {
        for change in ["pending", "attempts", "intent", "reference", "restore_id", "append_attempt"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("journal.json");
            let old = external_fixture();
            let first = compare_and_swap_journal(&path, &encode_payload(old.clone()), None).unwrap();
            let mut next = old;
            next["revision"] = json!(1); next["previousRevision"] = json!(0);
            let unit = &mut next["units"][0];
            match change {
                "pending" => unit["status"] = json!("pending"),
                "attempts" => unit["attempts"] = json!([]),
                "intent" => { unit.as_object_mut().unwrap().remove("submissionIntent"); },
                "reference" => unit["externalOperationReference"] = Value::Null,
                "restore_id" => unit["externalOperationReference"]["restoreId"] = json!("foreign"),
                _ => { let mut attempt = unit["attempts"][0].clone(); attempt["attemptId"] = json!(Uuid::new_v4().to_string()); unit["attempts"].as_array_mut().unwrap().push(attempt); },
            }
            assert!(compare_and_swap_journal(&path, &encode_payload(next), Some(&first.sha256)).is_err(), "accepted {change}");
            assert_eq!(read_journal(&path).unwrap().unwrap().contents, first.contents);
        }
    }

    #[test]
    fn failed_unknown_cannot_gain_replay_permission_in_a_later_revision() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("journal.json");
        let mut payload = external_fixture();
        payload["units"][0]["externalOperationReference"] = Value::Null;
        let first = compare_and_swap_journal(&path, &encode_payload(payload.clone()), None).unwrap();
        payload["revision"] = json!(1); payload["previousRevision"] = json!(0);
        payload["units"][0]["status"] = json!("failed");
        let second = compare_and_swap_journal(&path, &encode_payload(payload.clone()), Some(&first.sha256)).unwrap();
        payload["revision"] = json!(2); payload["previousRevision"] = json!(1);
        payload["units"][0]["retryPolicy"] = json!("proven_not_accepted");
        assert!(compare_and_swap_journal(&path, &encode_payload(payload), Some(&second.sha256)).is_err());
    }

    #[test]
    fn external_checkpoints_and_unknown_reconciliation_preserve_valid_transitions() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("journal.json");
        let sample = external_fixture(); let mut payload = sample.clone();
        payload["phase"] = json!("ready"); payload["units"][0]["status"] = json!("pending");
        payload["units"][0]["attempts"] = json!([]);
        payload["units"][0].as_object_mut().unwrap().remove("submissionIntent");
        payload["units"][0]["externalOperationReference"] = Value::Null;
        let mut current = compare_and_swap_journal(&path, &encode_payload(payload.clone()), None).unwrap();
        for step in 1..=8 {
            payload["revision"] = json!(step); payload["previousRevision"] = json!(step - 1);
            let unit = &mut payload["units"][0];
            match step {
                1 => { unit["status"] = json!("running"); unit["attempts"] = sample["units"][0]["attempts"].clone(); },
                2 => unit["submissionIntent"] = sample["units"][0]["submissionIntent"].clone(),
                3 => { unit["externalOperationReference"] = sample["units"][0]["externalOperationReference"].clone(); unit["externalOperationReference"]["lastStatus"] = Value::Null; },
                4 => unit["externalOperationReference"]["lastStatus"] = json!("RESTORING_MANGA"),
                5 => { unit["status"] = json!("unknown"); unit["attempts"][0]["resultCode"] = json!("OBSERVATION_TIMEOUT"); },
                6 => unit["externalOperationReference"]["lastStatus"] = json!("SUCCESS"),
                7 => {
                    unit["status"] = json!("succeeded"); unit["resultCode"] = json!("BACKEND_RESTORE_SUCCESS");
                    unit["completedAt"] = json!("2026-09-06T00:00:02.000Z");
                    unit["attempts"][0]["completedAt"] = unit["completedAt"].clone(); unit["attempts"][0]["resultCode"] = unit["resultCode"].clone();
                },
                _ => { payload["phase"] = json!("completed"); payload["outcome"] = json!("PASS"); },
            }
            current = compare_and_swap_journal(&path, &encode_payload(payload.clone()), Some(&current.sha256)).unwrap();
        }
        assert!(confirmed_external_terminal(&payload));
    }

    #[test]
    fn succeeded_without_external_attribution_cannot_clear_marker() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("journal.json");
        let mut payload = validated_payload(&envelope(&Uuid::new_v4().to_string(), 0, "completed")).unwrap();
        payload["units"][0].as_object_mut().unwrap().remove("submissionIntent");
        let journal = compare_and_swap_journal(&path, &encode_payload(payload), None).unwrap();
        let lease = begin_operation(dir.path(), "test-scope", &path, &journal.sha256, false).unwrap();
        assert!(lease.finish(&path, &journal.sha256).is_err());
        assert!(refuse_unresolved(dir.path()).is_err());
    }

    #[test]
    fn attributed_external_failure_can_finish_without_erasing_history() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("journal.json");
        let mut payload = external_fixture();
        payload["phase"] = json!("nonretryable_failure"); payload["outcome"] = json!("FAIL");
        let unit = &mut payload["units"][0];
        unit["status"] = json!("failed"); unit["resultCode"] = json!("BACKEND_RESTORE_FAILURE");
        unit["completedAt"] = json!("2026-09-06T00:00:01.000Z");
        unit["attempts"][0]["completedAt"] = unit["completedAt"].clone();
        unit["errorCode"] = json!("BACKEND_RESTORE_FAILURE");
        unit["attempts"][0]["resultCode"] = unit["resultCode"].clone();
        unit["attempts"][0]["errorCode"] = unit["errorCode"].clone();
        unit["externalOperationReference"]["lastStatus"] = json!("FAILURE");
        let journal = compare_and_swap_journal(&path, &encode_payload(payload), None).unwrap();
        let lease = begin_operation(dir.path(), "test-scope", &path, &journal.sha256, false).unwrap();
        lease.finish(&path, &journal.sha256).unwrap();
        assert_eq!(read_journal(&path).unwrap().unwrap().contents, journal.contents);
        assert!(refuse_unresolved(dir.path()).is_ok());
    }

    #[test]
    fn terminal_recovery_is_idempotent_and_preserves_foreign_marker() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("journal.json");
        let mut payload = external_fixture();
        payload["phase"] = json!("completed"); payload["outcome"] = json!("PASS");
        let unit = &mut payload["units"][0];
        unit["status"] = json!("succeeded"); unit["resultCode"] = json!("BACKEND_RESTORE_SUCCESS");
        unit["completedAt"] = json!("2026-09-06T00:00:01.000Z");
        unit["attempts"][0]["completedAt"] = unit["completedAt"].clone();
        unit["attempts"][0]["resultCode"] = unit["resultCode"].clone();
        unit["externalOperationReference"]["lastStatus"] = json!("SUCCESS");
        let journal = compare_and_swap_journal(&path, &encode_payload(payload.clone()), None).unwrap();
        drop(begin_operation(dir.path(), "test-scope", &path, &journal.sha256, false).unwrap());
        settle_terminal(dir.path(), "test-scope", &path, &journal.sha256).unwrap();
        settle_terminal(dir.path(), "test-scope", &path, &journal.sha256).unwrap();
        assert!(try_writer(dir.path(), "test-scope").is_ok());
        let other = dir.path().join("other.json");
        let other_journal = compare_and_swap_journal(&other, &envelope(&Uuid::new_v4().to_string(), 0, "ready"), None).unwrap();
        drop(begin_operation(dir.path(), "test-scope", &other, &other_journal.sha256, false).unwrap());
        assert!(settle_terminal(dir.path(), "test-scope", &path, &journal.sha256).is_err());
        assert!(refuse_unresolved(dir.path()).is_err());
        for field in ["submissionIntent", "externalOperationReference"] {
            let mut malformed = payload.clone(); malformed["units"][0][field] = Value::Null;
            assert!(!confirmed_external_terminal(&malformed));
        }
    }

    #[test]
    fn cross_language_journal_fixtures() {
        let fixtures: Value = serde_json::from_str(include_str!("../../src/lib/backup/fixtures/restoreJournalParity.json")).unwrap();
        let first: Value = serde_json::from_str(fixtures["cases"][0]["raw"].as_str().unwrap()).unwrap();
        let canonical = canonical_json(&first["payload"]).unwrap();
        assert_eq!(std::str::from_utf8(&canonical).unwrap(), fixtures["canonicalPayload"].as_str().unwrap());
        assert_eq!(digest(&canonical), fixtures["payloadSha256"].as_str().unwrap());
        for case in fixtures["cases"].as_array().unwrap() {
            assert_eq!(validated_payload(case["raw"].as_str().unwrap()).is_ok(), case["valid"].as_bool().unwrap(), "{}", case["name"]);
        }
    }

    fn envelope(id: &str, revision: u64, phase: &str) -> String {
        let fixtures: Value = serde_json::from_str(include_str!("../../src/lib/backup/fixtures/restoreJournalParity.json")).unwrap();
        let mut envelope: Value = serde_json::from_str(fixtures["cases"][1]["raw"].as_str().unwrap()).unwrap();
        let payload = &mut envelope["payload"];
        payload["operationId"] = json!(id);
        payload["revision"] = json!(revision);
        payload["previousRevision"] = if revision == 0 { Value::Null } else { json!(revision - 1) };
        payload["phase"] = json!(phase);
        payload["outcome"] = json!(if phase == "completed" { "PASS" } else { "NOT_TESTED" });
        let unit = &mut payload["units"][0];
        unit.as_object_mut().unwrap().remove("submissionIntent");
        unit["externalOperationReference"] = Value::Null;
        unit["attempts"] = json!([]);
        unit["status"] = json!(if phase == "completed" { "succeeded" } else { "pending" });
        if phase == "completed" {
            let attributed = external_fixture();
            unit["submissionIntent"] = attributed["units"][0]["submissionIntent"].clone();
            unit["submissionIntent"]["operationId"] = json!(id);
            unit["externalOperationReference"] = attributed["units"][0]["externalOperationReference"].clone();
            unit["externalOperationReference"]["lastStatus"] = json!("SUCCESS");
            unit["attempts"] = attributed["units"][0]["attempts"].clone();
            unit["completedAt"] = json!("2026-09-06T00:00:01.000Z");
            unit["resultCode"] = json!("BACKEND_RESTORE_SUCCESS");
            unit["attempts"][0]["completedAt"] = unit["completedAt"].clone();
            unit["attempts"][0]["resultCode"] = unit["resultCode"].clone();
        }
        envelope["checksum"] = json!(digest(&canonical_json(&envelope["payload"]).unwrap()));
        String::from_utf8(canonical_json(&envelope).unwrap()).unwrap()
    }

    #[test]
    fn journal_cas_rejects_stale_corrupt_and_truncated_without_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let id = uuid::Uuid::new_v4().to_string();
        let first = compare_and_swap_journal(&path, &envelope(&id, 0, "ready"), None).unwrap();
        assert!(compare_and_swap_journal(&path, &envelope(&id, 1, "running"), None).is_err());
        let second = compare_and_swap_journal(&path, &envelope(&id, 1, "running"), Some(&first.sha256)).unwrap();
        assert!(compare_and_swap_journal(&path, &envelope(&id, 2, "completed"), Some(&first.sha256)).is_err());
        assert_eq!(read_journal(&path).unwrap().unwrap().sha256, second.sha256);
        std::fs::write(&path, b"{\"payload\":").unwrap();
        let corrupt = std::fs::read(&path).unwrap();
        assert!(read_journal(&path).is_err());
        assert!(compare_and_swap_journal(&path, &envelope(&id, 0, "ready"), Some(&digest(&corrupt))).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
    }

    #[test]
    fn journal_rejects_checksum_identity_and_revision_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let id = uuid::Uuid::new_v4().to_string();
        let first = compare_and_swap_journal(&path, &envelope(&id, 0, "ready"), None).unwrap();
        assert!(compare_and_swap_journal(&path, &envelope(&uuid::Uuid::new_v4().to_string(), 1, "running"), Some(&first.sha256)).is_err());
        assert!(compare_and_swap_journal(&path, &envelope(&id, 2, "running"), Some(&first.sha256)).is_err());
        let altered = envelope(&id, 1, "running").replace("running", "completed");
        assert!(compare_and_swap_journal(&path, &altered, Some(&first.sha256)).is_err());
        assert_eq!(read_journal(&path).unwrap().unwrap().sha256, first.sha256);
    }

    #[test]
    fn one_concurrent_cas_writer_wins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let id = uuid::Uuid::new_v4().to_string();
        let first = compare_and_swap_journal(&path, &envelope(&id, 0, "ready"), None).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let joins: Vec<_> = (0..2).map(|_| {
            let (path, id, expected, barrier) = (path.clone(), id.clone(), first.sha256.clone(), barrier.clone());
            std::thread::spawn(move || { barrier.wait(); compare_and_swap_journal(&path, &envelope(&id, 1, "running"), Some(&expected)).is_ok() })
        }).collect();
        assert_eq!(joins.into_iter().map(|join| usize::from(join.join().unwrap())).sum::<usize>(), 1);
    }

    #[test]
    fn marker_survives_drop_and_blocks_writer_and_maintenance_until_attributed_completion() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let id = uuid::Uuid::new_v4().to_string();
        let first = compare_and_swap_journal(&path, &envelope(&id, 0, "ready"), None).unwrap();
        let writer = try_writer(dir.path(), "books:main").unwrap();
        assert!(begin_operation(dir.path(), "books:main", &path, &first.sha256, false).is_err());
        drop(writer);
        let owner = begin_operation(dir.path(), "books:main", &path, &first.sha256, false).unwrap();
        assert!(owner.validate_token("wrong").is_err());
        assert!(owner.validate_token(owner.token()).is_ok());
        assert!(try_writer(dir.path(), "books:main").is_err());
        drop(owner);
        assert!(try_writer(dir.path(), "books:main").is_err());
        assert!(refuse_unresolved(dir.path()).is_err());
        assert!(begin_operation(dir.path(), "books:main", &path, &first.sha256, false).is_err());
        let owner = begin_operation(dir.path(), "books:main", &path, &first.sha256, true).unwrap();
        assert!(owner.finish(&path, &first.sha256).is_err());
        drop(owner);
        let done = compare_and_swap_journal(&path, &envelope(&id, 1, "completed"), Some(&first.sha256)).unwrap();
        let owner = begin_operation(dir.path(), "books:main", &path, &done.sha256, true).unwrap();
        owner.finish(&path, &done.sha256).unwrap();
        drop(owner);
        assert!(try_writer(dir.path(), "books:main").is_ok());
        assert!(refuse_unresolved(dir.path()).is_ok());
    }

    #[test]
    fn corrupt_marker_and_foreign_journal_never_admit_or_remove_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let id = uuid::Uuid::new_v4().to_string();
        let first = compare_and_swap_journal(&path, &envelope(&id, 0, "ready"), None).unwrap();
        drop(begin_operation(dir.path(), "books:main", &path, &first.sha256, false).unwrap());
        let foreign = dir.path().join("foreign.json");
        let second = compare_and_swap_journal(&foreign, &envelope(&uuid::Uuid::new_v4().to_string(), 0, "ready"), None).unwrap();
        assert!(begin_operation(dir.path(), "books:main", &foreign, &second.sha256, true).is_err());
        let marker = scope_directory(dir.path(), "books:main").join("unresolved.json");
        std::fs::write(&marker, b"{broken").unwrap();
        assert!(begin_operation(dir.path(), "books:main", &path, &first.sha256, true).is_err());
        assert!(try_writer(dir.path(), "books:main").is_err());
        assert!(refuse_unresolved(dir.path()).is_err());
        assert_eq!(std::fs::read(&marker).unwrap(), b"{broken");
    }

    #[test]
    fn input_store_verifies_digest_size_and_preserves_existing_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"private backup bytes";
        let hash = digest(bytes);
        put_input(dir.path(), &hash, bytes.len() as u64, bytes).unwrap();
        assert_eq!(read_input(dir.path(), &hash, bytes.len() as u64).unwrap(), bytes);
        assert!(put_input(dir.path(), &hash, bytes.len() as u64, b"changed bytes").is_err());
        assert!(read_input(dir.path(), "../invalid", bytes.len() as u64).is_err());
        let path = dir.path().join("inputs").join(format!("{hash}.bin"));
        std::fs::write(&path, b"corrupt").unwrap();
        assert!(read_input(dir.path(), &hash, bytes.len() as u64).is_err());
        assert!(put_input(dir.path(), &hash, bytes.len() as u64, bytes).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"corrupt");
    }

    #[test]
    fn execution_freezes_target_inputs_and_plan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let id = uuid::Uuid::new_v4().to_string();
        let first = compare_and_swap_journal(&path, &envelope(&id, 0, "running"), None).unwrap();
        let mut changed: Value = serde_json::from_str(&envelope(&id, 1, "interrupted")).unwrap();
        changed["payload"]["target"]["profileId"] = json!("foreign");
        changed["checksum"] = json!(digest(&canonical_json(&changed["payload"]).unwrap()));
        assert!(compare_and_swap_journal(&path, &serde_json::to_string(&changed).unwrap(), Some(&first.sha256)).is_err());
    }

    #[test]
    fn incomplete_terminal_proof_retains_the_marker() {
        for (phase, units) in [("completed", json!([])), ("completed", json!([{"status":"cancelled"}]))] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("journal.json");
            let id = Uuid::new_v4().to_string();
            let first = compare_and_swap_journal(&path, &envelope(&id, 0, "ready"), None).unwrap();
            let owner = begin_operation(dir.path(), "books:main", &path, &first.sha256, false).unwrap();
            let mut next: Value = serde_json::from_str(&envelope(&id, 1, phase)).unwrap();
            next["payload"]["units"] = units;
            next["checksum"] = json!(digest(&canonical_json(&next["payload"]).unwrap()));
            let publication = compare_and_swap_journal(&path, &next.to_string(), Some(&first.sha256));
            if let Ok(published) = publication {
                assert!(owner.finish(&path, &published.sha256).is_err());
            }
            drop(owner);
            assert!(refuse_unresolved(dir.path()).is_err());
        }
    }

    #[test]
    fn running_plan_cannot_drop_units_or_regress_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let id = Uuid::new_v4().to_string();
        let mut original: Value = serde_json::from_str(&envelope(&id, 0, "running")).unwrap();
        original["payload"]["units"][0]["status"] = json!("succeeded");
        original["checksum"] = json!(digest(&canonical_json(&original["payload"]).unwrap()));
        let first = compare_and_swap_journal(&path, &original.to_string(), None).unwrap();
        for alteration in ["drop", "regress", "retarget"] {
            let mut next = original.clone();
            next["payload"]["revision"] = json!(1);
            next["payload"]["previousRevision"] = json!(0);
            match alteration {
                "drop" => next["payload"]["units"] = json!([]),
                "regress" => next["payload"]["units"][0]["status"] = json!("pending"),
                _ => next["payload"]["units"][0]["identity"] = json!("foreign"),
            }
            next["checksum"] = json!(digest(&canonical_json(&next["payload"]).unwrap()));
            assert!(compare_and_swap_journal(&path, &next.to_string(), Some(&first.sha256)).is_err(), "{alteration}");
            assert_eq!(read_journal(&path).unwrap().unwrap().sha256, first.sha256);
        }
    }

    #[test]
    fn persisted_unresolved_marker_rejects_actual_maintenance_entry() {
        let _coordinator = super::super::COORDINATOR_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let id = uuid::Uuid::new_v4().to_string();
        let first = compare_and_swap_journal(&path, &envelope(&id, 0, "ready"), None).unwrap();
        drop(begin_operation(dir.path(), "manga:main", &path, &first.sha256, false).unwrap());
        assert!(super::super::begin_exclusive_maintenance(dir.path(), "b2-test", super::super::MaintenancePhase::Updating).is_err());
    }
}
