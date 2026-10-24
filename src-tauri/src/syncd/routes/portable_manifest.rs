use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Extension, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use url::{Host, Url};
use uuid::Uuid;

use crate::syncd::db;
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{
    canonical_portable_work_id, canonicalize_public_novel_repository_url, AppError,
    AuthenticatedSession, ComicDependencyV3, ErrorDetail, ExtensionStoreReferenceV3,
    NovelDependencyV3, PortableWorkRefV3, RepositoryReferenceV3,
    SharedAppState,
};
use crate::syncd::routes::{suwayomi_catalog, suwayomi_extensions};

const PORTABLE_MANIFEST_SCHEMA_VERSION: u32 = 3;
const DEFAULT_PAGE_SIZE: i64 = 100;
const MAX_PAGE_SIZE: i64 = 250;
// A slow phone can spend minutes applying one page; an expired snapshot restarts the whole walk.
const MANIFEST_SNAPSHOT_TTL_MS: i64 = 10 * 60 * 1000;
const MAX_MANIFEST_SNAPSHOT_ITEMS: usize = 20_000;
const MAX_MANIFEST_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
const MAX_MANIFEST_SNAPSHOT_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_MANIFEST_SNAPSHOTS: usize = 8;

const MANIFEST_CAPABILITIES_QUERY: &str = r#"
  query EpigraphPortableManifestCapabilities {
    __schema { queryType { fields { name } } }
  }
"#;

const MANIFEST_EXTENSION_CAPABILITIES_QUERY: &str = r#"
  query EpigraphPortableManifestExtensionCapabilities {
    extensionType: __type(name: "ExtensionType") { fields { name } }
  }
"#;

const MANIFEST_V23_QUERY: &str = r#"
  query EpigraphPortableManifest($first: Int!, $offset: Int!) {
    aboutServer { version revision buildType }
    mangas(condition: { inLibrary: true }, first: $first, offset: $offset) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        id
        sourceId
        url
        title
        source { name displayName extension { pkgName } }
      }
    }
    sources {
      nodes {
        id
        name
        displayName
        extension { pkgName versionCodeLong isInstalled storeIndexUrl }
      }
    }
    extensions {
      nodes { pkgName versionCodeLong isInstalled storeIndexUrl }
    }
    extensionStores {
      nodes { indexUrl name }
    }
  }
"#;

const MANIFEST_V21_QUERY: &str = r#"
  query EpigraphPortableManifest($first: Int!, $offset: Int!) {
    aboutServer { version revision buildType }
    mangas(condition: { inLibrary: true }, first: $first, offset: $offset) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        id
        sourceId
        url
        title
        source { name displayName extension { pkgName } }
      }
    }
    sources {
      nodes {
        id
        name
        displayName
        extension { pkgName versionCode isInstalled repo }
      }
    }
    extensions {
      nodes { pkgName versionCode isInstalled repo }
    }
  }
"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableManifestQuery {
    pub scope_id: String,
    pub page_size: Option<i64>,
    pub offset: Option<i64>,
    pub snapshot_id: Option<String>,
    pub snapshot_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableManifestPage {
    pub offset: i64,
    pub page_size: i64,
    pub has_next_page: bool,
    pub total_count: i64,
    pub omitted_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableComicWorkDescriptor {
    pub portable_id: String,
    pub reference: PortableWorkRefV3,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_label_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableManifestResponse {
    pub schema_version: u32,
    pub scope_id: String,
    pub runtime_fingerprint: String,
    pub generated_at_ms: i64,
    pub snapshot_id: String,
    pub snapshot_fingerprint: String,
    pub snapshot_expires_at_ms: i64,
    pub page: PortableManifestPage,
    pub comic_dependencies: Vec<ComicDependencyV3>,
    pub works: Vec<PortableComicWorkDescriptor>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableNovelWorkDescriptor {
    pub portable_id: String,
    pub reference: PortableWorkRefV3,
    pub dependency_plugin_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_label_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableNovelManifestResponse {
    pub schema_version: u32,
    pub scope_id: String,
    pub manifest_fingerprint: String,
    pub generated_at_ms: i64,
    pub snapshot_id: String,
    pub snapshot_fingerprint: String,
    pub snapshot_expires_at_ms: i64,
    pub page: PortableManifestPage,
    pub novel_dependencies: Vec<NovelDependencyV3>,
    pub works: Vec<PortableNovelWorkDescriptor>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ManifestSnapshotType {
    Comics,
    Novels,
}

#[derive(Clone)]
struct ComicManifestSnapshot {
    runtime_fingerprint: String,
    omitted_count: i64,
    dependencies: Vec<ComicDependencyV3>,
    works: Vec<PortableComicWorkDescriptor>,
}

#[derive(Clone)]
struct NovelManifestSnapshot {
    omitted_count: i64,
    dependencies: Vec<NovelDependencyV3>,
    works: Vec<PortableNovelWorkDescriptor>,
}

#[derive(Clone)]
enum ManifestSnapshotPayload {
    Comics(Arc<ComicManifestSnapshot>),
    Novels(Arc<NovelManifestSnapshot>),
}

#[derive(Clone)]
struct ManifestSnapshotEntry {
    snapshot_id: String,
    fingerprint: String,
    token_id: String,
    device_id: String,
    scope_id: String,
    generated_at_ms: i64,
    expires_at_ms: i64,
    estimated_bytes: usize,
    payload: ManifestSnapshotPayload,
}

#[derive(Default)]
struct ManifestSnapshotCache {
    entries: BTreeMap<String, ManifestSnapshotEntry>,
    estimated_bytes: usize,
}

impl ManifestSnapshotCache {
    fn remove(&mut self, snapshot_id: &str) -> Option<ManifestSnapshotEntry> {
        let entry = self.entries.remove(snapshot_id)?;
        self.estimated_bytes = self.estimated_bytes.saturating_sub(entry.estimated_bytes);
        Some(entry)
    }

    fn purge_expired(&mut self, now_ms: i64) {
        let expired = self
            .entries
            .iter()
            .filter_map(|(id, entry)| (entry.expires_at_ms <= now_ms).then(|| id.clone()))
            .collect::<Vec<_>>();
        for id in expired {
            self.remove(&id);
        }
    }

    fn insert(&mut self, entry: ManifestSnapshotEntry, now_ms: i64) -> Result<(), AppError> {
        self.purge_expired(now_ms);
        if entry.estimated_bytes > MAX_MANIFEST_SNAPSHOT_BYTES {
            return Err(manifest_snapshot_too_large());
        }
        while self.entries.len() >= MAX_MANIFEST_SNAPSHOTS
            || self.estimated_bytes.saturating_add(entry.estimated_bytes)
                > MAX_MANIFEST_SNAPSHOT_CACHE_BYTES
        {
            let Some(oldest_id) = self
                .entries
                .values()
                .min_by_key(|candidate| candidate.generated_at_ms)
                .map(|candidate| candidate.snapshot_id.clone())
            else {
                break;
            };
            self.remove(&oldest_id);
        }
        self.estimated_bytes = self.estimated_bytes.saturating_add(entry.estimated_bytes);
        self.entries.insert(entry.snapshot_id.clone(), entry);
        Ok(())
    }
}

fn manifest_snapshot_cache() -> &'static Mutex<ManifestSnapshotCache> {
    static CACHE: OnceLock<Mutex<ManifestSnapshotCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ManifestSnapshotCache::default()))
}

pub async fn get_portable_manifest(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<PortableManifestQuery>,
) -> Result<Json<PortableManifestResponse>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    if query.scope_id != format!("comics:profile:{}", session.profile_id) {
        return Err(AppError::Forbidden(
            "The portable comics manifest requires the paired comics profile scope.".to_string(),
        ));
    }
    let page_size = query.page_size.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = query.offset.unwrap_or(0);
    if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
        return Err(AppError::BadRequest(format!(
            "pageSize must be between 1 and {MAX_PAGE_SIZE}."
        )));
    }
    if !(0..=i32::MAX as i64).contains(&offset) {
        return Err(AppError::BadRequest(
            "offset must be a non-negative Suwayomi integer.".to_string(),
        ));
    }

    let snapshot = match query.snapshot_id.as_deref() {
        Some(snapshot_id) => load_manifest_snapshot(
            snapshot_id,
            query.snapshot_fingerprint.as_deref(),
            &session,
            &query.scope_id,
            ManifestSnapshotType::Comics,
        )?,
        None => {
            require_new_snapshot_request(offset, query.snapshot_fingerprint.as_deref())?;
            let payload = build_comic_manifest_snapshot(&state, &session).await?;
            store_manifest_snapshot(
                &session,
                &query.scope_id,
                ManifestSnapshotPayload::Comics(Arc::new(payload)),
            )?
        }
    };
    let ManifestSnapshotPayload::Comics(payload) = &snapshot.payload else {
        return Err(invalid_manifest_snapshot());
    };
    let (page, works, dependencies) = comic_snapshot_page(payload, offset, page_size)?;
    Ok(Json(PortableManifestResponse {
        schema_version: PORTABLE_MANIFEST_SCHEMA_VERSION,
        scope_id: query.scope_id,
        runtime_fingerprint: payload.runtime_fingerprint.clone(),
        generated_at_ms: snapshot.generated_at_ms,
        snapshot_id: snapshot.snapshot_id,
        snapshot_fingerprint: snapshot.fingerprint,
        snapshot_expires_at_ms: snapshot.expires_at_ms,
        page,
        comic_dependencies: dependencies,
        works,
    }))
}

pub async fn get_portable_novel_manifest(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<PortableManifestQuery>,
) -> Result<Json<PortableNovelManifestResponse>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    if query.scope_id != format!("novels:profile:{}", session.profile_id) {
        return Err(AppError::Forbidden(
            "The portable novels manifest requires the paired novels profile scope.".to_string(),
        ));
    }
    let page_size = query.page_size.unwrap_or(DEFAULT_PAGE_SIZE);
    let offset = query.offset.unwrap_or(0);
    if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
        return Err(AppError::BadRequest(format!(
            "pageSize must be between 1 and {MAX_PAGE_SIZE}."
        )));
    }
    if !(0..=i32::MAX as i64).contains(&offset) {
        return Err(AppError::BadRequest(
            "offset must be a non-negative integer.".to_string(),
        ));
    }

    let snapshot = match query.snapshot_id.as_deref() {
        Some(snapshot_id) => load_manifest_snapshot(
            snapshot_id,
            query.snapshot_fingerprint.as_deref(),
            &session,
            &query.scope_id,
            ManifestSnapshotType::Novels,
        )?,
        None => {
            require_new_snapshot_request(offset, query.snapshot_fingerprint.as_deref())?;
            let payload = build_novel_manifest_snapshot(&state, &session, &query.scope_id).await?;
            store_manifest_snapshot(
                &session,
                &query.scope_id,
                ManifestSnapshotPayload::Novels(Arc::new(payload)),
            )?
        }
    };
    let ManifestSnapshotPayload::Novels(payload) = &snapshot.payload else {
        return Err(invalid_manifest_snapshot());
    };
    let (page, works, dependencies) = novel_snapshot_page(payload, offset, page_size)?;
    Ok(Json(PortableNovelManifestResponse {
        schema_version: PORTABLE_MANIFEST_SCHEMA_VERSION,
        scope_id: query.scope_id,
        manifest_fingerprint: snapshot.fingerprint.clone(),
        generated_at_ms: snapshot.generated_at_ms,
        snapshot_id: snapshot.snapshot_id,
        snapshot_fingerprint: snapshot.fingerprint,
        snapshot_expires_at_ms: snapshot.expires_at_ms,
        page,
        novel_dependencies: dependencies,
        works,
    }))
}

fn require_new_snapshot_request(
    offset: i64,
    snapshot_fingerprint: Option<&str>,
) -> Result<(), AppError> {
    if offset != 0 {
        return Err(manifest_snapshot_conflict(
            "PORTABLE_MANIFEST_SNAPSHOT_REQUIRED",
            "Start portable manifest pagination at offset zero to obtain a snapshot.",
        ));
    }
    if snapshot_fingerprint.is_some() {
        return Err(AppError::BadRequest(
            "snapshotFingerprint requires snapshotId.".to_string(),
        ));
    }
    Ok(())
}

fn store_manifest_snapshot(
    session: &AuthenticatedSession,
    scope_id: &str,
    payload: ManifestSnapshotPayload,
) -> Result<ManifestSnapshotEntry, AppError> {
    let canonical = match &payload {
        ManifestSnapshotPayload::Comics(snapshot) => serde_json::to_vec(&(
            PORTABLE_MANIFEST_SCHEMA_VERSION,
            scope_id,
            "comics",
            &snapshot.runtime_fingerprint,
            snapshot.omitted_count,
            &snapshot.dependencies,
            &snapshot.works,
        )),
        ManifestSnapshotPayload::Novels(snapshot) => serde_json::to_vec(&(
            PORTABLE_MANIFEST_SCHEMA_VERSION,
            scope_id,
            "novels",
            snapshot.omitted_count,
            &snapshot.dependencies,
            &snapshot.works,
        )),
    }
    .map_err(|error| AppError::Internal(error.to_string()))?;
    if canonical.len() > MAX_MANIFEST_SNAPSHOT_BYTES {
        return Err(manifest_snapshot_too_large());
    }
    let generated_at_ms = db::now_ms();
    let entry = ManifestSnapshotEntry {
        snapshot_id: Uuid::new_v4().to_string(),
        fingerprint: format!("sha256:{:x}", Sha256::digest(&canonical)),
        token_id: session.token_id.clone(),
        device_id: session.device_id.clone(),
        scope_id: scope_id.to_string(),
        generated_at_ms,
        expires_at_ms: generated_at_ms.saturating_add(MANIFEST_SNAPSHOT_TTL_MS),
        estimated_bytes: canonical.len(),
        payload,
    };
    manifest_snapshot_cache()
        .lock()
        .map_err(|_| {
            AppError::Internal("Portable manifest snapshot cache is unavailable.".to_string())
        })?
        .insert(entry.clone(), generated_at_ms)?;
    Ok(entry)
}

fn load_manifest_snapshot(
    snapshot_id: &str,
    snapshot_fingerprint: Option<&str>,
    session: &AuthenticatedSession,
    scope_id: &str,
    expected_type: ManifestSnapshotType,
) -> Result<ManifestSnapshotEntry, AppError> {
    if Uuid::parse_str(snapshot_id).is_err() {
        return Err(invalid_manifest_snapshot());
    }
    let fingerprint = snapshot_fingerprint.ok_or_else(|| {
        AppError::BadRequest("snapshotFingerprint is required with snapshotId.".to_string())
    })?;
    let now_ms = db::now_ms();
    let mut cache = manifest_snapshot_cache().lock().map_err(|_| {
        AppError::Internal("Portable manifest snapshot cache is unavailable.".to_string())
    })?;
    let Some(entry) = cache.entries.get(snapshot_id).cloned() else {
        cache.purge_expired(now_ms);
        return Err(invalid_manifest_snapshot());
    };
    if entry.expires_at_ms <= now_ms {
        cache.remove(snapshot_id);
        return Err(expired_manifest_snapshot());
    }
    let actual_type = match &entry.payload {
        ManifestSnapshotPayload::Comics(_) => ManifestSnapshotType::Comics,
        ManifestSnapshotPayload::Novels(_) => ManifestSnapshotType::Novels,
    };
    if entry.token_id != session.token_id
        || entry.device_id != session.device_id
        || entry.scope_id != scope_id
        || actual_type != expected_type
        || entry.fingerprint != fingerprint
    {
        return Err(invalid_manifest_snapshot());
    }
    // The TTL bounds an abandoned walk, not a slow one: each page read keeps the snapshot alive.
    let mut entry = entry;
    entry.expires_at_ms = now_ms.saturating_add(MANIFEST_SNAPSHOT_TTL_MS);
    if let Some(cached) = cache.entries.get_mut(snapshot_id) {
        cached.expires_at_ms = entry.expires_at_ms;
    }
    Ok(entry)
}

fn page_snapshot<T: Clone>(
    items: &[T],
    offset: i64,
    page_size: i64,
    omitted_count: i64,
) -> Result<(PortableManifestPage, Vec<T>), AppError> {
    let offset = usize::try_from(offset).map_err(|_| invalid_manifest_snapshot())?;
    let page_size = usize::try_from(page_size).map_err(|_| invalid_manifest_snapshot())?;
    if offset > items.len() {
        return Err(manifest_snapshot_conflict(
            "PORTABLE_MANIFEST_SNAPSHOT_OFFSET_INVALID",
            "The requested page does not belong to this portable manifest snapshot.",
        ));
    }
    let end = offset.saturating_add(page_size).min(items.len());
    Ok((
        PortableManifestPage {
            offset: offset as i64,
            page_size: page_size as i64,
            has_next_page: end < items.len(),
            total_count: items.len() as i64,
            omitted_count: if offset == 0 { omitted_count } else { 0 },
        },
        items[offset..end].to_vec(),
    ))
}

fn comic_snapshot_page(
    snapshot: &ComicManifestSnapshot,
    offset: i64,
    page_size: i64,
) -> Result<
    (
        PortableManifestPage,
        Vec<PortableComicWorkDescriptor>,
        Vec<ComicDependencyV3>,
    ),
    AppError,
> {
    let (page, works) = page_snapshot(&snapshot.works, offset, page_size, snapshot.omitted_count)?;
    Ok((page, works, snapshot.dependencies.clone()))
}

fn novel_snapshot_page(
    snapshot: &NovelManifestSnapshot,
    offset: i64,
    page_size: i64,
) -> Result<
    (
        PortableManifestPage,
        Vec<PortableNovelWorkDescriptor>,
        Vec<NovelDependencyV3>,
    ),
    AppError,
> {
    let (page, works) = page_snapshot(&snapshot.works, offset, page_size, snapshot.omitted_count)?;
    Ok((page, works, snapshot.dependencies.clone()))
}

#[derive(Clone, Copy)]
enum SuwayomiManifestProfile {
    V21,
    V23,
}

impl SuwayomiManifestProfile {
    fn document(self) -> &'static str {
        match self {
            Self::V21 => MANIFEST_V21_QUERY,
            Self::V23 => MANIFEST_V23_QUERY,
        }
    }

    fn version_code_field(self) -> &'static str {
        match self {
            Self::V21 => "versionCode",
            Self::V23 => "versionCodeLong",
        }
    }

    fn store_index_field(self) -> Option<&'static str> {
        match self {
            Self::V21 => None,
            Self::V23 => Some("storeIndexUrl"),
        }
    }
}

async fn first_comic_manifest_page(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> Result<(Value, SuwayomiManifestProfile), AppError> {
    let variables = json!({ "first": MAX_PAGE_SIZE, "offset": 0 });
    match suwayomi_catalog::execute_graphql_document(
        state,
        session,
        MANIFEST_V23_QUERY,
        variables.clone(),
        false,
    )
    .await
    {
        Ok(data) => Ok((data, SuwayomiManifestProfile::V23)),
        Err(v23_error) => {
            if !is_manifest_query_compatibility_error(&v23_error)
                || runtime_supports_v23_manifest(state, session).await != Some(false)
            {
                return Err(v23_error);
            }
            let data = suwayomi_catalog::execute_graphql_document(
                state,
                session,
                MANIFEST_V21_QUERY,
                variables,
                false,
            )
            .await?;
            Ok((data, SuwayomiManifestProfile::V21))
        }
    }
}

async fn build_comic_manifest_snapshot(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> Result<ComicManifestSnapshot, AppError> {
    let (mut data, profile) = first_comic_manifest_page(state, session).await?;
    let runtime_fingerprint = suwayomi_extensions::runtime_fingerprint(&data);
    let mut expected_total = None;
    let mut offset = 0_i64;
    let mut omitted_count = 0_i64;
    let mut works = Vec::new();
    let mut bindings = Vec::new();
    let mut dependencies = BTreeMap::<String, ComicDependencyV3>::new();

    loop {
        if suwayomi_extensions::runtime_fingerprint(&data) != runtime_fingerprint {
            return Err(changed_manifest_snapshot_source());
        }
        let normalized = normalize_manifest(
            &data,
            profile.version_code_field(),
            profile.store_index_field(),
            offset,
            MAX_PAGE_SIZE,
        )?;
        let total_count =
            usize::try_from(normalized.page.total_count).map_err(|_| invalid_manifest())?;
        if total_count > MAX_MANIFEST_SNAPSHOT_ITEMS {
            return Err(manifest_snapshot_too_large());
        }
        if expected_total
            .replace(normalized.page.total_count)
            .is_some_and(|previous| previous != normalized.page.total_count)
        {
            return Err(changed_manifest_snapshot_source());
        }
        let source_count = manifest_source_item_count(&data)?;
        omitted_count = omitted_count.saturating_add(normalized.page.omitted_count);
        works.extend(normalized.works);
        bindings.extend(normalized.local_bindings);
        merge_comic_dependencies(&mut dependencies, normalized.dependencies)?;
        if !normalized.page.has_next_page {
            break;
        }
        offset = offset
            .checked_add(source_count)
            .ok_or_else(invalid_manifest)?;
        data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            profile.document(),
            json!({ "first": MAX_PAGE_SIZE, "offset": offset }),
            false,
        )
        .await?;
    }

    let unique_work_count = works
        .iter()
        .map(|work| work.portable_id.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    let expected_total = expected_total.unwrap_or_default();
    if unique_work_count != works.len()
        || i64::try_from(works.len())
            .ok()
            .and_then(|count| count.checked_add(omitted_count))
            != Some(expected_total)
    {
        return Err(changed_manifest_snapshot_source());
    }

    let local_references = bindings
        .iter()
        .map(|binding| binding.local_manga_id.to_string())
        .collect::<Vec<_>>();
    let bound = bindings
        .iter()
        .zip(&local_references)
        .map(|(binding, local_reference)| db::BoundPortableWork {
            portable_id: &binding.portable_id,
            reference: &binding.reference,
            dependency_key: binding.dependency_package_name.as_deref(),
            local_reference,
            title_hint: binding.title_hint.as_deref(),
            provider_label_hint: binding.provider_label_hint.as_deref(),
        })
        .collect::<Vec<_>>();
    db::upsert_bound_portable_works(&state.pool, &session.profile_id, &bound, db::now_ms())
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(ComicManifestSnapshot {
        runtime_fingerprint,
        omitted_count,
        dependencies: dependencies.into_values().collect(),
        works,
    })
}

fn manifest_source_item_count(data: &Value) -> Result<i64, AppError> {
    data.pointer("/mangas/nodes")
        .and_then(Value::as_array)
        .and_then(|nodes| i64::try_from(nodes.len()).ok())
        .ok_or_else(invalid_manifest)
}

fn merge_comic_dependencies(
    merged: &mut BTreeMap<String, ComicDependencyV3>,
    page_dependencies: Vec<ComicDependencyV3>,
) -> Result<(), AppError> {
    for dependency in page_dependencies {
        if let Some(current) = merged.get_mut(&dependency.pkg_name) {
            if current.observed_version_code != dependency.observed_version_code
                || current.extension_store != dependency.extension_store
            {
                return Err(changed_manifest_snapshot_source());
            }
            current
                .required_source_ids
                .extend(dependency.required_source_ids);
        } else {
            merged.insert(dependency.pkg_name.clone(), dependency);
        }
    }
    Ok(())
}

async fn build_novel_manifest_snapshot(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    scope_id: &str,
) -> Result<NovelManifestSnapshot, AppError> {
    let fingerprint_before = novel_manifest_fingerprint(state, scope_id).await?;
    let rows = sqlx::query(
        r#"SELECT novel_id, title, external_url, source_json
           FROM novel_library_entries
           WHERE scope_id = ?
             AND external_url IS NOT NULL
             AND external_url <> ''
             AND json_valid(source_json)
             AND json_type(source_json) = 'object'
             AND json_type(source_json, '$.pluginId') = 'text'
             AND length(json_extract(source_json, '$.pluginId')) > 0
           ORDER BY novel_id
           LIMIT ?"#,
    )
    .bind(scope_id)
    .bind((MAX_MANIFEST_SNAPSHOT_ITEMS + 1) as i64)
    .fetch_all(&state.pool)
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    if rows.len() > MAX_MANIFEST_SNAPSHOT_ITEMS {
        return Err(manifest_snapshot_too_large());
    }
    let repositories = load_novel_repositories(state, scope_id).await?;
    let plugins = load_novel_plugins(state, scope_id).await?;
    let mut omitted_count = 0_i64;
    let mut works = Vec::with_capacity(rows.len());
    let mut bindings = Vec::with_capacity(rows.len());
    let mut used_plugin_ids = BTreeSet::new();
    for row in rows {
        let novel_id: String = row
            .try_get("novel_id")
            .map_err(|_| invalid_novel_manifest())?;
        let title: String = row.try_get("title").map_err(|_| invalid_novel_manifest())?;
        let novel_key: String = row
            .try_get("external_url")
            .map_err(|_| invalid_novel_manifest())?;
        let source_json: String = row
            .try_get("source_json")
            .map_err(|_| invalid_novel_manifest())?;
        let source: Value =
            serde_json::from_str(&source_json).map_err(|_| invalid_novel_manifest())?;
        let plugin_id = source
            .get("pluginId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(invalid_novel_manifest)?
            .to_string();
        let reference = PortableWorkRefV3::Novel {
            plugin_id: plugin_id.clone(),
            novel_key,
        };
        if let Err(error) = reference.validate() {
            if error == "provider-owned key may contain private credentials" {
                omitted_count += 1;
                continue;
            }
            return Err(invalid_novel_manifest());
        }
        let portable_id = canonical_portable_work_id(&reference);
        let provider_label_hint = source
            .get("sourceName")
            .or_else(|| source.get("name"))
            .and_then(|value| optional_hint(Some(value)));
        let work = PortableNovelWorkDescriptor {
            portable_id: portable_id.clone(),
            reference: reference.clone(),
            dependency_plugin_id: plugin_id.clone(),
            title_hint: optional_hint(Some(&Value::String(title))),
            provider_label_hint: provider_label_hint.clone(),
        };
        bindings.push((
            portable_id,
            reference,
            plugin_id.clone(),
            novel_id,
            work.title_hint.clone(),
            provider_label_hint,
        ));
        used_plugin_ids.insert(plugin_id);
        works.push(work);
    }
    let dependencies = used_plugin_ids
        .into_iter()
        .map(|plugin_id| novel_dependency(&plugin_id, &plugins, &repositories))
        .collect::<Vec<_>>();
    for dependency in &dependencies {
        dependency
            .validate()
            .map_err(|_| invalid_novel_manifest())?;
    }
    if novel_manifest_fingerprint(state, scope_id).await? != fingerprint_before {
        return Err(changed_manifest_snapshot_source());
    }

    let bound = bindings
        .iter()
        .map(
            |(portable_id, reference, plugin_id, novel_id, title_hint, provider_label_hint)| {
                db::BoundPortableWork {
                    portable_id,
                    reference,
                    dependency_key: Some(plugin_id),
                    local_reference: novel_id,
                    title_hint: title_hint.as_deref(),
                    provider_label_hint: provider_label_hint.as_deref(),
                }
            },
        )
        .collect::<Vec<_>>();
    db::upsert_bound_portable_works(&state.pool, &session.profile_id, &bound, db::now_ms())
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(NovelManifestSnapshot {
        omitted_count,
        dependencies,
        works,
    })
}

#[derive(Clone)]
struct NovelRepositoryDescriptor {
    repository_id: String,
    canonical_url: String,
    name: String,
}

#[derive(Clone)]
struct NovelPluginDescriptor {
    repository_id: String,
    plugin_id: String,
    version: String,
    artifact_sha256: String,
}

async fn load_novel_repositories(
    state: &SharedAppState,
    scope_id: &str,
) -> Result<Vec<NovelRepositoryDescriptor>, AppError> {
    let rows = sqlx::query(
        "SELECT repository_id, canonical_url, name FROM novel_repositories WHERE scope_id = ? ORDER BY repository_id",
    )
    .bind(scope_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    rows.into_iter()
        .map(|row| {
            Ok(NovelRepositoryDescriptor {
                repository_id: row.try_get("repository_id")?,
                canonical_url: row.try_get("canonical_url")?,
                name: row.try_get("name")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(|error| AppError::Internal(error.to_string()))
}

async fn load_novel_plugins(
    state: &SharedAppState,
    scope_id: &str,
) -> Result<Vec<NovelPluginDescriptor>, AppError> {
    let rows = sqlx::query(
        "SELECT repository_id, plugin_id, version, artifact_sha256 FROM novel_plugins WHERE scope_id = ? AND enabled = 1 ORDER BY plugin_entity_id",
    )
    .bind(scope_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    rows.into_iter()
        .map(|row| {
            Ok(NovelPluginDescriptor {
                repository_id: row.try_get("repository_id")?,
                plugin_id: row.try_get("plugin_id")?,
                version: row.try_get("version")?,
                artifact_sha256: row.try_get("artifact_sha256")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn novel_dependency(
    plugin_id: &str,
    plugins: &[NovelPluginDescriptor],
    repositories: &[NovelRepositoryDescriptor],
) -> NovelDependencyV3 {
    let matches = plugins
        .iter()
        .filter(|plugin| plugin.plugin_id == plugin_id)
        .collect::<Vec<_>>();
    let exact = if matches.len() == 1 {
        matches.first().copied()
    } else {
        None
    };
    let repository = exact.and_then(|plugin| {
        repositories
            .iter()
            .find(|repository| repository.repository_id == plugin.repository_id)
            .and_then(|repository| {
                canonicalize_public_novel_repository_url(&repository.canonical_url).map(
                    |index_url| RepositoryReferenceV3 {
                        index_url,
                        observed_manifest_sha256: None,
                        display_name_hint: optional_hint(Some(&Value::String(
                            repository.name.clone(),
                        ))),
                    },
                )
            })
    });
    NovelDependencyV3 {
        plugin_id: plugin_id.to_string(),
        observed_version: exact.map(|plugin| plugin.version.clone()),
        repository,
        observed_artifact_sha256: exact.map(|plugin| plugin.artifact_sha256.clone()),
    }
}

async fn novel_manifest_fingerprint(
    state: &SharedAppState,
    scope_id: &str,
) -> Result<String, AppError> {
    let work_revision: (i64, i64) = sqlx::query_as(
        r#"SELECT COUNT(*), COALESCE(MAX(record_server_version), 0)
           FROM novel_library_entries
           WHERE scope_id = ?
             AND external_url IS NOT NULL
             AND external_url <> ''
             AND json_valid(source_json)
             AND json_type(source_json) = 'object'
             AND json_type(source_json, '$.pluginId') = 'text'
             AND length(json_extract(source_json, '$.pluginId')) > 0"#,
    )
    .bind(scope_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    let plugin_revision: (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(MAX(record_server_version), 0) FROM novel_plugins WHERE scope_id = ?",
    )
    .bind(scope_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    let repository_revision: (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(MAX(record_server_version), 0) FROM novel_repositories WHERE scope_id = ?",
    )
    .bind(scope_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    let canonical = serde_json::to_vec(&(
        scope_id,
        work_revision,
        plugin_revision,
        repository_revision,
    ))
    .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

struct NormalizedManifest {
    page: PortableManifestPage,
    dependencies: Vec<ComicDependencyV3>,
    works: Vec<PortableComicWorkDescriptor>,
    local_bindings: Vec<LocalWorkBinding>,
}

struct LocalWorkBinding {
    portable_id: String,
    reference: PortableWorkRefV3,
    dependency_package_name: Option<String>,
    local_manga_id: i64,
    title_hint: Option<String>,
    provider_label_hint: Option<String>,
}

#[derive(Clone)]
struct ManifestSourceDependencyHint {
    package_name: String,
    provider_label_hint: Option<String>,
}

fn normalize_manifest(
    data: &Value,
    version_code_field: &str,
    store_index_field: Option<&str>,
    offset: i64,
    page_size: i64,
) -> Result<NormalizedManifest, AppError> {
    let manga_connection = data
        .get("mangas")
        .and_then(Value::as_object)
        .ok_or_else(invalid_manifest)?;
    let manga_nodes = manga_connection
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(invalid_manifest)?;
    let total_count = manga_connection
        .get("totalCount")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or_else(invalid_manifest)?;
    let has_next_page = manga_connection
        .get("pageInfo")
        .and_then(Value::as_object)
        .and_then(|page_info| page_info.get("hasNextPage"))
        .and_then(Value::as_bool)
        .ok_or_else(invalid_manifest)?;
    let observed_end = offset
        .checked_add(manga_nodes.len() as i64)
        .ok_or_else(invalid_manifest)?;
    if manga_nodes.len() > page_size as usize
        || observed_end > total_count
        || (has_next_page && manga_nodes.is_empty())
        || (!has_next_page && observed_end != total_count)
    {
        return Err(invalid_manifest());
    }

    let stores = connection_nodes(data, "extensionStores")
        .filter_map(|store| {
            let index_url = sanitize_extension_store_url(text(store.get("indexUrl"))?)?;
            Some((index_url, optional_hint(store.get("name"))))
        })
        .collect::<BTreeMap<_, _>>();
    let mut extensions = connection_nodes(data, "extensions")
        .filter(|extension| extension.get("isInstalled").and_then(Value::as_bool) == Some(true))
        .filter_map(|extension| {
            let package_name = text(extension.get("pkgName"))?.to_string();
            let version_code = scalar_string(extension.get(version_code_field));
            // A V21 `repo` is Legacy provenance, not a Mihon Extension Store. Omitting it keeps
            // trust local and prevents a Legacy URL from masquerading as a modern store.
            let store_index_url = store_index_field
                .and_then(|field| text(extension.get(field)))
                .and_then(sanitize_extension_store_url);
            Some((package_name, (version_code, store_index_url)))
        })
        .collect::<BTreeMap<_, _>>();
    let mut source_dependency_hints = BTreeMap::<String, ManifestSourceDependencyHint>::new();
    for source in connection_nodes(data, "sources") {
        let Some(source_id) = scalar_string(source.get("id")) else {
            continue;
        };
        let Some(extension) = source.get("extension") else {
            continue;
        };
        if extension.get("isInstalled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(package_name) = text(extension.get("pkgName")).map(str::to_string) else {
            continue;
        };
        let hint = ManifestSourceDependencyHint {
            package_name: package_name.clone(),
            provider_label_hint: optional_hint(source.get("displayName"))
                .or_else(|| optional_hint(source.get("name"))),
        };
        if source_dependency_hints
            .insert(source_id, hint)
            .is_some_and(|previous| previous.package_name.as_str() != package_name.as_str())
        {
            return Err(invalid_manifest());
        }

        // The registered-source inventory is authoritative enough to recover provenance when
        // Manga.source is null. Keep the top-level extension catalog as the preferred metadata
        // source, but retain version/store hints from the registered source when it is absent.
        extensions.entry(package_name).or_insert_with(|| {
            let version_code = scalar_string(extension.get(version_code_field));
            let store_index_url = store_index_field
                .and_then(|field| text(extension.get(field)))
                .and_then(sanitize_extension_store_url);
            (version_code, store_index_url)
        });
    }

    let mut omitted_count = 0_i64;
    let mut works = Vec::with_capacity(manga_nodes.len());
    let mut local_bindings = Vec::with_capacity(manga_nodes.len());
    let mut required_sources = BTreeMap::<String, BTreeSet<String>>::new();
    for manga in manga_nodes {
        let local_manga_id = manga
            .get("id")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .ok_or_else(invalid_manifest)?;
        let source_id = scalar_string(manga.get("sourceId")).ok_or_else(invalid_manifest)?;
        let manga_key = text(manga.get("url"))
            .ok_or_else(invalid_manifest)?
            .to_string();
        let reference = PortableWorkRefV3::Comic {
            source_id: source_id.clone(),
            manga_key,
        };
        if let Err(error) = reference.validate() {
            if error == "provider-owned key may contain private credentials" {
                omitted_count += 1;
                continue;
            }
            return Err(invalid_manifest());
        }
        let inventory_hint = source_dependency_hints.get(&source_id);
        let package_name = manga
            .pointer("/source/extension/pkgName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| inventory_hint.map(|hint| hint.package_name.clone()));
        if let Some(package_name) = package_name.as_ref() {
            required_sources
                .entry(package_name.clone())
                .or_default()
                .insert(source_id);
        }
        let portable_id = canonical_portable_work_id(&reference);
        let title_hint = optional_hint(manga.get("title"));
        let provider_label_hint = optional_hint(manga.pointer("/source/displayName"))
            .or_else(|| optional_hint(manga.pointer("/source/name")))
            .or_else(|| inventory_hint.and_then(|hint| hint.provider_label_hint.clone()));
        works.push(PortableComicWorkDescriptor {
            portable_id: portable_id.clone(),
            reference: reference.clone(),
            dependency_package_name: package_name.clone(),
            title_hint: title_hint.clone(),
            provider_label_hint: provider_label_hint.clone(),
        });
        local_bindings.push(LocalWorkBinding {
            portable_id,
            reference,
            dependency_package_name: package_name,
            local_manga_id,
            title_hint,
            provider_label_hint,
        });
    }

    let mut dependencies = Vec::with_capacity(required_sources.len());
    for (pkg_name, required_source_ids) in required_sources {
        let (observed_version_code, store_index_url) =
            extensions.get(&pkg_name).cloned().unwrap_or_default();
        let extension_store = store_index_url.map(|store_index_url| ExtensionStoreReferenceV3 {
            display_name_hint: stores.get(&store_index_url).cloned().flatten(),
            store_index_url,
            observed_manifest_sha256: None,
        });
        let dependency = ComicDependencyV3 {
            pkg_name,
            required_source_ids,
            observed_version_code,
            extension_store,
        };
        dependency.validate().map_err(|_| invalid_manifest())?;
        dependencies.push(dependency);
    }

    Ok(NormalizedManifest {
        page: PortableManifestPage {
            offset,
            page_size,
            has_next_page,
            total_count,
            omitted_count,
        },
        dependencies,
        works,
        local_bindings,
    })
}

fn connection_nodes<'a>(data: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    data.get(key)
        .and_then(|value| value.get("nodes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn scalar_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    value?.as_str().filter(|value| !value.is_empty())
}

fn optional_hint(value: Option<&Value>) -> Option<String> {
    text(value)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
        })
        .map(str::to_string)
}

fn is_manifest_query_compatibility_error(error: &AppError) -> bool {
    matches!(
        error,
        AppError::ServiceUnavailable(detail)
            if detail.code == "SUWAYOMI_CATALOG_QUERY_FAILED"
    )
}

pub(crate) async fn runtime_supports_v23_manifest(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> Option<bool> {
    let query_capabilities = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        MANIFEST_CAPABILITIES_QUERY,
        json!({}),
        false,
    )
    .await
    .ok()?;
    let query_fields = query_capabilities
        .pointer("/__schema/queryType/fields")?
        .as_array()?
        .iter()
        .filter_map(|field| text(field.get("name")))
        .collect::<BTreeSet<_>>();
    if !query_fields.contains("extensionStores") {
        return Some(false);
    }

    let extension_capabilities = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        MANIFEST_EXTENSION_CAPABILITIES_QUERY,
        json!({}),
        false,
    )
    .await
    .ok()?;
    let extension_fields = extension_capabilities
        .pointer("/extensionType/fields")?
        .as_array()?
        .iter()
        .filter_map(|field| text(field.get("name")))
        .collect::<BTreeSet<_>>();
    Some(extension_fields.contains("versionCodeLong") && extension_fields.contains("storeIndexUrl"))
}

#[cfg(test)]
fn manifest_v23_capability(data: &Value) -> Option<bool> {
    let query_fields = data
        .pointer("/__schema/queryType/fields")?
        .as_array()?
        .iter()
        .filter_map(|field| text(field.get("name")))
        .collect::<BTreeSet<_>>();
    let extension_fields = data
        .pointer("/extensionType/fields")?
        .as_array()?
        .iter()
        .filter_map(|field| text(field.get("name")))
        .collect::<BTreeSet<_>>();
    Some(
        query_fields.contains("extensionStores")
            && extension_fields.contains("versionCodeLong")
            && extension_fields.contains("storeIndexUrl"),
    )
}

pub(crate) fn sanitize_extension_store_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    match url.host()? {
        Host::Domain(host) if is_private_hostname(host) => return None,
        Host::Ipv4(address) if is_private_ip(IpAddr::V4(address)) => return None,
        Host::Ipv6(address) if is_private_ip(IpAddr::V6(address)) => return None,
        _ => {}
    }
    Some(url.to_string())
}

fn is_private_hostname(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    !host.contains('.')
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".lan")
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => {
            let octets = address.octets();
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_multicast()
                || address.is_unspecified()
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(address) => {
            let first = address.segments()[0];
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

fn invalid_manifest() -> AppError {
    AppError::service_unavailable(
        "SUWAYOMI_PORTABLE_MANIFEST_INVALID",
        "The comics runtime returned an invalid portable manifest.",
        true,
    )
}

fn invalid_novel_manifest() -> AppError {
    AppError::service_unavailable(
        "LNREADER_PORTABLE_MANIFEST_INVALID",
        "The novels profile returned an invalid portable manifest.",
        true,
    )
}

fn manifest_snapshot_conflict(code: &str, message: &str) -> AppError {
    AppError::Conflict(ErrorDetail {
        code: code.to_string(),
        message: message.to_string(),
        retryable: Some(true),
        min_client_version: None,
        current_server_version: None,
        min_replayable_server_version: None,
        required_action: Some("full_bootstrap".to_string()),
        details: None,
    })
}

fn invalid_manifest_snapshot() -> AppError {
    manifest_snapshot_conflict(
        "PORTABLE_MANIFEST_SNAPSHOT_INVALID",
        "The portable manifest snapshot is invalid or belongs to another session.",
    )
}

fn expired_manifest_snapshot() -> AppError {
    AppError::Gone(ErrorDetail {
        code: "PORTABLE_MANIFEST_SNAPSHOT_EXPIRED".to_string(),
        message: "The portable manifest snapshot expired. Start the bootstrap again.".to_string(),
        retryable: Some(true),
        min_client_version: None,
        current_server_version: None,
        min_replayable_server_version: None,
        required_action: Some("full_bootstrap".to_string()),
        details: None,
    })
}

fn changed_manifest_snapshot_source() -> AppError {
    manifest_snapshot_conflict(
        "PORTABLE_MANIFEST_SOURCE_CHANGED",
        "The portable manifest changed while its snapshot was being created. Try again.",
    )
}

fn manifest_snapshot_too_large() -> AppError {
    AppError::service_unavailable(
        "PORTABLE_MANIFEST_SNAPSHOT_TOO_LARGE",
        "The portable manifest is too large to snapshot safely.",
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The snapshot cache is shared by the whole process. Tests that store into it take turns,
    /// so one test's purge of expired entries cannot remove the entry another test is checking.
    fn snapshot_cache_turn() -> std::sync::MutexGuard<'static, ()> {
        static TURN: Mutex<()> = Mutex::new(());
        TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn test_session(token_id: &str, device_id: &str) -> AuthenticatedSession {
        AuthenticatedSession {
            token_id: token_id.to_string(),
            device_id: device_id.to_string(),
            profile_id: "main".to_string(),
            scopes: BTreeSet::from([
                "comics:profile:main".to_string(),
                "novels:profile:main".to_string(),
            ]),
            mutation_receipt: None,
        }
    }

    fn test_comic_snapshot() -> ComicManifestSnapshot {
        ComicManifestSnapshot {
            runtime_fingerprint: "sha256:runtime".to_string(),
            omitted_count: 0,
            dependencies: vec![ComicDependencyV3 {
                pkg_name: "ext.snapshot".to_string(),
                required_source_ids: BTreeSet::from(["10".to_string(), "11".to_string()]),
                observed_version_code: Some("7".to_string()),
                extension_store: None,
            }],
            works: (0..3)
                .map(|index| {
                    let reference = PortableWorkRefV3::Comic {
                        source_id: "10".to_string(),
                        manga_key: format!("/manga/{index}"),
                    };
                    PortableComicWorkDescriptor {
                        portable_id: canonical_portable_work_id(&reference),
                        reference,
                        dependency_package_name: None,
                        title_hint: None,
                        provider_label_hint: None,
                    }
                })
                .collect(),
        }
    }

    fn test_novel_snapshot() -> NovelManifestSnapshot {
        NovelManifestSnapshot {
            omitted_count: 0,
            dependencies: vec![NovelDependencyV3 {
                plugin_id: "plugin.snapshot".to_string(),
                observed_version: Some("1.0.0".to_string()),
                repository: None,
                observed_artifact_sha256: None,
            }],
            works: (0..3)
                .map(|index| {
                    let reference = PortableWorkRefV3::Novel {
                        plugin_id: "plugin.snapshot".to_string(),
                        novel_key: format!("/novel/{index}"),
                    };
                    PortableNovelWorkDescriptor {
                        portable_id: canonical_portable_work_id(&reference),
                        reference,
                        dependency_plugin_id: "plugin.snapshot".to_string(),
                        title_hint: None,
                        provider_label_hint: None,
                    }
                })
                .collect(),
        }
    }

    #[test]
    fn following_page_requires_the_original_snapshot() {
        assert!(require_new_snapshot_request(0, None).is_ok());
        assert!(matches!(
            require_new_snapshot_request(1, None),
            Err(AppError::Conflict(detail))
                if detail.code == "PORTABLE_MANIFEST_SNAPSHOT_REQUIRED"
        ));
    }

    #[test]
    fn snapshot_pages_are_immutable_slices() {
        let snapshot = test_comic_snapshot();
        let (first, first_works, first_dependencies) =
            comic_snapshot_page(&snapshot, 0, 2).unwrap();
        let (second, second_works, second_dependencies) =
            comic_snapshot_page(&snapshot, 2, 2).unwrap();

        assert_eq!(first.total_count, 3);
        assert!(first.has_next_page);
        assert_eq!(first_works.len(), 2);
        assert!(!second.has_next_page);
        assert_eq!(second_works.len(), 1);
        assert_ne!(first_works[0].portable_id, second_works[0].portable_id);
        assert_eq!(first_dependencies, snapshot.dependencies);
        assert_eq!(second_dependencies, snapshot.dependencies);
        assert_eq!(
            second_dependencies[0].required_source_ids,
            BTreeSet::from(["10".to_string(), "11".to_string()]),
        );
    }

    #[test]
    fn novel_resume_page_repeats_the_complete_dependency_set() {
        let snapshot = test_novel_snapshot();
        let (_, _, first_dependencies) = novel_snapshot_page(&snapshot, 0, 2).unwrap();
        let (_, second_works, second_dependencies) = novel_snapshot_page(&snapshot, 2, 2).unwrap();

        assert_eq!(second_works.len(), 1);
        assert_eq!(first_dependencies, snapshot.dependencies);
        assert_eq!(second_dependencies, snapshot.dependencies);
        assert_eq!(second_dependencies[0].plugin_id, "plugin.snapshot");
    }

    #[test]
    fn snapshot_rejects_changed_fingerprint_or_different_session() {
        let _cache = snapshot_cache_turn();
        let session = test_session("token-a", "device-a");
        let entry = store_manifest_snapshot(
            &session,
            "comics:profile:main",
            ManifestSnapshotPayload::Comics(Arc::new(test_comic_snapshot())),
        )
        .unwrap();

        assert!(matches!(
            load_manifest_snapshot(
                &entry.snapshot_id,
                Some("sha256:tampered"),
                &session,
                "comics:profile:main",
                ManifestSnapshotType::Comics,
            ),
            Err(AppError::Conflict(detail))
                if detail.code == "PORTABLE_MANIFEST_SNAPSHOT_INVALID"
        ));
        assert!(load_manifest_snapshot(
            &entry.snapshot_id,
            Some(&entry.fingerprint),
            &test_session("token-b", "device-a"),
            "comics:profile:main",
            ManifestSnapshotType::Comics,
        )
        .is_err());
    }

    #[test]
    fn expired_snapshot_is_removed_and_rejected() {
        let _cache = snapshot_cache_turn();
        let session = test_session("token-expired", "device-expired");
        let mut entry = store_manifest_snapshot(
            &session,
            "comics:profile:main",
            ManifestSnapshotPayload::Comics(Arc::new(test_comic_snapshot())),
        )
        .unwrap();
        entry.expires_at_ms = db::now_ms() - 1;
        manifest_snapshot_cache()
            .lock()
            .unwrap()
            .entries
            .insert(entry.snapshot_id.clone(), entry.clone());

        assert!(matches!(
            load_manifest_snapshot(
                &entry.snapshot_id,
                Some(&entry.fingerprint),
                &session,
                "comics:profile:main",
                ManifestSnapshotType::Comics,
            ),
            Err(AppError::Gone(detail))
                if detail.code == "PORTABLE_MANIFEST_SNAPSHOT_EXPIRED"
        ));
        assert!(!manifest_snapshot_cache()
            .lock()
            .unwrap()
            .entries
            .contains_key(&entry.snapshot_id));
    }

    #[test]
    fn reading_a_snapshot_page_extends_its_expiry() {
        let _cache = snapshot_cache_turn();
        let session = test_session("token-sliding", "device-sliding");
        let mut entry = store_manifest_snapshot(
            &session,
            "comics:profile:main",
            ManifestSnapshotPayload::Comics(Arc::new(test_comic_snapshot())),
        )
        .unwrap();
        entry.expires_at_ms = db::now_ms() + 1_000;
        manifest_snapshot_cache()
            .lock()
            .unwrap()
            .entries
            .insert(entry.snapshot_id.clone(), entry.clone());

        let loaded = load_manifest_snapshot(
            &entry.snapshot_id,
            Some(&entry.fingerprint),
            &session,
            "comics:profile:main",
            ManifestSnapshotType::Comics,
        )
        .unwrap();

        assert!(loaded.expires_at_ms > entry.expires_at_ms + 60_000);
        assert_eq!(
            manifest_snapshot_cache().lock().unwrap().entries[&entry.snapshot_id].expires_at_ms,
            loaded.expires_at_ms
        );
    }

    #[test]
    fn manifest_uses_opaque_keys_and_groups_required_sources_by_extension() {
        let data = json!({
            "aboutServer": { "version": "2.3.2243", "revision": "abc", "buildType": "Stable" },
            "mangas": {
                "totalCount": 2,
                "pageInfo": { "hasNextPage": false },
                "nodes": [
                    {
                        "id": 42,
                        "sourceId": "-10",
                        "url": "/manga/Path?chapter=A%2FB",
                        "title": "Hint only",
                        "source": { "name": "Source A", "displayName": "Source A (EN)", "extension": { "pkgName": "ext.demo" } }
                    },
                    {
                        "id": 43,
                        "sourceId": "11",
                        "url": "Case/Sensitive",
                        "title": "Second",
                        "source": { "name": "Source B", "extension": { "pkgName": "ext.demo" } }
                    }
                ]
            },
            "extensions": { "nodes": [
                { "pkgName": "ext.demo", "versionCodeLong": "7", "isInstalled": true, "storeIndexUrl": "https://store.example/index.min.json" }
            ] },
            "extensionStores": { "nodes": [
                { "indexUrl": "https://store.example/index.min.json", "name": "Example" }
            ] }
        });

        let manifest =
            normalize_manifest(&data, "versionCodeLong", Some("storeIndexUrl"), 0, 100).unwrap();
        assert_eq!(manifest.works.len(), 2);
        assert_eq!(
            manifest.works[0].reference,
            PortableWorkRefV3::Comic {
                source_id: "-10".to_string(),
                manga_key: "/manga/Path?chapter=A%2FB".to_string(),
            }
        );
        assert_ne!(manifest.works[0].portable_id, manifest.works[1].portable_id);
        assert_eq!(manifest.dependencies.len(), 1);
        assert_eq!(
            manifest.dependencies[0].required_source_ids,
            BTreeSet::from(["-10".to_string(), "11".to_string(),])
        );
        assert_eq!(
            manifest.dependencies[0]
                .extension_store
                .as_ref()
                .map(|store| store.store_index_url.as_str()),
            Some("https://store.example/index.min.json"),
        );
    }

    #[test]
    fn manifest_recovers_dependencies_from_registered_sources_when_manga_source_is_null() {
        let data = json!({
            "mangas": {
                "totalCount": 3,
                "pageInfo": { "hasNextPage": false },
                "nodes": [
                    {
                        "id": 1,
                        "sourceId": "10",
                        "url": "/title/mangadex",
                        "title": "MangaDex title",
                        "source": null
                    },
                    {
                        "id": 2,
                        "sourceId": "20",
                        "url": "/title/flame",
                        "title": "Flame title",
                        "source": null
                    },
                    {
                        "id": 3,
                        "sourceId": "30",
                        "url": "/title/webtoons",
                        "title": "Webtoons title",
                        "source": null
                    }
                ]
            },
            "sources": { "nodes": [
                {
                    "id": "10",
                    "name": "MangaDex",
                    "displayName": "MangaDex (EN)",
                    "extension": {
                        "pkgName": "eu.kanade.tachiyomi.extension.all.mangadex",
                        "versionCodeLong": "100",
                        "isInstalled": true,
                        "storeIndexUrl": "https://store.example/index.min.json"
                    }
                },
                {
                    "id": "20",
                    "name": "Flame Comics",
                    "extension": {
                        "pkgName": "eu.kanade.tachiyomi.extension.en.flamecomics",
                        "versionCodeLong": "200",
                        "isInstalled": true,
                        "storeIndexUrl": "https://store.example/index.min.json"
                    }
                },
                {
                    "id": "30",
                    "name": "Webtoons.com",
                    "extension": {
                        "pkgName": "eu.kanade.tachiyomi.extension.all.webtoons",
                        "versionCodeLong": "300",
                        "isInstalled": true,
                        "storeIndexUrl": "https://store.example/index.min.json"
                    }
                }
            ] },
            "extensions": { "nodes": [] },
            "extensionStores": { "nodes": [
                { "indexUrl": "https://store.example/index.min.json", "name": "Example" }
            ] }
        });

        let manifest =
            normalize_manifest(&data, "versionCodeLong", Some("storeIndexUrl"), 0, 100).unwrap();

        assert_eq!(manifest.works.len(), 3);
        assert_eq!(manifest.dependencies.len(), 3);
        assert_eq!(
            manifest
                .works
                .iter()
                .map(|work| work.dependency_package_name.as_deref().unwrap())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                "eu.kanade.tachiyomi.extension.all.mangadex",
                "eu.kanade.tachiyomi.extension.all.webtoons",
                "eu.kanade.tachiyomi.extension.en.flamecomics",
            ])
        );
        assert_eq!(
            manifest.works[0].provider_label_hint.as_deref(),
            Some("MangaDex (EN)")
        );
        for dependency in &manifest.dependencies {
            assert!(dependency.observed_version_code.is_some());
            assert_eq!(
                dependency
                    .extension_store
                    .as_ref()
                    .map(|store| store.store_index_url.as_str()),
                Some("https://store.example/index.min.json")
            );
        }
        assert!(manifest
            .local_bindings
            .iter()
            .all(|binding| binding.dependency_package_name.is_some()));
    }

    #[test]
    fn manifest_rejects_a_noncanonical_source_id() {
        let data = json!({
            "mangas": {
                "totalCount": 1,
                "pageInfo": { "hasNextPage": false },
                "nodes": [{
                    "id": 1,
                    "sourceId": "01",
                    "url": "/manga/a",
                    "source": { "name": "A", "extension": { "pkgName": "ext.demo" } }
                }]
            },
            "extensions": { "nodes": [] }
        });
        assert!(
            normalize_manifest(&data, "versionCodeLong", Some("storeIndexUrl"), 0, 100).is_err()
        );
    }

    #[test]
    fn manifest_omits_secret_bearing_provider_keys_without_exposing_them() {
        let data = json!({
            "mangas": {
                "totalCount": 2,
                "pageInfo": { "hasNextPage": false },
                "nodes": [
                    {
                        "id": 1,
                        "sourceId": "10",
                        "url": "/manga/private?token=secret",
                        "source": { "name": "Private", "extension": { "pkgName": "ext.demo" } }
                    },
                    {
                        "id": 2,
                        "sourceId": "10",
                        "url": "/manga/public?chapter=one",
                        "source": { "name": "Public", "extension": { "pkgName": "ext.demo" } }
                    }
                ]
            },
            "extensions": { "nodes": [
                { "pkgName": "ext.demo", "versionCodeLong": "1", "isInstalled": true }
            ] }
        });

        let manifest =
            normalize_manifest(&data, "versionCodeLong", Some("storeIndexUrl"), 0, 100).unwrap();

        assert_eq!(manifest.page.omitted_count, 1);
        assert_eq!(manifest.works.len(), 1);
        assert_eq!(
            manifest.works[0].reference,
            PortableWorkRefV3::Comic {
                source_id: "10".to_string(),
                manga_key: "/manga/public?chapter=one".to_string(),
            },
        );
        assert!(!serde_json::to_string(&manifest.works)
            .unwrap()
            .contains("secret"));
    }

    #[test]
    fn extension_store_url_is_normalized_only_when_public_and_credential_free() {
        assert_eq!(
            sanitize_extension_store_url(" https://store.example:443/index.min.json "),
            Some("https://store.example/index.min.json".to_string())
        );
        for rejected in [
            "not a url",
            "http://store.example/index.json",
            "https://user:secret@store.example/index.json",
            "https://store.example/index.json?token=secret",
            "https://store.example/index.json#private",
            "https://localhost/index.json",
            "https://repo.local/index.json",
            "https://127.0.0.1/index.json",
            "https://10.0.0.8/index.json",
            "https://[::1]/index.json",
            "https://[fd00::1]/index.json",
        ] {
            assert_eq!(
                sanitize_extension_store_url(rejected),
                None,
                "accepted unsafe store URL: {rejected}"
            );
        }
    }

    #[test]
    fn unsafe_extension_store_provenance_is_omitted_from_the_wire_model() {
        let data = json!({
            "mangas": {
                "totalCount": 1,
                "pageInfo": { "hasNextPage": false },
                "nodes": [{
                    "id": 1,
                    "sourceId": "10",
                    "url": "/manga/a",
                    "source": { "name": "A", "extension": { "pkgName": "ext.demo" } }
                }]
            },
            "extensions": { "nodes": [{
                "pkgName": "ext.demo",
                "versionCodeLong": "1",
                "isInstalled": true,
                "storeIndexUrl": "https://user:secret@127.0.0.1/index.json?token=secret"
            }] },
            "extensionStores": { "nodes": [{
                "indexUrl": "https://user:secret@127.0.0.1/index.json?token=secret",
                "name": "Private"
            }] }
        });

        let manifest =
            normalize_manifest(&data, "versionCodeLong", Some("storeIndexUrl"), 0, 100).unwrap();

        assert!(manifest.dependencies[0].extension_store.is_none());
    }

    #[test]
    fn v21_repo_is_not_promoted_to_a_modern_extension_store() {
        let data = json!({
            "mangas": {
                "totalCount": 1,
                "pageInfo": { "hasNextPage": false },
                "nodes": [{
                    "id": 1,
                    "sourceId": "10",
                    "url": "/manga/one",
                    "title": "One",
                    "source": null
                }]
            },
            "sources": { "nodes": [{
                "id": "10",
                "name": "Legacy Source",
                "extension": {
                    "pkgName": "ext.legacy",
                    "versionCode": 7,
                    "isInstalled": true,
                    "repo": "https://legacy.example/index.min.json"
                }
            }] },
            "extensions": { "nodes": [{
                "pkgName": "ext.legacy",
                "versionCode": 7,
                "isInstalled": true,
                "repo": "https://legacy.example/index.min.json"
            }] }
        });

        let manifest = normalize_manifest(&data, "versionCode", None, 0, 100).unwrap();

        assert_eq!(
            manifest.works[0].dependency_package_name.as_deref(),
            Some("ext.legacy")
        );
        assert_eq!(
            manifest.dependencies[0].observed_version_code.as_deref(),
            Some("7")
        );
        assert!(manifest.dependencies[0].extension_store.is_none());
    }

    #[test]
    fn v21_fallback_requires_a_query_compatibility_error() {
        assert!(is_manifest_query_compatibility_error(
            &AppError::service_unavailable(
                "SUWAYOMI_CATALOG_QUERY_FAILED",
                "schema mismatch",
                false,
            )
        ));
        assert!(!is_manifest_query_compatibility_error(
            &AppError::Unauthorized("invalid token".to_string())
        ));
        assert!(!is_manifest_query_compatibility_error(
            &AppError::service_unavailable(
                "SUWAYOMI_CATALOG_UNAVAILABLE",
                "timeout or runtime failure",
                true,
            )
        ));
    }

    #[test]
    fn v23_capability_must_be_proven_before_suppressing_its_query_error() {
        let supported = json!({
            "__schema": { "queryType": { "fields": [
                { "name": "extensions" }, { "name": "extensionStores" }
            ] } },
            "extensionType": { "fields": [
                { "name": "versionCodeLong" }, { "name": "storeIndexUrl" }
            ] }
        });
        let legacy = json!({
            "__schema": { "queryType": { "fields": [{ "name": "extensions" }] } },
            "extensionType": { "fields": [{ "name": "versionCode" }] }
        });

        assert_eq!(manifest_v23_capability(&supported), Some(true));
        assert_eq!(manifest_v23_capability(&legacy), Some(false));
        assert_eq!(manifest_v23_capability(&json!({})), None);
    }

    #[test]
    fn novel_dependency_uses_plugin_identity_and_repository_only_as_provenance() {
        let repositories = vec![NovelRepositoryDescriptor {
            repository_id: "repo-1".to_string(),
            canonical_url: "https://repo.example/.dist/plugins.min.json".to_string(),
            name: "Example".to_string(),
        }];
        let plugins = vec![NovelPluginDescriptor {
            repository_id: "repo-1".to_string(),
            plugin_id: "lnreader.plugin".to_string(),
            version: "1.2.3".to_string(),
            artifact_sha256: "a".repeat(64),
        }];

        let dependency = novel_dependency("lnreader.plugin", &plugins, &repositories);

        assert_eq!(dependency.plugin_id, "lnreader.plugin");
        assert_eq!(dependency.observed_version.as_deref(), Some("1.2.3"));
        assert_eq!(
            dependency
                .repository
                .as_ref()
                .map(|value| value.index_url.as_str()),
            Some("https://repo.example/.dist/plugins.min.json"),
        );
    }

    #[test]
    fn private_novel_repository_remains_local_and_is_omitted_from_portable_provenance() {
        let repositories = vec![NovelRepositoryDescriptor {
            repository_id: "repo-local".to_string(),
            canonical_url: "https://192.168.1.10/plugins.min.json".to_string(),
            name: "Local repository".to_string(),
        }];
        let plugins = vec![NovelPluginDescriptor {
            repository_id: "repo-local".to_string(),
            plugin_id: "lnreader.local".to_string(),
            version: "1".to_string(),
            artifact_sha256: "a".repeat(64),
        }];

        let dependency = novel_dependency("lnreader.local", &plugins, &repositories);

        assert_eq!(dependency.plugin_id, "lnreader.local");
        assert!(dependency.repository.is_none());
    }

    #[test]
    fn ambiguous_plugin_provenance_is_not_guessed() {
        let repositories = vec![];
        let plugins = vec![
            NovelPluginDescriptor {
                repository_id: "repo-a".to_string(),
                plugin_id: "same.plugin".to_string(),
                version: "1".to_string(),
                artifact_sha256: "a".repeat(64),
            },
            NovelPluginDescriptor {
                repository_id: "repo-b".to_string(),
                plugin_id: "same.plugin".to_string(),
                version: "2".to_string(),
                artifact_sha256: "b".repeat(64),
            },
        ];

        let dependency = novel_dependency("same.plugin", &plugins, &repositories);

        assert_eq!(dependency.plugin_id, "same.plugin");
        assert!(dependency.repository.is_none());
        assert!(dependency.observed_version.is_none());
        assert!(dependency.observed_artifact_sha256.is_none());
    }
}
