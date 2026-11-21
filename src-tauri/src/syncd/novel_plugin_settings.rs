//! LNReader novel plugin settings (`novel.plugin_setting`).
//!
//! One full-state record per novel plugin and declared setting key (`pluginSettings`), so a
//! choice made on one device, such as WTR-LAB's preferred translation, applies on the other:
//!
//! ```json
//! { "settingId": "novel.plugin_setting::wtrlab::preferredMode", "pluginId": "wtrlab",
//!   "key": "preferredMode", "valueType": "string", "value": "web", "updatedAtMs": 1763600000000 }
//! ```
//!
//! `valueType` is `boolean` (Switch), `string` (Select, Text) or `string_set` (CheckboxGroup).
//! The value rules, limits and the list of keys that never travel (credentials, sessions,
//! caches) are the ones of `comic.source_preference`. Records live in `tracking_records` with
//! `work_id` = plugin id and `tracker_key` = setting key, so they share its record-level LWW.

use serde_json::{json, Value};

use super::source_preferences::{is_syncable_key, PreferenceValue, MAX_KEY_BYTES, MAX_RECORD_BYTES};

pub const NOVEL_PLUGIN_SETTING: &str = "novel.plugin_setting";
const ENTITY_PREFIX: &str = "novel.plugin_setting::";
pub const MAX_PLUGIN_ID_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub code: &'static str,
    pub message: String,
}

impl ValidationError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedSetting {
    pub plugin_id: String,
    pub key: String,
    pub value: PreferenceValue,
}

pub fn entity_id_for(plugin_id: &str, key: &str) -> String {
    format!("{ENTITY_PREFIX}{plugin_id}::{key}")
}

/// An LNReader plugin id: printable, trimmed, at most 128 bytes and without `::`.
pub fn is_valid_plugin_id(plugin_id: &str) -> bool {
    !plugin_id.is_empty()
        && plugin_id.len() <= MAX_PLUGIN_ID_BYTES
        && plugin_id.trim() == plugin_id
        && !plugin_id.contains("::")
        && !plugin_id.chars().any(char::is_control)
}

/// `(pluginId, key)` of `novel.plugin_setting::<pluginId>::<key>`.
pub fn parse_entity_id(entity_id: &str) -> Option<(&str, &str)> {
    let rest = entity_id.strip_prefix(ENTITY_PREFIX)?;
    let (plugin_id, key) = rest.split_once("::")?;
    (is_valid_plugin_id(plugin_id)
        && !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key.trim() == key
        && !key.contains("::")
        && !key.chars().any(char::is_control))
    .then_some((plugin_id, key))
}

/// Whether a plugin setting may travel at all: same key rules as extension source preferences.
pub fn is_syncable_setting(plugin_id: &str, key: &str) -> bool {
    is_valid_plugin_id(plugin_id) && !key.contains("::") && is_syncable_key(key)
}

/// Validates a full-state record written by a device.
pub fn validate_patch(entity_id: &str, patch: &Value) -> Result<ValidatedSetting, ValidationError> {
    let Some((plugin_id, key)) = parse_entity_id(entity_id) else {
        return Err(ValidationError::new(
            "INVALID_NOVEL_PLUGIN_SETTING_ID",
            "Novel plugin setting entityId must be 'novel.plugin_setting::<pluginId>::<key>'.",
        ));
    };
    let Some(object) = patch.as_object() else {
        return Err(ValidationError::new(
            "INVALID_NOVEL_PLUGIN_SETTING",
            "Novel plugin setting records must be JSON objects.",
        ));
    };
    if serde_json::to_vec(patch).map_or(usize::MAX, |bytes| bytes.len()) > MAX_RECORD_BYTES {
        return Err(ValidationError::new(
            "NOVEL_PLUGIN_SETTING_TOO_LARGE",
            format!("Novel plugin setting records are limited to {MAX_RECORD_BYTES} bytes."),
        ));
    }
    let text = |field: &str| object.get(field).and_then(Value::as_str);
    if text("settingId") != Some(entity_id)
        || text("pluginId") != Some(plugin_id)
        || text("key") != Some(key)
    {
        return Err(ValidationError::new(
            "NOVEL_PLUGIN_SETTING_ID_MISMATCH",
            "settingId, pluginId and key must match the entityId.",
        ));
    }
    if !is_syncable_key(key) {
        return Err(ValidationError::new(
            "NOVEL_PLUGIN_SETTING_NOT_SYNCABLE",
            "This plugin setting key is never synced (credential, session or cache).",
        ));
    }
    if let Some(updated_at) = object.get("updatedAtMs") {
        if !updated_at.as_i64().is_some_and(|value| value >= 0) {
            return Err(ValidationError::new(
                "INVALID_NOVEL_PLUGIN_SETTING",
                "updatedAtMs must be a non-negative integer.",
            ));
        }
    }
    let value_type = text("valueType").unwrap_or_default();
    let raw_value = object.get("value");
    let Some(value) = raw_value.and_then(|value| PreferenceValue::from_typed(value_type, value)) else {
        return Err(ValidationError::new(
            "INVALID_NOVEL_PLUGIN_SETTING_VALUE",
            "value must match valueType (boolean, string or string_set).",
        ));
    };
    if let (PreferenceValue::StringSet(values), Some(Value::Array(raw))) = (&value, raw_value) {
        if values.len() != raw.len() {
            return Err(ValidationError::new(
                "INVALID_NOVEL_PLUGIN_SETTING_VALUE",
                "string_set values must not repeat.",
            ));
        }
    }
    if !value.is_syncable() {
        return Err(ValidationError::new(
            "NOVEL_PLUGIN_SETTING_NOT_SYNCABLE",
            "This plugin setting value is too large or looks like a secret.",
        ));
    }
    Ok(ValidatedSetting {
        plugin_id: plugin_id.to_string(),
        key: key.to_string(),
        value,
    })
}

/// The full-state record for a value chosen on this device.
pub fn core_record(plugin_id: &str, key: &str, value: &PreferenceValue, updated_at_ms: i64) -> Value {
    json!({
        "settingId": entity_id_for(plugin_id, key),
        "pluginId": plugin_id,
        "key": key,
        "valueType": value.value_type(),
        "value": value.to_json(),
        "updatedAtMs": updated_at_ms,
    })
}

/// The value of a stored record, when it is still valid.
pub fn record_value(entity_id: &str, record: &Value) -> Option<PreferenceValue> {
    validate_patch(entity_id, record).ok().map(|valid| valid.value)
}

/// The typed value of a setting as stored in the desktop `plugin-settings.json` (a JSON boolean,
/// string or array of strings), when it may travel.
pub fn local_value(value: &Value) -> Option<PreferenceValue> {
    let typed = match value {
        Value::Bool(flag) => PreferenceValue::Boolean(*flag),
        Value::String(text) => PreferenceValue::String(text.clone()),
        Value::Array(entries) => PreferenceValue::StringSet(
            entries
                .iter()
                .map(|entry| entry.as_str().map(str::to_string))
                .collect::<Option<_>>()?,
        ),
        _ => return None,
    };
    typed.is_syncable().then_some(typed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn record(plugin: &str, key: &str, value_type: &str, value: Value) -> (String, Value) {
        let id = entity_id_for(plugin, key);
        let record = json!({
            "settingId": id, "pluginId": plugin, "key": key,
            "valueType": value_type, "value": value, "updatedAtMs": 1,
        });
        (id, record)
    }

    // Keys and options below are the ones WTR-LAB 1.2.3, BoxNovel 2.2.2 and Komga 1.0.2 declare.
    #[test]
    fn accepts_declared_choices_of_real_plugins() {
        let (id, value) = record("wtrlab", "preferredMode", "string", json!("web"));
        let valid = validate_patch(&id, &value).expect("valid");
        assert_eq!(valid.plugin_id, "wtrlab");
        assert_eq!(valid.value, PreferenceValue::String("web".into()));
        let (id, value) = record("boxnovel", "hideLocked", "boolean", json!(true));
        assert!(validate_patch(&id, &value).is_ok());
        let (id, value) = record("komga", "url", "string", json!("http://192.168.0.5:25600"));
        assert!(validate_patch(&id, &value).is_ok());
    }

    #[test]
    fn refuses_credentials_sessions_and_secret_values() {
        for key in ["password", "email", "sessionCookie", "signInUrl"] {
            let (id, value) = record("komga", key, "string", json!("x"));
            assert_eq!(
                validate_patch(&id, &value).unwrap_err().code,
                "NOVEL_PLUGIN_SETTING_NOT_SYNCABLE",
                "{key}"
            );
            assert!(!is_syncable_setting("komga", key));
        }
        let (id, value) = record("komga", "url", "string", json!("http://me:pw@host"));
        assert_eq!(validate_patch(&id, &value).unwrap_err().code, "NOVEL_PLUGIN_SETTING_NOT_SYNCABLE");
    }

    #[test]
    fn checks_identity_shape_and_types() {
        let (id, mut value) = record("wtrlab", "preferredMode", "string", json!("web"));
        value["pluginId"] = json!("other");
        assert_eq!(validate_patch(&id, &value).unwrap_err().code, "NOVEL_PLUGIN_SETTING_ID_MISMATCH");
        let (id, value) = record("wtrlab", "fallbackToWeb", "boolean", json!("true"));
        assert_eq!(validate_patch(&id, &value).unwrap_err().code, "INVALID_NOVEL_PLUGIN_SETTING_VALUE");
        let (id, value) = record("p", "groups", "string_set", json!(["a", "a"]));
        assert_eq!(validate_patch(&id, &value).unwrap_err().code, "INVALID_NOVEL_PLUGIN_SETTING_VALUE");
        assert!(parse_entity_id("novel.plugin_setting::a::b::c").is_none());
        assert!(parse_entity_id("comic.source_preference::1::k").is_none());
        assert!(!is_valid_plugin_id(" padded"));
    }

    #[test]
    fn reads_local_values_like_the_plugin_storage() {
        assert_eq!(local_value(&json!(false)), Some(PreferenceValue::Boolean(false)));
        assert_eq!(
            local_value(&json!(["b", "a"])),
            Some(PreferenceValue::StringSet(BTreeSet::from(["a".into(), "b".into()])))
        );
        assert_eq!(local_value(&json!(3)), None);
        assert_eq!(local_value(&json!("bearer abc")), None);
        let value = PreferenceValue::String("web".into());
        let record = core_record("wtrlab", "preferredMode", &value, 5);
        assert_eq!(record_value(&entity_id_for("wtrlab", "preferredMode"), &record), Some(value));
    }
}
