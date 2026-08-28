use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use axum::extract::{Extension, State};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::syncd::db;
use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState};
use crate::syncd::routes::suwayomi_catalog;

const EXTENSION_INVENTORY_SCHEMA_VERSION: u32 = 2;

const EXTENSIONS_V23_QUERY: &str = r#"
  query EpigraphCoreExtensionInventory {
    aboutServer { version revision buildType }
    sources {
      nodes {
        id name displayName lang
        extension { pkgName name versionName versionCodeLong isInstalled storeIndexUrl }
      }
    }
  }
"#;

const EXTENSIONS_V21_QUERY: &str = r#"
  query EpigraphCoreExtensionInventory {
    aboutServer { version revision buildType }
    sources {
      nodes {
        id name displayName lang
        extension { pkgName name versionName versionCode isInstalled repo }
      }
    }
  }
"#;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreExtensionSource {
    pub id: String,
    pub name: String,
    pub lang: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreExtensionDescriptor {
    pub package_name: String,
    pub display_name: String,
    pub version_code: String,
    pub version_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_index_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_repository_index_url: Option<String>,
    pub sources: Vec<CoreExtensionSource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreExtensionInventory {
    pub schema_version: u32,
    pub server_id: String,
    pub profile_id: String,
    pub runtime_fingerprint: String,
    pub generated_at_ms: i64,
    pub extensions: Vec<CoreExtensionDescriptor>,
}

pub async fn get_extensions(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Result<Json<CoreExtensionInventory>, AppError> {
    let scope_id = format!("comics:profile:{}", session.profile_id);
    if !session.scopes.contains(&scope_id) {
        return Err(AppError::Forbidden(
            "The paired device is not authorized for this comics profile.".to_string(),
        ));
    }

    let data = match suwayomi_catalog::execute_graphql_document(
        &state,
        &session,
        EXTENSIONS_V23_QUERY,
        json!({}),
        false,
    )
    .await
    {
        Ok(data) => (data, "versionCodeLong", "storeIndexUrl"),
        Err(v23_error) => {
            if super::portable_manifest::runtime_supports_v23_manifest(&state, &session).await
                != Some(false)
            {
                return Err(v23_error);
            }
            (
                suwayomi_catalog::execute_graphql_document(
                    &state,
                    &session,
                    EXTENSIONS_V21_QUERY,
                    json!({}),
                    false,
                )
                .await?,
                "versionCode",
                "repo",
            )
        }
    };

    let mut extensions = normalize_inventory(&data.0, data.1, data.2)?;
    let dependency_hints = load_portable_dependency_hints(&state, &session.profile_id).await?;
    merge_portable_dependencies(
        &mut extensions,
        dependency_hints,
        &crate::syncd::extension_store_seed::active_profile_root(),
    );
    let server_identity = db::load_server_identity(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load the Core server identity.".to_string()))?;

    Ok(Json(CoreExtensionInventory {
        schema_version: EXTENSION_INVENTORY_SCHEMA_VERSION,
        server_id: server_identity.server_id,
        profile_id: session.profile_id,
        runtime_fingerprint: runtime_fingerprint(&data.0),
        generated_at_ms: db::now_ms(),
        extensions,
    }))
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct PortableDependencyHint {
    package_name: String,
    source_id: String,
    display_name: Option<String>,
    observed_version_code: Option<String>,
    store_index_url: Option<String>,
}

async fn load_portable_dependency_hints(
    state: &SharedAppState,
    profile_id: &str,
) -> Result<Vec<PortableDependencyHint>, AppError> {
    sqlx::query_as::<_, PortableDependencyHint>(
        r#"
        SELECT
          work.dependency_key AS package_name,
          work.source_id,
          MAX(COALESCE(dependency.display_name_hint, work.provider_label_hint)) AS display_name,
          MAX(dependency.observed_version_code) AS observed_version_code,
          MAX(dependency.extension_store_index_url) AS store_index_url
        FROM portable_work_bindings work
        LEFT JOIN portable_comic_dependencies dependency
          ON dependency.profile_id = work.profile_id
         AND dependency.package_name = work.dependency_key
        WHERE work.profile_id = ?
          AND work.ecosystem = 'SUWAYOMI'
          AND work.dependency_key IS NOT NULL
          AND work.source_id IS NOT NULL
        GROUP BY work.dependency_key, work.source_id
        ORDER BY work.dependency_key, work.source_id
        "#,
    )
    .bind(profile_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| {
        AppError::Internal(
            "Failed to load the comics dependencies required by the synchronized library."
                .to_string(),
        )
    })
}

fn merge_portable_dependencies(
    extensions: &mut Vec<CoreExtensionDescriptor>,
    hints: Vec<PortableDependencyHint>,
    profile_root: &Path,
) {
    let installed = extensions
        .iter()
        .map(|extension| extension.package_name.as_str())
        .collect::<BTreeSet<_>>();
    let mut missing = BTreeMap::<String, Vec<PortableDependencyHint>>::new();
    for hint in hints {
        if !installed.contains(hint.package_name.as_str()) {
            missing
                .entry(hint.package_name.clone())
                .or_default()
                .push(hint);
        }
    }
    drop(installed);

    for (package_name, package_hints) in missing {
        let artifact_version = extension_artifact_version(profile_root, &package_name);
        let version_code = package_hints
            .iter()
            .find_map(|hint| hint.observed_version_code.clone())
            .or_else(|| {
                artifact_version
                    .as_ref()
                    .map(|version| version.version_code.clone())
            })
            .unwrap_or_else(|| "0".to_string());
        let version_name = artifact_version
            .as_ref()
            .map(|version| version.version_name.clone())
            .unwrap_or_else(|| "unavailable".to_string());
        let display_name = package_hints
            .iter()
            .find_map(|hint| hint.display_name.as_deref())
            .map(clean_provider_label)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| package_name.clone());
        let store_index_url = package_hints
            .iter()
            .find_map(|hint| hint.store_index_url.as_deref())
            .and_then(super::portable_manifest::sanitize_extension_store_url);
        let mut sources = package_hints
            .iter()
            .filter_map(|hint| canonical_source_id(&hint.source_id).map(|id| (id, hint)))
            .map(|(id, hint)| CoreExtensionSource {
                id,
                name: hint
                    .display_name
                    .as_deref()
                    .map(clean_provider_label)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| display_name.clone()),
                lang: provider_label_language(hint.display_name.as_deref()).unwrap_or_default(),
            })
            .collect::<Vec<_>>();
        sources.sort_by(|left, right| left.id.cmp(&right.id));
        sources.dedup_by(|left, right| left.id == right.id);
        if sources.is_empty() {
            continue;
        }
        extensions.push(CoreExtensionDescriptor {
            package_name,
            display_name,
            version_code,
            version_name,
            store_index_url,
            legacy_repository_index_url: None,
            sources,
        });
    }
    extensions.sort_by(|left, right| left.package_name.cmp(&right.package_name));
}

#[derive(Debug, Clone)]
struct ExtensionArtifactVersion {
    version_code: String,
    version_name: String,
}

fn extension_artifact_version(
    profile_root: &Path,
    package_name: &str,
) -> Option<ExtensionArtifactVersion> {
    let package_suffix = package_name.strip_prefix("eu.kanade.tachiyomi.extension.")?;
    let prefix = format!("tachiyomi-{package_suffix}-v");
    let entries = std::fs::read_dir(profile_root.join("extensions")).ok()?;
    let mut versions = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| {
            let version = name.strip_prefix(&prefix)?.strip_suffix(".jar")?;
            let version_code = version.rsplit('.').next()?;
            (!version.is_empty() && version_code.bytes().all(|byte| byte.is_ascii_digit())).then(
                || ExtensionArtifactVersion {
                    version_code: version_code.to_string(),
                    version_name: version.to_string(),
                },
            )
        })
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| left.version_name.cmp(&right.version_name));
    versions.pop()
}

fn clean_provider_label(value: &str) -> String {
    value
        .trim()
        .rsplit_once(" (")
        .and_then(|(name, language)| language.strip_suffix(')').map(|_| name))
        .unwrap_or(value.trim())
        .to_string()
}

fn provider_label_language(value: Option<&str>) -> Option<String> {
    value?
        .trim()
        .rsplit_once(" (")
        .and_then(|(_, language)| language.strip_suffix(')'))
        .map(str::to_ascii_lowercase)
}

fn normalize_inventory(
    data: &Value,
    version_code_field: &str,
    store_index_field: &str,
) -> Result<Vec<CoreExtensionDescriptor>, AppError> {
    let mut sources_by_package = BTreeMap::<String, Vec<CoreExtensionSource>>::new();
    let mut extensions_by_package = BTreeMap::<String, Value>::new();
    // Keep accepting the legacy normalized shape in tests and rolling upgrades. Production
    // queries no longer request this top-level catalog because resolving every available
    // extension is both wasteful and capable of crashing older Suwayomi converters.
    for extension in nodes(data, "extensions") {
        let package_name = string_field(extension, "pkgName");
        if !package_name.is_empty() {
            extensions_by_package.insert(package_name, extension.clone());
        }
    }
    for source in nodes(data, "sources") {
        let Some(extension) = source.get("extension") else {
            continue;
        };
        let Some(package_name) = extension
            .get("pkgName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(source_id) =
            scalar_string(source.get("id")).and_then(|value| canonical_source_id(&value))
        else {
            continue;
        };
        extensions_by_package
            .entry(package_name.to_string())
            .or_insert_with(|| extension.clone());
        sources_by_package
            .entry(package_name.to_string())
            .or_default()
            .push(CoreExtensionSource {
                id: source_id,
                name: string_field(source, "name"),
                lang: string_field(source, "lang"),
            });
    }

    let mut extensions = Vec::new();
    for (package_name, extension) in extensions_by_package {
        if extension.get("isInstalled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let mut sources = sources_by_package.remove(&package_name).unwrap_or_default();
        // An installed artifact is not usable until Suwayomi has registered at least one source
        // for it. Publishing only loaded extensions keeps the mobile parity report from claiming
        // that a structurally broken desktop extension is available.
        if sources.is_empty() {
            continue;
        }
        sources.sort_by(|left, right| {
            let left = left.id.parse::<i64>().unwrap_or_default();
            let right = right.id.parse::<i64>().unwrap_or_default();
            left.cmp(&right)
        });
        let display_name = string_field(&extension, "name");
        let version_code = scalar_string(extension.get(version_code_field)).unwrap_or_default();
        let version_name = string_field(&extension, "versionName");
        let repository_url = extension
            .get(store_index_field)
            .and_then(Value::as_str)
            .and_then(super::portable_manifest::sanitize_extension_store_url);
        // Suwayomi 2.1 exposes the old `repo` field. It is useful provenance for an
        // explicit mobile resolution step, but it is not an Extension Store reference
        // and must never be promoted to the modern portable dependency contract.
        let (store_index_url, legacy_repository_index_url) = if store_index_field == "repo" {
            (None, repository_url)
        } else {
            (repository_url, None)
        };
        if version_code.is_empty() || version_name.is_empty() {
            return Err(AppError::service_unavailable(
                "SUWAYOMI_EXTENSION_INVENTORY_INVALID",
                "The comics runtime returned an invalid extension inventory.",
                true,
            ));
        }
        extensions.push(CoreExtensionDescriptor {
            display_name: if display_name.is_empty() {
                package_name.clone()
            } else {
                display_name
            },
            package_name,
            version_code,
            version_name,
            store_index_url,
            legacy_repository_index_url,
            sources,
        });
    }
    extensions.sort_by(|left, right| left.package_name.cmp(&right.package_name));
    Ok(extensions)
}

fn nodes<'a>(data: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    data.get(key)
        .and_then(|value| value.get("nodes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn scalar_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn canonical_source_id(value: &str) -> Option<String> {
    let parsed = value.parse::<i64>().ok()?;
    (parsed != 0 && parsed.to_string() == value).then(|| value.to_string())
}

pub(crate) fn runtime_fingerprint(data: &Value) -> String {
    let about = data.get("aboutServer").unwrap_or(&Value::Null);
    let canonical = json!({
        "buildType": about.get("buildType").and_then(Value::as_str).unwrap_or_default(),
        "revision": about.get("revision").and_then(Value::as_str).unwrap_or_default(),
        "version": about.get("version").and_then(Value::as_str).unwrap_or_default(),
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&canonical).unwrap_or_default());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn inventory_contains_only_installed_extensions_and_dedupes_sources() {
        let data = json!({
            "aboutServer": { "version": "2.3.2243", "revision": "abc", "buildType": "Stable" },
            "extensions": { "nodes": [
                { "pkgName": "ext.a", "name": "A", "versionName": "1.2", "versionCodeLong": "12", "isInstalled": true },
                { "pkgName": "ext.b", "name": "B", "versionName": "1.0", "versionCodeLong": "10", "isInstalled": false }
            ] },
            "sources": { "nodes": [
                { "id": "2", "name": "A two", "displayName": "A two (EN)", "lang": "en", "extension": { "pkgName": "ext.a" } },
                { "id": "1", "name": "A one", "displayName": "A one (PT-BR)", "lang": "pt-BR", "extension": { "pkgName": "ext.a" } }
            ] }
        });

        let inventory = normalize_inventory(&data, "versionCodeLong", "storeIndexUrl").unwrap();
        assert_eq!(inventory.len(), 1);
        assert_eq!(inventory[0].package_name, "ext.a");
        assert_eq!(inventory[0].version_code, "12");
        assert_eq!(inventory[0].sources[0].id, "1");
        assert_eq!(inventory[0].sources[1].id, "2");

        let wire = serde_json::to_value(&inventory[0].sources[0]).unwrap();
        assert_eq!(wire["id"], "1");
        assert_eq!(wire["name"], "A one");
        assert_eq!(wire["lang"], "pt-BR");
        assert!(wire.get("sourceId").is_none());
    }

    #[test]
    fn inventory_is_derived_from_loaded_sources_without_resolving_the_store_catalog() {
        let data = json!({
            "aboutServer": { "version": "2.3.2333", "revision": "r2333", "buildType": "Preview" },
            "sources": { "nodes": [
                {
                    "id": "2528986671771677900",
                    "name": "Mangakakalot",
                    "lang": "en",
                    "extension": {
                        "pkgName": "eu.kanade.tachiyomi.extension.en.mangakakalot",
                        "name": "Mangakakalot",
                        "versionName": "1.4.22",
                        "versionCodeLong": "22",
                        "isInstalled": true,
                        "storeIndexUrl": "https://github.com/keiyoushi/extensions/raw/repo/index.pb"
                    }
                },
                {
                    "id": "0",
                    "name": "Local source",
                    "lang": "localsourcelang",
                    "extension": {
                        "pkgName": "eu.kanade.tachiyomi.source.local",
                        "name": "Local",
                        "versionName": "1.0",
                        "versionCodeLong": "0",
                        "isInstalled": true
                    }
                }
            ] }
        });

        let inventory = normalize_inventory(&data, "versionCodeLong", "storeIndexUrl").unwrap();

        assert_eq!(inventory.len(), 1);
        assert_eq!(
            inventory[0].package_name,
            "eu.kanade.tachiyomi.extension.en.mangakakalot"
        );
        assert_eq!(inventory[0].sources[0].id, "2528986671771677900");
        assert_eq!(inventory[0].version_code, "22");
    }

    #[test]
    fn production_inventory_queries_do_not_request_the_full_extension_catalog() {
        for query in [EXTENSIONS_V23_QUERY, EXTENSIONS_V21_QUERY] {
            assert!(!query.contains("extensions {"));
            assert!(query.contains("sources {"));
            assert!(query.contains("extension { pkgName"));
        }
    }

    #[test]
    fn required_library_dependency_is_reported_without_resolving_the_store_catalog() {
        let temp = tempdir().unwrap();
        let extensions_dir = temp.path().join("extensions");
        std::fs::create_dir_all(&extensions_dir).unwrap();
        std::fs::write(
            extensions_dir.join("tachiyomi-en.mangaclash-v1.4.57.jar"),
            b"fixture",
        )
        .unwrap();
        let mut inventory = Vec::new();

        merge_portable_dependencies(
            &mut inventory,
            vec![PortableDependencyHint {
                package_name: "eu.kanade.tachiyomi.extension.en.mangaclash".to_string(),
                source_id: "5214196327345905951".to_string(),
                display_name: Some("MangaClash (EN)".to_string()),
                observed_version_code: None,
                store_index_url: None,
            }],
            temp.path(),
        );

        assert_eq!(inventory.len(), 1);
        assert_eq!(inventory[0].display_name, "MangaClash");
        assert_eq!(inventory[0].version_name, "1.4.57");
        assert_eq!(inventory[0].version_code, "57");
        assert_eq!(inventory[0].sources[0].id, "5214196327345905951");
        assert_eq!(inventory[0].sources[0].lang, "en");
    }

    #[test]
    fn version_21_numeric_codes_are_normalized_to_strings() {
        let data = json!({
            "extensions": { "nodes": [
                {
                    "pkgName": "ext.a",
                    "name": "A",
                    "versionName": "1.0",
                    "versionCode": 7,
                    "isInstalled": true,
                    "repo": "https://repo.example/extensions/"
                }
            ] },
            "sources": { "nodes": [
                { "id": "1", "name": "A", "lang": "en", "extension": { "pkgName": "ext.a" } }
            ] }
        });
        let inventory = normalize_inventory(&data, "versionCode", "repo").unwrap();
        assert_eq!(inventory[0].version_code, "7");
        assert_eq!(inventory[0].store_index_url, None);
        assert_eq!(
            inventory[0].legacy_repository_index_url.as_deref(),
            Some("https://repo.example/extensions/")
        );
    }

    #[test]
    fn source_ids_remain_exact_above_javascript_safe_integer_range() {
        let data = json!({
            "extensions": { "nodes": [
                { "pkgName": "ext.large", "name": "Large", "versionName": "1.0", "versionCodeLong": "1", "isInstalled": true }
            ] },
            "sources": { "nodes": [
                { "id": "2499283573021220255", "name": "Large", "lang": "en", "extension": { "pkgName": "ext.large" } }
            ] }
        });

        let inventory = normalize_inventory(&data, "versionCodeLong", "storeIndexUrl").unwrap();

        assert_eq!(inventory[0].sources[0].id, "2499283573021220255");
        assert_eq!(
            serde_json::to_value(&inventory[0].sources[0]).unwrap()["id"],
            "2499283573021220255"
        );
    }

    #[test]
    fn inventory_omits_installed_artifacts_that_did_not_register_sources() {
        let data = json!({
            "extensions": { "nodes": [
                { "pkgName": "ext.broken", "name": "Broken", "versionName": "1.0", "versionCodeLong": "1", "isInstalled": true }
            ] },
            "sources": { "nodes": [] }
        });

        assert!(
            normalize_inventory(&data, "versionCodeLong", "storeIndexUrl")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn inventory_exposes_only_sanitized_store_provenance() {
        let data = json!({
            "extensions": { "nodes": [
                {
                    "pkgName": "ext.safe",
                    "name": "Safe",
                    "versionName": "1.0",
                    "versionCodeLong": "1",
                    "isInstalled": true,
                    "storeIndexUrl": "https://store.example/index.min.json"
                },
                {
                    "pkgName": "ext.private",
                    "name": "Private",
                    "versionName": "1.0",
                    "versionCodeLong": "1",
                    "isInstalled": true,
                    "storeIndexUrl": "https://user:secret@127.0.0.1/index.json?token=secret"
                }
            ] },
            "sources": { "nodes": [
                { "id": "1", "name": "Safe", "lang": "en", "extension": { "pkgName": "ext.safe" } },
                { "id": "2", "name": "Private", "lang": "en", "extension": { "pkgName": "ext.private" } }
            ] }
        });

        let inventory = normalize_inventory(&data, "versionCodeLong", "storeIndexUrl").unwrap();
        let safe = inventory
            .iter()
            .find(|item| item.package_name == "ext.safe")
            .unwrap();
        let private = inventory
            .iter()
            .find(|item| item.package_name == "ext.private")
            .unwrap();
        assert_eq!(
            safe.store_index_url.as_deref(),
            Some("https://store.example/index.min.json")
        );
        assert_eq!(safe.legacy_repository_index_url, None);
        assert_eq!(private.store_index_url, None);
        assert_eq!(private.legacy_repository_index_url, None);
    }

    #[test]
    fn runtime_fingerprint_ignores_upstream_object_key_order() {
        let left = json!({ "aboutServer": { "version": "2.3.2243", "revision": "abc", "buildType": "Stable" } });
        let right = serde_json::from_str::<Value>(
            r#"{"aboutServer":{"buildType":"Stable","revision":"abc","version":"2.3.2243"}}"#,
        )
        .unwrap();

        assert_eq!(runtime_fingerprint(&left), runtime_fingerprint(&right));
    }
}
