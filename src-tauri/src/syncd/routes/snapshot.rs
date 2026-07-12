use axum::extract::{Extension, Query, State};
use axum::Json;
use serde::Deserialize;

use crate::syncd::db;
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{AppError, AuthenticatedSession, SharedAppState, SnapshotResponse};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotQuery {
    pub scope_id: String,
}

pub async fn get_snapshot(
    State(state): State<SharedAppState>,
    Extension(session): Extension<AuthenticatedSession>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Json<SnapshotResponse>, AppError> {
    validate_scope(&session, &query.scope_id)?;
    let snapshot = db::load_scope_snapshot(&state.pool, &query.scope_id)
        .await
        .map_err(|error| {
            tracing::error!(scope_id = %query.scope_id, error = %error, "failed to load sync snapshot");
            AppError::Internal("Failed to load authoritative snapshot.".to_string())
        })?;
    Ok(Json(snapshot))
}
