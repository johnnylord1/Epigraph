use axum::extract::{Extension, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

use crate::syncd::db;
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState};
use crate::syncd::routes::suwayomi_catalog;

const COMMAND_SCHEMA_VERSION: u32 = 1;
const MAX_CHAPTER_IDS: usize = 250;
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

const FETCH_EXTENSIONS_QUERY: &str = r#"
  mutation EpigraphFetchExtensions {
    fetchExtensions(input: {}) {
      extensions { pkgName isInstalled }
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateMangaVariables {
    id: i64,
    in_library: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateMangaCategoriesVariables {
    manga_id: i64,
    add_to: Vec<i64>,
    remove_from: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateChaptersProgressVariables {
    ids: Vec<i64>,
    is_read: Option<bool>,
    is_bookmarked: Option<bool>,
    last_page_read: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateCategoryVariables {
    id: i64,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateCategoryVariables {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteCategoryVariables {
    id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddExtensionReposVariables {
    repos: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallExtensionVariables {
    pkg_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    let (document, variables) = normalized_command(&operation, variables)?;
    let session = AuthenticatedSession {
        token_id: "epigraph-core-projection".to_string(),
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
    let data = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        FETCH_EXTENSIONS_QUERY,
        json!({}),
        true,
    )
    .await?;
    let listed = data
        .get("fetchExtensions")
        .and_then(|value| value.get("extensions"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|extension| {
            extension.get("pkgName").and_then(Value::as_str) == Some(pkg_name.as_str())
        });
    let Some(listed) = listed else {
        return Ok(json!({ "pkgName": pkg_name, "available": false, "isInstalled": false }));
    };
    if listed.get("isInstalled").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({ "pkgName": pkg_name, "available": true, "isInstalled": true }));
    }
    let data =
        suwayomi_catalog::execute_graphql_document(state, session, document, variables, true)
            .await?;
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
                        "UpdateManga requires only id and inLibrary variables.".to_string(),
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
                        "UpdateCategory requires only id and name variables.".to_string(),
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
                    AppError::BadRequest("CreateCategory requires only a name variable.".to_string())
                })?;
            ensure_category_name(&variables.name)?;
            Ok((CREATE_CATEGORY_QUERY, json!({ "name": variables.name })))
        }
        CommandOperation::DeleteCategory => {
            let variables: DeleteCategoryVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest("DeleteCategory requires only an id variable.".to_string())
                })?;
            ensure_int(variables.id, "id")?;
            Ok((DELETE_CATEGORY_QUERY, json!({ "id": variables.id })))
        }
        CommandOperation::AddExtensionRepos => {
            let variables: AddExtensionReposVariables = serde_json::from_value(variables)
                .map_err(|_| {
                    AppError::BadRequest("AddExtensionRepos requires only repos.".to_string())
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
            let variables: InstallExtensionVariables = serde_json::from_value(variables)
                .map_err(|_| {
                    AppError::BadRequest("InstallExtension requires only pkgName.".to_string())
                })?;
            ensure_package_name(&variables.pkg_name)?;
            Ok((INSTALL_EXTENSION_QUERY, json!({ "id": variables.pkg_name })))
        }
        CommandOperation::UpdateCategoryOrder => {
            let variables: UpdateCategoryOrderVariables = serde_json::from_value(variables)
                .map_err(|_| {
                    AppError::BadRequest(
                        "UpdateCategoryOrder requires only id and position variables.".to_string(),
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
        && value.ends_with(".json")
        && !value.chars().any(|c| c.is_whitespace() || c.is_control());
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Extension repositories must be https URLs to a .json index.".to_string(),
        ))
    }
}

fn ensure_package_name(value: &str) -> Result<(), AppError> {
    let segments: Vec<&str> = value.split('.').collect();
    let valid = value.len() <= 200
        && segments.len() >= 2
        && segments.iter().all(|segment| {
            segment.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && segment.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
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
    fn rejects_unknown_command_variables_and_empty_category_changes() {
        assert!(normalized_command(
            &CommandOperation::UpdateManga,
            json!({ "id": 7, "inLibrary": true, "query": "drop" }),
        )
        .is_err());
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
            json!({ "name": "Reading", "order": 1 }),
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
        assert_eq!(variables, json!({ "id": "eu.kanade.tachiyomi.extension.en.mangadex" }));
        for bad in ["", "mangadex", "eu.kanade..x", "eu.kanade.1x", "eu.kanade.x;drop"] {
            assert!(normalized_command(
                &CommandOperation::InstallExtension,
                json!({ "pkgName": bad }),
            )
            .is_err());
        }
        assert!(normalized_command(
            &CommandOperation::InstallExtension,
            json!({ "pkgName": "a.b", "extra": 1 }),
        )
        .is_err());

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
        for bad in [json!({ "repos": [] }), json!({ "repos": ["http://x/index.json"] }), json!({ "repos": ["https://x/a b.json"] })] {
            assert!(normalized_command(&CommandOperation::AddExtensionRepos, bad).is_err());
        }
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
}
