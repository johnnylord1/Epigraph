use axum::extract::{Extension, State};
use axum::response::Json;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

use crate::syncd::db;
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{
    AppError, AuthenticatedSession, BookBookmarkPatch, BookCategoryAssignmentPatch,
    BookCategoryPatch, BookEntryPatch, BookLibraryUiPatch, BookProgressPatch, ErrorDetail,
    MutationEntityType, MutationInput, MutationOperation, MutationReceiptContext, MutationResult,
    MutationResultStatus, MutationsRequest, MutationsResponse, NovelBookmarkPatch,
    NovelChapterPatch, NovelClassificationPatch, NovelEntryPatch, NovelHistoryPatch,
    NovelProgressPatch, SharedAppState,
};

pub async fn post_mutations(
    State(state): State<SharedAppState>,
    Extension(mut session): Extension<AuthenticatedSession>,
    Json(request): Json<MutationsRequest>,
) -> Result<Json<MutationsResponse>, AppError> {
    if request.request_id.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Mutations requestId must not be empty.".to_string(),
        ));
    }
    if request.mutations.is_empty() {
        return Err(AppError::BadRequest(
            "Mutations request must include at least one mutation.".to_string(),
        ));
    }

    let _mutation_guard = state.mutation_gate.lock().await;

    let mut results = Vec::with_capacity(request.mutations.len());
    let mut receipt_contexts = HashMap::<String, MutationReceiptContext>::new();
    let mut current_server_version = db::load_server_runtime(&state.pool)
        .await
        .map_err(|_| AppError::Internal("Failed to load syncd runtime state.".to_string()))?
        .current_server_version;

    for mutation in request.mutations {
        let entity_type = mutation.entity_type();
        let base = mutation.base();
        if base.client_mutation_id.trim().is_empty() {
            return Err(AppError::BadRequest(
                "Mutation clientMutationId must not be empty.".to_string(),
            ));
        }

        let (mutation_json, mutation_hash) = canonical_mutation(&mutation)?;
        let receipt_context = MutationReceiptContext {
            device_id: session.device_id.clone(),
            client_mutation_id: base.client_mutation_id.clone(),
            mutation_hash,
            mutation_json,
            entity_type,
            entity_id: base.entity_id.clone(),
            canonical_entity_id: None,
            scope_id: base.scope_id.clone(),
            op: base.op,
        };
        if let Some(previous) = receipt_contexts.get(&base.client_mutation_id) {
            if previous.mutation_hash != receipt_context.mutation_hash {
                return Err(receipt_conflict_error(previous, &receipt_context));
            }
        } else {
            receipt_contexts.insert(base.client_mutation_id.clone(), receipt_context.clone());
        }

        match db::lookup_mutation_receipt(
            &state.pool,
            &session.device_id,
            &base.client_mutation_id,
            &receipt_context.mutation_hash,
        )
        .await
        .map_err(|error| AppError::Internal(format!("Failed to load mutation receipt: {error}")))?
        {
            db::MutationReceiptLookup::Missing => {}
            db::MutationReceiptLookup::Match(result) => {
                if let Some(version) = result.applied_server_version {
                    current_server_version = current_server_version.max(version);
                }
                results.push(result);
                continue;
            }
            db::MutationReceiptLookup::Conflict { existing_hash } => {
                return Err(receipt_hash_conflict_error(
                    &session.device_id,
                    &base.client_mutation_id,
                    &existing_hash,
                    &receipt_context.mutation_hash,
                ));
            }
        }

        session.mutation_receipt = Some(receipt_context);
        if let Some(error) = validate_mutation_base(
            &session,
            entity_type,
            base.op,
            &base.scope_id,
            &base.entity_id,
            base.lamport,
        ) {
            results.push(rejected_result(&mutation, error));
            continue;
        }

        let outcome = match &mutation {
            MutationInput::BookEntry { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Book entry merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_book_entry_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    db::apply_book_entry_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to persist book entry mutation: {error}"
                        ))
                    })?
                }
                MutationOperation::Delete => db::delete_book_entry_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &base.entity_id,
                    base.lamport,
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!("Failed to delete book entry mutation: {error}"))
                })?,
            },
            MutationInput::BookCategory { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Book category merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_book_category_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    db::apply_book_category_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to persist book category mutation: {error}"
                        ))
                    })?
                }
                MutationOperation::Delete => db::delete_book_category_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &base.entity_id,
                    base.lamport,
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!("Failed to delete book category mutation: {error}"))
                })?,
            },
            MutationInput::BookCategoryAssignment { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Book category assignment merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_book_category_assignment_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    db::apply_book_category_assignment_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to persist book category assignment mutation: {error}"
                        ))
                    })?
                }
                MutationOperation::Delete => db::delete_book_category_assignment_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &base.entity_id,
                    base.lamport,
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!(
                        "Failed to delete book category assignment mutation: {error}"
                    ))
                })?,
            },
            MutationInput::BookLibraryUi { base, patch } => match base.op {
                MutationOperation::Merge => {
                    if let Some(error) = validate_book_library_ui_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    db::apply_book_library_ui_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to persist book library UI mutation: {error}"
                        ))
                    })?
                }
                MutationOperation::Delete => {
                    results.push(rejected_result(
                        &mutation,
                        error_detail(
                            "UNSUPPORTED_OPERATION",
                            "Delete is not supported for book library UI mutations in this slice.",
                            Some(json!({
                                "entityType": "book.library_ui",
                                "op": "delete",
                            })),
                        ),
                    ));
                    continue;
                }
            },
            MutationInput::BookProgress { base, patch } => {
                if let Some(error) = validate_book_progress_patch(patch) {
                    results.push(rejected_result(&mutation, error));
                    continue;
                }
                db::apply_book_progress_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &base.entity_id,
                    patch,
                    base.lamport,
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!("Failed to persist book progress mutation: {error}"))
                })?
            }
            MutationInput::NovelProgress { base, patch } => {
                if let Some(error) = validate_novel_progress_patch(patch) {
                    results.push(rejected_result(&mutation, error));
                    continue;
                }
                let (prefix, requested_novel_id) = base
                    .entity_id
                    .strip_prefix("novel.progress::")
                    .map(|novel_id| ("novel.progress::", novel_id))
                    .unwrap_or(("", base.entity_id.as_str()));
                let canonical_novel_id =
                    db::resolve_novel_entity_id(&state.pool, &base.scope_id, requested_novel_id)
                        .await
                        .map_err(|error| {
                            AppError::Internal(format!(
                                "Failed to resolve novel progress identity: {error}"
                            ))
                        })?;
                let canonical_entity_id = format!("{prefix}{canonical_novel_id}");
                set_canonical_receipt(&mut session, &base.entity_id, &canonical_entity_id);
                db::apply_novel_progress_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &canonical_entity_id,
                    patch,
                    base.lamport,
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!(
                        "Failed to persist novel progress mutation: {error}"
                    ))
                })?
            }
            MutationInput::BookBookmark { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Bookmark merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_book_bookmark_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    match db::apply_book_bookmark_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            if let Some(error) = bookmark_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to persist book bookmark mutation.".to_string(),
                            ));
                        }
                    }
                }
                MutationOperation::Delete => {
                    if patch.is_some() {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "DELETE_PATCH_NOT_ALLOWED",
                                "Bookmark delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    match db::delete_book_bookmark_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            if let Some(error) = bookmark_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to delete book bookmark mutation.".to_string(),
                            ));
                        }
                    }
                }
            },
            MutationInput::NovelEntry { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Novel entry merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_novel_entry_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    let canonical_entity_id = db::resolve_novel_entry_entity_id(
                        &state.pool,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to resolve novel entry identity: {error}"
                        ))
                    })?;
                    if canonical_entity_id != base.entity_id {
                        if let Some(context) = session.mutation_receipt.as_mut() {
                            context.canonical_entity_id = Some(canonical_entity_id.clone());
                        }
                    }
                    db::apply_novel_entry_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &canonical_entity_id,
                        patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to persist novel entry mutation: {error}"
                        ))
                    })?
                }
                MutationOperation::Delete => {
                    let canonical_entity_id =
                        db::resolve_novel_entity_id(&state.pool, &base.scope_id, &base.entity_id)
                            .await
                            .map_err(|error| {
                                AppError::Internal(format!(
                                    "Failed to resolve novel entry identity for delete: {error}"
                                ))
                            })?;
                    set_canonical_receipt(&mut session, &base.entity_id, &canonical_entity_id);
                    db::delete_novel_entry_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &canonical_entity_id,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to delete novel entry mutation: {error}"
                        ))
                    })?
                }
            },
            MutationInput::NovelChapter { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Novel chapter merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_novel_chapter_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    let mut canonical_patch = patch.clone();
                    canonical_patch.novel_id =
                        db::resolve_novel_entity_id(&state.pool, &base.scope_id, &patch.novel_id)
                            .await
                            .map_err(|error| {
                                AppError::Internal(format!(
                                    "Failed to resolve novel chapter owner: {error}"
                                ))
                            })?;
                    db::apply_novel_chapter_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        &canonical_patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to persist novel chapter mutation: {error}"
                        ))
                    })?
                }
                MutationOperation::Delete => db::delete_novel_chapter_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &base.entity_id,
                    base.lamport,
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!("Failed to delete novel chapter mutation: {error}"))
                })?,
            },
            MutationInput::NovelBookmark { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Bookmark merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_novel_bookmark_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    let mut canonical_patch = patch.clone();
                    canonical_patch.novel_id =
                        db::resolve_novel_entity_id(&state.pool, &base.scope_id, &patch.novel_id)
                            .await
                            .map_err(|error| {
                                AppError::Internal(format!(
                                    "Failed to resolve novel bookmark owner: {error}"
                                ))
                            })?;
                    match db::apply_novel_bookmark_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        &canonical_patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            if let Some(error) = bookmark_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to persist novel bookmark mutation.".to_string(),
                            ));
                        }
                    }
                }
                MutationOperation::Delete => {
                    if patch.is_some() {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "DELETE_PATCH_NOT_ALLOWED",
                                "Bookmark delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    match db::delete_novel_bookmark_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            if let Some(error) = bookmark_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to delete novel bookmark mutation.".to_string(),
                            ));
                        }
                    }
                }
            },
            MutationInput::NovelHistory { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Novel history merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_novel_history_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    let mut canonical_patch = patch.clone();
                    canonical_patch.novel_id =
                        db::resolve_novel_entity_id(&state.pool, &base.scope_id, &patch.novel_id)
                            .await
                            .map_err(|error| {
                                AppError::Internal(format!(
                                    "Failed to resolve novel history owner: {error}"
                                ))
                            })?;
                    db::apply_novel_history_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        &canonical_patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to persist novel history mutation: {error}"
                        ))
                    })?
                }
                MutationOperation::Delete => db::delete_novel_history_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &base.entity_id,
                    base.lamport,
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!("Failed to delete novel history mutation: {error}"))
                })?,
            },
            MutationInput::NovelClassification { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Novel classification merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_novel_classification_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    db::apply_novel_classification_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|error| {
                        AppError::Internal(format!(
                            "Failed to persist novel classification mutation: {error}"
                        ))
                    })?
                }
                MutationOperation::Delete => db::delete_novel_classification_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &base.entity_id,
                    base.lamport,
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!(
                        "Failed to delete novel classification mutation: {error}"
                    ))
                })?,
            },
        };

        current_server_version = outcome.envelope.server_version;
        let _ = state.change_sender.send(outcome.envelope.clone());
        results.push(MutationResult {
            client_mutation_id: base.client_mutation_id.clone(),
            entity_type,
            entity_id: base.entity_id.clone(),
            canonical_entity_id: (outcome.envelope.entity_id != base.entity_id)
                .then(|| outcome.envelope.entity_id.clone()),
            scope_id: base.scope_id.clone(),
            op: base.op,
            status: MutationResultStatus::Applied,
            applied_server_version: Some(outcome.envelope.server_version),
            applied_lamport: Some(outcome.applied_lamport),
            record: Some(outcome.record),
            error: None,
        });
    }

    for result in &mut results {
        if result.status != MutationResultStatus::Rejected {
            continue;
        }
        let Some(context) = receipt_contexts.get(&result.client_mutation_id) else {
            return Err(AppError::Internal(
                "Mutation receipt context was lost before persistence.".to_string(),
            ));
        };
        match db::persist_rejected_mutation_receipt(&state.pool, context, result)
            .await
            .map_err(|error| {
                AppError::Internal(format!("Failed to persist mutation receipt: {error}"))
            })? {
            db::MutationReceiptLookup::Match(stored) => *result = stored,
            db::MutationReceiptLookup::Conflict { existing_hash } => {
                return Err(receipt_hash_conflict_error(
                    &context.device_id,
                    &context.client_mutation_id,
                    &existing_hash,
                    &context.mutation_hash,
                ));
            }
            db::MutationReceiptLookup::Missing => {
                return Err(AppError::Internal(
                    "Mutation receipt disappeared after persistence.".to_string(),
                ));
            }
        }
    }

    Ok(Json(MutationsResponse {
        request_id: request.request_id,
        current_server_version,
        results,
    }))
}

fn canonical_mutation(mutation: &MutationInput) -> Result<(String, String), AppError> {
    let value = serde_json::to_value(mutation)
        .map_err(|error| AppError::Internal(format!("Failed to encode mutation: {error}")))?;
    let canonical = canonicalize_json(value);
    let mutation_json = serde_json::to_string(&canonical)
        .map_err(|error| AppError::Internal(format!("Failed to canonicalize mutation: {error}")))?;
    let mutation_hash = format!("{:x}", Sha256::digest(mutation_json.as_bytes()));
    Ok((mutation_json, mutation_hash))
}

fn set_canonical_receipt(
    session: &mut AuthenticatedSession,
    requested_entity_id: &str,
    canonical_entity_id: &str,
) {
    if requested_entity_id == canonical_entity_id {
        return;
    }
    if let Some(context) = session.mutation_receipt.as_mut() {
        context.canonical_entity_id = Some(canonical_entity_id.to_string());
    }
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let sorted = values
                .into_iter()
                .map(|(key, value)| (key, canonicalize_json(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(sorted.into_iter().collect())
        }
        scalar => scalar,
    }
}

fn receipt_conflict_error(
    existing: &MutationReceiptContext,
    incoming: &MutationReceiptContext,
) -> AppError {
    receipt_hash_conflict_error(
        &incoming.device_id,
        &incoming.client_mutation_id,
        &existing.mutation_hash,
        &incoming.mutation_hash,
    )
}

fn receipt_hash_conflict_error(
    device_id: &str,
    client_mutation_id: &str,
    existing_hash: &str,
    incoming_hash: &str,
) -> AppError {
    AppError::Conflict(ErrorDetail {
        code: "CLIENT_MUTATION_ID_REUSED".to_string(),
        message: "clientMutationId was already used by this device for different content."
            .to_string(),
        retryable: Some(false),
        min_client_version: None,
        current_server_version: None,
        min_replayable_server_version: None,
        required_action: Some("generate_new_client_mutation_id".to_string()),
        details: Some(json!({
            "deviceId": device_id,
            "clientMutationId": client_mutation_id,
            "existingMutationHash": existing_hash,
            "incomingMutationHash": incoming_hash,
        })),
    })
}

fn validate_mutation_base(
    session: &AuthenticatedSession,
    entity_type: MutationEntityType,
    operation: MutationOperation,
    scope_id: &str,
    entity_id: &str,
    lamport: i64,
) -> Option<ErrorDetail> {
    if entity_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_ENTITY_ID",
            "Mutation entityId must not be empty.",
            None,
        ));
    }
    if lamport < 0 {
        return Some(error_detail(
            "INVALID_LAMPORT",
            "Mutation lamport must be zero or greater.",
            Some(json!({ "receivedLamport": lamport })),
        ));
    }

    match entity_type {
        MutationEntityType::BookEntry
        | MutationEntityType::BookCategory
        | MutationEntityType::BookCategoryAssignment
        | MutationEntityType::BookLibraryUi
        | MutationEntityType::BookProgress
        | MutationEntityType::BookBookmark => {
            if scope_id != "books:global" {
                return Some(error_detail(
                    "INVALID_SCOPE_FOR_ENTITY",
                    "Book mutations must use books:global.",
                    Some(json!({
                        "entityType": entity_type.as_str(),
                        "expectedScope": "books:global",
                        "receivedScope": scope_id,
                    })),
                ));
            }
        }
        MutationEntityType::NovelEntry
        | MutationEntityType::NovelChapter
        | MutationEntityType::NovelHistory
        | MutationEntityType::NovelProgress
        | MutationEntityType::NovelBookmark
        | MutationEntityType::NovelClassification => {
            if !scope_id.starts_with("novels:profile:") {
                return Some(error_detail(
                    "INVALID_SCOPE_FOR_ENTITY",
                    "Novel mutations must use novels:profile:<id>.",
                    Some(json!({
                        "entityType": entity_type.as_str(),
                        "expectedScopePattern": "novels:profile:<id>",
                        "receivedScope": scope_id,
                    })),
                ));
            }
        }
    }

    match (entity_type, operation) {
        (
            MutationEntityType::BookProgress | MutationEntityType::NovelProgress,
            MutationOperation::Delete,
        ) => {
            return Some(error_detail(
                "UNSUPPORTED_OPERATION",
                "Delete is not supported for progress mutations in this slice.",
                Some(json!({
                    "entityType": entity_type.as_str(),
                    "op": "delete",
                })),
            ));
        }
        _ => {}
    }

    if let Err(error) = validate_scope(session, scope_id) {
        let message = match error {
            AppError::Forbidden(message) => message,
            _ => "Scope is not allowed for the authenticated token.".to_string(),
        };
        return Some(error_detail(
            "FORBIDDEN_SCOPE",
            &message,
            Some(json!({
                "entityType": entity_type.as_str(),
                "scopeId": scope_id,
                "profileId": session.profile_id,
            })),
        ));
    }

    None
}

fn validate_book_progress_patch(patch: &BookProgressPatch) -> Option<ErrorDetail> {
    if !matches!(patch.renderer.as_deref(), None | Some("epub") | Some("pdf")) {
        return Some(error_detail(
            "INVALID_RENDERER",
            "Book progress renderer must be 'epub' or 'pdf'.",
            Some(json!({ "receivedRenderer": patch.renderer })),
        ));
    }
    validate_progress_value(patch.progress_percent)
        .or_else(|| validate_non_negative_timestamp(patch.last_read_at_ms, "lastReadAtMs"))
}

fn validate_book_entry_patch(patch: &BookEntryPatch) -> Option<ErrorDetail> {
    if patch.title.trim().is_empty() {
        return Some(error_detail(
            "INVALID_TITLE",
            "Book entry patch must include a non-empty title.",
            None,
        ));
    }
    if patch.subtype.trim().is_empty() {
        return Some(error_detail(
            "INVALID_SUBTYPE",
            "Book entry patch must include a non-empty subtype.",
            None,
        ));
    }
    validate_non_negative_timestamp(patch.created_at_ms, "createdAtMs")
        .or_else(|| validate_non_negative_timestamp(patch.book_updated_at_ms, "bookUpdatedAtMs"))
}

fn validate_book_category_patch(patch: &BookCategoryPatch) -> Option<ErrorDetail> {
    if patch.category_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_CATEGORY_ID",
            "Book category patch must include a non-empty categoryId.",
            None,
        ));
    }
    if patch.name.trim().is_empty() {
        return Some(error_detail(
            "INVALID_CATEGORY_NAME",
            "Book category patch must include a non-empty name.",
            None,
        ));
    }
    None
}

fn validate_book_category_assignment_patch(
    patch: &BookCategoryAssignmentPatch,
) -> Option<ErrorDetail> {
    if patch.book_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_BOOK_ID",
            "Book category assignment patch must include a non-empty bookId.",
            None,
        ));
    }
    None
}

fn validate_book_library_ui_patch(_patch: &BookLibraryUiPatch) -> Option<ErrorDetail> {
    None
}

fn validate_novel_progress_patch(patch: &NovelProgressPatch) -> Option<ErrorDetail> {
    validate_progress_value(patch.progress_percent)
        .or_else(|| validate_non_negative_timestamp(patch.updated_at_ms, "updatedAtMs"))
}

fn validate_novel_entry_patch(patch: &NovelEntryPatch) -> Option<ErrorDetail> {
    if patch.identity_key.trim().is_empty() {
        return Some(error_detail(
            "INVALID_IDENTITY_KEY",
            "Novel entry patch must include a non-empty identityKey.",
            None,
        ));
    }
    if patch.title.trim().is_empty() {
        return Some(error_detail(
            "INVALID_TITLE",
            "Novel entry patch must include a non-empty title.",
            None,
        ));
    }
    if patch.path.trim().is_empty() {
        return Some(error_detail(
            "INVALID_PATH",
            "Novel entry patch must include a non-empty path.",
            None,
        ));
    }
    validate_non_negative_timestamp(patch.added_at_ms, "addedAtMs")
        .or_else(|| validate_non_negative_timestamp(patch.updated_at_ms, "updatedAtMs"))
}

fn validate_novel_chapter_patch(patch: &NovelChapterPatch) -> Option<ErrorDetail> {
    if patch.novel_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_NOVEL_ID",
            "Novel chapter patch must include a non-empty novelId.",
            None,
        ));
    }
    if patch.path.trim().is_empty() {
        return Some(error_detail(
            "INVALID_PATH",
            "Novel chapter patch must include a non-empty path.",
            None,
        ));
    }
    if patch.title.trim().is_empty() {
        return Some(error_detail(
            "INVALID_TITLE",
            "Novel chapter patch must include a non-empty title.",
            None,
        ));
    }
    if let Some(release_time_ms) = patch.release_time_ms {
        return validate_non_negative_timestamp(release_time_ms, "releaseTimeMs");
    }
    None
}

fn validate_book_bookmark_patch(patch: &BookBookmarkPatch) -> Option<ErrorDetail> {
    if patch.book_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_PARENT_ID",
            "Book bookmark patch must include a non-empty bookId.",
            None,
        ));
    }
    validate_progress_value(patch.progress_percent)
        .or_else(|| validate_non_negative_timestamp(patch.saved_at_ms, "savedAtMs"))
}

fn validate_novel_bookmark_patch(patch: &NovelBookmarkPatch) -> Option<ErrorDetail> {
    if patch.novel_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_PARENT_ID",
            "Novel bookmark patch must include a non-empty novelId.",
            None,
        ));
    }
    validate_non_negative_timestamp(patch.saved_at_ms, "savedAtMs")
}

fn validate_novel_history_patch(patch: &NovelHistoryPatch) -> Option<ErrorDetail> {
    if patch.novel_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_NOVEL_ID",
            "Novel history patch must include a non-empty novelId.",
            None,
        ));
    }
    validate_non_negative_timestamp(patch.read_at_ms, "readAtMs")
}

fn validate_novel_classification_patch(patch: &NovelClassificationPatch) -> Option<ErrorDetail> {
    if patch.plugin_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_PLUGIN_ID",
            "Novel classification patch must include a non-empty pluginId.",
            None,
        ));
    }
    if patch.status.trim().is_empty() {
        return Some(error_detail(
            "INVALID_STATUS",
            "Novel classification patch must include a non-empty status.",
            None,
        ));
    }
    if patch.notes.trim().is_empty() {
        return Some(error_detail(
            "INVALID_NOTES",
            "Novel classification patch must include non-empty notes.",
            None,
        ));
    }
    validate_non_negative_timestamp(patch.classified_at_ms, "classifiedAtMs")
}

fn validate_progress_value(progress_percent: f64) -> Option<ErrorDetail> {
    if !(0.0..=1.0).contains(&progress_percent) {
        return Some(error_detail(
            "INVALID_PROGRESS_PERCENT",
            "Mutation progressPercent must be between 0.0 and 1.0.",
            Some(json!({ "receivedProgressPercent": progress_percent })),
        ));
    }
    None
}

fn validate_non_negative_timestamp(value: i64, field: &str) -> Option<ErrorDetail> {
    if value < 0 {
        return Some(error_detail(
            "INVALID_TIMESTAMP",
            &format!("Mutation {field} must be zero or greater."),
            Some(json!({ field: value })),
        ));
    }
    None
}

fn rejected_result(mutation: &MutationInput, error: ErrorDetail) -> MutationResult {
    let base = mutation.base();
    MutationResult {
        client_mutation_id: base.client_mutation_id.clone(),
        entity_type: mutation.entity_type(),
        entity_id: base.entity_id.clone(),
        canonical_entity_id: None,
        scope_id: base.scope_id.clone(),
        op: base.op,
        status: MutationResultStatus::Rejected,
        applied_server_version: None,
        applied_lamport: None,
        record: None,
        error: Some(error),
    }
}

fn error_detail(code: &str, message: &str, details: Option<Value>) -> ErrorDetail {
    ErrorDetail {
        code: code.to_string(),
        message: message.to_string(),
        retryable: Some(false),
        min_client_version: None,
        current_server_version: None,
        min_replayable_server_version: None,
        required_action: None,
        details,
    }
}

fn bookmark_persist_error_detail(error: anyhow::Error) -> Option<ErrorDetail> {
    let message = error.to_string();
    if message.contains("stale bookmark mutation rejected by tombstone lamport") {
        Some(error_detail("STALE_BOOKMARK_MUTATION", &message, None))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syncd::app::build_test_router;
    use crate::syncd::config::{SyncdAdvertisedEndpointResolver, SyncdConfig};
    use crate::syncd::db::{
        connect, ensure_test_token, load_server_runtime, upsert_server_identity,
    };
    use crate::syncd::discovery::{
        SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
        SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
    };
    use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
    use crate::syncd::models::AppState;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::{broadcast, Mutex, RwLock};
    use tower::ServiceExt;

    fn token_hash(raw: &str) -> String {
        let digest = Sha256::digest(raw.as_bytes());
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    async fn build_state() -> (tempfile::TempDir, SharedAppState) {
        let temp = tempdir().unwrap();
        let state = build_state_in(temp.path().to_path_buf()).await;
        (temp, state)
    }

    async fn build_state_in(data_dir: std::path::PathBuf) -> SharedAppState {
        let config = SyncdConfig::for_test(data_dir);
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        ensure_test_token(
            &pool,
            "device-main",
            "main",
            &token_hash("main-token"),
            &["books:global", "novels:profile:main"],
        )
        .await
        .unwrap();
        ensure_test_token(
            &pool,
            "device-test",
            "test",
            &token_hash("test-token"),
            &["books:global", "novels:profile:test"],
        )
        .await
        .unwrap();
        let advertised_endpoint_resolver =
            SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let discovery_provider_manager =
            SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let initial_status =
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver);
        let (change_sender, _) = broadcast::channel(128);
        let (pairing_status_sender, _) = broadcast::channel(64);
        Arc::new(AppState {
            config,
            advertised_endpoint_resolver,
            discovery_descriptor_provider: SyncdDiscoveryDescriptorProvider::default(),
            client_discovery_contract_provider: SyncdClientDiscoveryContractProvider::default(),
            client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider::default(),
            discovery_provider_state: Arc::new(RwLock::new(initial_status)),
            discovery_provider_manager,
            discovery_provider_runtime: Arc::new(Mutex::new(None)),
            pool,
            change_sender,
            pairing_status_sender,
            mutation_gate: Arc::new(Mutex::new(())),
            tls_cert_sha256: "fingerprint".to_string(),
        })
    }

    fn auth_headers(token: &str) -> Vec<(String, String)> {
        vec![
            ("authorization".to_string(), format!("Bearer {token}")),
            (
                CLIENT_VERSION_HEADER.as_str().to_string(),
                "0.1.0".to_string(),
            ),
            (CLIENT_PROTOCOL_HEADER.as_str().to_string(), "1".to_string()),
        ]
    }

    fn request_with_json(uri: &str, token: &str, body: Value) -> Request<Body> {
        let mut builder = Request::builder().method("POST").uri(uri);
        for (key, value) in auth_headers(token) {
            builder = builder.header(key, value);
        }
        builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn request_without_body(uri: &str, token: &str, last_event_id: Option<i64>) -> Request<Body> {
        let mut builder = Request::builder().method("GET").uri(uri);
        for (key, value) in auth_headers(token) {
            builder = builder.header(key, value);
        }
        if let Some(last_event_id) = last_event_id {
            builder = builder.header("last-event-id", last_event_id.to_string());
        }
        builder.body(Body::empty()).unwrap()
    }

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn parse_sse_change_events(text: &str) -> Vec<Value> {
        text.replace("\r\n", "\n")
            .split("\n\n")
            .filter_map(|block| {
                let mut event_name = None;
                let mut data_lines = Vec::new();
                for line in block.lines() {
                    if let Some(value) = line.strip_prefix("event: ") {
                        event_name = Some(value);
                    } else if let Some(value) = line.strip_prefix("data: ") {
                        data_lines.push(value);
                    }
                }
                if event_name == Some("change") && !data_lines.is_empty() {
                    Some(serde_json::from_str::<Value>(&data_lines.join("\n")).unwrap())
                } else {
                    None
                }
            })
            .collect()
    }

    async fn collect_sse_change_events(
        response: axum::response::Response,
        expected_changes: usize,
    ) -> Vec<Value> {
        let mut body = response.into_body();
        let mut text = String::new();

        for _ in 0..(expected_changes * 4).max(4) {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.frame())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let bytes = frame.into_data().unwrap();
            text.push_str(&String::from_utf8_lossy(&bytes));
            let events = parse_sse_change_events(&text);
            if events.len() >= expected_changes {
                return events;
            }
        }

        panic!("timed out waiting for {expected_changes} SSE change events");
    }

    #[tokio::test]
    async fn accepts_book_progress_and_replays_it() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());

        let mutation_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-book-progress",
                    "mutations": [{
                        "entityType": "book.progress",
                        "clientMutationId": "book-progress-1",
                        "scopeId": "books:global",
                        "entityId": "book-1",
                        "lamport": 4,
                        "patch": {
                            "renderer": "pdf",
                            "progressPercent": 0.4,
                            "lastReadAtMs": 1000,
                            "pageIndex": 12,
                            "totalPages": 100,
                            "sectionLabel": "Chapter 1"
                        }
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(mutation_response.status(), StatusCode::OK);
        let payload = json_body(mutation_response).await;
        assert_eq!(payload["results"][0]["status"], "applied");
        assert_eq!(payload["results"][0]["record"]["pageIndex"], 12);
        let applied_server_version = payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let replay_response = app
            .clone()
            .oneshot(request_without_body(
                "/v1/events?scopeId=books%3Aglobal",
                "main-token",
                Some(applied_server_version - 1),
            ))
            .await
            .unwrap();

        assert_eq!(replay_response.status(), StatusCode::OK);
        let mut body = replay_response.into_body();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let bytes = frame.into_data().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("event: change"));
        assert!(text.contains("\"entityType\":\"book.progress\""));
        assert!(text.contains("\"pageIndex\":12"));
    }

    #[tokio::test]
    async fn rejects_invalid_scope_for_book_progress() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let response = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-invalid-book-scope",
                    "mutations": [{
                        "entityType": "book.progress",
                        "clientMutationId": "bad-book-progress",
                        "scopeId": "novels:profile:main",
                        "entityId": "book-1",
                        "lamport": 1,
                        "patch": {
                            "renderer": "pdf",
                            "progressPercent": 0.1,
                            "lastReadAtMs": 100,
                            "pageIndex": 1
                        }
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["results"][0]["status"], "rejected");
        assert_eq!(
            payload["results"][0]["error"]["code"],
            "INVALID_SCOPE_FOR_ENTITY"
        );
    }

    #[tokio::test]
    async fn book_progress_never_regresses_page_index() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let first = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-book-progress-a",
                    "mutations": [{
                        "entityType": "book.progress",
                        "clientMutationId": "book-progress-a",
                        "scopeId": "books:global",
                        "entityId": "book-1",
                        "lamport": 1,
                        "patch": {
                            "renderer": "pdf",
                            "progressPercent": 0.6,
                            "lastReadAtMs": 1000,
                            "pageIndex": 20
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        let second = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-book-progress-b",
                    "mutations": [{
                        "entityType": "book.progress",
                        "clientMutationId": "book-progress-b",
                        "scopeId": "books:global",
                        "entityId": "book-1",
                        "lamport": 99,
                        "patch": {
                            "renderer": "pdf",
                            "progressPercent": 0.2,
                            "lastReadAtMs": 2000,
                            "pageIndex": 5
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        let payload = json_body(second).await;
        assert_eq!(payload["results"][0]["record"]["pageIndex"], 20);
    }

    #[tokio::test]
    async fn book_progress_explicit_reset_accepts_regression_without_persisting_flag() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        for (client_mutation_id, lamport, page_index, progress_percent, reset) in [
            ("book-reset-high", 1, 20, 0.8, false),
            ("book-reset-low", 2, 2, 0.1, true),
        ] {
            let response = app
                .clone()
                .oneshot(request_with_json(
                    "/v1/mutations",
                    "main-token",
                    json!({
                        "requestId": format!("request-{client_mutation_id}"),
                        "mutations": [{
                            "entityType": "book.progress",
                            "clientMutationId": client_mutation_id,
                            "scopeId": "books:global",
                            "entityId": "book-reset",
                            "lamport": lamport,
                            "patch": {
                                "renderer": "pdf",
                                "progressPercent": progress_percent,
                                "lastReadAtMs": lamport * 1000,
                                "pageIndex": page_index,
                                "reset": reset
                            }
                        }]
                    }),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let payload = json_body(response).await;
            if reset {
                assert_eq!(payload["results"][0]["record"]["pageIndex"], 2);
                assert_eq!(payload["results"][0]["record"]["progressPercent"], 0.1);
                assert!(payload["results"][0]["record"].get("reset").is_none());
            }
        }
    }

    #[tokio::test]
    async fn novel_progress_never_regresses_chapter_order() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let first = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-progress-a",
                    "mutations": [{
                        "entityType": "novel.progress",
                        "clientMutationId": "novel-progress-a",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-1",
                        "lamport": 1,
                        "patch": {
                            "chapterId": "c20",
                            "chapterTitle": "Twenty",
                            "chapterOrderKey": 20,
                            "progressPercent": 0.2,
                            "locator": "/20#p2",
                            "locatorSortKey": 2,
                            "updatedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        let second = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-progress-b",
                    "mutations": [{
                        "entityType": "novel.progress",
                        "clientMutationId": "novel-progress-b",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-1",
                        "lamport": 50,
                        "patch": {
                            "chapterId": "c19",
                            "chapterTitle": "Nineteen",
                            "chapterOrderKey": 19,
                            "progressPercent": 0.9,
                            "locator": "/19#p9",
                            "locatorSortKey": 9,
                            "updatedAtMs": 2000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        let payload = json_body(second).await;
        assert_eq!(
            payload["results"][0]["record"]["chapterOrderKey"]
                .as_f64()
                .unwrap(),
            20.0
        );
        assert_eq!(payload["results"][0]["record"]["chapterId"], "c20");
    }

    #[tokio::test]
    async fn novel_progress_explicit_reset_accepts_regression_without_persisting_flag() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        for (client_mutation_id, lamport, chapter, order, progress, reset) in [
            ("novel-reset-high", 1, "c20", 20, 0.8, false),
            ("novel-reset-low", 2, "c2", 2, 0.1, true),
        ] {
            let response = app
                .clone()
                .oneshot(request_with_json(
                    "/v1/mutations",
                    "main-token",
                    json!({
                        "requestId": format!("request-{client_mutation_id}"),
                        "mutations": [{
                            "entityType": "novel.progress",
                            "clientMutationId": client_mutation_id,
                            "scopeId": "novels:profile:main",
                            "entityId": "novel-reset",
                            "lamport": lamport,
                            "patch": {
                                "chapterId": chapter,
                                "chapterTitle": chapter,
                                "chapterOrderKey": order,
                                "progressPercent": progress,
                                "locator": format!("/{chapter}"),
                                "locatorSortKey": progress,
                                "updatedAtMs": lamport * 1000,
                                "reset": reset
                            }
                        }]
                    }),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let payload = json_body(response).await;
            if reset {
                assert_eq!(payload["results"][0]["record"]["chapterId"], "c2");
                assert_eq!(
                    payload["results"][0]["record"]["chapterOrderKey"].as_f64(),
                    Some(2.0)
                );
                assert!(payload["results"][0]["record"].get("reset").is_none());
            }
        }
    }

    #[tokio::test]
    async fn novel_entry_deduplicates_canonical_identity_and_returns_existing_entity_id() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let canonical_identity =
            "novel-2ddcfbbb73a4bc27095ac742d5e3355a7f432b5ecd484525fb59fbbaf8a9b127";

        let desktop = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "request-desktop-novel",
                    "mutations": [{
                        "entityType": "novel.entry",
                        "clientMutationId": "desktop-novel",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel:source:%2Fnovel%2F1",
                        "lamport": 1,
                        "patch": {
                            "identityKey": "novel:source:%2Fnovel%2F1",
                            "title": "Example Novel",
                            "path": "/novel/1",
                            "tags": [],
                            "source": {
                                "repositoryUrl": "HTTPS://Example.COM:443/repository/",
                                "pluginId": "plugin",
                                "sourceId": "source"
                            },
                            "addedAtMs": 1000,
                            "updatedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(desktop.status(), StatusCode::OK);
        let desktop_payload = json_body(desktop).await;
        assert_eq!(
            desktop_payload["results"][0]["record"]["identityKey"],
            canonical_identity
        );

        let mobile_mutation = json!({
            "entityType": "novel.entry",
            "clientMutationId": "mobile-novel",
            "scopeId": "novels:profile:main",
            "entityId": canonical_identity,
            "lamport": 2,
            "patch": {
                "identityKey": canonical_identity,
                "title": "Example Novel Mobile",
                "path": "/novel/1",
                "tags": ["updated"],
                "source": {
                    "repositoryUrl": "https://example.com/repository",
                    "pluginId": "plugin",
                    "sourceId": "source"
                },
                "addedAtMs": 1000,
                "updatedAtMs": 2000
            }
        });
        let mobile = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "request-mobile-novel",
                    "mutations": [
                        mobile_mutation.clone(),
                        {
                            "entityType": "novel.progress",
                            "clientMutationId": "mobile-novel-progress",
                            "scopeId": "novels:profile:main",
                            "entityId": format!("novel.progress::{canonical_identity}"),
                            "lamport": 3,
                            "patch": {
                                "chapterId": "chapter-1",
                                "chapterOrderKey": 1,
                                "progressPercent": 0.5,
                                "updatedAtMs": 3000
                            }
                        },
                        {
                            "entityType": "novel.bookmark",
                            "clientMutationId": "mobile-novel-bookmark",
                            "scopeId": "novels:profile:main",
                            "entityId": "bookmark-mobile-1",
                            "lamport": 4,
                            "patch": {
                                "novelId": canonical_identity,
                                "chapterId": "chapter-1",
                                "progressPercent": 0.5,
                                "savedAtMs": 4000
                            }
                        },
                        {
                            "entityType": "novel.history",
                            "clientMutationId": "mobile-novel-history",
                            "scopeId": "novels:profile:main",
                            "entityId": "history-mobile-1",
                            "lamport": 5,
                            "patch": {
                                "novelId": canonical_identity,
                                "chapterId": "chapter-1",
                                "readAtMs": 5000
                            }
                        }
                    ]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(mobile.status(), StatusCode::OK);
        let mobile_payload = json_body(mobile).await;
        assert_eq!(mobile_payload["results"][0]["entityId"], canonical_identity);
        assert_eq!(
            mobile_payload["results"][0]["canonicalEntityId"],
            "novel:source:%2Fnovel%2F1"
        );
        assert_eq!(
            mobile_payload["results"][0]["record"]["novelId"],
            "novel:source:%2Fnovel%2F1"
        );
        assert_eq!(
            mobile_payload["results"][1]["entityId"],
            format!("novel.progress::{canonical_identity}")
        );
        assert_eq!(
            mobile_payload["results"][1]["canonicalEntityId"],
            "novel.progress::novel:source:%2Fnovel%2F1"
        );
        assert_eq!(
            mobile_payload["results"][1]["record"]["novelId"],
            "novel:source:%2Fnovel%2F1"
        );
        assert_eq!(
            mobile_payload["results"][2]["record"]["novelId"],
            "novel:source:%2Fnovel%2F1"
        );
        assert_eq!(
            mobile_payload["results"][3]["record"]["novelId"],
            "novel:source:%2Fnovel%2F1"
        );

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM novel_library_entries WHERE scope_id = ?")
                .bind("novels:profile:main")
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(count, 1);

        let retry = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "request-mobile-novel-retry",
                    "mutations": [mobile_mutation]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        let retry_payload = json_body(retry).await;
        assert_eq!(retry_payload["results"][0], mobile_payload["results"][0]);
    }

    #[tokio::test]
    async fn concurrent_novel_entry_additions_converge_to_one_entity() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let canonical_identity =
            "novel-2ddcfbbb73a4bc27095ac742d5e3355a7f432b5ecd484525fb59fbbaf8a9b127";
        let mutation = |client_mutation_id: &str, entity_id: &str, repository: &str| {
            json!({
                "requestId": format!("request-{client_mutation_id}"),
                "mutations": [{
                    "entityType": "novel.entry",
                    "clientMutationId": client_mutation_id,
                    "scopeId": "novels:profile:main",
                    "entityId": entity_id,
                    "lamport": 1,
                    "patch": {
                        "identityKey": entity_id,
                        "title": "Concurrent Novel",
                        "path": "/novel/1",
                        "tags": [],
                        "source": {
                            "repositoryUrl": repository,
                            "pluginId": "plugin",
                            "sourceId": "source"
                        },
                        "addedAtMs": 1000,
                        "updatedAtMs": 1000
                    }
                }]
            })
        };

        let desktop_request = request_with_json(
            "/v1/mutations",
            "main-token",
            mutation(
                "concurrent-desktop-novel",
                "novel:source:%2Fnovel%2F1",
                "HTTPS://Example.COM:443/repository/",
            ),
        );
        let mobile_request = request_with_json(
            "/v1/mutations",
            "main-token",
            mutation(
                "concurrent-mobile-novel",
                canonical_identity,
                "https://example.com/repository",
            ),
        );
        let (desktop, mobile) = tokio::join!(
            app.clone().oneshot(desktop_request),
            app.oneshot(mobile_request)
        );
        let desktop = desktop.unwrap();
        let mobile = mobile.unwrap();
        assert_eq!(desktop.status(), StatusCode::OK);
        assert_eq!(mobile.status(), StatusCode::OK);
        let desktop = json_body(desktop).await;
        let mobile = json_body(mobile).await;

        let canonical_results = [&desktop, &mobile]
            .into_iter()
            .filter(|payload| payload["results"][0].get("canonicalEntityId").is_some())
            .count();
        assert_eq!(canonical_results, 1);
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM novel_library_entries WHERE scope_id = ?")
                .bind("novels:profile:main")
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn publishes_book_progress_to_live_sse() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let response = app
            .clone()
            .oneshot(request_without_body(
                "/v1/events?scopeId=books%3Aglobal",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let mutation_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-live-book-progress",
                    "mutations": [{
                        "entityType": "book.progress",
                        "clientMutationId": "live-book-progress",
                        "scopeId": "books:global",
                        "entityId": "book-live",
                        "lamport": 1,
                        "patch": {
                            "renderer": "pdf",
                            "progressPercent": 0.3,
                            "lastReadAtMs": 100,
                            "pageIndex": 3
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(mutation_response.status(), StatusCode::OK);

        let mut body = response.into_body();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let bytes = frame.into_data().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("event: change"));
        assert!(text.contains("\"entityId\":\"book-live\""));
    }

    #[tokio::test]
    async fn accepts_book_bookmark_and_replays_it() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let mutation_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-book-bookmark",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "book-bookmark-1",
                        "scopeId": "books:global",
                        "entityId": "bookmark-1",
                        "lamport": 5,
                        "patch": {
                            "bookId": "book-1",
                            "pageIndex": 12,
                            "progressPercent": 0.4,
                            "label": "Note",
                            "savedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(mutation_response.status(), StatusCode::OK);
        let payload = json_body(mutation_response).await;
        assert_eq!(payload["results"][0]["status"], "applied");
        let applied_server_version = payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let replay_response = app
            .clone()
            .oneshot(request_without_body(
                "/v1/events?scopeId=books%3Aglobal",
                "main-token",
                Some(applied_server_version - 1),
            ))
            .await
            .unwrap();

        assert_eq!(replay_response.status(), StatusCode::OK);
        let mut body = replay_response.into_body();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let bytes = frame.into_data().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("\"entityType\":\"book.bookmark\""));
        assert!(text.contains("\"bookmarkId\":\"bookmark-1\""));
    }

    #[tokio::test]
    async fn deletes_book_bookmark_and_replays_delete_event() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let create_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-book-bookmark-create",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "book-bookmark-create",
                        "scopeId": "books:global",
                        "entityId": "bookmark-delete-1",
                        "lamport": 5,
                        "patch": {
                            "bookId": "book-1",
                            "pageIndex": 12,
                            "progressPercent": 0.4,
                            "label": "Delete me",
                            "savedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);

        let delete_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-book-bookmark-delete",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "book-bookmark-delete",
                        "scopeId": "books:global",
                        "entityId": "bookmark-delete-1",
                        "op": "delete",
                        "lamport": 6
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(delete_response.status(), StatusCode::OK);
        let payload = json_body(delete_response).await;
        assert_eq!(payload["results"][0]["status"], "applied");
        assert_eq!(payload["results"][0]["op"], "delete");
        assert!(payload["results"][0]["record"].is_null());
        let delete_version = payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let replay_response = app
            .clone()
            .oneshot(request_without_body(
                "/v1/events?scopeId=books%3Aglobal",
                "main-token",
                Some(delete_version - 1),
            ))
            .await
            .unwrap();

        assert_eq!(replay_response.status(), StatusCode::OK);
        let mut body = replay_response.into_body();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let bytes = frame.into_data().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("\"entityType\":\"book.bookmark\""));
        assert!(text.contains("\"op\":\"delete\""));
    }

    #[tokio::test]
    async fn rejects_stale_bookmark_merge_after_delete_tombstone() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let create_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-bookmark-stale-create",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "bookmark-stale-create",
                        "scopeId": "books:global",
                        "entityId": "bookmark-stale-1",
                        "lamport": 10,
                        "patch": {
                            "bookId": "book-1",
                            "pageIndex": 2,
                            "progressPercent": 0.2,
                            "savedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);

        let delete_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-bookmark-stale-delete",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "bookmark-stale-delete",
                        "scopeId": "books:global",
                        "entityId": "bookmark-stale-1",
                        "op": "delete",
                        "lamport": 20
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::OK);

        let stale_merge = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-bookmark-stale-merge",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "bookmark-stale-merge",
                        "scopeId": "books:global",
                        "entityId": "bookmark-stale-1",
                        "lamport": 15,
                        "patch": {
                            "bookId": "book-1",
                            "pageIndex": 3,
                            "progressPercent": 0.3,
                            "savedAtMs": 1100
                        }
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(stale_merge.status(), StatusCode::OK);
        let payload = json_body(stale_merge).await;
        assert_eq!(payload["results"][0]["status"], "rejected");
        assert_eq!(
            payload["results"][0]["error"]["code"],
            "STALE_BOOKMARK_MUTATION"
        );
    }

    #[tokio::test]
    async fn resurrects_book_bookmark_and_replay_matches_changes() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());

        let create_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-book-bookmark-resurrect-create",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "book-bookmark-resurrect-create",
                        "scopeId": "books:global",
                        "entityId": "bookmark-resurrect-1",
                        "lamport": 10,
                        "patch": {
                            "bookId": "book-1",
                            "pageIndex": 12,
                            "progressPercent": 0.4,
                            "label": "Original",
                            "savedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let create_payload = json_body(create_response).await;
        let create_version = create_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let delete_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-book-bookmark-resurrect-delete",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "book-bookmark-resurrect-delete",
                        "scopeId": "books:global",
                        "entityId": "bookmark-resurrect-1",
                        "op": "delete",
                        "lamport": 20
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::OK);
        let delete_payload = json_body(delete_response).await;
        let delete_version = delete_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let resurrect_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-book-bookmark-resurrect-merge",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "book-bookmark-resurrect-merge",
                        "scopeId": "books:global",
                        "entityId": "bookmark-resurrect-1",
                        "lamport": 21,
                        "patch": {
                            "bookId": "book-1",
                            "location": "/epub/chapter-4.xhtml#frag",
                            "pageIndex": 14,
                            "progressPercent": 0.6,
                            "label": "Restored",
                            "savedAtMs": 2000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(resurrect_response.status(), StatusCode::OK);
        let resurrect_payload = json_body(resurrect_response).await;
        assert_eq!(resurrect_payload["results"][0]["status"], "applied");
        assert_eq!(
            resurrect_payload["results"][0]["record"]["label"],
            "Restored"
        );
        assert_eq!(
            resurrect_payload["results"][0]["record"]["location"],
            "/epub/chapter-4.xhtml#frag"
        );
        let resurrect_version = resurrect_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let bookmark_row =
            sqlx::query_as::<_, (String, Option<String>, Option<i64>, Option<String>, i64)>(
                r#"
            SELECT book_id, location, page_index, label, record_server_version
            FROM book_bookmarks
            WHERE scope_id = 'books:global' AND bookmark_id = ?
            "#,
            )
            .bind("bookmark-resurrect-1")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(bookmark_row.0, "book-1");
        assert_eq!(
            bookmark_row.1.as_deref(),
            Some("/epub/chapter-4.xhtml#frag")
        );
        assert_eq!(bookmark_row.2, Some(14));
        assert_eq!(bookmark_row.3.as_deref(), Some("Restored"));
        assert_eq!(bookmark_row.4, resurrect_version);

        let tombstone_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*) FROM tombstones
            WHERE scope_id = 'books:global'
              AND entity_type = 'book.bookmark'
              AND entity_id = ?
            "#,
        )
        .bind("bookmark-resurrect-1")
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(tombstone_count, 0);

        let changes_response = app
            .clone()
            .oneshot(request_without_body(
                &format!(
                    "/v1/changes?scopeId=books%3Aglobal&sinceVersion={}",
                    create_version - 1
                ),
                "main-token",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(changes_response.status(), StatusCode::OK);
        let changes_payload = json_body(changes_response).await;
        let changes = changes_payload["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0]["op"], "merge");
        assert_eq!(changes[1]["op"], "delete");
        assert_eq!(changes[2]["op"], "merge");
        assert_eq!(changes[2]["patch"]["label"], "Restored");
        assert_eq!(
            changes[2]["patch"]["location"],
            "/epub/chapter-4.xhtml#frag"
        );

        let post_delete_changes = app
            .clone()
            .oneshot(request_without_body(
                &format!("/v1/changes?scopeId=books%3Aglobal&sinceVersion={delete_version}"),
                "main-token",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(post_delete_changes.status(), StatusCode::OK);
        let post_delete_payload = json_body(post_delete_changes).await;
        let post_delete_array = post_delete_payload["changes"].as_array().unwrap();
        assert_eq!(post_delete_array.len(), 1);
        assert_eq!(post_delete_array[0]["op"], "merge");
        assert_eq!(post_delete_array[0]["patch"]["label"], "Restored");

        let replay_response = app
            .clone()
            .oneshot(request_without_body(
                "/v1/events?scopeId=books%3Aglobal",
                "main-token",
                Some(create_version - 1),
            ))
            .await
            .unwrap();
        assert_eq!(replay_response.status(), StatusCode::OK);
        let replay_events = collect_sse_change_events(replay_response, 3).await;
        assert_eq!(replay_events[0]["op"], "merge");
        assert_eq!(replay_events[1]["op"], "delete");
        assert_eq!(replay_events[2]["op"], "merge");
        assert_eq!(replay_events[2]["patch"]["label"], "Restored");
        assert_eq!(replay_events[2]["serverVersion"], resurrect_version);
        assert_eq!(replay_events[2]["patch"], changes[2]["patch"]);
    }

    #[tokio::test]
    async fn rejects_stale_novel_bookmark_merge_after_delete_tombstone() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let create_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-bookmark-stale-create",
                    "mutations": [{
                        "entityType": "novel.bookmark",
                        "clientMutationId": "novel-bookmark-stale-create",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-bookmark-stale-1",
                        "lamport": 10,
                        "patch": {
                            "novelId": "novel-1",
                            "chapterId": "c10",
                            "chapterOrderKey": 10,
                            "locator": "/10#p1",
                            "locatorSortKey": 1,
                            "savedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);

        let delete_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-bookmark-stale-delete",
                    "mutations": [{
                        "entityType": "novel.bookmark",
                        "clientMutationId": "novel-bookmark-stale-delete",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-bookmark-stale-1",
                        "op": "delete",
                        "lamport": 20
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::OK);

        let stale_merge = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-bookmark-stale-merge",
                    "mutations": [{
                        "entityType": "novel.bookmark",
                        "clientMutationId": "novel-bookmark-stale-merge",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-bookmark-stale-1",
                        "lamport": 15,
                        "patch": {
                            "novelId": "novel-1",
                            "chapterId": "c11",
                            "chapterOrderKey": 11,
                            "locator": "/11#p3",
                            "locatorSortKey": 3,
                            "savedAtMs": 1200
                        }
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(stale_merge.status(), StatusCode::OK);
        let payload = json_body(stale_merge).await;
        assert_eq!(payload["results"][0]["status"], "rejected");
        assert_eq!(
            payload["results"][0]["error"]["code"],
            "STALE_BOOKMARK_MUTATION"
        );
    }

    #[tokio::test]
    async fn resurrects_novel_bookmark_and_changes_and_replay_stay_profile_scoped() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());

        let create_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-bookmark-resurrect-create",
                    "mutations": [{
                        "entityType": "novel.bookmark",
                        "clientMutationId": "novel-bookmark-resurrect-create",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-bookmark-resurrect-1",
                        "lamport": 10,
                        "patch": {
                            "novelId": "novel-1",
                            "chapterId": "c10",
                            "chapterTitle": "Ten",
                            "chapterOrderKey": 10,
                            "locator": "/10#p2",
                            "locatorSortKey": 2,
                            "label": "Original",
                            "savedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);
        let create_payload = json_body(create_response).await;
        let create_version = create_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let delete_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-bookmark-resurrect-delete",
                    "mutations": [{
                        "entityType": "novel.bookmark",
                        "clientMutationId": "novel-bookmark-resurrect-delete",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-bookmark-resurrect-1",
                        "op": "delete",
                        "lamport": 20
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(delete_response.status(), StatusCode::OK);
        let delete_payload = json_body(delete_response).await;
        let delete_version = delete_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let resurrect_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-bookmark-resurrect-merge",
                    "mutations": [{
                        "entityType": "novel.bookmark",
                        "clientMutationId": "novel-bookmark-resurrect-merge",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-bookmark-resurrect-1",
                        "lamport": 21,
                        "patch": {
                            "novelId": "novel-1",
                            "chapterId": "c11",
                            "chapterTitle": "Eleven",
                            "chapterOrderKey": 11,
                            "locator": "/11#p5",
                            "locatorSortKey": 5,
                            "label": "Restored",
                            "savedAtMs": 2000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(resurrect_response.status(), StatusCode::OK);
        let resurrect_payload = json_body(resurrect_response).await;
        assert_eq!(resurrect_payload["results"][0]["status"], "applied");
        assert_eq!(
            resurrect_payload["results"][0]["record"]["chapterOrderKey"],
            11.0
        );
        assert_eq!(
            resurrect_payload["results"][0]["record"]["label"],
            "Restored"
        );
        let resurrect_version = resurrect_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let bookmark_row =
            sqlx::query_as::<_, (String, Option<String>, Option<f64>, Option<String>, i64)>(
                r#"
            SELECT novel_id, chapter_id, chapter_order_key, label, record_server_version
            FROM novel_bookmarks
            WHERE scope_id = 'novels:profile:main' AND bookmark_id = ?
            "#,
            )
            .bind("novel-bookmark-resurrect-1")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(bookmark_row.0, "novel-1");
        assert_eq!(bookmark_row.1.as_deref(), Some("c11"));
        assert_eq!(bookmark_row.2, Some(11.0));
        assert_eq!(bookmark_row.3.as_deref(), Some("Restored"));
        assert_eq!(bookmark_row.4, resurrect_version);

        let tombstone_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*) FROM tombstones
            WHERE scope_id = 'novels:profile:main'
              AND entity_type = 'novel.bookmark'
              AND entity_id = ?
            "#,
        )
        .bind("novel-bookmark-resurrect-1")
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(tombstone_count, 0);

        let changes_response = app
            .clone()
            .oneshot(request_without_body(
                &format!(
                    "/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion={}",
                    create_version - 1
                ),
                "main-token",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(changes_response.status(), StatusCode::OK);
        let changes_payload = json_body(changes_response).await;
        let changes = changes_payload["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0]["op"], "merge");
        assert_eq!(changes[1]["op"], "delete");
        assert_eq!(changes[2]["op"], "merge");
        assert_eq!(changes[2]["patch"]["chapterId"], "c11");
        assert_eq!(changes[2]["patch"]["label"], "Restored");

        let replay_response = app
            .clone()
            .oneshot(request_without_body(
                "/v1/events?scopeId=novels%3Aprofile%3Amain",
                "main-token",
                Some(create_version - 1),
            ))
            .await
            .unwrap();
        assert_eq!(replay_response.status(), StatusCode::OK);
        let replay_events = collect_sse_change_events(replay_response, 3).await;
        assert_eq!(replay_events[0]["op"], "merge");
        assert_eq!(replay_events[1]["op"], "delete");
        assert_eq!(replay_events[2]["op"], "merge");
        assert_eq!(replay_events[2]["patch"]["chapterId"], "c11");
        assert_eq!(replay_events[2]["patch"], changes[2]["patch"]);

        let cross_scope_changes = app
            .clone()
            .oneshot(request_without_body(
                &format!(
                    "/v1/changes?scopeId=books%3Aglobal&sinceVersion={}",
                    create_version - 1
                ),
                "main-token",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(cross_scope_changes.status(), StatusCode::OK);
        let cross_scope_payload = json_body(cross_scope_changes).await;
        let cross_scope_array = cross_scope_payload["changes"].as_array().unwrap();
        assert!(cross_scope_array
            .iter()
            .all(|change| change["entityType"] != "novel.bookmark"));

        let wrong_scope_resurrection = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-bookmark-wrong-scope-resurrection",
                    "mutations": [{
                        "entityType": "book.bookmark",
                        "clientMutationId": "book-bookmark-wrong-scope-resurrection",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-bookmark-resurrect-1",
                        "lamport": 30,
                        "patch": {
                            "bookId": "book-1",
                            "pageIndex": 30,
                            "progressPercent": 0.8,
                            "savedAtMs": 3000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(wrong_scope_resurrection.status(), StatusCode::OK);
        let wrong_scope_payload = json_body(wrong_scope_resurrection).await;
        assert_eq!(wrong_scope_payload["results"][0]["status"], "rejected");
        assert_eq!(
            wrong_scope_payload["results"][0]["error"]["code"],
            "INVALID_SCOPE_FOR_ENTITY"
        );

        let forbidden_profile = app
            .clone()
            .oneshot(request_without_body(
                &format!(
                    "/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion={delete_version}"
                ),
                "test-token",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(forbidden_profile.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn deletes_novel_bookmark_and_replays_delete_event() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let create_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-bookmark-create",
                    "mutations": [{
                        "entityType": "novel.bookmark",
                        "clientMutationId": "novel-bookmark-create",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-bookmark-delete-1",
                        "lamport": 5,
                        "patch": {
                            "novelId": "novel-1",
                            "chapterId": "c10",
                            "chapterTitle": "Ten",
                            "chapterOrderKey": 10,
                            "locator": "/10#p2",
                            "locatorSortKey": 2,
                            "savedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::OK);

        let delete_response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-novel-bookmark-delete",
                    "mutations": [{
                        "entityType": "novel.bookmark",
                        "clientMutationId": "novel-bookmark-delete",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-bookmark-delete-1",
                        "op": "delete",
                        "lamport": 6
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(delete_response.status(), StatusCode::OK);
        let payload = json_body(delete_response).await;
        assert_eq!(payload["results"][0]["status"], "applied");
        assert_eq!(payload["results"][0]["op"], "delete");
        let delete_version = payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let replay_response = app
            .clone()
            .oneshot(request_without_body(
                "/v1/events?scopeId=novels%3Aprofile%3Amain",
                "main-token",
                Some(delete_version - 1),
            ))
            .await
            .unwrap();

        assert_eq!(replay_response.status(), StatusCode::OK);
        let mut body = replay_response.into_body();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let bytes = frame.into_data().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("\"entityType\":\"novel.bookmark\""));
        assert!(text.contains("\"op\":\"delete\""));
    }

    #[tokio::test]
    async fn rejects_novel_bookmark_in_global_books_scope() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);

        let response = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-invalid-novel-bookmark-scope",
                    "mutations": [{
                        "entityType": "novel.bookmark",
                        "clientMutationId": "bad-novel-bookmark",
                        "scopeId": "books:global",
                        "entityId": "bookmark-2",
                        "lamport": 1,
                        "patch": {
                            "novelId": "novel-1",
                            "chapterOrderKey": 1,
                            "savedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["results"][0]["status"], "rejected");
        assert_eq!(
            payload["results"][0]["error"]["code"],
            "INVALID_SCOPE_FOR_ENTITY"
        );
    }

    #[tokio::test]
    async fn applies_novel_progress_and_updates_runtime_server_version() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());

        let response = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-runtime-version",
                    "mutations": [{
                        "entityType": "novel.progress",
                        "clientMutationId": "novel-progress-runtime",
                        "scopeId": "novels:profile:main",
                        "entityId": "novel-runtime",
                        "lamport": 3,
                        "patch": {
                            "chapterOrderKey": 7,
                            "progressPercent": 0.7,
                            "locatorSortKey": 2,
                            "updatedAtMs": 700
                        }
                    }]
                }),
            ))
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        let runtime = load_server_runtime(&state.pool).await.unwrap();
        assert_eq!(
            payload["currentServerVersion"].as_i64().unwrap(),
            runtime.current_server_version
        );
    }

    fn idempotent_book_progress(
        request_id: &str,
        client_mutation_id: &str,
        progress_percent: f64,
    ) -> Value {
        json!({
            "requestId": request_id,
            "mutations": [{
                "entityType": "book.progress",
                "clientMutationId": client_mutation_id,
                "scopeId": "books:global",
                "entityId": "idempotent-book",
                "lamport": 7,
                "patch": {
                    "renderer": "pdf",
                    "progressPercent": progress_percent,
                    "lastReadAtMs": 700,
                    "pageIndex": 7,
                    "totalPages": 10
                }
            }]
        })
    }

    #[tokio::test]
    async fn identical_retry_returns_receipt_without_incrementing_server_version() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let mutation = idempotent_book_progress("first-request", "stable-mutation", 0.7);

        let first = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", mutation))
            .await
            .unwrap();
        let first_payload = json_body(first).await;
        let first_version = first_payload["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let retry = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                idempotent_book_progress("retry-request", "stable-mutation", 0.7),
            ))
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        let retry_payload = json_body(retry).await;
        assert_eq!(retry_payload["results"][0], first_payload["results"][0]);

        let runtime = load_server_runtime(&state.pool).await.unwrap();
        assert_eq!(runtime.current_server_version, first_version);
    }

    #[tokio::test]
    async fn identical_retry_survives_database_restart() {
        let temp = tempdir().unwrap();
        let state = build_state_in(temp.path().to_path_buf()).await;
        let app = build_test_router(state.clone());
        let first = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                idempotent_book_progress("before-restart", "restart-mutation", 0.7),
            ))
            .await
            .unwrap();
        let first_payload = json_body(first).await;
        let first_result = first_payload["results"][0].clone();
        let first_version = first_result["appliedServerVersion"].as_i64().unwrap();

        drop(app);
        state.pool.close().await;
        drop(state);

        let restarted_state = build_state_in(temp.path().to_path_buf()).await;
        let restarted_app = build_test_router(restarted_state.clone());
        let retry = restarted_app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                idempotent_book_progress("after-restart", "restart-mutation", 0.7),
            ))
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        let retry_payload = json_body(retry).await;
        assert_eq!(retry_payload["results"][0], first_result);
        assert_eq!(
            load_server_runtime(&restarted_state.pool)
                .await
                .unwrap()
                .current_server_version,
            first_version
        );
    }

    #[tokio::test]
    async fn concurrent_identical_retries_apply_once() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let first_request = request_with_json(
            "/v1/mutations",
            "main-token",
            idempotent_book_progress("concurrent-a", "concurrent-mutation", 0.7),
        );
        let second_request = request_with_json(
            "/v1/mutations",
            "main-token",
            idempotent_book_progress("concurrent-b", "concurrent-mutation", 0.7),
        );

        let (first, second) = tokio::join!(
            app.clone().oneshot(first_request),
            app.clone().oneshot(second_request)
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::OK);
        let first_payload = json_body(first).await;
        let second_payload = json_body(second).await;
        assert_eq!(first_payload["results"][0], second_payload["results"][0]);
        assert_eq!(
            load_server_runtime(&state.pool)
                .await
                .unwrap()
                .current_server_version,
            1
        );
    }

    #[tokio::test]
    async fn reused_client_mutation_id_with_different_content_conflicts() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let first = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                idempotent_book_progress("conflict-a", "reused-mutation", 0.7),
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first_version = load_server_runtime(&state.pool)
            .await
            .unwrap()
            .current_server_version;

        let conflict = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                idempotent_book_progress("conflict-b", "reused-mutation", 0.8),
            ))
            .await
            .unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let conflict_payload = json_body(conflict).await;
        assert_eq!(
            conflict_payload["error"]["code"],
            "CLIENT_MUTATION_ID_REUSED"
        );
        assert_eq!(
            load_server_runtime(&state.pool)
                .await
                .unwrap()
                .current_server_version,
            first_version
        );
    }

    #[tokio::test]
    async fn client_mutation_id_namespace_is_isolated_per_device() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let first = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                idempotent_book_progress("device-main", "shared-client-id", 0.7),
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        let second = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "test-token",
                idempotent_book_progress("device-test", "shared-client-id", 0.8),
            ))
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        let second_payload = json_body(second).await;
        assert_eq!(second_payload["results"][0]["status"], "applied");
        assert_eq!(
            load_server_runtime(&state.pool)
                .await
                .unwrap()
                .current_server_version,
            2
        );
        let receipt_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM mutation_receipts WHERE client_mutation_id = ?",
        )
        .bind("shared-client-id")
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(receipt_count, 2);
    }

    #[tokio::test]
    async fn rejected_mutation_decision_is_receipted() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let invalid = json!({
            "requestId": "invalid-a",
            "mutations": [{
                "entityType": "book.progress",
                "clientMutationId": "invalid-receipt",
                "scopeId": "novels:profile:main",
                "entityId": "book-invalid",
                "lamport": 1,
                "patch": {
                    "renderer": "pdf",
                    "progressPercent": 0.1,
                    "lastReadAtMs": 100
                }
            }]
        });
        let first = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", invalid))
            .await
            .unwrap();
        let first_payload = json_body(first).await;

        let retry = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "invalid-b",
                    "mutations": [{
                        "entityType": "book.progress",
                        "clientMutationId": "invalid-receipt",
                        "scopeId": "novels:profile:main",
                        "entityId": "book-invalid",
                        "lamport": 1,
                        "patch": {
                            "renderer": "pdf",
                            "progressPercent": 0.1,
                            "lastReadAtMs": 100
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        let retry_payload = json_body(retry).await;
        assert_eq!(retry_payload["results"][0], first_payload["results"][0]);
        assert_eq!(
            load_server_runtime(&state.pool)
                .await
                .unwrap()
                .current_server_version,
            0
        );
    }
}
