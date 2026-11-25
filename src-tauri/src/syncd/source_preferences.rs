//! Extension source preferences (`comic.source_preference`).
//!
//! One record per Tachiyomi/Suwayomi source and preference key, for example the preferred mirror
//! of a source, so a choice made on one device applies on the other:
//!
//! ```json
//! { "preferenceId": "comic.source_preference::2528986671771677900::preferred_mirror",
//!   "sourceId": "2528986671771677900", "key": "preferred_mirror",
//!   "valueType": "string", "value": "1", "updatedAtMs": 1763600000000 }
//! ```
//!
//! `valueType` is `boolean`, `string` or `string_set`. Records are full state and keep unknown
//! fields. Only simple user choices travel: keys that look like credentials, sessions or
//! extension caches are refused on every side, and so are values that look like secrets.
//!
//! Desktop side: a record written by a device is projected into Suwayomi with
//! `updateSourcePreference` (see `suwayomi_projection`), and a value changed in the desktop
//! Suwayomi is published back by `suwayomi_source_preference_mirror`.

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

pub const COMIC_SOURCE_PREFERENCE: &str = "comic.source_preference";
pub const UPDATE_SOURCE_PREFERENCE_OPERATION: &str = "UpdateSourcePreference";
const ENTITY_PREFIX: &str = "comic.source_preference::";

pub const MAX_KEY_BYTES: usize = 128;
pub const MAX_STRING_BYTES: usize = 4_096;
pub const MAX_SET_ENTRIES: usize = 64;
pub const MAX_SET_ENTRY_BYTES: usize = 512;
pub const MAX_RECORD_BYTES: usize = 16 * 1_024;

pub const VALUE_TYPE_BOOLEAN: &str = "boolean";
pub const VALUE_TYPE_STRING: &str = "string";
pub const VALUE_TYPE_STRING_SET: &str = "string_set";

/// Normalized key fragments of credentials and sessions. Matching is by substring, so some
/// harmless keys (an "author" filter) are also left out: never syncing a secret matters more.
const SECRET_KEY_FRAGMENTS: [&str; 17] = [
    "password",
    "passwd",
    "passcode",
    "token",
    "cookie",
    "apikey",
    "secret",
    "login",
    "signin",
    "session",
    "auth",
    "credential",
    "privatekey",
    "accesskey",
    "username",
    "email",
    "account",
];

/// Normalized key fragments of values an extension computes or caches for itself, or that only
/// mean something on one device.
const CACHE_KEY_FRAGMENTS: [&str; 13] = [
    "fetchedmirrors",
    "cache",
    "fetched",
    "lastupdate",
    "lastcheck",
    "lastfetch",
    "lastsync",
    "timestamp",
    "expir",
    "useragent",
    "uuid",
    "deviceid",
    "private",
];

/// Lowercase fragments of string values that carry a secret whatever their key is called.
const SECRET_VALUE_FRAGMENTS: [&str; 8] = [
    "token=",
    "apikey=",
    "api_key=",
    "password=",
    "passwd=",
    "access_token",
    "bearer ",
    "authorization:",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreferenceValue {
    Boolean(bool),
    String(String),
    StringSet(BTreeSet<String>),
}

impl PreferenceValue {
    pub fn value_type(&self) -> &'static str {
        match self {
            Self::Boolean(_) => VALUE_TYPE_BOOLEAN,
            Self::String(_) => VALUE_TYPE_STRING,
            Self::StringSet(_) => VALUE_TYPE_STRING_SET,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Boolean(value) => Value::Bool(*value),
            Self::String(value) => Value::String(value.clone()),
            Self::StringSet(values) => Value::Array(
                values.iter().cloned().map(Value::String).collect(),
            ),
        }
    }

    /// The value of a record (or of projection variables), when it has the declared type.
    pub fn from_typed(value_type: &str, value: &Value) -> Option<Self> {
        match (value_type, value) {
            (VALUE_TYPE_BOOLEAN, Value::Bool(value)) => Some(Self::Boolean(*value)),
            (VALUE_TYPE_STRING, Value::String(value)) => Some(Self::String(value.clone())),
            (VALUE_TYPE_STRING_SET, Value::Array(values)) => values
                .iter()
                .map(|value| value.as_str().map(str::to_string))
                .collect::<Option<BTreeSet<_>>>()
                .map(Self::StringSet),
            _ => None,
        }
    }

    /// A stable text for comparing values across devices (sets are sorted).
    pub fn fingerprint(&self) -> String {
        format!("{}:{}", self.value_type(), self.to_json())
    }

    /// Whether the value fits the size limits and does not look like a secret.
    pub fn is_syncable(&self) -> bool {
        match self {
            Self::Boolean(_) => true,
            Self::String(value) => value.len() <= MAX_STRING_BYTES && !value_looks_secret(value),
            Self::StringSet(values) => {
                values.len() <= MAX_SET_ENTRIES
                    && values.iter().all(|value| {
                        value.len() <= MAX_SET_ENTRY_BYTES && !value_looks_secret(value)
                    })
            }
        }
    }
}

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
pub struct ValidatedPreference {
    pub source_id: String,
    pub key: String,
    pub value: PreferenceValue,
}

pub fn entity_id_for(source_id: &str, key: &str) -> String {
    format!("{ENTITY_PREFIX}{source_id}::{key}")
}

/// `(sourceId, key)` of `comic.source_preference::<sourceId>::<key>`.
pub fn parse_entity_id(entity_id: &str) -> Option<(&str, &str)> {
    let rest = entity_id.strip_prefix(ENTITY_PREFIX)?;
    let (source_id, key) = rest.split_once("::")?;
    (is_valid_source_id(source_id) && is_valid_key(key)).then_some((source_id, key))
}

/// A Tachiyomi source id: a signed 64-bit integer in decimal.
pub fn is_valid_source_id(source_id: &str) -> bool {
    let digits = source_id.strip_prefix('-').unwrap_or(source_id);
    !digits.is_empty()
        && digits.len() <= 19
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && source_id.parse::<i64>().is_ok()
}

fn is_valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key.trim() == key
        && !key.chars().any(char::is_control)
}

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|character| !matches!(character, '_' | '-' | '.' | ' '))
        .flat_map(char::to_lowercase)
        .collect()
}

/// Whether a preference key may be synced: a well-formed key that names neither a credential,
/// a session nor something the extension caches for itself.
pub fn is_syncable_key(key: &str) -> bool {
    if !is_valid_key(key) || key.starts_with("__") {
        return false;
    }
    let normalized = normalized_key(key);
    !SECRET_KEY_FRAGMENTS
        .iter()
        .chain(CACHE_KEY_FRAGMENTS.iter())
        .any(|fragment| normalized.contains(fragment))
}

/// Whether a string value carries a secret: URL credentials (`scheme://user:pass@host`) or an
/// inline token, key or password.
pub fn value_looks_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if SECRET_VALUE_FRAGMENTS
        .iter()
        .any(|fragment| lower.contains(fragment))
    {
        return true;
    }
    lower.split("://").skip(1).any(|after_scheme| {
        let authority = after_scheme
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default();
        authority.contains('@')
    })
}

/// Validates a full-state record written by a device.
pub fn validate_patch(entity_id: &str, patch: &Value) -> Result<ValidatedPreference, ValidationError> {
    let Some((source_id, key)) = parse_entity_id(entity_id) else {
        return Err(ValidationError::new(
            "INVALID_SOURCE_PREFERENCE_ID",
            "Source preference entityId must be 'comic.source_preference::<sourceId>::<key>'.",
        ));
    };
    let Some(object) = patch.as_object() else {
        return Err(ValidationError::new(
            "INVALID_SOURCE_PREFERENCE",
            "Source preference records must be JSON objects.",
        ));
    };
    if serde_json::to_vec(patch).map_or(usize::MAX, |bytes| bytes.len()) > MAX_RECORD_BYTES {
        return Err(ValidationError::new(
            "SOURCE_PREFERENCE_TOO_LARGE",
            format!("Source preference records are limited to {MAX_RECORD_BYTES} bytes."),
        ));
    }
    let text = |field: &str| object.get(field).and_then(Value::as_str);
    if text("preferenceId") != Some(entity_id) {
        return Err(ValidationError::new(
            "SOURCE_PREFERENCE_ID_MISMATCH",
            "preferenceId must equal the entityId.",
        ));
    }
    if text("sourceId") != Some(source_id) || text("key") != Some(key) {
        return Err(ValidationError::new(
            "SOURCE_PREFERENCE_ID_MISMATCH",
            "sourceId and key must match the entityId.",
        ));
    }
    if !is_syncable_key(key) {
        return Err(ValidationError::new(
            "SOURCE_PREFERENCE_NOT_SYNCABLE",
            "This source preference key is never synced (credential, session or cache).",
        ));
    }
    if let Some(updated_at) = object.get("updatedAtMs") {
        if !updated_at.as_i64().is_some_and(|value| value >= 0) {
            return Err(ValidationError::new(
                "INVALID_SOURCE_PREFERENCE",
                "updatedAtMs must be a non-negative integer.",
            ));
        }
    }
    let value_type = text("valueType").unwrap_or_default();
    let Some(value) = object
        .get("value")
        .and_then(|value| PreferenceValue::from_typed(value_type, value))
    else {
        return Err(ValidationError::new(
            "INVALID_SOURCE_PREFERENCE_VALUE",
            "value must match valueType (boolean, string or string_set).",
        ));
    };
    if let (PreferenceValue::StringSet(values), Some(Value::Array(raw))) = (&value, object.get("value")) {
        if values.len() != raw.len() {
            return Err(ValidationError::new(
                "INVALID_SOURCE_PREFERENCE_VALUE",
                "string_set values must not repeat.",
            ));
        }
    }
    if !value.is_syncable() {
        return Err(ValidationError::new(
            "SOURCE_PREFERENCE_NOT_SYNCABLE",
            "This source preference value is too large or looks like a secret.",
        ));
    }
    Ok(ValidatedPreference {
        source_id: source_id.to_string(),
        key: key.to_string(),
        value,
    })
}

/// The full-state record for a value read on this device.
pub fn core_record(source_id: &str, key: &str, value: &PreferenceValue, updated_at_ms: i64) -> Value {
    json!({
        "preferenceId": entity_id_for(source_id, key),
        "sourceId": source_id,
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

/// The variables of an `UpdateSourcePreference` projection row.
pub fn projection_variables(record: &Value) -> Option<Value> {
    let source_id = record.get("sourceId")?.as_str()?;
    let key = record.get("key")?.as_str()?;
    let entity_id = entity_id_for(source_id, key);
    let valid = validate_patch(&entity_id, record).ok()?;
    Some(json!({
        "sourceId": valid.source_id,
        "key": valid.key,
        "valueType": valid.value.value_type(),
        "value": valid.value.to_json(),
    }))
}

/// `(sourceId, key, value)` of projection variables.
pub fn parse_projection_variables(variables: &Value) -> Option<(String, String, PreferenceValue)> {
    let source_id = variables.get("sourceId")?.as_str()?;
    let key = variables.get("key")?.as_str()?;
    if !is_valid_source_id(source_id) || !is_syncable_key(key) {
        return None;
    }
    let value = PreferenceValue::from_typed(
        variables.get("valueType")?.as_str()?,
        variables.get("value")?,
    )?;
    value
        .is_syncable()
        .then(|| (source_id.to_string(), key.to_string(), value))
}

// ---------------------------------------------------------------------------------------------
// Suwayomi GraphQL
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreferenceKind {
    CheckBox,
    Switch,
    List,
    EditText,
    MultiSelect,
}

impl PreferenceKind {
    fn from_typename(typename: &str) -> Option<Self> {
        match typename {
            "CheckBoxPreference" => Some(Self::CheckBox),
            "SwitchPreference" => Some(Self::Switch),
            "ListPreference" => Some(Self::List),
            "EditTextPreference" => Some(Self::EditText),
            "MultiSelectListPreference" => Some(Self::MultiSelect),
            _ => None,
        }
    }

    fn field_prefix(self) -> &'static str {
        match self {
            Self::CheckBox => "checkBox",
            Self::Switch => "switch",
            Self::List => "list",
            Self::EditText => "editText",
            Self::MultiSelect => "multiSelect",
        }
    }

    fn value_type(self) -> &'static str {
        match self {
            Self::CheckBox | Self::Switch => VALUE_TYPE_BOOLEAN,
            Self::List | Self::EditText => VALUE_TYPE_STRING,
            Self::MultiSelect => VALUE_TYPE_STRING_SET,
        }
    }

    /// The field of `SourcePreferenceChangeInput` that sets this kind.
    fn state_field(self) -> &'static str {
        match self {
            Self::CheckBox => "checkBoxState",
            Self::Switch => "switchState",
            Self::List => "listState",
            Self::EditText => "editTextState",
            Self::MultiSelect => "multiSelectState",
        }
    }
}

/// One preference a source offers on its settings screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfferedPreference {
    /// Index in the source's preference list, which `updateSourcePreference` addresses.
    pub position: usize,
    pub kind: PreferenceKind,
    pub key: String,
    pub enabled: bool,
    pub entry_values: Option<Vec<String>>,
    /// The current value, or the default when the source has none stored.
    pub current: Option<PreferenceValue>,
    /// The extension's default value.
    pub default: Option<PreferenceValue>,
}

impl OfferedPreference {
    /// Whether `value` is something this preference can hold.
    pub fn accepts(&self, value: &PreferenceValue) -> bool {
        if value.value_type() != self.kind.value_type() {
            return false;
        }
        match (value, &self.entry_values) {
            (PreferenceValue::String(text), Some(entries)) if self.kind == PreferenceKind::List => {
                entries.iter().any(|entry| entry == text)
            }
            (PreferenceValue::StringSet(values), Some(entries)) => {
                values.iter().all(|value| entries.iter().any(|entry| entry == value))
            }
            (_, None) if self.kind == PreferenceKind::List || self.kind == PreferenceKind::MultiSelect => {
                false
            }
            _ => true,
        }
    }
}

/// The preferences of a `source { preferences }` (or `updateSourcePreference`) answer.
pub fn parse_offered_preferences(preferences: Option<&Value>) -> Vec<OfferedPreference> {
    let Some(items) = preferences.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .enumerate()
        .filter_map(|(position, item)| {
            let kind = PreferenceKind::from_typename(item.get("__typename")?.as_str()?)?;
            let key = item.get("key")?.as_str()?.to_string();
            let prefix = kind.field_prefix();
            let typed = |field: String| {
                item.get(&field)
                    .filter(|value| !value.is_null())
                    .and_then(|value| PreferenceValue::from_typed(kind.value_type(), value))
            };
            let default = typed(format!("{prefix}Default"));
            let current = typed(format!("{prefix}Current")).or_else(|| default.clone());
            let entry_values = item.get("entryValues").and_then(Value::as_array).map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            });
            Some(OfferedPreference {
                position,
                kind,
                key,
                enabled: item.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                entry_values,
                current,
                default,
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChangePlan {
    /// The source already holds the value.
    AlreadySet,
    /// The `change` of `UpdateSourcePreferenceInput`.
    Change(Value),
    /// The source does not offer the key, offers it with another type or disabled, or does not
    /// offer the value (for example a mirror an older extension does not know).
    NotOffered,
}

pub fn plan_change(offered: &[OfferedPreference], key: &str, target: &PreferenceValue) -> ChangePlan {
    let Some(preference) = offered.iter().find(|preference| preference.key == key) else {
        return ChangePlan::NotOffered;
    };
    if !preference.accepts(target) {
        return ChangePlan::NotOffered;
    }
    if preference.current.as_ref() == Some(target) {
        return ChangePlan::AlreadySet;
    }
    if !preference.enabled {
        return ChangePlan::NotOffered;
    }
    let mut change = Map::new();
    change.insert("position".to_string(), json!(preference.position));
    change.insert(preference.kind.state_field().to_string(), target.to_json());
    ChangePlan::Change(Value::Object(change))
}

/// Whether an answer shows the preference holding `target`.
pub fn confirms(offered: &[OfferedPreference], key: &str, target: &PreferenceValue) -> bool {
    offered
        .iter()
        .find(|preference| preference.key == key)
        .is_some_and(|preference| preference.current.as_ref() == Some(target))
}

/// One value the desktop stores for a source preference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopValue {
    pub key: String,
    pub value: PreferenceValue,
    /// The value is the extension's default, which an extension may store on its own.
    pub is_default: bool,
}

/// The syncable values the desktop has for a source: preferences the source offers whose key is
/// stored explicitly in its settings file (`explicit_keys`), so untouched defaults never travel.
pub fn desktop_values(
    offered: &[OfferedPreference],
    explicit_keys: &BTreeSet<String>,
) -> Vec<DesktopValue> {
    offered
        .iter()
        .filter(|preference| explicit_keys.contains(&preference.key))
        .filter(|preference| is_syncable_key(&preference.key))
        .filter_map(|preference| {
            let value = preference.current.clone()?;
            (value.is_syncable() && preference.accepts(&value)).then(|| DesktopValue {
                key: preference.key.clone(),
                is_default: preference.default.as_ref() == Some(&value),
                value,
            })
        })
        .collect()
}

/// The source id of a Suwayomi `settings/source_<id>.xml` file name.
pub fn source_id_from_settings_file(file_name: &str) -> Option<&str> {
    let source_id = file_name.strip_prefix("source_")?.strip_suffix(".xml")?;
    is_valid_source_id(source_id).then_some(source_id)
}

// ---------------------------------------------------------------------------------------------
// Desktop -> Core mirror decision
// ---------------------------------------------------------------------------------------------

/// What the mirror last agreed on for one preference: the desktop value and the Core version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorAgreement {
    pub fingerprint: Option<String>,
    pub core_server_version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorDecision {
    /// Nothing changed.
    Nothing,
    /// Remember the desktop value without publishing it: a value the desktop already had when
    /// sync first looked at the profile is not a new choice, and publishing it would override the
    /// value the phone uploads.
    Baseline,
    /// Both sides hold what they hold now; record it as the agreement.
    Agree,
    /// The Core value has not reached Suwayomi yet; look again later.
    Wait,
    /// The desktop value changed since the agreement: publish it.
    Emit,
}

/// What the mirror sees for one preference.
#[derive(Debug, Clone, Copy, Default)]
pub struct MirrorObservation<'a> {
    /// Fingerprint of the value the desktop stores explicitly, if any.
    pub desktop: Option<&'a str>,
    /// The desktop value is the extension's default.
    pub desktop_is_default: bool,
    pub agreement: Option<&'a MirrorAgreement>,
    /// Fingerprint of the live Core record, if any.
    pub core: Option<&'a str>,
    /// Core version of the record or its tombstone (0 when it never existed).
    pub core_version: i64,
    /// A projection of this preference is still queued for this Suwayomi.
    pub projection_pending: bool,
    /// The mirror already took its first look at this profile.
    pub profile_baselined: bool,
}

/// Decides one preference.
pub fn decide(observation: MirrorObservation<'_>) -> MirrorDecision {
    let MirrorObservation {
        desktop,
        desktop_is_default,
        agreement,
        core,
        core_version,
        projection_pending,
        profile_baselined,
    } = observation;
    let Some(desktop) = desktop else {
        // A value the desktop no longer stores is left alone: preferences are never deleted.
        return MirrorDecision::Nothing;
    };
    let Some(agreement) = agreement else {
        // First sight of this preference.
        if core == Some(desktop) {
            return MirrorDecision::Agree;
        }
        if !profile_baselined {
            return MirrorDecision::Baseline;
        }
        if projection_pending {
            return MirrorDecision::Wait;
        }
        // A key the desktop started storing after the first look is a choice made here, unless
        // it is the extension's default while a device chose something else: extensions may
        // store a default on their own, and that must not override the other device's choice.
        return if core.is_some() && desktop_is_default {
            MirrorDecision::Baseline
        } else {
            MirrorDecision::Emit
        };
    };
    let core_changed = core_version != agreement.core_server_version;
    let desktop_changed = agreement.fingerprint.as_deref() != Some(desktop);
    if core == Some(desktop) {
        return if core_changed || desktop_changed {
            MirrorDecision::Agree
        } else {
            MirrorDecision::Nothing
        };
    }
    if core_changed {
        // A device wrote the preference since the agreement: the Core wins. Once its projection
        // is settled (applied, or blocked because this extension cannot take the value) the
        // desktop value stands as the new agreement.
        return if projection_pending {
            MirrorDecision::Wait
        } else {
            MirrorDecision::Agree
        };
    }
    if desktop_changed {
        MirrorDecision::Emit
    } else {
        MirrorDecision::Nothing
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "2528986671771677900";

    fn record(key: &str, value_type: &str, value: Value) -> Value {
        json!({
            "preferenceId": entity_id_for(SOURCE, key),
            "sourceId": SOURCE,
            "key": key,
            "valueType": value_type,
            "value": value,
            "updatedAtMs": 1_763_600_000_000_i64,
        })
    }

    #[test]
    fn entity_ids_round_trip_and_reject_bad_shapes() {
        let id = entity_id_for(SOURCE, "preferred_mirror");
        assert_eq!(id, "comic.source_preference::2528986671771677900::preferred_mirror");
        assert_eq!(parse_entity_id(&id), Some((SOURCE, "preferred_mirror")));
        assert_eq!(
            parse_entity_id("comic.source_preference::-42::a::b"),
            Some(("-42", "a::b"))
        );
        assert!(parse_entity_id("comic.source_preference::abc::key").is_none());
        assert!(parse_entity_id("comic.source_preference::12::").is_none());
        assert!(parse_entity_id("comic.source_preference::99999999999999999999::k").is_none());
        assert!(parse_entity_id("comic.tracking::12::key").is_none());
    }

    #[test]
    fn credential_session_and_cache_keys_are_never_synced() {
        for key in [
            "preferred_mirror",
            "pref_quality",
            "blockedGroups_en",
            "dataSaver",
            "lang_filter",
        ] {
            assert!(is_syncable_key(key), "{key} should sync");
        }
        for key in [
            "password",
            "user_password",
            "api-key",
            "apiKey",
            "access_token",
            "Cookie",
            "session_id",
            "login_email",
            "auth",
            "fetchedMirrors",
            "fetchedMirrorsFrom",
            "mirror_cache",
            "last_update_check",
            "hasSanitizedUuids_en",
            "__PRIVATE_x",
            "user.agent",
            "",
        ] {
            assert!(!is_syncable_key(key), "{key} must not sync");
        }
    }

    #[test]
    fn secret_looking_values_are_refused() {
        assert!(value_looks_secret("https://user:pass@example.com/path"));
        assert!(value_looks_secret("https://example.com/?token=abc"));
        assert!(value_looks_secret("Bearer abc"));
        assert!(!value_looks_secret("https://mangakakalove.com"));
        assert!(!value_looks_secret("https://example.com/@user"));
        assert!(!value_looks_secret("1"));
    }

    #[test]
    fn valid_records_pass_and_keep_their_value() {
        let valid = validate_patch(
            &entity_id_for(SOURCE, "preferred_mirror"),
            &record("preferred_mirror", "string", json!("1")),
        )
        .unwrap();
        assert_eq!(valid.source_id, SOURCE);
        assert_eq!(valid.value, PreferenceValue::String("1".to_string()));

        let mut extra = record("blocked", "string_set", json!(["b", "a"]));
        extra["futureField"] = json!(true);
        let valid = validate_patch(&entity_id_for(SOURCE, "blocked"), &extra).unwrap();
        assert_eq!(
            valid.value,
            PreferenceValue::StringSet(BTreeSet::from(["a".to_string(), "b".to_string()]))
        );
        assert_eq!(valid.value.fingerprint(), "string_set:[\"a\",\"b\"]");
    }

    #[test]
    fn invalid_records_are_rejected_with_a_code() {
        let id = entity_id_for(SOURCE, "preferred_mirror");
        let code = |patch: Value| validate_patch(&id, &patch).unwrap_err().code;
        assert_eq!(
            code(record("preferred_mirror", "boolean", json!("1"))),
            "INVALID_SOURCE_PREFERENCE_VALUE"
        );
        assert_eq!(
            code(record("preferred_mirror", "integer", json!(1))),
            "INVALID_SOURCE_PREFERENCE_VALUE"
        );
        assert_eq!(
            code(record("other_key", "string", json!("1"))),
            "SOURCE_PREFERENCE_ID_MISMATCH"
        );
        assert_eq!(
            code(record("preferred_mirror", "string", json!("x".repeat(MAX_STRING_BYTES + 1)))),
            "SOURCE_PREFERENCE_NOT_SYNCABLE"
        );
        assert_eq!(
            code(record("preferred_mirror", "string_set", json!(["a", "a"]))),
            "INVALID_SOURCE_PREFERENCE_VALUE"
        );
        assert_eq!(code(json!([])), "INVALID_SOURCE_PREFERENCE");
        let token_id = entity_id_for(SOURCE, "token");
        let mut token = record("token", "string", json!("abc"));
        token["preferenceId"] = json!(token_id);
        assert_eq!(
            validate_patch(&token_id, &token).unwrap_err().code,
            "SOURCE_PREFERENCE_NOT_SYNCABLE"
        );
        assert_eq!(
            validate_patch("comic.source_preference::x::k", &json!({}))
                .unwrap_err()
                .code,
            "INVALID_SOURCE_PREFERENCE_ID"
        );
    }

    #[test]
    fn projection_variables_round_trip() {
        let variables =
            projection_variables(&record("preferred_mirror", "string", json!("1"))).unwrap();
        assert_eq!(
            variables,
            json!({ "sourceId": SOURCE, "key": "preferred_mirror", "valueType": "string", "value": "1" })
        );
        assert_eq!(
            parse_projection_variables(&variables),
            Some((
                SOURCE.to_string(),
                "preferred_mirror".to_string(),
                PreferenceValue::String("1".to_string())
            ))
        );
        assert!(projection_variables(&json!({ "sourceId": SOURCE })).is_none());
    }

    fn mirror_preferences() -> Value {
        json!([
            { "__typename": "ListPreference", "key": "preferred_mirror", "enabled": true,
              "entryValues": ["0", "1", "2"], "listDefault": "0", "listCurrent": null },
            { "__typename": "SwitchPreference", "key": "data_saver", "enabled": true,
              "switchDefault": false, "switchCurrent": true },
            { "__typename": "MultiSelectListPreference", "key": "langs", "enabled": false,
              "entryValues": ["en", "pt"], "multiSelectDefault": [], "multiSelectCurrent": ["en"] },
            { "__typename": "EditTextPreference", "key": "custom_domain", "enabled": true,
              "editTextDefault": "", "editTextCurrent": "https://example.org" },
            { "__typename": "UnknownPreference", "key": "x" }
        ])
    }

    #[test]
    fn graphql_preferences_parse_with_positions_and_defaults() {
        let offered = parse_offered_preferences(Some(&mirror_preferences()));
        assert_eq!(offered.len(), 4);
        assert_eq!(offered[0].position, 0);
        assert_eq!(offered[0].current, Some(PreferenceValue::String("0".to_string())));
        assert_eq!(offered[0].default, Some(PreferenceValue::String("0".to_string())));
        assert_eq!(offered[1].default, Some(PreferenceValue::Boolean(false)));
        assert_eq!(offered[1].current, Some(PreferenceValue::Boolean(true)));
        assert_eq!(offered[3].position, 3);
        assert!(!offered[2].enabled);
        assert!(parse_offered_preferences(None).is_empty());
    }

    #[test]
    fn change_plans_follow_the_offered_preference() {
        let offered = parse_offered_preferences(Some(&mirror_preferences()));
        let mirror = |value: &str| PreferenceValue::String(value.to_string());
        assert_eq!(
            plan_change(&offered, "preferred_mirror", &mirror("1")),
            ChangePlan::Change(json!({ "position": 0, "listState": "1" }))
        );
        assert_eq!(
            plan_change(&offered, "preferred_mirror", &mirror("0")),
            ChangePlan::AlreadySet
        );
        assert_eq!(
            plan_change(&offered, "preferred_mirror", &mirror("9")),
            ChangePlan::NotOffered
        );
        assert_eq!(
            plan_change(&offered, "preferred_mirror", &PreferenceValue::Boolean(true)),
            ChangePlan::NotOffered
        );
        assert_eq!(
            plan_change(&offered, "missing", &mirror("1")),
            ChangePlan::NotOffered
        );
        assert_eq!(
            plan_change(&offered, "data_saver", &PreferenceValue::Boolean(false)),
            ChangePlan::Change(json!({ "position": 1, "switchState": false }))
        );
        let pt = PreferenceValue::StringSet(BTreeSet::from(["pt".to_string()]));
        assert_eq!(plan_change(&offered, "langs", &pt), ChangePlan::NotOffered);
        assert!(confirms(&offered, "data_saver", &PreferenceValue::Boolean(true)));
        assert!(!confirms(&offered, "data_saver", &PreferenceValue::Boolean(false)));
    }

    #[test]
    fn desktop_values_only_take_explicit_syncable_keys() {
        let offered = parse_offered_preferences(Some(&mirror_preferences()));
        let explicit = BTreeSet::from([
            "data_saver".to_string(),
            "custom_domain".to_string(),
            "fetchedMirrors".to_string(),
        ]);
        let values = desktop_values(&offered, &explicit);
        assert_eq!(
            values,
            vec![
                DesktopValue {
                    key: "data_saver".to_string(),
                    value: PreferenceValue::Boolean(true),
                    is_default: false,
                },
                DesktopValue {
                    key: "custom_domain".to_string(),
                    value: PreferenceValue::String("https://example.org".to_string()),
                    is_default: false,
                },
            ]
        );
        let explicit_default = BTreeSet::from(["preferred_mirror".to_string()]);
        assert!(desktop_values(&offered, &explicit_default)[0].is_default);
        assert_eq!(source_id_from_settings_file("source_-12.xml"), Some("-12"));
        assert_eq!(source_id_from_settings_file("source_ab.xml"), None);
        assert_eq!(source_id_from_settings_file("tracker.xml"), None);
    }

    #[test]
    fn mirror_decisions() {
        let agreed = |fingerprint: &str, version: i64| MirrorAgreement {
            fingerprint: Some(fingerprint.to_string()),
            core_server_version: version,
        };
        let see = |desktop: Option<&'static str>,
                   agreement: Option<MirrorAgreement>,
                   core: Option<&'static str>,
                   core_version: i64,
                   projection_pending: bool| {
            decide(MirrorObservation {
                desktop,
                agreement: agreement.as_ref(),
                core,
                core_version,
                projection_pending,
                profile_baselined: true,
                ..MirrorObservation::default()
            })
        };
        // First look at the profile: remember, do not publish.
        assert_eq!(
            decide(MirrorObservation {
                desktop: Some("a"),
                core: Some("b"),
                core_version: 5,
                ..MirrorObservation::default()
            }),
            MirrorDecision::Baseline
        );
        // A key first stored after the first look is a desktop choice.
        assert_eq!(see(Some("a"), None, Some("b"), 5, false), MirrorDecision::Emit);
        assert_eq!(see(Some("a"), None, None, 0, false), MirrorDecision::Emit);
        assert_eq!(see(Some("a"), None, Some("a"), 5, false), MirrorDecision::Agree);
        assert_eq!(see(Some("a"), None, Some("b"), 5, true), MirrorDecision::Wait);
        // ...unless it is the extension default while a device chose something else.
        let default_written = MirrorObservation {
            desktop: Some("d"),
            desktop_is_default: true,
            core: Some("b"),
            core_version: 5,
            profile_baselined: true,
            ..MirrorObservation::default()
        };
        assert_eq!(decide(default_written), MirrorDecision::Baseline);
        assert_eq!(
            decide(MirrorObservation { core: None, core_version: 0, ..default_written }),
            MirrorDecision::Emit
        );
        // The desktop no longer stores a value: nothing.
        assert_eq!(see(None, Some(agreed("a", 5)), Some("a"), 5, false), MirrorDecision::Nothing);
        assert_eq!(see(None, None, Some("a"), 5, false), MirrorDecision::Nothing);
        // In agreement.
        assert_eq!(see(Some("a"), Some(agreed("a", 5)), Some("a"), 5, false), MirrorDecision::Nothing);
        // Desktop edit.
        assert_eq!(see(Some("b"), Some(agreed("a", 5)), Some("a"), 5, false), MirrorDecision::Emit);
        assert_eq!(see(Some("b"), Some(agreed("a", 0)), None, 0, false), MirrorDecision::Emit);
        // Phone edit not projected yet: wait, never echo the old desktop value.
        assert_eq!(see(Some("a"), Some(agreed("a", 5)), Some("c"), 9, true), MirrorDecision::Wait);
        // Phone edit landed.
        assert_eq!(see(Some("c"), Some(agreed("a", 5)), Some("c"), 9, false), MirrorDecision::Agree);
        // Both changed: the Core wins; once its projection settles the agreement moves on.
        assert_eq!(see(Some("b"), Some(agreed("a", 5)), Some("c"), 9, true), MirrorDecision::Wait);
        assert_eq!(see(Some("b"), Some(agreed("a", 5)), Some("c"), 9, false), MirrorDecision::Agree);
        // Desktop changed to what the Core already holds.
        assert_eq!(see(Some("c"), Some(agreed("a", 9)), Some("c"), 9, false), MirrorDecision::Agree);
    }
}
