use axum::extract::{Extension, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

use crate::syncd::db;
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState};
use crate::syncd::routes::{suwayomi_catalog, suwayomi_import};

const COMMAND_SCHEMA_VERSION: u32 = 1;
/// Chapters one `UpdateChaptersProgress` command names at most.
pub(crate) const MAX_CHAPTER_IDS: usize = 250;
const CATEGORY_LOOKUP_PAGE_SIZE: i64 = 100;
const MAX_CATEGORY_LOOKUP_PAGES: usize = 20;

const UPDATE_MANGA_QUERY: &str = r#"
  mutation UpdateManga($id: Int!, $inLibrary: Boolean) {
    updateManga(input: { id: $id, patch: { inLibrary: $inLibrary } }) {
      manga { id inLibrary }
    }
  }
"#;

const UPDATE_MANGA_CATEGORIES_QUERY: &str = r#"
  mutation UpdateMangaCategories($mangaId: Int!, $addTo: [Int!]!, $removeFrom: [Int!]!) {
    updateMangaCategories(input: {
      id: $mangaId,
      patch: { addToCategories: $addTo, removeFromCategories: $removeFrom }
    }) {
      manga { id }
    }
  }
"#;

const UPDATE_CHAPTERS_PROGRESS_QUERY: &str = r#"
  mutation UpdateChaptersProgress(
    $ids: [Int!]!,
    $isRead: Boolean,
    $isBookmarked: Boolean,
    $lastPageRead: Int
  ) {
    updateChapters(input: {
      ids: $ids,
      patch: {
        isRead: $isRead,
        isBookmarked: $isBookmarked,
        lastPageRead: $lastPageRead
      }
    }) {
      chapters { id isRead isBookmarked lastPageRead }
    }
  }
"#;

const UPDATE_CATEGORY_QUERY: &str = r#"
  mutation UpdateCategory($id: Int!, $name: String) {
    updateCategory(input: { id: $id, patch: { name: $name } }) {
      category { id name order }
    }
  }
"#;

const DELETE_CATEGORY_QUERY: &str = r#"
  mutation DeleteCategory($id: Int!) {
    deleteCategory(input: { categoryId: $id }) {
      category { id }
    }
  }
"#;

const CREATE_CATEGORY_QUERY: &str = r#"
  mutation CreateCategory($name: String!) {
    createCategory(input: { name: $name }) {
      category { id name order }
    }
  }
"#;

const CATEGORY_LOOKUP_QUERY: &str = r#"
  query EpigraphLookupCategories($first: Int!, $offset: Int!) {
    categories(first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id name order }
    }
  }
"#;

const UPDATE_CATEGORY_ORDER_QUERY: &str = r#"
  mutation UpdateCategoryOrder($id: Int!, $position: Int!) {
    updateCategoryOrder(input: { id: $id, position: $position }) {
      categories { id name order }
    }
  }
"#;

const EXTENSION_REPOS_QUERY: &str = r#"
  query EpigraphExtensionRepos {
    settings { extensionRepos }
  }
"#;

const SET_EXTENSION_REPOS_QUERY: &str = r#"
  mutation EpigraphSetExtensionRepos($repos: [String!]!) {
    setSettings(input: { settings: { extensionRepos: $repos } }) {
      settings { extensionRepos }
    }
  }
"#;

const EXTENSION_STORES_QUERY: &str = r#"
  query EpigraphExtensionStores {
    extensionStores { nodes { indexUrl } }
  }
"#;

const ADD_EXTENSION_STORE_QUERY: &str = r#"
  mutation EpigraphAddExtensionStore($indexUrl: String!) {
    addExtensionStore(input: { indexUrl: $indexUrl }) {
      extensionStore { indexUrl }
    }
  }
"#;

const LIST_EXTENSIONS_QUERY: &str = r#"
  query EpigraphListExtensions {
    extensions {
      nodes { pkgName apkName isInstalled }
    }
  }
"#;

const FETCH_EXTENSIONS_QUERY: &str = r#"
  mutation EpigraphFetchExtensions {
    fetchExtensions(input: {}) {
      extensions { pkgName apkName isInstalled }
    }
  }
"#;

const INSTALL_EXTENSION_QUERY: &str = r#"
  mutation EpigraphInstallExtension($id: String!) {
    updateExtension(input: { id: $id, patch: { install: true } }) {
      extension { pkgName isInstalled }
    }
  }
"#;

const RESOLVE_MANGA_LOOKUP_QUERY: &str = r#"
  query EpigraphResolveManga($sourceId: LongString!, $url: String!) {
    mangas(condition: { sourceId: $sourceId, url: $url }, first: 2) {
      nodes { id url inLibrary }
    }
  }
"#;

const RESOLVE_MANGA_SEARCH_QUERY: &str = r#"
  mutation EpigraphResolveMangaSearch($source: LongString!, $query: String!) {
    fetchSourceManga(input: { source: $source, type: SEARCH, query: $query, page: 1 }) {
      mangas { id url inLibrary }
    }
  }
"#;

const FETCH_CHAPTERS_QUERY: &str = r#"
  mutation EpigraphFetchChapters($mangaId: Int!) {
    fetchChapters(input: { mangaId: $mangaId }) {
      chapters { id }
    }
  }
"#;

const MAX_EXTENSION_REPOS: usize = 20;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum CommandOperation {
    #[serde(rename = "UpdateManga")]
    UpdateManga,
    #[serde(rename = "UpdateMangaCategories")]
    UpdateMangaCategories,
    #[serde(rename = "UpdateChaptersProgress")]
    UpdateChaptersProgress,
    #[serde(rename = "UpdateCategory")]
    UpdateCategory,
    #[serde(rename = "DeleteCategory")]
    DeleteCategory,
    #[serde(rename = "UpdateCategoryOrder")]
    UpdateCategoryOrder,
    #[serde(rename = "CreateCategory")]
    CreateCategory,
    #[serde(rename = "AddExtensionRepos")]
    AddExtensionRepos,
    #[serde(rename = "InstallExtension")]
    InstallExtension,
    #[serde(rename = "ResolveManga")]
    ResolveManga,
    #[serde(rename = "FetchChapters")]
    FetchChapters,
    #[serde(rename = "ImportWorks")]
    ImportWorks,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandQuery {
    pub scope_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRequest {
    pub operation: CommandOperation,
    pub variables: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResponse {
    pub schema_version: u32,
    pub scope_id: String,
    pub operation: CommandOperation,
    pub applied_at_ms: i64,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMangaVariables {
    id: i64,
    in_library: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMangaCategoriesVariables {
    manga_id: i64,
    add_to: Vec<i64>,
    remove_from: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateChaptersProgressVariables {
    ids: Vec<i64>,
    is_read: Option<bool>,
    is_bookmarked: Option<bool>,
    last_page_read: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCategoryVariables {
    id: i64,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCategoryVariables {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteCategoryVariables {
    id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddExtensionReposVariables {
    repos: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallExtensionVariables {
    pkg_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveMangaVariables {
    source_id: String,
    url: String,
    title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchChaptersVariables {
    manga_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCategoryOrderVariables {
    id: i64,
    position: i64,
}

pub async fn post_command(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<CommandQuery>,
    Json(request): Json<CommandRequest>,
) -> Result<Json<CommandResponse>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    if !query.scope_id.starts_with("comics:profile:") {
        return Err(AppError::Forbidden(
            "The Suwayomi command bridge requires a comics profile scope.".to_string(),
        ));
    }
    if request.variables.is_null() || !request.variables.is_object() {
        return Err(AppError::BadRequest(
            "Suwayomi command variables must be a JSON object.".to_string(),
        ));
    }

    let (document, variables) = normalized_command(&request.operation, request.variables)?;
    let data = if request.operation == CommandOperation::CreateCategory {
        create_category_confirmed(&state, &session, document, variables).await?
    } else if request.operation == CommandOperation::AddExtensionRepos {
        add_extension_repos_confirmed(&state, &session, variables).await?
    } else if request.operation == CommandOperation::InstallExtension {
        install_extension_confirmed(&state, &session, document, variables).await?
    } else if request.operation == CommandOperation::ResolveManga {
        resolve_manga_confirmed(&state, &session, document, variables).await?
    } else if request.operation == CommandOperation::ImportWorks {
        suwayomi_import::import_works_confirmed(&state, &session, variables).await?
    } else {
        suwayomi_catalog::execute_graphql_document(&state, &session, document, variables, true)
            .await?
    };

    Ok(Json(CommandResponse {
        schema_version: COMMAND_SCHEMA_VERSION,
        scope_id: query.scope_id,
        operation: request.operation,
        applied_at_ms: db::now_ms(),
        data,
    }))
}

pub(crate) async fn execute_internal_command(
    state: &SharedAppState,
    profile_id: &str,
    operation: CommandOperation,
    variables: Value,
) -> Result<Value, AppError> {
    if operation == CommandOperation::ImportWorks {
        return Err(AppError::BadRequest(
            "ImportWorks is only a direct device command.".to_string(),
        ));
    }
    let (document, variables) = normalized_command(&operation, variables)?;
    let session = AuthenticatedSession {
        token_id: "suwayomi-projection".to_string(),
        device_id: "epigraph-core".to_string(),
        profile_id: profile_id.to_string(),
        scopes: BTreeSet::from([format!("comics:profile:{profile_id}")]),
        mutation_receipt: None,
    };
    suwayomi_catalog::execute_graphql_document(state, &session, document, variables, true).await
}

/// Creates a category and answers only with a confirmed `{ id, name, order }`. A retried
/// request whose category already exists returns that category instead of a duplicate.
async fn create_category_confirmed(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    document: &'static str,
    variables: Value,
) -> Result<Value, AppError> {
    let name = variables
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    for page in 0..MAX_CATEGORY_LOOKUP_PAGES {
        let offset = (page as i64).saturating_mul(CATEGORY_LOOKUP_PAGE_SIZE);
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            CATEGORY_LOOKUP_QUERY,
            json!({ "first": CATEGORY_LOOKUP_PAGE_SIZE, "offset": offset }),
            false,
        )
        .await?;
        let categories = data.get("categories");
        if let Some(category) = categories
            .and_then(|value| value.get("nodes"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|category| confirmed_category(category, &name))
        {
            return Ok(json!({
                "createCategory": { "category": category, "created": false }
            }));
        }
        let has_next = categories
            .and_then(|value| value.get("pageInfo"))
            .and_then(|value| value.get("hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_next {
            break;
        }
    }
    let data =
        suwayomi_catalog::execute_graphql_document(state, session, document, variables, true)
            .await?;
    let category = created_category(&name, &data).ok_or_else(|| {
        AppError::service_unavailable(
            "SUWAYOMI_CATEGORY_NOT_CONFIRMED",
            "The comics runtime did not confirm the new category.",
            true,
        )
    })?;
    Ok(json!({ "createCategory": { "category": category, "created": true } }))
}

/// Adds repositories to the desktop runtime without dropping the ones it already has.
async fn add_extension_repos_confirmed(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    variables: Value,
) -> Result<Value, AppError> {
    let requested: Vec<String> = string_array(variables.get("repos"));
    // Suwayomi v2.3 keeps extension stores; older runtimes keep JSON repositories in settings.
    if let Ok(data) = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        EXTENSION_STORES_QUERY,
        json!({}),
        false,
    )
    .await
    {
        return add_extension_stores_confirmed(state, session, requested, &data).await;
    }
    let data = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        EXTENSION_REPOS_QUERY,
        json!({}),
        false,
    )
    .await?;
    let mut repos = string_array(
        data.get("settings")
            .and_then(|value| value.get("extensionRepos")),
    );
    let before = repos.len();
    for repo in requested {
        let repo = legacy_repo_url(&repo);
        if !repos
            .iter()
            .any(|known| repo_root(known).eq_ignore_ascii_case(repo_root(&repo)))
        {
            repos.push(repo);
        }
    }
    if repos.len() == before {
        return Ok(json!({ "extensionRepos": repos, "changed": false }));
    }
    let data = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        SET_EXTENSION_REPOS_QUERY,
        json!({ "repos": repos }),
        true,
    )
    .await?;
    let confirmed = string_array(
        data.get("setSettings")
            .and_then(|value| value.get("settings"))
            .and_then(|value| value.get("extensionRepos")),
    );
    Ok(json!({ "extensionRepos": confirmed, "changed": true }))
}

/// Adds each repository the runtime does not have yet as an extension store, trying the index
/// formats a repository folder may publish until the runtime accepts one.
async fn add_extension_stores_confirmed(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    requested: Vec<String>,
    data: &Value,
) -> Result<Value, AppError> {
    let mut stores: Vec<String> = data
        .get("extensionStores")
        .and_then(|value| value.get("nodes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|node| node.get("indexUrl").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let mut changed = false;
    for repo in requested {
        if stores
            .iter()
            .any(|known| repo_root(known).eq_ignore_ascii_case(repo_root(&repo)))
        {
            continue;
        }
        for candidate in store_index_candidates(&repo) {
            let added = suwayomi_catalog::execute_graphql_document(
                state,
                session,
                ADD_EXTENSION_STORE_QUERY,
                json!({ "indexUrl": candidate }),
                true,
            )
            .await;
            if let Ok(data) = added {
                let confirmed = data
                    .pointer("/addExtensionStore/extensionStore/indexUrl")
                    .and_then(Value::as_str)
                    .unwrap_or(&candidate)
                    .to_string();
                stores.push(confirmed);
                changed = true;
                break;
            }
        }
    }
    Ok(json!({ "extensionRepos": stores, "changed": changed }))
}

/// The requested index first, then the other formats in the same repository folder.
fn store_index_candidates(repo: &str) -> Vec<String> {
    let root = repo_root(repo);
    let mut candidates = vec![repo.to_string()];
    for file in ["index.pb", "index.min.json"] {
        let candidate = format!("{root}/{file}");
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

/// Runtimes before extension stores read only JSON indexes.
fn legacy_repo_url(repo: &str) -> String {
    if repo.ends_with(".pb") {
        format!("{}/index.min.json", repo_root(repo))
    } else {
        repo.to_string()
    }
}

/// The repository folder, so `.../repo/index.min.json`, `.../repo/index.pb` and
/// `.../repo/repo.json` count as the same repository.
fn repo_root(url: &str) -> &str {
    let url = url.trim_end_matches('/');
    match url.rsplit_once('/') {
        Some((root, file)) if file.ends_with(".json") || file.ends_with(".pb") => root,
        _ => url,
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn listed_extension<'a>(nodes: Option<&'a Value>, pkg_name: &str) -> Option<&'a Value> {
    nodes?
        .as_array()?
        .iter()
        .find(|extension| extension.get("pkgName").and_then(Value::as_str) == Some(pkg_name))
}

fn normalize_extension_jar_filename(raw_name: &str) -> Option<String> {
    if raw_name.is_empty()
        || raw_name.contains('/')
        || raw_name.contains('\\')
        || raw_name.contains("..")
        || raw_name.contains('\0')
        || raw_name.contains(':')
    {
        return None;
    }
    let mut components = std::path::Path::new(raw_name).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(_)), None) => {}
        _ => return None,
    }
    if raw_name.ends_with(".jar") {
        Some(raw_name.to_string())
    } else if let Some(stem) = raw_name.strip_suffix(".apk") {
        if stem.is_empty() {
            None
        } else {
            Some(format!("{stem}.jar"))
        }
    } else {
        None
    }
}

fn remove_stale_extension_jar_if_uninstalled(
    suwayomi_root: &std::path::Path,
    is_installed: bool,
    apk_name: Option<&str>,
) -> bool {
    if is_installed {
        return false;
    }
    let Some(jar_filename) = apk_name.and_then(normalize_extension_jar_filename) else {
        return false;
    };
    let extensions_dir = suwayomi_root.join("extensions");
    let Ok(canonical_extensions_dir) = std::fs::canonicalize(&extensions_dir) else {
        return false;
    };
    let candidate = canonical_extensions_dir.join(&jar_filename);
    let Ok(metadata) = std::fs::symlink_metadata(&candidate) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return false;
    }
    let Ok(canonical_candidate) = std::fs::canonicalize(&candidate) else {
        return false;
    };
    if canonical_candidate.parent() != Some(canonical_extensions_dir.as_path()) {
        return false;
    }
    match std::fs::remove_file(&canonical_candidate) {
        Ok(()) => {
            tracing::info!(
                jar = %jar_filename,
                "Removed stale uninstalled extension jar before install"
            );
            true
        }
        Err(_) => false,
    }
}

fn is_file_already_exists_error(error: &AppError) -> bool {
    format!("{error:?}").contains("FileAlreadyExistsException")
}

fn extract_jar_filename_from_error(error: &AppError) -> Option<String> {
    let debug = format!("{error:?}");
    let jar_end = debug.find(".jar")? + 4;
    let prefix = &debug[..jar_end];
    let start = prefix
        .rfind(['/', '\\', ' ', '"', '\''])
        .map(|idx| idx + 1)
        .unwrap_or(0);
    let candidate = &debug[start..jar_end];
    if candidate.is_empty() {
        None
    } else {
        Some(candidate.to_string())
    }
}

/// Installs an extension from the desktop runtime's own repositories. A package the runtime
/// does not offer is answered with `available: false` so the caller can stop retrying it.
async fn install_extension_confirmed(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    document: &'static str,
    variables: Value,
) -> Result<Value, AppError> {
    let pkg_name = variables
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // Check Suwayomi's cached extension list first so installing or confirming several packages in
    // one sync does not re-download every remote extension repository index for each package.
    let cached = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        LIST_EXTENSIONS_QUERY,
        json!({}),
        false,
    )
    .await
    .ok();
    let cached_listed = cached
        .as_ref()
        .and_then(|data| listed_extension(data.pointer("/extensions/nodes"), &pkg_name));
    let fetched;
    let listed = if let Some(listed) = cached_listed {
        listed
    } else {
        fetched = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            FETCH_EXTENSIONS_QUERY,
            json!({}),
            true,
        )
        .await?;
        let Some(listed) = listed_extension(
            fetched
                .get("fetchExtensions")
                .and_then(|value| value.get("extensions")),
            &pkg_name,
        ) else {
            return Ok(json!({ "pkgName": pkg_name, "available": false, "isInstalled": false }));
        };
        listed
    };
    if listed.get("isInstalled").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({ "pkgName": pkg_name, "available": true, "isInstalled": true }));
    }
    let apk_name = listed.get("apkName").and_then(Value::as_str);
    let suwayomi_root = crate::syncd::extension_store_seed::active_profile_root();
    remove_stale_extension_jar_if_uninstalled(&suwayomi_root, false, apk_name);

    let data = match suwayomi_catalog::execute_graphql_document(
        state,
        session,
        document,
        variables.clone(),
        true,
    )
    .await
    {
        Ok(data) => data,
        Err(error) if is_file_already_exists_error(&error) => {
            let extracted = extract_jar_filename_from_error(&error);
            let fallback_name = extracted.as_deref().or(apk_name);
            if remove_stale_extension_jar_if_uninstalled(&suwayomi_root, false, fallback_name) {
                suwayomi_catalog::execute_graphql_document(
                    state,
                    session,
                    document,
                    variables,
                    true,
                )
                .await?
            } else {
                return Err(error);
            }
        }
        Err(error) => return Err(error),
    };
    let installed = data
        .get("updateExtension")
        .and_then(|value| value.get("extension"))
        .and_then(|value| value.get("isInstalled"))
        .and_then(Value::as_bool)
        == Some(true);
    if !installed {
        return Err(AppError::service_unavailable(
            "SUWAYOMI_EXTENSION_NOT_CONFIRMED",
            "The comics runtime did not confirm the extension install.",
            true,
        ));
    }
    Ok(json!({ "pkgName": pkg_name, "available": true, "isInstalled": true }))
}

/// Finds a work by its source and key. Suwayomi only knows works it has already fetched, so when
/// the key is not there yet, searching the source for the title fetches it; only an exact key
/// match is accepted. `mangaId` is null when the work cannot be found, for example because its
/// extension is not installed here.
async fn resolve_manga_confirmed(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    document: &'static str,
    variables: Value,
) -> Result<Value, AppError> {
    let field = |name: &str| {
        variables
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let (source_id, url, title) = (field("sourceId"), field("url"), field("title"));
    let data = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        document,
        json!({ "sourceId": source_id, "url": url }),
        false,
    )
    .await?;
    let mut found = exact_manga_match(data.pointer("/mangas/nodes"), &url);
    if found.is_none() {
        // A missing or failing extension answers with an error, which means not found here.
        if let Ok(data) = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            RESOLVE_MANGA_SEARCH_QUERY,
            json!({ "source": source_id, "query": title }),
            true,
        )
        .await
        {
            found = exact_manga_match(data.pointer("/fetchSourceManga/mangas"), &url);
        }
    }
    Ok(match found {
        Some((id, in_library)) => json!({ "mangaId": id, "inLibrary": in_library }),
        None => json!({ "mangaId": null, "inLibrary": false }),
    })
}

fn exact_manga_match(nodes: Option<&Value>, url: &str) -> Option<(i64, bool)> {
    nodes?
        .as_array()?
        .iter()
        .filter(|node| node.get("url").and_then(Value::as_str) == Some(url))
        .find_map(|node| {
            let id = node.get("id").and_then(Value::as_i64)?;
            let in_library = node.get("inLibrary").and_then(Value::as_bool) == Some(true);
            (id > 0 && id <= i32::MAX as i64).then_some((id, in_library))
        })
}

pub(crate) fn created_category<'a>(name: &str, data: &'a Value) -> Option<&'a Value> {
    data.get("createCategory")
        .and_then(|value| value.get("category"))
        .filter(|category| confirmed_category(category, name))
}

fn confirmed_category(category: &Value, name: &str) -> bool {
    category
        .get("id")
        .and_then(Value::as_i64)
        .is_some_and(|id| (1..=i32::MAX as i64).contains(&id))
        && category.get("name").and_then(Value::as_str) == Some(name)
}

fn normalized_command(
    operation: &CommandOperation,
    variables: Value,
) -> Result<(&'static str, Value), AppError> {
    match operation {
        CommandOperation::UpdateManga => {
            let variables: UpdateMangaVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest(
                        "UpdateManga requires id and inLibrary variables.".to_string(),
                    )
                })?;
            ensure_int(variables.id, "id")?;
            Ok((
                UPDATE_MANGA_QUERY,
                json!({ "id": variables.id, "inLibrary": variables.in_library }),
            ))
        }
        CommandOperation::UpdateMangaCategories => {
            let variables: UpdateMangaCategoriesVariables = serde_json::from_value(variables)
                .map_err(|_| {
                    AppError::BadRequest(
                        "UpdateMangaCategories requires mangaId, addTo and removeFrom variables."
                            .to_string(),
                    )
                })?;
            ensure_int(variables.manga_id, "mangaId")?;
            if variables
                .add_to
                .iter()
                .chain(&variables.remove_from)
                .any(|id| *id < 0 || *id > i32::MAX as i64)
            {
                return Err(AppError::BadRequest(
                    "Category IDs must be valid Suwayomi integers.".to_string(),
                ));
            }
            if variables.add_to.is_empty() && variables.remove_from.is_empty() {
                return Err(AppError::BadRequest(
                    "At least one category change is required.".to_string(),
                ));
            }
            Ok((
                UPDATE_MANGA_CATEGORIES_QUERY,
                json!({
                    "mangaId": variables.manga_id,
                    "addTo": variables.add_to,
                    "removeFrom": variables.remove_from,
                }),
            ))
        }
        CommandOperation::UpdateChaptersProgress => {
            let variables: UpdateChaptersProgressVariables = serde_json::from_value(variables)
                .map_err(|_| {
                    AppError::BadRequest(
                        "UpdateChaptersProgress requires ids and optional progress fields."
                            .to_string(),
                    )
                })?;
            if variables.ids.is_empty() || variables.ids.len() > MAX_CHAPTER_IDS {
                return Err(AppError::BadRequest(format!(
                    "ids must contain between 1 and {MAX_CHAPTER_IDS} chapters."
                )));
            }
            for id in &variables.ids {
                ensure_int(*id, "chapter id")?;
            }
            if let Some(last_page_read) = variables.last_page_read {
                if !(0..=i32::MAX as i64).contains(&last_page_read) {
                    return Err(AppError::BadRequest(
                        "lastPageRead must be a non-negative Suwayomi integer.".to_string(),
                    ));
                }
            }
            Ok((
                UPDATE_CHAPTERS_PROGRESS_QUERY,
                json!({
                    "ids": variables.ids,
                    "isRead": variables.is_read,
                    "isBookmarked": variables.is_bookmarked,
                    "lastPageRead": variables.last_page_read,
                }),
            ))
        }
        CommandOperation::UpdateCategory => {
            let variables: UpdateCategoryVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest(
                        "UpdateCategory requires id and name variables.".to_string(),
                    )
                })?;
            ensure_int(variables.id, "id")?;
            ensure_category_name(&variables.name)?;
            Ok((
                UPDATE_CATEGORY_QUERY,
                json!({ "id": variables.id, "name": variables.name }),
            ))
        }
        CommandOperation::CreateCategory => {
            let variables: CreateCategoryVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest("CreateCategory requires a name variable.".to_string())
                })?;
            ensure_category_name(&variables.name)?;
            Ok((CREATE_CATEGORY_QUERY, json!({ "name": variables.name })))
        }
        CommandOperation::DeleteCategory => {
            let variables: DeleteCategoryVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest("DeleteCategory requires an id variable.".to_string())
                })?;
            ensure_int(variables.id, "id")?;
            Ok((DELETE_CATEGORY_QUERY, json!({ "id": variables.id })))
        }
        CommandOperation::AddExtensionRepos => {
            let variables: AddExtensionReposVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest("AddExtensionRepos requires repos.".to_string())
                })?;
            if variables.repos.is_empty() || variables.repos.len() > MAX_EXTENSION_REPOS {
                return Err(AppError::BadRequest(format!(
                    "repos must contain between 1 and {MAX_EXTENSION_REPOS} URLs."
                )));
            }
            for repo in &variables.repos {
                ensure_repo_url(repo)?;
            }
            Ok((EXTENSION_REPOS_QUERY, json!({ "repos": variables.repos })))
        }
        CommandOperation::InstallExtension => {
            let variables: InstallExtensionVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest("InstallExtension requires pkgName.".to_string())
                })?;
            ensure_package_name(&variables.pkg_name)?;
            Ok((INSTALL_EXTENSION_QUERY, json!({ "id": variables.pkg_name })))
        }
        CommandOperation::ResolveManga => {
            let variables: ResolveMangaVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest(
                        "ResolveManga requires sourceId, url and title variables.".to_string(),
                    )
                })?;
            ensure_source_id(&variables.source_id)?;
            ensure_manga_url(&variables.url)?;
            let title = variables.title.trim();
            if title.is_empty() || title.len() > 512 || title.chars().any(char::is_control) {
                return Err(AppError::BadRequest(
                    "title must be a work title of at most 512 bytes.".to_string(),
                ));
            }
            Ok((
                RESOLVE_MANGA_LOOKUP_QUERY,
                json!({ "sourceId": variables.source_id, "url": variables.url, "title": title }),
            ))
        }
        CommandOperation::FetchChapters => {
            let variables: FetchChaptersVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest("FetchChapters requires a mangaId variable.".to_string())
                })?;
            ensure_int(variables.manga_id, "mangaId")?;
            Ok((
                FETCH_CHAPTERS_QUERY,
                json!({ "mangaId": variables.manga_id }),
            ))
        }
        CommandOperation::ImportWorks => Ok((
            suwayomi_import::RESTORE_MUTATION,
            suwayomi_import::normalized_import(variables)?,
        )),
        CommandOperation::UpdateCategoryOrder => {
            let variables: UpdateCategoryOrderVariables = serde_json::from_value(variables)
                .map_err(|_| {
                    AppError::BadRequest(
                        "UpdateCategoryOrder requires id and position variables.".to_string(),
                    )
                })?;
            ensure_int(variables.id, "id")?;
            if !(1..=i32::MAX as i64).contains(&variables.position) {
                return Err(AppError::BadRequest(
                    "Category position must be a positive 1-based Suwayomi integer.".to_string(),
                ));
            }
            Ok((
                UPDATE_CATEGORY_ORDER_QUERY,
                json!({ "id": variables.id, "position": variables.position }),
            ))
        }
    }
}

fn ensure_repo_url(value: &str) -> Result<(), AppError> {
    let valid = value.len() <= 2048
        && value.starts_with("https://")
        && (value.ends_with(".json") || value.ends_with(".pb"))
        && !value.chars().any(|c| c.is_whitespace() || c.is_control());
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Extension repositories must be https URLs to a .json or .pb index.".to_string(),
        ))
    }
}

pub(super) fn ensure_source_id(value: &str) -> Result<(), AppError> {
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || digits.len() > 19 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::BadRequest(
            "sourceId must be a Suwayomi source id.".to_string(),
        ));
    }
    Ok(())
}

pub(super) fn ensure_manga_url(value: &str) -> Result<(), AppError> {
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err(AppError::BadRequest(
            "url must be a work key of at most 2048 bytes.".to_string(),
        ));
    }
    Ok(())
}

fn ensure_package_name(value: &str) -> Result<(), AppError> {
    let segments: Vec<&str> = value.split('.').collect();
    let valid = value.len() <= 200
        && segments.len() >= 2
        && segments.iter().all(|segment| {
            segment
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "pkgName must be an Android package name.".to_string(),
        ))
    }
}

fn ensure_category_name(value: &str) -> Result<(), AppError> {
    let name = value.trim();
    if name.is_empty() || name != value || name.len() > 256 || name.contains('\0') {
        return Err(AppError::BadRequest(
            "Category name must be trimmed, non-empty, at most 256 bytes, and contain no NUL."
                .to_string(),
        ));
    }
    // Suwayomi reserves "Default" in any letter case for its system category; createCategory
    // rejects it and a rename to it would leave two categories the clients cannot tell apart.
    if name.eq_ignore_ascii_case("default") {
        return Err(AppError::BadRequest(
            "Category name \"Default\" is reserved by Suwayomi.".to_string(),
        ));
    }
    Ok(())
}

fn ensure_int(value: i64, name: &str) -> Result<(), AppError> {
    if !(1..=i32::MAX as i64).contains(&value) {
        return Err(AppError::BadRequest(format!(
            "{name} must be a positive Suwayomi integer."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_only_allowlisted_manga_commands() {
        let (document, variables) = normalized_command(
            &CommandOperation::UpdateManga,
            json!({ "id": 7, "inLibrary": true }),
        )
        .unwrap();
        assert!(document.contains("mutation UpdateManga"));
        assert_eq!(variables["id"], 7);
        assert_eq!(variables["inLibrary"], true);
    }

    #[test]
    fn ignores_unknown_command_variables_and_rejects_empty_category_changes() {
        // Unknown variables are accepted but never forwarded to Suwayomi.
        let (_, variables) = normalized_command(
            &CommandOperation::UpdateManga,
            json!({ "id": 7, "inLibrary": true, "query": "drop" }),
        )
        .unwrap();
        assert_eq!(variables, json!({ "id": 7, "inLibrary": true }));
        assert!(normalized_command(
            &CommandOperation::UpdateMangaCategories,
            json!({ "mangaId": 7, "addTo": [], "removeFrom": [] }),
        )
        .is_err());
        assert!(normalized_command(
            &CommandOperation::UpdateCategoryOrder,
            json!({ "id": 3, "position": 0 }),
        )
        .is_err());
    }

    #[test]
    fn caps_chapter_batch_and_normalizes_progress() {
        let (document, variables) = normalized_command(
            &CommandOperation::UpdateChaptersProgress,
            json!({ "ids": [11, 12], "isRead": true, "lastPageRead": 3 }),
        )
        .unwrap();
        assert!(document.contains("mutation UpdateChaptersProgress"));
        assert_eq!(variables["ids"], json!([11, 12]));
        assert_eq!(variables["lastPageRead"], 3);
        assert!(normalized_command(
            &CommandOperation::UpdateChaptersProgress,
            json!({ "ids": Vec::<i64>::new() }),
        )
        .is_err());
    }

    #[test]
    fn normalizes_category_lifecycle_commands_without_forwarding_extra_fields() {
        let (document, variables) = normalized_command(
            &CommandOperation::UpdateCategory,
            json!({ "id": 3, "name": "Reading" }),
        )
        .unwrap();
        assert!(document.contains("mutation UpdateCategory"));
        assert_eq!(variables, json!({ "id": 3, "name": "Reading" }));

        let (document, variables) =
            normalized_command(&CommandOperation::DeleteCategory, json!({ "id": 3 })).unwrap();
        assert!(document.contains("mutation DeleteCategory"));
        assert_eq!(variables, json!({ "id": 3 }));

        let (document, variables) = normalized_command(
            &CommandOperation::UpdateCategoryOrder,
            json!({ "id": 3, "position": 2 }),
        )
        .unwrap();
        assert!(document.contains("mutation UpdateCategoryOrder"));
        assert_eq!(variables, json!({ "id": 3, "position": 2 }));
    }

    #[test]
    fn normalizes_create_category_and_confirms_only_matching_result() {
        let (document, variables) = normalized_command(
            &CommandOperation::CreateCategory,
            json!({ "name": "Reading" }),
        )
        .unwrap();
        assert!(document.contains("mutation CreateCategory"));
        assert_eq!(variables, json!({ "name": "Reading" }));
        for invalid in [
            json!({ "name": "" }),
            json!({ "name": " Reading" }),
            json!({ "name": "Rea\u{0}ding" }),
            json!({ "name": "x".repeat(257) }),
        ] {
            assert!(
                normalized_command(&CommandOperation::CreateCategory, invalid.clone()).is_err(),
                "{invalid}"
            );
        }

        let data = json!({
            "createCategory": { "category": { "id": 9, "name": "Reading", "order": 4 } }
        });
        assert_eq!(
            created_category("Reading", &data),
            Some(&json!({ "id": 9, "name": "Reading", "order": 4 }))
        );
        assert!(created_category("Other", &data).is_none());
        assert!(created_category(
            "Reading",
            &json!({ "createCategory": { "category": { "id": 0, "name": "Reading" } } })
        )
        .is_none());
        assert!(created_category("Reading", &json!({ "createCategory": null })).is_none());
    }

    #[test]
    fn normalizes_extension_commands_and_rejects_unsafe_values() {
        let (document, variables) = normalized_command(
            &CommandOperation::InstallExtension,
            json!({ "pkgName": "eu.kanade.tachiyomi.extension.en.mangadex" }),
        )
        .unwrap();
        assert_eq!(document, INSTALL_EXTENSION_QUERY);
        assert_eq!(
            variables,
            json!({ "id": "eu.kanade.tachiyomi.extension.en.mangadex" })
        );
        for bad in [
            "",
            "mangadex",
            "eu.kanade..x",
            "eu.kanade.1x",
            "eu.kanade.x;drop",
        ] {
            assert!(normalized_command(
                &CommandOperation::InstallExtension,
                json!({ "pkgName": bad }),
            )
            .is_err());
        }
        assert_eq!(
            normalized_command(
                &CommandOperation::InstallExtension,
                json!({ "pkgName": "a.b", "extra": 1 }),
            )
            .unwrap()
            .1,
            json!({ "id": "a.b" })
        );

        assert_eq!(
            repo_root("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb"),
            repo_root("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"),
        );

        let repo = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json";
        let (_, variables) = normalized_command(
            &CommandOperation::AddExtensionRepos,
            json!({ "repos": [repo] }),
        )
        .unwrap();
        assert_eq!(variables, json!({ "repos": [repo] }));
        for bad in [
            json!({ "repos": [] }),
            json!({ "repos": ["http://x/index.json"] }),
            json!({ "repos": ["https://x/a b.json"] }),
        ] {
            assert!(normalized_command(&CommandOperation::AddExtensionRepos, bad).is_err());
        }

        let store = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb";
        assert!(normalized_command(
            &CommandOperation::AddExtensionRepos,
            json!({ "repos": [store] }),
        )
        .is_ok());
        assert_eq!(
            store_index_candidates(store),
            vec![
                store.to_string(),
                "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"
                    .to_string(),
            ]
        );
        assert_eq!(store_index_candidates(repo)[1], store);
        assert_eq!(legacy_repo_url(store), repo);
        assert_eq!(legacy_repo_url(repo), repo);

        let cached = json!([
            { "pkgName": "eu.kanade.tachiyomi.extension.en.mangadex", "isInstalled": true },
            { "pkgName": "eu.kanade.tachiyomi.extension.pt.brmangas", "isInstalled": false },
        ]);
        assert_eq!(
            listed_extension(Some(&cached), "eu.kanade.tachiyomi.extension.en.mangadex")
                .and_then(|value| value.get("isInstalled"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(
            listed_extension(Some(&cached), "eu.kanade.tachiyomi.extension.en.missing").is_none()
        );
    }

    #[test]
    fn normalizes_work_resolution_and_chapter_listing() {
        let (document, variables) = normalized_command(
            &CommandOperation::ResolveManga,
            json!({ "sourceId": "2499283573021220255", "url": "/title/abc", "title": " One ", "x": 1 }),
        )
        .unwrap();
        assert_eq!(document, RESOLVE_MANGA_LOOKUP_QUERY);
        assert_eq!(
            variables,
            json!({ "sourceId": "2499283573021220255", "url": "/title/abc", "title": "One" })
        );
        for bad in [
            json!({ "sourceId": "", "url": "/a", "title": "A" }),
            json!({ "sourceId": "12a", "url": "/a", "title": "A" }),
            json!({ "sourceId": "1", "url": "", "title": "A" }),
            json!({ "sourceId": "1", "url": "/a\n", "title": "A" }),
            json!({ "sourceId": "1", "url": "/a", "title": "  " }),
        ] {
            assert!(normalized_command(&CommandOperation::ResolveManga, bad).is_err());
        }

        let (document, variables) =
            normalized_command(&CommandOperation::FetchChapters, json!({ "mangaId": 9 })).unwrap();
        assert_eq!(document, FETCH_CHAPTERS_QUERY);
        assert_eq!(variables, json!({ "mangaId": 9 }));
        assert!(
            normalized_command(&CommandOperation::FetchChapters, json!({ "mangaId": 0 })).is_err()
        );

        let nodes = json!([
            { "id": 4, "url": "/title/abcd", "inLibrary": true },
            { "id": 5, "url": "/title/abc", "inLibrary": false },
        ]);
        assert_eq!(
            exact_manga_match(Some(&nodes), "/title/abc"),
            Some((5, false))
        );
        assert_eq!(exact_manga_match(Some(&nodes), "/title/ab"), None);
    }

    #[test]
    fn rejects_invalid_category_lifecycle_values() {
        assert!(normalized_command(
            &CommandOperation::UpdateCategory,
            json!({ "id": 3, "name": "  Reading" }),
        )
        .is_err());
        for reserved in ["Default", "default", "DEFAULT"] {
            assert!(normalized_command(
                &CommandOperation::CreateCategory,
                json!({ "name": reserved }),
            )
            .is_err());
            assert!(normalized_command(
                &CommandOperation::UpdateCategory,
                json!({ "id": 3, "name": reserved }),
            )
            .is_err());
        }
        assert!(normalized_command(
            &CommandOperation::CreateCategory,
            json!({ "name": "Defaults" }),
        )
        .is_ok());
        assert!(
            normalized_command(&CommandOperation::DeleteCategory, json!({ "id": 0 }),).is_err()
        );
        assert!(normalized_command(
            &CommandOperation::UpdateCategoryOrder,
            json!({ "id": 3, "position": -1 }),
        )
        .is_err());
    }

    #[test]
    fn stale_extension_jar_cleanup_normalizes_apk_and_enforces_safety_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let extensions_dir = temp.path().join("extensions");
        std::fs::create_dir_all(&extensions_dir).unwrap();

        let stale_jar = extensions_dir.join("tachiyomi-en.comix-v1.6.65.jar");
        std::fs::write(&stale_jar, b"stale").unwrap();
        let outside_jar = temp.path().join("outside.jar");
        std::fs::write(&outside_jar, b"keep").unwrap();

        // Never touches files when isInstalled == true.
        assert!(!remove_stale_extension_jar_if_uninstalled(
            temp.path(),
            true,
            Some("tachiyomi-en.comix-v1.6.65.apk"),
        ));
        assert!(stale_jar.exists());

        // Rejects path traversal, separators, drive prefixes, and non-apk/jar names.
        for bad in [
            "../outside.jar",
            "..\\outside.jar",
            "sub/tachiyomi-en.comix-v1.6.65.jar",
            "C:tachiyomi-en.comix-v1.6.65.jar",
            ".jar",
            ".apk",
            "tachiyomi-en.comix-v1.6.65.txt",
            "",
        ] {
            assert!(!remove_stale_extension_jar_if_uninstalled(
                temp.path(),
                false,
                Some(bad),
            ));
        }
        assert!(outside_jar.exists());

        // Removes stale .jar when given matching .apk name and isInstalled == false.
        assert!(remove_stale_extension_jar_if_uninstalled(
            temp.path(),
            false,
            Some("tachiyomi-en.comix-v1.6.65.apk"),
        ));
        assert!(!stale_jar.exists());
        assert!(outside_jar.exists());
    }
}
