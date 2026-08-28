use axum::extract::{Extension, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::syncd::db;
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusQuery {
    pub scope_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusResponse {
    pub scope_id: String,
    pub current_server_version: i64,
    pub min_replayable_server_version: i64,
    pub comic_authority_mode: &'static str,
    pub suwayomi_projection_pending: i64,
    pub suwayomi_projection_blocked: i64,
    pub suwayomi_projection_in_flight: i64,
    pub ready: bool,
}

/// Returns server-side readiness for a comic scope. The mobile outbox is
/// client-owned; this endpoint covers the Core's durable Suwayomi projection
/// queue so a write is not reported as synchronized while it is still being
/// applied to the authoritative server.
pub async fn get_sync_status(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<SyncStatusQuery>,
) -> Result<Json<SyncStatusResponse>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    let profile_id = query
        .scope_id
        .strip_prefix("comics:profile:")
        .filter(|profile| *profile == session.profile_id)
        .ok_or_else(|| {
            AppError::BadRequest(
                "Server-side Suwayomi projection status is available for comic scopes only."
                    .to_string(),
            )
        })?;

    let runtime = db::load_server_runtime(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load sync status.".to_string()))?;
    let (pending, blocked, in_flight): (i64, i64, i64) = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'in_flight' THEN 1 ELSE 0 END), 0)
        FROM suwayomi_projection_outbox
        WHERE profile_id = ?
        "#,
    )
    .bind(profile_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|_| AppError::Internal("Failed to load Suwayomi projection status.".to_string()))?;

    Ok(Json(SyncStatusResponse {
        scope_id: query.scope_id,
        current_server_version: runtime.current_server_version,
        min_replayable_server_version: runtime.min_replayable_server_version,
        comic_authority_mode: "suwayomi-confirmed-v1",
        suwayomi_projection_pending: pending,
        suwayomi_projection_blocked: blocked,
        suwayomi_projection_in_flight: in_flight,
        ready: pending == 0 && blocked == 0 && in_flight == 0,
    }))
}
