use axum::Json;

use crate::syncd::models::HealthResponse;

pub async fn get_health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}
