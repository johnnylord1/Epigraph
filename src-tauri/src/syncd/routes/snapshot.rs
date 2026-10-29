use axum::extract::{Extension, Query, State};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::syncd::db::{self, SnapshotPageCursor};
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState, SnapshotResponse};

/// Largest page a client may ask for; comic chapter states are about 1 KB each.
pub const MAX_SNAPSHOT_PAGE_SIZE: usize = 5_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotQuery {
    pub scope_id: String,
    /// Asks for the paged form (`supportsPagedSnapshotV1`); without it the whole scope is sent.
    #[serde(default)]
    pub page_size: Option<usize>,
    /// The `nextCursor` of the previous page.
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPageResponse {
    #[serde(flatten)]
    pub snapshot: SnapshotResponse,
    /// Present on every page but the last, which is the only one marked complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

pub async fn get_snapshot(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<SnapshotPageResponse>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    let loaded = match query.page_size {
        None => {
            if query.cursor.is_some() {
                return Err(AppError::BadRequest(
                    "A snapshot cursor needs a page size.".to_string(),
                ));
            }
            db::load_scope_snapshot(&state.pool, &query.scope_id)
                .await
                .map(|snapshot| (snapshot, None))
        }
        Some(page_size) => {
            let after = query.cursor.as_deref().map(decode_cursor).transpose()?;
            db::load_scope_snapshot_page(
                &state.pool,
                &query.scope_id,
                after.as_ref(),
                page_size.clamp(1, MAX_SNAPSHOT_PAGE_SIZE),
            )
            .await
        }
    };
    let (snapshot, next) = loaded.map_err(|error| {
        tracing::error!(scope_id = %query.scope_id, error = %error, "failed to load sync snapshot");
        AppError::Internal("Failed to load authoritative snapshot.".to_string())
    })?;
    Ok(Json(SnapshotPageResponse {
        snapshot,
        next_cursor: next.as_ref().map(encode_cursor),
    }))
}

fn encode_cursor(cursor: &SnapshotPageCursor) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).unwrap_or_default())
}

fn decode_cursor(raw: &str) -> Result<SnapshotPageCursor, AppError> {
    URL_SAFE_NO_PAD
        .decode(raw)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SnapshotPageCursor>(&bytes).ok())
        .ok_or_else(|| AppError::BadRequest("The snapshot cursor is invalid.".to_string()))
}
