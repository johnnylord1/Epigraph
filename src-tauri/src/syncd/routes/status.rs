use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
    /// Sent by devices that report what they still have to upload, with or without the count.
    #[serde(default)]
    pub reports_uploads: Option<bool>,
    /// What the calling device still has to upload, once its sync run sent what it could.
    #[serde(default)]
    pub pending_uploads: Option<i64>,
}

/// A device's last upload report. `pending` stays `None` until a device that reports uploads has
/// finished a sync run; devices too old to report count as having nothing left.
#[derive(Debug, Clone, Copy)]
struct UploadReport {
    pending: Option<i64>,
    at: Instant,
}

/// A device that stopped syncing no longer holds the first run of this computer.
const UPLOAD_REPORT_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_PENDING_UPLOADS: i64 = 100_000_000;

type UploadReports = BTreeMap<(String, String), UploadReport>;

static UPLOAD_REPORTS: Mutex<UploadReports> = Mutex::new(BTreeMap::new());

fn record_upload_report(
    reports_by_device: &mut UploadReports,
    profile_id: &str,
    device_id: &str,
    reports: bool,
    pending: Option<i64>,
    now: Instant,
) {
    let key = (profile_id.to_string(), device_id.to_string());
    let pending = match (reports, pending) {
        (true, Some(pending)) => Some(pending),
        // A mid-run status call: keep the count from the last finished run, if still fresh.
        (true, None) => reports_by_device
            .get(&key)
            .filter(|report| now.duration_since(report.at) < UPLOAD_REPORT_TTL)
            .and_then(|report| report.pending),
        (false, _) => Some(0),
    };
    reports_by_device.insert(key, UploadReport { pending, at: now });
}

fn pending_uploads_at(reports_by_device: &mut UploadReports, now: Instant) -> Option<i64> {
    reports_by_device.retain(|_, report| now.duration_since(report.at) < UPLOAD_REPORT_TTL);
    if reports_by_device.is_empty() {
        return None;
    }
    reports_by_device
        .values()
        .try_fold(0_i64, |total, report| report.pending.map(|pending| total.saturating_add(pending)))
}

fn upload_reports() -> std::sync::MutexGuard<'static, UploadReports> {
    UPLOAD_REPORTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What paired devices still have to upload here, from their latest status calls. `None` until
/// every device that synced lately has finished a run and reported it.
pub fn pending_uploads() -> Option<i64> {
    pending_uploads_at(&mut upload_reports(), Instant::now())
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
    /// Pending or in-flight projections that change the library or its categories, leaving out
    /// chapter progress, which a library catalog read cannot undo.
    pub suwayomi_catalog_projection_pending: i64,
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
    if query
        .pending_uploads
        .is_some_and(|pending| !(0..=MAX_PENDING_UPLOADS).contains(&pending))
    {
        return Err(AppError::BadRequest("pendingUploads is out of range.".to_string()));
    }
    record_upload_report(
        &mut upload_reports(),
        profile_id,
        &session.device_id,
        query.reports_uploads == Some(true),
        query.pending_uploads,
        Instant::now(),
    );

    let runtime = db::load_server_runtime(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load sync status.".to_string()))?;
    let (pending, blocked, in_flight, catalog_pending): (i64, i64, i64, i64) = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM(CASE WHEN status IN ('pending', 'retry') THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status = 'in_flight' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN status IN ('pending', 'retry', 'in_flight')
                AND operation_name <> 'UpdateChaptersProgress' THEN 1 ELSE 0 END), 0)
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
        suwayomi_catalog_projection_pending: catalog_pending,
        ready: pending == 0 && blocked == 0 && in_flight == 0,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_uploads_wait_for_every_reporting_device() {
        let mut reports = UploadReports::new();
        let now = Instant::now();
        assert_eq!(pending_uploads_at(&mut reports, now), None);

        // The phone's catalog sync calls mid-run with the marker only: nothing is known yet.
        record_upload_report(&mut reports, "main", "phone", true, None, now);
        assert_eq!(pending_uploads_at(&mut reports, now), None);

        record_upload_report(&mut reports, "main", "phone", true, Some(37), now);
        assert_eq!(pending_uploads_at(&mut reports, now), Some(37));

        // A later mid-run call keeps the last finished run's count.
        record_upload_report(&mut reports, "main", "phone", true, None, now);
        assert_eq!(pending_uploads_at(&mut reports, now), Some(37));

        // A device too old to report counts as having nothing left.
        record_upload_report(&mut reports, "main", "old-phone", false, None, now);
        assert_eq!(pending_uploads_at(&mut reports, now), Some(37));

        record_upload_report(&mut reports, "main", "phone", true, Some(0), now);
        assert_eq!(pending_uploads_at(&mut reports, now), Some(0));
    }

    #[test]
    fn stale_upload_reports_stop_counting() {
        let mut reports = UploadReports::new();
        let then = Instant::now();
        record_upload_report(&mut reports, "main", "gone", true, Some(5), then);
        let later = then + UPLOAD_REPORT_TTL;
        record_upload_report(&mut reports, "main", "phone", true, Some(0), later);
        assert_eq!(pending_uploads_at(&mut reports, later), Some(0));

        // A stale count is not carried into a new mid-run report.
        record_upload_report(&mut reports, "main", "gone", true, Some(5), then);
        record_upload_report(&mut reports, "main", "gone", true, None, later);
        assert_eq!(pending_uploads_at(&mut reports, later), None);
    }
}
