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

const UPDATE_CATEGORY_ORDER_QUERY: &str = r#"
  mutation UpdateCategoryOrder($id: Int!, $position: Int!) {
    updateCategoryOrder(input: { id: $id, position: $position }) {
      categories { id name order }
    }
  }
"#;

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
struct DeleteCategoryVariables {
    id: i64,
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
    let data =
        suwayomi_catalog::execute_graphql_document(&state, &session, document, variables, true)
            .await?;

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
            let name = variables.name.trim();
            if name.is_empty() || name != variables.name || name.len() > 256 || name.contains('\0')
            {
                return Err(AppError::BadRequest(
                    "Category name must be trimmed, non-empty, at most 256 bytes, and contain no NUL."
                        .to_string(),
                ));
            }
            Ok((
                UPDATE_CATEGORY_QUERY,
                json!({ "id": variables.id, "name": variables.name }),
            ))
        }
        CommandOperation::DeleteCategory => {
            let variables: DeleteCategoryVariables =
                serde_json::from_value(variables).map_err(|_| {
                    AppError::BadRequest("DeleteCategory requires only an id variable.".to_string())
                })?;
            ensure_int(variables.id, "id")?;
            Ok((DELETE_CATEGORY_QUERY, json!({ "id": variables.id })))
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
    fn rejects_invalid_category_lifecycle_values() {
        assert!(normalized_command(
            &CommandOperation::UpdateCategory,
            json!({ "id": 3, "name": "  Reading" }),
        )
        .is_err());
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
