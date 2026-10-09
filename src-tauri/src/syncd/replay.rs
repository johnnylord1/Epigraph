use std::collections::BTreeSet;

use axum::http::HeaderMap;

use super::db;
use super::middleware::filter_allowed_scopes;
use super::models::{AppError, AuthenticatedSession, ChangeEnvelope, SharedAppState};

const LAST_EVENT_ID_HEADER: &str = "last-event-id";

pub struct ReplayContext {
    pub snapshot_version: i64,
    pub backlog: Vec<ChangeEnvelope>,
    pub allowed_scopes: BTreeSet<String>,
}

pub async fn prepare_replay(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    scope_filter: Option<&str>,
    headers: &HeaderMap,
) -> Result<ReplayContext, AppError> {
    let runtime = db::load_server_runtime(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load replay state.".to_string()))?;
    let last_event_id = parse_last_event_id(headers)?;
    if let Some(last) = last_event_id {
        if last < runtime.min_replayable_server_version {
            return Err(AppError::replay_window_expired(
                runtime.current_server_version,
                runtime.min_replayable_server_version,
            ));
        }
        if last > runtime.current_server_version {
            return Err(AppError::replay_cursor_ahead(
                last,
                runtime.current_server_version,
                runtime.min_replayable_server_version,
            ));
        }
    }

    let allowed_scopes = filter_allowed_scopes(session, scope_filter)?;
    let snapshot_version = runtime.current_server_version;
    let starting_after = last_event_id.unwrap_or(snapshot_version);

    let backlog_rows = db::fetch_replay_changes(&state.pool, starting_after, snapshot_version)
        .await
        .map_err(|_| AppError::Internal("Failed to fetch replay backlog.".to_string()))?;
    let mut backlog = Vec::new();
    for row in backlog_rows {
        if !allowed_scopes.contains(&row.scope_id) {
            continue;
        }
        let envelope = ChangeEnvelope::try_from(row)
            .map_err(|_| AppError::Internal("Failed to decode replay backlog row.".to_string()))?;
        backlog.push(envelope);
    }

    Ok(ReplayContext {
        snapshot_version,
        backlog,
        allowed_scopes,
    })
}

pub fn parse_last_event_id(headers: &HeaderMap) -> Result<Option<i64>, AppError> {
    let Some(raw) = headers.get(LAST_EVENT_ID_HEADER) else {
        return Ok(None);
    };
    let value = raw
        .to_str()
        .map_err(|_| AppError::BadRequest("Invalid Last-Event-ID header.".to_string()))?;
    let parsed = value
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest("Last-Event-ID must be an integer.".to_string()))?;
    Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};

    use super::parse_last_event_id;

    #[test]
    fn parses_last_event_id_header() {
        let mut headers = HeaderMap::new();
        headers.insert("last-event-id", HeaderValue::from_static("42"));
        assert_eq!(parse_last_event_id(&headers).unwrap(), Some(42));
    }
}
