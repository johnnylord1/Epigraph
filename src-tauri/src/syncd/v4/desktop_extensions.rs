//! Sync V4 mappers for the desktop's LNReader novel repositories, installed plugins and plugin
//! settings. The keys and payloads match what the Android app exports in
//! `V4ExtensionInventoryBridge` and `V4ExtensionPreferences`.
//!
//! Records other devices send are applied in two places. Repositories and plugins become the
//! declarations that `syncd_replication` hands to the webview, which installs them from the
//! repository the way it does after a restore. Plugin settings are written here.
//!
//! Novel source classification stays local. It is desktop QA metadata, and phones reject a
//! `novels` record type they do not know, which would stop their whole novels sync.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::db::{V4IncomingItem, V4WireRecord};
use super::hlc::Hlc;
use crate::syncd::models::canonicalize_public_novel_repository_url;
use crate::syncd::novel_plugin_settings;
use crate::syncd::source_preferences::PreferenceValue;

pub const DOMAIN_EXTENSIONS: &str = "extensions";
pub const DOMAIN_PREFERENCES: &str = "preferences";
pub const ENTITY_EXTENSION_REPO: &str = "extension.repo";
pub const ENTITY_EXTENSION_INSTALLED: &str = "extension.installed";
pub const ENTITY_EXTENSION_PREF: &str = "extension.pref";

/// `normalizeNovelRepositoryUrl` on the desktop and `trim().trimEnd('/')` on the phone.
pub fn normalize_repo_url(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

/// Private and local repositories stay on this device, as they did under the legacy sync.
fn public_repo_url(raw: &str) -> Option<String> {
    let base = normalize_repo_url(raw);
    (!base.is_empty() && canonicalize_public_novel_repository_url(&base).is_some()).then_some(base)
}

fn repo_url(repo: &Value) -> Option<&str> {
    repo.get("normalizedUrl")
        .or_else(|| repo.get("url"))
        .and_then(Value::as_str)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn stamp(items: BTreeMap<(String, String), (String, Value)>, device_id: &str, base_ts_ms: i64) -> Vec<V4IncomingItem> {
    items
        .into_iter()
        .enumerate()
        .map(|(counter, ((entity_type, entity_key), (domain, payload)))| V4IncomingItem {
            domain,
            entity_type,
            entity_key,
            hlc: Hlc::new(base_ts_ms.max(1), counter as i64, device_id),
            deleted: false,
            payload,
            client_mutation_id: None,
        })
        .collect()
}

/// `extension.repo` and `extension.installed` items for the novel repository state document.
/// Output is sorted by key, so an unchanged document exports the same items.
pub fn export_desktop_novel_extensions_to_v4(
    doc: &Value,
    device_id: &str,
    base_ts_ms: i64,
) -> Vec<V4IncomingItem> {
    let empty = Vec::new();
    let repos = doc
        .get("repositories")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut items = BTreeMap::new();
    let mut repo_urls = BTreeMap::new();
    for repo in repos {
        let Some(base_url) = repo_url(repo).and_then(public_repo_url) else {
            continue;
        };
        if let Some(id) = text(repo, "id") {
            repo_urls.insert(id.to_string(), base_url.clone());
        }
        let mut payload = json!({ "kind": "novel", "baseUrl": base_url, "name": base_url });
        if let Some(enabled) = repo.get("enabled").and_then(Value::as_bool) {
            payload["enabled"] = Value::Bool(enabled);
        }
        items.insert(
            (ENTITY_EXTENSION_REPO.to_string(), format!("novel:{base_url}")),
            (DOMAIN_EXTENSIONS.to_string(), payload),
        );
    }

    let catalog = doc
        .get("catalogEntries")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    for plugin in doc
        .get("installedPlugins")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
    {
        let Some(plugin_id) = text(plugin, "pluginId") else {
            continue;
        };
        let repository_id = text(plugin, "repositoryId").unwrap_or("");
        let entry = catalog.iter().find(|entry| {
            text(entry, "pluginId") == Some(plugin_id)
                && text(entry, "repositoryId").unwrap_or("") == repository_id
        });
        let mut payload = Map::new();
        payload.insert("kind".into(), json!("novel"));
        payload.insert("packageId".into(), json!(plugin_id));
        payload.insert(
            "name".into(),
            json!(entry.and_then(|entry| text(entry, "name")).unwrap_or(plugin_id)),
        );
        payload.insert("versionName".into(), json!(text(plugin, "version").unwrap_or("")));
        payload.insert(
            "lang".into(),
            json!(entry.and_then(|entry| text(entry, "lang")).unwrap_or("")),
        );
        if let Some(url) = repo_urls.get(repository_id) {
            payload.insert("repoUrl".into(), json!(url));
        }
        if let Some(enabled) = plugin.get("enabled").and_then(Value::as_bool) {
            payload.insert("enabled".into(), Value::Bool(enabled));
        }
        items.insert(
            (ENTITY_EXTENSION_INSTALLED.to_string(), format!("novel:{plugin_id}")),
            (DOMAIN_EXTENSIONS.to_string(), Value::Object(payload)),
        );
    }
    stamp(items, device_id, base_ts_ms)
}

/// `extension.pref` items for the novel plugin settings document. Secrets and credentials are
/// filtered by `novel_plugin_settings::is_syncable_setting` and never leave the device.
pub fn export_desktop_novel_plugin_settings_to_v4(
    doc: &Value,
    device_id: &str,
    base_ts_ms: i64,
) -> Vec<V4IncomingItem> {
    let mut items = BTreeMap::new();
    let Some(plugins) = doc.get("plugins").and_then(Value::as_object) else {
        return Vec::new();
    };
    for (plugin_id, entries) in plugins {
        let Some(entries) = entries.as_object() else {
            continue;
        };
        for (key, raw_value) in entries {
            if !novel_plugin_settings::is_syncable_setting(plugin_id, key) {
                continue;
            }
            let Some(value) = novel_plugin_settings::local_value(raw_value) else {
                continue;
            };
            items.insert(
                (ENTITY_EXTENSION_PREF.to_string(), format!("novel:{plugin_id}:{key}")),
                (
                    DOMAIN_PREFERENCES.to_string(),
                    json!({ "valueType": value.value_type(), "value": value.to_json() }),
                ),
            );
        }
    }
    stamp(items, device_id, base_ts_ms)
}

/// Applies `extension.pref` records of kind `novel` to the novel plugin settings document.
/// Returns whether the document changed. Settings that may hold secrets are never written.
pub fn apply_v4_records_to_desktop_novel_plugin_settings(
    doc: &mut Value,
    records: &[V4WireRecord],
) -> bool {
    if !doc.is_object() {
        *doc = json!({ "version": 1, "plugins": {} });
    }
    let root = doc.as_object_mut().expect("object");
    root.entry("version").or_insert(json!(1));
    let plugins = root
        .entry("plugins")
        .or_insert_with(|| Value::Object(Map::new()));
    if !plugins.is_object() {
        *plugins = Value::Object(Map::new());
    }
    let plugins = plugins.as_object_mut().expect("plugins object");
    let mut changed = false;
    for record in records {
        if record.domain != DOMAIN_PREFERENCES || record.entity_type != ENTITY_EXTENSION_PREF {
            continue;
        }
        let mut parts = record.entity_key.splitn(3, ':');
        let (Some("novel"), Some(plugin_id), Some(key)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if !novel_plugin_settings::is_syncable_setting(plugin_id, key) {
            continue;
        }
        if record.deleted {
            if let Some(settings) = plugins.get_mut(plugin_id).and_then(Value::as_object_mut) {
                changed |= settings.remove(key).is_some();
            }
            continue;
        }
        let Some(value) = record
            .payload
            .get("valueType")
            .and_then(Value::as_str)
            .zip(record.payload.get("value"))
            .and_then(|(value_type, value)| PreferenceValue::from_typed(value_type, value))
        else {
            continue;
        };
        let settings = plugins
            .entry(plugin_id.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !settings.is_object() {
            *settings = Value::Object(Map::new());
        }
        let value = value.to_json();
        let settings = settings.as_object_mut().expect("settings object");
        if settings.get(key) != Some(&value) {
            settings.insert(key.to_string(), value);
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(items: Vec<V4IncomingItem>) -> Vec<V4WireRecord> {
        items
            .into_iter()
            .enumerate()
            .map(|(index, item)| V4WireRecord {
                server_seq: index as i64 + 1,
                domain: item.domain,
                entity_type: item.entity_type,
                entity_key: item.entity_key,
                hlc: item.hlc,
                deleted: item.deleted,
                payload: item.payload,
                origin_device_id: "desktop-a".to_string(),
                updated_at_ms: 1_000,
            })
            .collect()
    }

    fn record(entity_type: &str, key: &str, deleted: bool, payload: Value) -> V4WireRecord {
        let domain = if entity_type == ENTITY_EXTENSION_PREF {
            DOMAIN_PREFERENCES
        } else {
            DOMAIN_EXTENSIONS
        };
        V4WireRecord {
            server_seq: 1,
            domain: domain.to_string(),
            entity_type: entity_type.to_string(),
            entity_key: key.to_string(),
            hlc: Hlc::new(2_000, 0, "phone"),
            deleted,
            payload,
            origin_device_id: "phone".to_string(),
            updated_at_ms: 2_000,
        }
    }

    fn repository_doc() -> Value {
        json!({
            "repositories": [
                {
                    "id": "novel-repo:https%3A%2F%2Fraw.githubusercontent.com%2FLNReader%2Fplugins%2Fdist%2Fplugins.min.json",
                    "url": "https://raw.githubusercontent.com/LNReader/plugins/dist/plugins.min.json/",
                    "normalizedUrl": "https://raw.githubusercontent.com/LNReader/plugins/dist/plugins.min.json",
                    "enabled": true,
                    "trustState": "trusted"
                },
                { "id": "lan", "url": "http://192.168.0.4/plugins.json", "normalizedUrl": "http://192.168.0.4/plugins.json", "enabled": true }
            ],
            "catalogEntries": [{
                "repositoryId": "novel-repo:https%3A%2F%2Fraw.githubusercontent.com%2FLNReader%2Fplugins%2Fdist%2Fplugins.min.json",
                "pluginId": "wtrlab", "name": "WTR-LAB", "lang": "English", "version": "1.2.3"
            }],
            "installedPlugins": [{
                "repositoryId": "novel-repo:https%3A%2F%2Fraw.githubusercontent.com%2FLNReader%2Fplugins%2Fdist%2Fplugins.min.json",
                "pluginId": "wtrlab", "version": "1.2.3", "enabled": true, "artifactPath": "C:/plugins/wtrlab.js"
            }]
        })
    }

    #[test]
    fn exports_public_repositories_and_plugins_with_the_phone_keys() {
        let items = export_desktop_novel_extensions_to_v4(&repository_doc(), "desktop-a", 1_000);
        let keys = items
            .iter()
            .map(|item| (item.entity_type.as_str(), item.entity_key.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            vec![
                ("extension.installed", "novel:wtrlab"),
                (
                    "extension.repo",
                    "novel:https://raw.githubusercontent.com/LNReader/plugins/dist/plugins.min.json"
                ),
            ]
        );
        assert_eq!(
            items[0].payload,
            json!({
                "kind": "novel", "packageId": "wtrlab", "name": "WTR-LAB", "versionName": "1.2.3",
                "lang": "English", "enabled": true,
                "repoUrl": "https://raw.githubusercontent.com/LNReader/plugins/dist/plugins.min.json"
            })
        );
        assert_eq!(
            export_desktop_novel_extensions_to_v4(&repository_doc(), "desktop-a", 1_000)
                .iter()
                .map(|item| &item.payload)
                .collect::<Vec<_>>(),
            items.iter().map(|item| &item.payload).collect::<Vec<_>>()
        );
    }

    #[test]
    fn every_exported_item_passes_the_core_validator() {
        let settings = json!({ "version": 1, "plugins": { "wtrlab": { "preferredMode": "web", "tags": ["b", "a"] } } });
        let items = export_desktop_novel_extensions_to_v4(&repository_doc(), "desktop-a", 1_000)
            .into_iter()
            .chain(export_desktop_novel_plugin_settings_to_v4(&settings, "desktop-a", 1_000));
        let mut count = 0;
        for item in items {
            count += 1;
            assert_eq!(
                super::super::db::validate_incoming_item(&item),
                Ok(()),
                "{} {}",
                item.entity_type,
                item.entity_key
            );
        }
        assert_eq!(count, 4);
    }

    #[test]
    fn secret_settings_never_leave_the_device_or_arrive() {
        let settings = json!({ "version": 1, "plugins": { "wtrlab": {
            "preferredMode": "web", "sessionCookie": "c", "apiToken": "t", "password": "p"
        } } });
        let exported = export_desktop_novel_plugin_settings_to_v4(&settings, "desktop-a", 1_000);
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0].entity_key, "novel:wtrlab:preferredMode");
        assert_eq!(exported[0].payload, json!({ "valueType": "string", "value": "web" }));

        let mut doc = json!({});
        let secret = record(ENTITY_EXTENSION_PREF, "novel:wtrlab:apiToken", false, json!({ "valueType": "string", "value": "stolen" }));
        assert!(!apply_v4_records_to_desktop_novel_plugin_settings(&mut doc, &[secret]));
        assert_eq!(doc, json!({ "version": 1, "plugins": {} }));
    }

    #[test]
    fn settings_round_trip_is_idempotent_and_a_tombstone_removes_one_key() {
        let source = json!({ "version": 1, "plugins": { "wtrlab": { "preferredMode": "web", "showImages": true, "tags": ["b", "a"] } } });
        let records = wire(export_desktop_novel_plugin_settings_to_v4(&source, "desktop-a", 1_000));
        let mut target = json!({ "version": 1, "plugins": { "wtrlab": { "localOnly": "keep" } } });
        assert!(apply_v4_records_to_desktop_novel_plugin_settings(&mut target, &records));
        assert!(!apply_v4_records_to_desktop_novel_plugin_settings(&mut target, &records));
        assert_eq!(target["plugins"]["wtrlab"]["preferredMode"], "web");
        assert_eq!(target["plugins"]["wtrlab"]["showImages"], true);
        assert_eq!(target["plugins"]["wtrlab"]["tags"], json!(["a", "b"]));
        assert_eq!(target["plugins"]["wtrlab"]["localOnly"], "keep");

        let tombstone = record(ENTITY_EXTENSION_PREF, "novel:wtrlab:showImages", true, json!({}));
        assert!(apply_v4_records_to_desktop_novel_plugin_settings(&mut target, &[tombstone]));
        assert!(target["plugins"]["wtrlab"].get("showImages").is_none());
        assert_eq!(target["plugins"]["wtrlab"]["preferredMode"], "web");
    }

    #[test]
    fn settings_of_other_kinds_and_bad_values_are_ignored() {
        let mut settings = json!({});
        let wrong_type = record(ENTITY_EXTENSION_PREF, "novel:wtrlab:showImages", false, json!({ "valueType": "boolean", "value": "yes" }));
        let comic_pref = record(ENTITY_EXTENSION_PREF, "comic:123:showImages", false, json!({ "valueType": "boolean", "value": true }));
        assert!(!apply_v4_records_to_desktop_novel_plugin_settings(&mut settings, &[wrong_type, comic_pref]));
        assert_eq!(settings, json!({ "version": 1, "plugins": {} }));
    }
}
