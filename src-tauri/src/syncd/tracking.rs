//! Pure validation and identity helpers for tracker sync.
//!
//! Tracking records (`comic.tracking`, `novel.tracking`) are full-state,
//! non-secret tracker bindings keyed by `<entityType>::<workId>::<trackerKey>`.
//! Credentials never travel through this path; see `tracker_credentials`.

use serde_json::Value;

pub const COMIC_TRACKING: &str = "comic.tracking";
pub const NOVEL_TRACKING: &str = "novel.tracking";

/// Upper bound for one stored tracking record.  Real records are a few hundred
/// bytes; the cap only keeps a misbehaving client from bloating the change log.
pub const MAX_TRACKING_RECORD_BYTES: usize = 64 * 1024;
const MAX_TRACKING_ENTITY_ID_BYTES: usize = 1024;

/// Field names that look like secrets.  Compared after lower-casing and
/// removing `_` / `-`, so `access_token`, `AccessToken` and `access-token`
/// all match `accesstoken`.
const CREDENTIAL_FIELD_NAMES: [&str; 5] =
    ["token", "password", "accesstoken", "refreshtoken", "cookie"];

/// Numeric fields of the wire record.  They must be JSON numbers when present.
const NUMERIC_FIELDS: [&str; 9] = [
    "remoteId",
    "libraryId",
    "status",
    "progress",
    "totalChapters",
    "score",
    "startedAtMs",
    "finishedAtMs",
    "updatedAtMs",
];

/// Fields a full-state record must carry.  A partial record would let an older
/// writer erase data on other devices.
const REQUIRED_FIELDS: [&str; 7] = [
    "remoteId",
    "title",
    "remoteUrl",
    "status",
    "progress",
    "totalChapters",
    "score",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackingIdentity {
    pub work_id: String,
    pub tracker_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackingValidationError {
    pub code: &'static str,
    pub message: String,
}

impl TrackingValidationError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// `^[a-z][a-z0-9_]{0,63}$`
pub fn is_valid_tracker_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

pub fn tracking_work_key(entity_type: &str) -> Option<&'static str> {
    match entity_type {
        COMIC_TRACKING => Some("comicId"),
        NOVEL_TRACKING => Some("novelId"),
        _ => None,
    }
}

pub fn tracking_entity_id(entity_type: &str, work_id: &str, tracker_key: &str) -> String {
    format!("{entity_type}::{work_id}::{tracker_key}")
}

/// Splits `<entityType>::<workId>::<trackerKey>` and validates each segment.
pub fn parse_tracking_entity_id(entity_type: &str, entity_id: &str) -> Option<TrackingIdentity> {
    tracking_work_key(entity_type)?;
    if entity_id.len() > MAX_TRACKING_ENTITY_ID_BYTES || entity_id.contains('\0') {
        return None;
    }
    let rest = entity_id.strip_prefix(entity_type)?.strip_prefix("::")?;
    let (work_id, tracker_key) = rest.rsplit_once("::")?;
    if work_id.is_empty() || work_id != work_id.trim() || !is_valid_tracker_key(tracker_key) {
        return None;
    }
    // Comic tracking is portable-only; novels may still use their pre-portable identity.
    if entity_type == COMIC_TRACKING && !work_id.starts_with("comic:") {
        return None;
    }
    Some(TrackingIdentity {
        work_id: work_id.to_string(),
        tracker_key: tracker_key.to_string(),
    })
}

fn normalized_field_name(name: &str) -> String {
    name.chars()
        .filter(|character| *character != '_' && *character != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

/// Returns the first credential-looking field name anywhere in the value.
/// Only the name is returned so callers never echo a secret.
pub fn credential_field_name(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => map.iter().find_map(|(key, nested)| {
            let normalized = normalized_field_name(key);
            if CREDENTIAL_FIELD_NAMES.contains(&normalized.as_str()) {
                Some(key.clone())
            } else {
                credential_field_name(nested)
            }
        }),
        Value::Array(values) => values.iter().find_map(credential_field_name),
        _ => None,
    }
}

/// Validates a full-state tracking record against its mutation entity id.
pub fn validate_tracking_patch(
    entity_type: &str,
    entity_id: &str,
    patch: &Value,
) -> Result<TrackingIdentity, TrackingValidationError> {
    let Some(work_key) = tracking_work_key(entity_type) else {
        return Err(TrackingValidationError::new(
            "INVALID_ENTITY_TYPE",
            "Unsupported tracking entity type.",
        ));
    };
    let Some(record) = patch.as_object() else {
        return Err(TrackingValidationError::new(
            "INVALID_TRACKING_RECORD",
            "Tracking patch must be a JSON object.",
        ));
    };
    if let Some(field) = credential_field_name(patch) {
        return Err(TrackingValidationError::new(
            "TRACKING_CREDENTIAL_FIELD",
            format!("Tracking records must not carry credentials (field '{field}')."),
        ));
    }
    let encoded_len = serde_json::to_vec(patch).map(|bytes| bytes.len()).unwrap_or(usize::MAX);
    if encoded_len > MAX_TRACKING_RECORD_BYTES {
        return Err(TrackingValidationError::new(
            "TRACKING_RECORD_TOO_LARGE",
            format!("Tracking records must be at most {MAX_TRACKING_RECORD_BYTES} bytes."),
        ));
    }
    let tracking_id = record.get("trackingId").and_then(Value::as_str);
    if tracking_id != Some(entity_id) {
        return Err(TrackingValidationError::new(
            "ENTITY_ID_MISMATCH",
            "Tracking trackingId must equal the mutation entityId.",
        ));
    }
    let Some(identity) = parse_tracking_entity_id(entity_type, entity_id) else {
        return Err(TrackingValidationError::new(
            "INVALID_TRACKING_ID",
            format!("Tracking entityId must be '{entity_type}::<workId>::<trackerKey>'."),
        ));
    };
    if record.get(work_key).and_then(Value::as_str) != Some(identity.work_id.as_str()) {
        return Err(TrackingValidationError::new(
            "PARENT_ID_MISMATCH",
            format!("Tracking {work_key} must match the entityId work segment."),
        ));
    }
    if record.get("trackerKey").and_then(Value::as_str) != Some(identity.tracker_key.as_str()) {
        return Err(TrackingValidationError::new(
            "INVALID_TRACKER_KEY",
            "Tracking trackerKey must match ^[a-z][a-z0-9_]{0,63}$ and the entityId suffix.",
        ));
    }
    for field in NUMERIC_FIELDS {
        match record.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::Number(number)) => {
                if !number.as_f64().is_some_and(f64::is_finite) {
                    return Err(TrackingValidationError::new(
                        "INVALID_NUMBER",
                        format!("Tracking {field} must be a finite number."),
                    ));
                }
            }
            Some(_) => {
                return Err(TrackingValidationError::new(
                    "INVALID_NUMBER",
                    format!("Tracking {field} must be a finite number."),
                ));
            }
        }
    }
    for field in ["title", "remoteUrl"] {
        if record.get(field).is_some_and(|value| !value.is_string()) {
            return Err(TrackingValidationError::new(
                "INVALID_TRACKING_RECORD",
                format!("Tracking {field} must be a string."),
            ));
        }
    }
    for field in REQUIRED_FIELDS {
        if record.get(field).is_none_or(Value::is_null) {
            return Err(TrackingValidationError::new(
                "MISSING_TRACKING_FIELD",
                format!("Tracking records are full-state; {field} is required."),
            ));
        }
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "comic.tracking::comic:abc123::anilist";

    fn record() -> Value {
        json!({
            "trackingId": ID,
            "comicId": "comic:abc123",
            "trackerKey": "anilist",
            "remoteId": 4242,
            "libraryId": null,
            "title": "Title",
            "remoteUrl": "https://anilist.co/manga/4242",
            "status": 1,
            "progress": 12.5,
            "totalChapters": 100,
            "score": 8.0,
            "startedAtMs": 0,
            "finishedAtMs": 0,
            "updatedAtMs": 1_790_000_000_000_i64,
            "futureField": {"kept": true}
        })
    }

    #[test]
    fn tracker_key_pattern_matches_contract() {
        assert!(is_valid_tracker_key("anilist"));
        assert!(is_valid_tracker_key("a"));
        assert!(is_valid_tracker_key("novel_updates2"));
        assert!(is_valid_tracker_key(&format!("a{}", "b".repeat(63))));
        assert!(!is_valid_tracker_key(&format!("a{}", "b".repeat(64))));
        assert!(!is_valid_tracker_key(""));
        assert!(!is_valid_tracker_key("1anilist"));
        assert!(!is_valid_tracker_key("AniList"));
        assert!(!is_valid_tracker_key("ani-list"));
        assert!(!is_valid_tracker_key("_anilist"));
    }

    #[test]
    fn parses_tracking_entity_ids() {
        assert_eq!(
            parse_tracking_entity_id(COMIC_TRACKING, ID),
            Some(TrackingIdentity {
                work_id: "comic:abc123".to_string(),
                tracker_key: "anilist".to_string(),
            })
        );
        assert_eq!(
            parse_tracking_entity_id(NOVEL_TRACKING, "novel.tracking::novel-local-1::hardcover")
                .map(|identity| identity.work_id),
            Some("novel-local-1".to_string())
        );
        assert!(parse_tracking_entity_id(NOVEL_TRACKING, ID).is_none());
        assert!(parse_tracking_entity_id(COMIC_TRACKING, "comic.tracking::12::anilist").is_none());
        assert!(parse_tracking_entity_id(COMIC_TRACKING, "comic.tracking::comic:x::Bad").is_none());
        assert!(parse_tracking_entity_id(COMIC_TRACKING, "comic.tracking::::anilist").is_none());
        assert!(parse_tracking_entity_id("comic.entry", ID).is_none());
    }

    #[test]
    fn accepts_full_state_record_with_unknown_fields() {
        let identity = validate_tracking_patch(COMIC_TRACKING, ID, &record()).unwrap();
        assert_eq!(identity.tracker_key, "anilist");
    }

    #[test]
    fn rejects_identity_mismatches() {
        let mut value = record();
        value["trackingId"] = json!("comic.tracking::comic:other::anilist");
        assert_eq!(
            validate_tracking_patch(COMIC_TRACKING, ID, &value).unwrap_err().code,
            "ENTITY_ID_MISMATCH"
        );

        let mut value = record();
        value["comicId"] = json!("comic:other");
        assert_eq!(
            validate_tracking_patch(COMIC_TRACKING, ID, &value).unwrap_err().code,
            "PARENT_ID_MISMATCH"
        );

        let mut value = record();
        value["trackerKey"] = json!("myanimelist");
        assert_eq!(
            validate_tracking_patch(COMIC_TRACKING, ID, &value).unwrap_err().code,
            "INVALID_TRACKER_KEY"
        );

        assert_eq!(
            validate_tracking_patch(NOVEL_TRACKING, ID, &record())
                .unwrap_err()
                .code,
            "INVALID_TRACKING_ID"
        );
    }

    #[test]
    fn rejects_non_numeric_and_missing_fields() {
        let mut value = record();
        value["score"] = json!("8.0");
        assert_eq!(
            validate_tracking_patch(COMIC_TRACKING, ID, &value).unwrap_err().code,
            "INVALID_NUMBER"
        );

        let mut value = record();
        value.as_object_mut().unwrap().remove("remoteId");
        assert_eq!(
            validate_tracking_patch(COMIC_TRACKING, ID, &value).unwrap_err().code,
            "MISSING_TRACKING_FIELD"
        );
    }

    #[test]
    fn detects_credential_fields_without_returning_values() {
        for name in ["token", "Password", "accessToken", "refresh_token", "COOKIE", "access-token"] {
            let mut value = record();
            value[name] = json!("super-secret");
            let error = validate_tracking_patch(COMIC_TRACKING, ID, &value).unwrap_err();
            assert_eq!(error.code, "TRACKING_CREDENTIAL_FIELD");
            assert!(!error.message.contains("super-secret"));
        }
        let mut value = record();
        value["futureField"] = json!({"nested": [{"refreshToken": "x"}]});
        assert_eq!(credential_field_name(&value).as_deref(), Some("refreshToken"));
        assert_eq!(credential_field_name(&record()), None);
    }
}
