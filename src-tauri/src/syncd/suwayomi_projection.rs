use std::collections::BTreeSet;
use std::time::Duration;

use anyhow::Context;
use serde_json::Value;
use sqlx::FromRow;

use super::lifecycle::{wait_for_shutdown_request, ShutdownRequest};
use super::models::{
    canonical_portable_chapter_id, canonical_portable_work_id, AppError, AuthenticatedSession,
    PortableChapterRefV3, PortableResolutionStateV3, PortableWorkRefV3, SharedAppState,
};
use super::routes::suwayomi_commands::{self, CommandOperation};
use super::{db, routes::suwayomi_catalog};

const MAX_BATCH: usize = 8;
const LEASE_MS: i64 = 60_000;
const BASE_RETRY_MS: i64 = 30_000;
const MAX_RETRY_MS: i64 = 6 * 60 * 60 * 1_000;
const PORTABLE_CHAPTER_PAGE_SIZE: i64 = 250;
const MAX_PORTABLE_CHAPTER_PAGES: usize = 80;

const PORTABLE_CHAPTER_LOOKUP_QUERY: &str = r#"
  query EpigraphResolvePortableChapter($mangaId: Int!, $first: Int!, $offset: Int!) {
    chapters(condition: { mangaId: $mangaId }, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id mangaId url }
    }
  }
"#;

#[derive(Debug, Clone, FromRow)]
struct ProjectionRow {
    operation_id: String,
    profile_id: String,
    operation_name: String,
    variables_json: String,
    attempt_count: i64,
}

pub fn spawn_projection_task(
    state: SharedAppState,
    mut shutdown: tokio::sync::watch::Receiver<Option<ShutdownRequest>>,
) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(2));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(error) = drain_ready(&state).await {
                        tracing::warn!(error = %error, "failed to drain canonical Suwayomi projections");
                    }
                }
                _ = wait_for_shutdown_request(&mut shutdown) => break,
            }
        }
    });
}

#[allow(dead_code)]
pub async fn pending_projection_count(state: &SharedAppState) -> anyhow::Result<i64> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM suwayomi_projection_outbox WHERE status IN ('pending', 'in_flight', 'retry', 'blocked')",
    )
    .fetch_one(&state.pool)
    .await
    .context("failed to count pending Suwayomi projections")
}

async fn drain_ready(state: &SharedAppState) -> anyhow::Result<usize> {
    let mut completed = 0;
    for _ in 0..MAX_BATCH {
        let Some(row) = claim_next(state).await? else {
            break;
        };
        match apply_projection(state, &row).await {
            ProjectionOutcome::Applied => {
                let _writer_guard = state.mutation_gate.lock().await;
                sqlx::query("DELETE FROM suwayomi_projection_outbox WHERE operation_id = ?")
                    .bind(&row.operation_id)
                    .execute(&state.pool)
                    .await?;
                completed += 1;
            }
            ProjectionOutcome::Retry(code) => {
                let shift = row.attempt_count.clamp(0, 8) as u32;
                let delay = BASE_RETRY_MS
                    .saturating_mul(1_i64 << shift)
                    .min(MAX_RETRY_MS);
                let now = super::db::now_ms();
                let _writer_guard = state.mutation_gate.lock().await;
                sqlx::query(
                    r#"
                    UPDATE suwayomi_projection_outbox
                    SET status = 'retry', next_attempt_at_ms = ?, lease_until_ms = NULL,
                        last_error = ?, updated_at_ms = ?
                    WHERE operation_id = ?
                    "#,
                )
                .bind(now.saturating_add(delay))
                .bind(code)
                .bind(now)
                .bind(&row.operation_id)
                .execute(&state.pool)
                .await?;
            }
            ProjectionOutcome::Blocked(code) => {
                let now = super::db::now_ms();
                let _writer_guard = state.mutation_gate.lock().await;
                sqlx::query(
                    r#"
                    UPDATE suwayomi_projection_outbox
                    SET status = 'blocked', lease_until_ms = NULL, last_error = ?, updated_at_ms = ?
                    WHERE operation_id = ?
                    "#,
                )
                .bind(code)
                .bind(now)
                .bind(&row.operation_id)
                .execute(&state.pool)
                .await?;
            }
        }
    }
    Ok(completed)
}

async fn claim_next(state: &SharedAppState) -> anyhow::Result<Option<ProjectionRow>> {
    let _writer_guard = state.mutation_gate.lock().await;
    let now = super::db::now_ms();
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE suwayomi_projection_outbox
        SET status = 'retry', next_attempt_at_ms = ?, lease_until_ms = NULL,
            last_error = 'lease_expired', updated_at_ms = ?
        WHERE status = 'in_flight' AND lease_until_ms IS NOT NULL AND lease_until_ms <= ?
        "#,
    )
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let row = sqlx::query_as::<_, ProjectionRow>(
        r#"
        SELECT operation_id, profile_id, operation_name, variables_json, attempt_count
        FROM suwayomi_projection_outbox
        WHERE status IN ('pending', 'retry') AND next_attempt_at_ms <= ?
        ORDER BY source_server_version ASC
        LIMIT 1
        "#,
    )
    .bind(now)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = &row {
        sqlx::query(
            r#"
            UPDATE suwayomi_projection_outbox
            SET status = 'in_flight', attempt_count = attempt_count + 1,
                lease_until_ms = ?, last_error = NULL, updated_at_ms = ?
            WHERE operation_id = ?
            "#,
        )
        .bind(now.saturating_add(LEASE_MS))
        .bind(now)
        .bind(&row.operation_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(row)
}

async fn apply_projection(state: &SharedAppState, row: &ProjectionRow) -> ProjectionOutcome {
    let variables: Value = match serde_json::from_str(&row.variables_json) {
        Ok(value) => value,
        Err(_) => return ProjectionOutcome::Blocked("invalid_variables"),
    };
    let variables = match resolve_portable_projection_identity(state, row, variables).await {
        Ok(variables) => variables,
        Err(outcome) => return outcome,
    };
    let operation = match row.operation_name.as_str() {
        "UpdateManga" => CommandOperation::UpdateManga,
        "UpdateMangaCategories" => CommandOperation::UpdateMangaCategories,
        "UpdateChaptersProgress" => CommandOperation::UpdateChaptersProgress,
        "UpdateCategory" => CommandOperation::UpdateCategory,
        "DeleteCategory" => CommandOperation::DeleteCategory,
        "UpdateCategoryOrder" => CommandOperation::UpdateCategoryOrder,
        _ => return ProjectionOutcome::Blocked("unsupported_operation"),
    };
    let command_variables = if operation == CommandOperation::UpdateChaptersProgress {
        let Some(object) = variables.as_object() else {
            return ProjectionOutcome::Blocked("invalid_variables");
        };
        let mut object = object.clone();
        object.remove("mangaId");
        Value::Object(object)
    } else {
        variables.clone()
    };
    let data = match suwayomi_commands::execute_internal_command(
        state,
        &row.profile_id,
        operation,
        command_variables,
    )
    .await
    {
        Ok(data) => data,
        Err(AppError::BadRequest(_) | AppError::Forbidden(_)) => {
            return ProjectionOutcome::Blocked("command_rejected")
        }
        Err(_) => return ProjectionOutcome::Retry("runtime_unavailable"),
    };
    if projection_confirmed(operation, &variables, &data) {
        ProjectionOutcome::Applied
    } else {
        ProjectionOutcome::Retry("confirmation_mismatch")
    }
}

async fn resolve_portable_projection_identity(
    state: &SharedAppState,
    row: &ProjectionRow,
    mut variables: Value,
) -> Result<Value, ProjectionOutcome> {
    let Some(object) = variables.as_object_mut() else {
        return Err(ProjectionOutcome::Blocked("invalid_variables"));
    };
    let work_value = object.get("portableWorkRef").cloned();
    let chapter_value = object.get("portableChapterRef").cloned();
    if work_value.is_none() && chapter_value.is_none() {
        return Ok(variables);
    }
    let Some(work_value) = work_value else {
        return Err(ProjectionOutcome::Blocked("incomplete_portable_reference"));
    };
    let work: PortableWorkRefV3 = serde_json::from_value(work_value)
        .map_err(|_| ProjectionOutcome::Blocked("invalid_portable_work_reference"))?;
    work.validate()
        .map_err(|_| ProjectionOutcome::Blocked("invalid_portable_work_reference"))?;
    if !matches!(work, PortableWorkRefV3::Comic { .. }) {
        return Err(ProjectionOutcome::Blocked(
            "portable_reference_type_mismatch",
        ));
    }

    let portable_work_id = canonical_portable_work_id(&work);
    let binding = db::load_portable_work_binding(&state.pool, &row.profile_id, &portable_work_id)
        .await
        .map_err(|_| ProjectionOutcome::Retry("portable_binding_unavailable"))?
        .ok_or(ProjectionOutcome::Retry("portable_work_not_bound"))?;
    if binding.portable_ref().ok().as_ref() != Some(&work) || binding.resolution_state != "BOUND" {
        return Err(ProjectionOutcome::Blocked("portable_work_binding_mismatch"));
    }
    let manga_id = binding
        .local_reference
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0 && *value <= i32::MAX as i64)
        .ok_or(ProjectionOutcome::Blocked(
            "portable_work_local_reference_invalid",
        ))?;

    let Some(chapter_value) = chapter_value else {
        object.remove("portableWorkRef");
        match row.operation_name.as_str() {
            "UpdateManga" => object.insert("id".to_string(), Value::from(manga_id)),
            "UpdateMangaCategories" => object.insert("mangaId".to_string(), Value::from(manga_id)),
            _ => return Err(ProjectionOutcome::Blocked("incomplete_portable_reference")),
        };
        return Ok(variables);
    };
    let chapter: PortableChapterRefV3 = serde_json::from_value(chapter_value)
        .map_err(|_| ProjectionOutcome::Blocked("invalid_portable_chapter_reference"))?;
    chapter
        .validate()
        .map_err(|_| ProjectionOutcome::Blocked("invalid_portable_chapter_reference"))?;
    let PortableChapterRefV3::Comic {
        work: chapter_work,
        chapter_key,
    } = &chapter
    else {
        return Err(ProjectionOutcome::Blocked(
            "portable_reference_type_mismatch",
        ));
    };
    if chapter_work != &work {
        return Err(ProjectionOutcome::Blocked(
            "portable_reference_parent_mismatch",
        ));
    }

    let portable_chapter_id = canonical_portable_chapter_id(&chapter);
    let cached_chapter_id =
        db::load_portable_chapter_binding(&state.pool, &row.profile_id, &portable_chapter_id)
            .await
            .map_err(|_| ProjectionOutcome::Retry("portable_binding_unavailable"))?
            .filter(|binding| {
                binding.portable_work_id == portable_work_id
                    && binding.provider_key == *chapter_key
                    && binding.resolution_state == "BOUND"
            })
            .and_then(|binding| binding.local_reference)
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| *value > 0 && *value <= i32::MAX as i64);
    let chapter_id = match cached_chapter_id {
        Some(chapter_id) => chapter_id,
        None => resolve_chapter_id(state, &row.profile_id, manga_id, chapter_key).await?,
    };
    let local_chapter_reference = chapter_id.to_string();
    db::upsert_portable_chapter_binding(
        &state.pool,
        &row.profile_id,
        &portable_chapter_id,
        &portable_work_id,
        chapter_key,
        Some(&local_chapter_reference),
        PortableResolutionStateV3::Bound,
        None,
        0,
        db::now_ms(),
    )
    .await
    .map_err(|_| ProjectionOutcome::Retry("portable_binding_unavailable"))?;

    object.remove("portableWorkRef");
    object.remove("portableChapterRef");
    object.insert("mangaId".to_string(), Value::from(manga_id));
    object.insert(
        "ids".to_string(),
        Value::Array(vec![Value::from(chapter_id)]),
    );
    Ok(variables)
}

async fn resolve_chapter_id(
    state: &SharedAppState,
    profile_id: &str,
    manga_id: i64,
    chapter_key: &str,
) -> Result<i64, ProjectionOutcome> {
    let session = AuthenticatedSession {
        token_id: "epigraph-core-projection".to_string(),
        device_id: "epigraph-core".to_string(),
        profile_id: profile_id.to_string(),
        scopes: BTreeSet::from([format!("comics:profile:{profile_id}")]),
        mutation_receipt: None,
    };
    for page in 0..MAX_PORTABLE_CHAPTER_PAGES {
        let offset = (page as i64).saturating_mul(PORTABLE_CHAPTER_PAGE_SIZE);
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            &session,
            PORTABLE_CHAPTER_LOOKUP_QUERY,
            serde_json::json!({
                "mangaId": manga_id,
                "first": PORTABLE_CHAPTER_PAGE_SIZE,
                "offset": offset,
            }),
            false,
        )
        .await
        .map_err(|_| ProjectionOutcome::Retry("runtime_unavailable"))?;
        let chapters = data
            .get("chapters")
            .ok_or(ProjectionOutcome::Retry("portable_chapter_lookup_invalid"))?;
        if let Some(id) = chapters
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|node| {
                node.get("mangaId").and_then(Value::as_i64) == Some(manga_id)
                    && node.get("url").and_then(Value::as_str) == Some(chapter_key)
            })
            .and_then(|node| node.get("id"))
            .and_then(Value::as_i64)
            .filter(|id| *id > 0 && *id <= i32::MAX as i64)
        {
            return Ok(id);
        }
        let has_next = chapters
            .get("pageInfo")
            .and_then(|value| value.get("hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_next {
            return Err(ProjectionOutcome::Retry("portable_chapter_not_resolved"));
        }
    }
    Err(ProjectionOutcome::Retry("portable_chapter_lookup_limit"))
}

fn projection_confirmed(operation: CommandOperation, variables: &Value, data: &Value) -> bool {
    match operation {
        CommandOperation::UpdateManga => {
            let expected_id = variables.get("id").and_then(Value::as_i64);
            let expected_membership = variables.get("inLibrary").and_then(Value::as_bool);
            let manga = data.get("updateManga").and_then(|value| value.get("manga"));
            manga
                .and_then(|value| value.get("id"))
                .and_then(Value::as_i64)
                == expected_id
                && expected_membership.map_or(true, |expected| {
                    manga
                        .and_then(|value| value.get("inLibrary"))
                        .and_then(Value::as_bool)
                        == Some(expected)
                })
        }
        CommandOperation::UpdateMangaCategories => {
            let expected_id = variables.get("mangaId").and_then(Value::as_i64);
            data.get("updateMangaCategories")
                .and_then(|value| value.get("manga"))
                .and_then(|value| value.get("id"))
                .and_then(Value::as_i64)
                == expected_id
        }
        CommandOperation::UpdateChaptersProgress => chapters_projection_confirmed(variables, data),
        CommandOperation::UpdateCategory => {
            let expected_id = variables.get("id").and_then(Value::as_i64);
            let expected_name = variables.get("name").and_then(Value::as_str);
            let category = data
                .get("updateCategory")
                .and_then(|value| value.get("category"));
            category
                .and_then(|value| value.get("id"))
                .and_then(Value::as_i64)
                == expected_id
                && expected_name.map_or(true, |expected| {
                    category
                        .and_then(|value| value.get("name"))
                        .and_then(Value::as_str)
                        == Some(expected)
                })
        }
        CommandOperation::DeleteCategory => {
            let expected_id = variables.get("id").and_then(Value::as_i64);
            data.get("deleteCategory")
                .and_then(|value| value.get("category"))
                .and_then(|value| value.get("id"))
                .and_then(Value::as_i64)
                == expected_id
        }
        CommandOperation::UpdateCategoryOrder => {
            let expected_id = variables.get("id").and_then(Value::as_i64);
            let expected_position = variables.get("position").and_then(Value::as_i64);
            data.get("updateCategoryOrder")
                .and_then(|value| value.get("categories"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|category| {
                    category.get("id").and_then(Value::as_i64) == expected_id
                        && category.get("order").and_then(Value::as_i64) == expected_position
                })
        }
    }
}

fn chapters_projection_confirmed(variables: &Value, data: &Value) -> bool {
    let Some(expected_ids) = variables
        .get("ids")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_i64).collect::<Vec<_>>())
        .filter(|ids| !ids.is_empty())
    else {
        return false;
    };
    let chapters = data
        .get("updateChapters")
        .and_then(|value| value.get("chapters"))
        .and_then(Value::as_array);
    let Some(chapters) = chapters else {
        return false;
    };
    expected_ids.iter().all(|expected_id| {
        chapters.iter().any(|chapter| {
            chapter.get("id").and_then(Value::as_i64) == Some(*expected_id)
                && optional_field_matches(variables, chapter, "isRead", Value::as_bool)
                && optional_field_matches(variables, chapter, "isBookmarked", Value::as_bool)
            // lastPageRead is intentionally NOT part of the confirmation: Suwayomi
            // clamps it against the chapter's known page count, and extension-fetched
            // chapters carry pageCount = -1, so the echoed value is 0 regardless of the
            // input. The chapter id plus read/bookmark state are the reliable signals.
        })
    })
}

fn optional_field_matches<T: PartialEq>(
    expected: &Value,
    actual: &Value,
    field: &str,
    decode: fn(&Value) -> Option<T>,
) -> bool {
    let Some(expected) = expected.get(field).filter(|value| !value.is_null()) else {
        return true;
    };
    decode(actual.get(field).unwrap_or(&Value::Null)) == decode(expected)
}

enum ProjectionOutcome {
    Applied,
    Retry(&'static str),
    Blocked(&'static str),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirms_each_allowlisted_projection_shape() {
        assert!(projection_confirmed(
            CommandOperation::UpdateManga,
            &serde_json::json!({ "id": 7, "inLibrary": true }),
            &serde_json::json!({ "updateManga": { "manga": { "id": 7, "inLibrary": true } } }),
        ));
        assert!(projection_confirmed(
            CommandOperation::UpdateMangaCategories,
            &serde_json::json!({ "mangaId": 7, "addTo": [3], "removeFrom": [] }),
            &serde_json::json!({ "updateMangaCategories": { "manga": { "id": 7 } } }),
        ));
        assert!(projection_confirmed(
            CommandOperation::UpdateChaptersProgress,
            &serde_json::json!({
                "mangaId": 7,
                "ids": [11],
                "isRead": true,
                "isBookmarked": false,
                "lastPageRead": 8
            }),
            &serde_json::json!({
                "updateChapters": {
                    "chapters": [{
                        "id": 11,
                        "isRead": true,
                        "isBookmarked": false,
                        "lastPageRead": 8
                    }]
                }
            }),
        ));
        assert!(projection_confirmed(
            CommandOperation::UpdateCategory,
            &serde_json::json!({ "id": 3, "name": "Reading" }),
            &serde_json::json!({
                "updateCategory": { "category": { "id": 3, "name": "Reading", "order": 2 } }
            }),
        ));
        assert!(projection_confirmed(
            CommandOperation::DeleteCategory,
            &serde_json::json!({ "id": 3 }),
            &serde_json::json!({ "deleteCategory": { "category": { "id": 3 } } }),
        ));
        assert!(projection_confirmed(
            CommandOperation::UpdateCategoryOrder,
            &serde_json::json!({ "id": 3, "position": 2 }),
            &serde_json::json!({
                "updateCategoryOrder": { "categories": [{ "id": 3, "order": 2 }] }
            }),
        ));
    }

    #[test]
    fn rejects_incomplete_or_mismatched_projection_confirmation() {
        assert!(!projection_confirmed(
            CommandOperation::UpdateManga,
            &serde_json::json!({ "id": 7, "inLibrary": true }),
            &serde_json::json!({ "updateManga": { "manga": { "id": 7, "inLibrary": false } } }),
        ));
        assert!(!projection_confirmed(
            CommandOperation::UpdateChaptersProgress,
            &serde_json::json!({ "ids": [11], "lastPageRead": 8 }),
            &serde_json::json!({ "updateChapters": { "chapters": [] } }),
        ));
        assert!(!projection_confirmed(
            CommandOperation::UpdateCategoryOrder,
            &serde_json::json!({ "id": 3, "position": 2 }),
            &serde_json::json!({
                "updateCategoryOrder": { "categories": [{ "id": 3, "order": 1 }] }
            }),
        ));
    }
}
