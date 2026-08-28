use axum::extract::{Extension, Query, State};
use axum::Json;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::syncd::db;
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState};
use crate::syncd::routes::suwayomi_proxy;

const CATALOG_BRIDGE_SCHEMA_VERSION: u32 = 1;
const DEFAULT_CATALOG_PAGE_SIZE: i64 = 100;
const MAX_CATALOG_PAGE_SIZE: i64 = 250;
const MAX_CATALOG_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

const LIBRARY_QUERY: &str = r#"
  query EpigraphCatalogLibrary($first: Int!, $offset: Int!) {
    mangas(condition: { inLibrary: true }, first: $first, offset: $offset) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        id
        title
        thumbnailUrl
        realUrl
        inLibrary
        downloadCount
        unreadCount
        chapters { totalCount }
        status
        genre
        sourceId
        url
        source { id name lang displayName extension { pkgName } }
      }
    }
  }
"#;

const CATEGORIES_QUERY: &str = r#"
  query EpigraphCatalogCategories($first: Int!, $offset: Int!) {
    categories(first: $first, offset: $offset) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        id
        name
        order
        default
        includeInUpdate
        includeInDownload
        mangas { nodes { id inLibrary } }
      }
    }
  }
"#;

const CHAPTERS_QUERY: &str = r#"
  query EpigraphCatalogChapters($mangaId: Int!, $first: Int!, $offset: Int!) {
    chapters(condition: { mangaId: $mangaId }, first: $first, offset: $offset) {
      totalCount
      pageInfo { hasNextPage }
      nodes {
        id
        name
        chapterNumber
        sourceOrder
        isRead
        isDownloaded
        isBookmarked
        pageCount
        mangaId
        uploadDate
        realUrl
        lastPageRead
        scanlator
      }
    }
  }
"#;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CatalogOperation {
    Library,
    Categories,
    Chapters,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogQuery {
    pub scope_id: String,
    pub operation: CatalogOperation,
    pub manga_id: Option<i64>,
    pub page_size: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub offset: i64,
    pub page_size: i64,
    pub has_next_page: bool,
    pub total_count: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub schema_version: u32,
    pub scope_id: String,
    pub operation: CatalogOperation,
    pub generated_at_ms: i64,
    pub page: CatalogPage,
    pub data: Value,
}

pub async fn get_catalog(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<CatalogQuery>,
) -> Result<Json<CatalogResponse>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    if !query.scope_id.starts_with("comics:profile:") {
        return Err(AppError::Forbidden(
            "The Suwayomi catalog bridge requires a comics profile scope.".to_string(),
        ));
    }

    let page_size = query.page_size.unwrap_or(DEFAULT_CATALOG_PAGE_SIZE);
    let offset = query.offset.unwrap_or(0);
    if !(1..=MAX_CATALOG_PAGE_SIZE).contains(&page_size) {
        return Err(AppError::BadRequest(format!(
            "pageSize must be between 1 and {MAX_CATALOG_PAGE_SIZE}."
        )));
    }
    if !(0..=i32::MAX as i64).contains(&offset) {
        return Err(AppError::BadRequest(
            "offset must be a non-negative Suwayomi integer.".to_string(),
        ));
    }

    let (document, variables) = match query.operation {
        CatalogOperation::Library => {
            if query.manga_id.is_some() {
                return Err(AppError::BadRequest(
                    "mangaId is only valid for the chapters operation.".to_string(),
                ));
            }
            (
                LIBRARY_QUERY,
                json!({ "first": page_size, "offset": offset }),
            )
        }
        CatalogOperation::Categories => {
            if query.manga_id.is_some() {
                return Err(AppError::BadRequest(
                    "mangaId is only valid for the chapters operation.".to_string(),
                ));
            }
            (
                CATEGORIES_QUERY,
                json!({ "first": page_size, "offset": offset }),
            )
        }
        CatalogOperation::Chapters => {
            let manga_id = query.manga_id.ok_or_else(|| {
                AppError::BadRequest("mangaId is required for the chapters operation.".to_string())
            })?;
            if manga_id <= 0 || manga_id > i32::MAX as i64 {
                return Err(AppError::BadRequest(
                    "mangaId must be a positive Suwayomi integer id.".to_string(),
                ));
            }
            (
                CHAPTERS_QUERY,
                json!({ "mangaId": manga_id, "first": page_size, "offset": offset }),
            )
        }
    };

    let data = execute_graphql_document(&state, &session, document, variables, false).await?;
    let page = page_for(&query.operation, &data, offset, page_size)?;
    Ok(Json(CatalogResponse {
        schema_version: CATALOG_BRIDGE_SCHEMA_VERSION,
        scope_id: query.scope_id,
        operation: query.operation,
        generated_at_ms: db::now_ms(),
        page,
        data,
    }))
}

fn page_for(
    operation: &CatalogOperation,
    data: &Value,
    offset: i64,
    page_size: i64,
) -> Result<CatalogPage, AppError> {
    let connection_key = match operation {
        CatalogOperation::Library => "mangas",
        CatalogOperation::Categories => "categories",
        CatalogOperation::Chapters => "chapters",
    };
    let connection = data
        .get(connection_key)
        .and_then(Value::as_object)
        .ok_or_else(invalid_catalog_connection)?;
    let nodes = connection
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(invalid_catalog_connection)?;
    if nodes.len() > page_size as usize {
        return Err(invalid_catalog_connection());
    }
    let has_next_page = connection
        .get("pageInfo")
        .and_then(Value::as_object)
        .and_then(|value| value.get("hasNextPage"))
        .and_then(Value::as_bool)
        .ok_or_else(invalid_catalog_connection)?;
    let total_count = connection
        .get("totalCount")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or_else(invalid_catalog_connection)?;
    let observed_end = offset
        .checked_add(nodes.len() as i64)
        .ok_or_else(invalid_catalog_connection)?;
    if observed_end > total_count || (has_next_page && nodes.is_empty()) {
        return Err(invalid_catalog_connection());
    }
    if !has_next_page && observed_end != total_count {
        return Err(invalid_catalog_connection());
    }
    Ok(CatalogPage {
        offset,
        page_size,
        has_next_page,
        total_count: Some(total_count),
    })
}

fn invalid_catalog_connection() -> AppError {
    AppError::service_unavailable(
        "SUWAYOMI_CATALOG_INVALID_RESPONSE",
        "The comics runtime returned an incomplete catalog page.",
        true,
    )
}

pub(crate) async fn execute_graphql_document(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    document: &str,
    variables: Value,
    mutation: bool,
) -> Result<Value, AppError> {
    let _operation_lease = if mutation {
        Some(
            crate::suwayomi_maintenance::try_acquire_shared_file_lease(
                &crate::suwayomi_maintenance::default_runtime_root(),
            )
            .map_err(|_| {
                AppError::service_unavailable(
                    "SUWAYOMI_MAINTENANCE",
                    "The comics runtime is being maintained. Try again shortly.",
                    true,
                )
            })?,
        )
    } else {
        None
    };
    let base = suwayomi_proxy::resolve_upstream_base(state, &session.profile_id).map_err(|_| {
        AppError::service_unavailable(
            "SUWAYOMI_CATALOG_UNAVAILABLE",
            "The comics runtime is temporarily unavailable.",
            true,
        )
    })?;
    let url = suwayomi_proxy::build_upstream_url(base, "api/graphql", None).map_err(|_| {
        AppError::service_unavailable(
            "SUWAYOMI_CATALOG_UNAVAILABLE",
            "The comics runtime endpoint is unavailable.",
            true,
        )
    })?;
    let response = suwayomi_proxy::proxy_client()
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&json!({ "query": document, "variables": variables }))
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(
                profile = session.profile_id,
                error_class = suwayomi_proxy::proxy_reqwest_error_class(&error),
                "Suwayomi catalog bridge request failed"
            );
            AppError::service_unavailable(
                "SUWAYOMI_CATALOG_UNAVAILABLE",
                "The comics runtime is temporarily unavailable.",
                true,
            )
        })?;

    if !response.status().is_success() {
        tracing::warn!(
            profile = session.profile_id,
            status = response.status().as_u16(),
            "Suwayomi catalog bridge returned a non-success status"
        );
        return Err(AppError::service_unavailable(
            "SUWAYOMI_CATALOG_UNAVAILABLE",
            "The comics runtime rejected the catalog request.",
            response.status().is_server_error(),
        ));
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            AppError::service_unavailable(
                "SUWAYOMI_CATALOG_UNAVAILABLE",
                "The comics catalog response was interrupted.",
                true,
            )
        })?;
        if body.len().saturating_add(chunk.len()) > MAX_CATALOG_RESPONSE_BYTES {
            return Err(AppError::service_unavailable(
                "SUWAYOMI_CATALOG_TOO_LARGE",
                "The comics catalog response is too large to process safely.",
                false,
            ));
        }
        body.extend_from_slice(&chunk);
    }

    let payload: Value = serde_json::from_slice(&body).map_err(|_| {
        AppError::service_unavailable(
            "SUWAYOMI_CATALOG_INVALID_RESPONSE",
            "The comics runtime returned an invalid catalog response.",
            true,
        )
    })?;
    if payload
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err(AppError::service_unavailable(
            "SUWAYOMI_CATALOG_QUERY_FAILED",
            "The comics runtime could not provide the requested catalog data.",
            false,
        ));
    }
    payload.get("data").cloned().ok_or_else(|| {
        AppError::service_unavailable(
            "SUWAYOMI_CATALOG_INVALID_RESPONSE",
            "The comics runtime returned no catalog data.",
            true,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_manifest_exposes_the_extension_package_for_source_relinking() {
        assert!(LIBRARY_QUERY.contains("extension { pkgName }"));
        assert!(LIBRARY_QUERY.contains("realUrl"));
    }

    #[test]
    fn page_metadata_is_derived_from_the_allowlisted_connection() {
        let data = json!({
            "mangas": {
                "totalCount": 102,
                "pageInfo": { "hasNextPage": true },
                "nodes": [{ "id": 101 }]
            }
        });

        let page = page_for(&CatalogOperation::Library, &data, 100, 1).unwrap();

        assert_eq!(page.offset, 100);
        assert_eq!(page.page_size, 1);
        assert!(page.has_next_page);
        assert_eq!(page.total_count, Some(102));
    }

    #[test]
    fn incomplete_connection_is_rejected_instead_of_becoming_an_empty_catalog() {
        let result = page_for(
            &CatalogOperation::Chapters,
            &json!({ "unexpected": {} }),
            0,
            100,
        );

        assert!(result.is_err());
    }

    #[test]
    fn terminal_page_must_account_for_the_complete_connection() {
        let result = page_for(
            &CatalogOperation::Library,
            &json!({
                "mangas": {
                    "totalCount": 2,
                    "pageInfo": { "hasNextPage": false },
                    "nodes": [{ "id": 1 }]
                }
            }),
            0,
            100,
        );

        assert!(result.is_err());
    }
}
