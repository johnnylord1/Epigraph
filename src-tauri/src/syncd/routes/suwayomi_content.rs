use axum::extract::{Extension, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::syncd::db;
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState};
use crate::syncd::routes::suwayomi_catalog;

const CONTENT_SCHEMA_VERSION: u32 = 1;

const FETCH_MANGA_DOCUMENT: &str = r#"
  mutation EpigraphCoreFetchManga($id: Int!) {
    fetchManga(input: { id: $id }) {
      manga { id title description thumbnailUrl status author artist genre inLibrary realUrl }
    }
  }
"#;

/// Read-only fallback when the source cannot be refreshed (blocked, offline): the details
/// Suwayomi already stores, in the `fetchManga` shape.
const STORED_MANGA_DOCUMENT: &str = r#"
  query EpigraphCoreStoredManga($id: Int!) {
    manga(id: $id) { id title description thumbnailUrl status author artist genre inLibrary realUrl }
  }
"#;

const FETCH_CHAPTERS_DOCUMENT: &str = r#"
  mutation EpigraphCoreFetchChapters($mangaId: Int!) {
    fetchChapters(input: { mangaId: $mangaId }) {
      chapters {
        id name chapterNumber sourceOrder pageCount mangaId uploadDate realUrl scanlator
        isRead isBookmarked lastPageRead lastReadAt
      }
    }
  }
"#;

const FETCH_CHAPTER_PAGES_DOCUMENT: &str = r#"
  mutation EpigraphCoreFetchChapterPages($chapterId: Int!) {
    fetchChapterPages(input: { chapterId: $chapterId }) { pages }
  }
"#;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub enum ContentOperation {
    FetchManga,
    FetchChapters,
    FetchChapterPages,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentQuery {
    pub scope_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRequest {
    pub operation: ContentOperation,
    pub id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentResponse {
    pub schema_version: u32,
    pub scope_id: String,
    pub operation: ContentOperation,
    pub fetched_at_ms: i64,
    pub data: Value,
}

pub async fn post_content(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<ContentQuery>,
    Json(request): Json<ContentRequest>,
) -> Result<Json<ContentResponse>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    if !query.scope_id.starts_with("comics:profile:") {
        return Err(AppError::Forbidden(
            "The Suwayomi content bridge requires a comics profile scope.".to_string(),
        ));
    }

    let (document, variables) = normalized_content(&request.operation, request.id)?;
    // These upstream operations refresh source-owned state even though this Core boundary is
    // read-only to the mobile client, so they participate in the maintenance operation lease.
    let data = match suwayomi_catalog::execute_graphql_document(
        &state, &session, document, variables, true,
    )
    .await
    {
        Ok(data) => data,
        Err(error) if request.operation == ContentOperation::FetchManga => {
            stored_manga(&state, &session, request.id)
                .await
                .ok_or(error)?
        }
        Err(error) => return Err(error),
    };

    Ok(Json(ContentResponse {
        schema_version: CONTENT_SCHEMA_VERSION,
        scope_id: query.scope_id,
        operation: request.operation,
        fetched_at_ms: db::now_ms(),
        data,
    }))
}

async fn stored_manga(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    id: i64,
) -> Option<Value> {
    let data = suwayomi_catalog::execute_graphql_document(
        state,
        session,
        STORED_MANGA_DOCUMENT,
        json!({ "id": id }),
        false,
    )
    .await
    .ok()?;
    let fetched = stored_manga_as_fetched(data)?;
    tracing::warn!(
        profile = session.profile_id,
        manga_id = id,
        "source refresh failed; serving the manga details Suwayomi already stores"
    );
    Some(fetched)
}

fn stored_manga_as_fetched(data: Value) -> Option<Value> {
    let manga = data.get("manga").filter(|manga| manga.is_object())?.clone();
    Some(json!({ "fetchManga": { "manga": manga } }))
}

fn normalized_content(
    operation: &ContentOperation,
    id: i64,
) -> Result<(&'static str, Value), AppError> {
    if !(1..=i32::MAX as i64).contains(&id) {
        return Err(AppError::BadRequest(
            "Content id must be a positive Suwayomi integer.".to_string(),
        ));
    }
    Ok(match operation {
        ContentOperation::FetchManga => (FETCH_MANGA_DOCUMENT, json!({ "id": id })),
        ContentOperation::FetchChapters => (FETCH_CHAPTERS_DOCUMENT, json!({ "mangaId": id })),
        ContentOperation::FetchChapterPages => {
            (FETCH_CHAPTER_PAGES_DOCUMENT, json!({ "chapterId": id }))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_manga_fallback_is_read_only_and_keeps_the_fetch_shape() {
        assert!(STORED_MANGA_DOCUMENT.trim_start().starts_with("query "));
        let fetched =
            stored_manga_as_fetched(json!({ "manga": { "id": 1, "title": "T" } })).unwrap();
        assert_eq!(
            fetched.pointer("/fetchManga/manga/title"),
            Some(&json!("T"))
        );
        assert!(stored_manga_as_fetched(json!({ "manga": null })).is_none());
        assert!(stored_manga_as_fetched(json!({})).is_none());
    }

    #[test]
    fn normalizes_only_fixed_content_operations() {
        let (details, details_variables) =
            normalized_content(&ContentOperation::FetchManga, 7).unwrap();
        assert!(details.contains("mutation EpigraphCoreFetchManga"));
        assert_eq!(details_variables, json!({ "id": 7 }));

        let (chapters, chapter_variables) =
            normalized_content(&ContentOperation::FetchChapters, 8).unwrap();
        assert!(chapters.contains("mutation EpigraphCoreFetchChapters"));
        // Paired phones mirror the desktop read state from this list; without it a Core manga
        // read on the desktop opens on the phone at chapter one, and lastReadAt fills History.
        for field in ["isRead", "isBookmarked", "lastPageRead", "lastReadAt"] {
            assert!(chapters.contains(field), "fetchChapters must select {field}");
        }
        assert_eq!(chapter_variables, json!({ "mangaId": 8 }));

        let (pages, page_variables) =
            normalized_content(&ContentOperation::FetchChapterPages, 9).unwrap();
        assert!(pages.contains("mutation EpigraphCoreFetchChapterPages"));
        assert_eq!(page_variables, json!({ "chapterId": 9 }));
    }

    #[test]
    fn rejects_invalid_suwayomi_ids() {
        assert!(normalized_content(&ContentOperation::FetchManga, 0).is_err());
        assert!(
            normalized_content(&ContentOperation::FetchManga, i64::from(i32::MAX) + 1).is_err()
        );
    }
}
