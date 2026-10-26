use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Extension, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::syncd::middleware::validate_scope;
use crate::syncd::{catalog_revision, db, suwayomi_projection};
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
    /// The part of it that is library rather than reading state (progress, history, bookmarks).
    /// Sent mid-run as soon as it reaches zero, so a first run can go on while progress uploads.
    #[serde(default)]
    pub pending_library_uploads: Option<i64>,
}

/// A device's last upload report. `pending` stays `None` until a device that reports uploads has
/// finished a sync run; devices too old to report count as having nothing left.
#[derive(Debug, Clone, Copy)]
struct UploadReport {
    pending: Option<i64>,
    /// Library rows among them; `None` from devices that do not tell them apart.
    library_pending: Option<i64>,
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
    library_pending: Option<i64>,
    now: Instant,
) {
    let key = (profile_id.to_string(), device_id.to_string());
    let previous = reports_by_device
        .get(&key)
        .filter(|report| now.duration_since(report.at) < UPLOAD_REPORT_TTL)
        .copied();
    let (pending, library_pending) = if reports {
        // A mid-run status call keeps the counts from the last finished run, if still fresh.
        let pending = pending.or(previous.and_then(|report| report.pending));
        let library_pending = library_pending
            .or(previous.and_then(|report| report.library_pending))
            // Nothing left at all leaves no library rows either.
            .or(pending.filter(|pending| *pending == 0));
        (pending, library_pending)
    } else {
        (Some(0), Some(0))
    };
    reports_by_device.insert(key, UploadReport { pending, library_pending, at: now });
}

fn pending_uploads_at(reports_by_device: &mut UploadReports, now: Instant) -> Option<i64> {
    sum_fresh_reports(reports_by_device, now, |report| report.pending)
}

fn pending_library_uploads_at(reports_by_device: &mut UploadReports, now: Instant) -> Option<i64> {
    sum_fresh_reports(reports_by_device, now, |report| report.library_pending)
}

fn sum_fresh_reports(
    reports_by_device: &mut UploadReports,
    now: Instant,
    count: impl Fn(&UploadReport) -> Option<i64>,
) -> Option<i64> {
    reports_by_device.retain(|_, report| now.duration_since(report.at) < UPLOAD_REPORT_TTL);
    if reports_by_device.is_empty() {
        return None;
    }
    reports_by_device
        .values()
        .try_fold(0_i64, |total, report| count(report).map(|pending| total.saturating_add(pending)))
}

fn upload_reports() -> std::sync::MutexGuard<'static, UploadReports> {
    UPLOAD_REPORTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What paired devices still have to upload here, from their latest status calls. `None` until
/// every device that synced lately has finished a run and reported it.
pub fn pending_uploads() -> Option<i64> {
    pending_uploads_at(&mut upload_reports(), Instant::now())
}

/// The library part of [`pending_uploads`]: `None` until every device that synced lately has told
/// how much of its upload is library, which older devices never do.
pub fn pending_library_uploads() -> Option<i64> {
    pending_library_uploads_at(&mut upload_reports(), Instant::now())
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
    /// Revision of the library titles and categories a device applies. Present only while it is
    /// known to match Suwayomi and no library change waits to be projected or is blocked (chapter
    /// progress is not part of it); a device that applied the same revision may skip reading the
    /// catalog again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comic_library_revision: Option<String>,
    /// Revision of the extension inventory, under the same rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comic_extensions_revision: Option<String>,
    /// Revision of the library titles and extensions without categories, which the portable
    /// manifest does not read, under the same rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comic_manifest_revision: Option<String>,
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
    if query
        .pending_library_uploads
        .is_some_and(|pending| !(0..=MAX_PENDING_UPLOADS).contains(&pending))
    {
        return Err(AppError::BadRequest("pendingLibraryUploads is out of range.".to_string()));
    }
    record_upload_report(
        &mut upload_reports(),
        profile_id,
        &session.device_id,
        query.reports_uploads == Some(true),
        query.pending_uploads,
        query.pending_library_uploads,
        Instant::now(),
    );

    let runtime = db::load_server_runtime(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load sync status.".to_string()))?;
    let suwayomi_projection::ProjectionStatusCounts { pending, blocked, in_flight, catalog_pending } =
        suwayomi_projection::projection_status_counts(&state.pool, profile_id)
            .await
            .map_err(|_| AppError::Internal("Failed to load Suwayomi projection status.".to_string()))?;

    let ready = pending == 0 && blocked == 0 && in_flight == 0;
    let revisions = announced_revisions(catalog_revision::current(profile_id), blocked, catalog_pending);
    let (comic_library_revision, comic_extensions_revision, comic_manifest_revision) = match revisions {
        Some(revisions) => (Some(revisions.library), Some(revisions.extensions), Some(revisions.manifest)),
        None => (None, None, None),
    };
    Ok(Json(SyncStatusResponse {
        scope_id: query.scope_id,
        current_server_version: runtime.current_server_version,
        min_replayable_server_version: runtime.min_replayable_server_version,
        comic_authority_mode: "suwayomi-confirmed-v1",
        suwayomi_projection_pending: pending,
        suwayomi_projection_blocked: blocked,
        suwayomi_projection_in_flight: in_flight,
        suwayomi_catalog_projection_pending: catalog_pending,
        ready,
        comic_library_revision,
        comic_extensions_revision,
        comic_manifest_revision,
    }))
}

/// Revisions are announced while no library change waits to be projected or is blocked. Pending
/// chapter progress does not hide them: it is not part of a revision, and a device reads the status
/// right after pushing its own progress.
fn announced_revisions(
    revisions: Option<catalog_revision::ComicRevisions>,
    blocked: i64,
    catalog_pending: i64,
) -> Option<catalog_revision::ComicRevisions> {
    revisions.filter(|_| blocked == 0 && catalog_pending == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_stay_announced_while_only_progress_projects() {
        let revisions = || {
            Some(catalog_revision::ComicRevisions {
                library: "library".to_string(),
                manifest: "manifest".to_string(),
                extensions: "extensions".to_string(),
            })
        };
        assert_eq!(announced_revisions(revisions(), 0, 0), revisions());
        // A library change still projecting or blocked hides them; so does an unknown revision.
        assert_eq!(announced_revisions(revisions(), 0, 1), None);
        assert_eq!(announced_revisions(revisions(), 1, 0), None);
        assert_eq!(announced_revisions(None, 0, 0), None);
    }

    #[test]
    fn pending_uploads_wait_for_every_reporting_device() {
        let mut reports = UploadReports::new();
        let now = Instant::now();
        assert_eq!(pending_uploads_at(&mut reports, now), None);

        // The phone's catalog sync calls mid-run with the marker only: nothing is known yet.
        record_upload_report(&mut reports, "main", "phone", true, None, None, now);
        assert_eq!(pending_uploads_at(&mut reports, now), None);

        record_upload_report(&mut reports, "main", "phone", true, Some(37), None, now);
        assert_eq!(pending_uploads_at(&mut reports, now), Some(37));

        // A later mid-run call keeps the last finished run's count.
        record_upload_report(&mut reports, "main", "phone", true, None, None, now);
        assert_eq!(pending_uploads_at(&mut reports, now), Some(37));

        // A device too old to report counts as having nothing left.
        record_upload_report(&mut reports, "main", "old-phone", false, None, None, now);
        assert_eq!(pending_uploads_at(&mut reports, now), Some(37));

        record_upload_report(&mut reports, "main", "phone", true, Some(0), None, now);
        assert_eq!(pending_uploads_at(&mut reports, now), Some(0));
    }

    #[test]
    fn stale_upload_reports_stop_counting() {
        let mut reports = UploadReports::new();
        let then = Instant::now();
        record_upload_report(&mut reports, "main", "gone", true, Some(5), None, then);
        let later = then + UPLOAD_REPORT_TTL;
        record_upload_report(&mut reports, "main", "phone", true, Some(0), None, later);
        assert_eq!(pending_uploads_at(&mut reports, later), Some(0));

        // A stale count is not carried into a new mid-run report.
        record_upload_report(&mut reports, "main", "gone", true, Some(5), None, then);
        record_upload_report(&mut reports, "main", "gone", true, None, None, later);
        assert_eq!(pending_uploads_at(&mut reports, later), None);
    }

    #[test]
    fn library_uploads_are_reported_before_the_run_ends() {
        let mut reports = UploadReports::new();
        let now = Instant::now();
        record_upload_report(&mut reports, "main", "phone", true, Some(900), Some(40), now);
        assert_eq!(pending_library_uploads_at(&mut reports, now), Some(40));

        // Mid-run, the library is in while 900 progress rows still upload.
        record_upload_report(&mut reports, "main", "phone", true, None, Some(0), now);
        assert_eq!(pending_uploads_at(&mut reports, now), Some(900));
        assert_eq!(pending_library_uploads_at(&mut reports, now), Some(0));

        // A later call without the library count keeps it.
        record_upload_report(&mut reports, "main", "phone", true, None, None, now);
        assert_eq!(pending_library_uploads_at(&mut reports, now), Some(0));

        // A device that does not tell library apart holds it until it has nothing left at all.
        record_upload_report(&mut reports, "main", "tablet", true, Some(3), None, now);
        assert_eq!(pending_library_uploads_at(&mut reports, now), None);
        record_upload_report(&mut reports, "main", "tablet", true, Some(0), None, now);
        assert_eq!(pending_library_uploads_at(&mut reports, now), Some(0));

        // Devices too old to report count as having nothing left.
        record_upload_report(&mut reports, "main", "old-phone", false, None, None, now);
        assert_eq!(pending_library_uploads_at(&mut reports, now), Some(0));
    }
}
