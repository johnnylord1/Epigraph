use axum::extract::{Extension, State};
use axum::response::Json;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

use crate::syncd::db;
use crate::syncd::middleware::validate_scope;
use crate::syncd::models::{
    canonical_novel_category_assignment_id, canonical_novel_chapter_asset_id,
    canonical_novel_plugin_id, canonical_novel_repository_id, canonical_portable_chapter_id,
    canonical_portable_work_id, canonicalize_novel_repository_url, AppError, AuthenticatedSession,
    BookBookmarkPatch, BookCategoryAssignmentPatch, BookCategoryPatch, BookEntryPatch,
    BookHighlightPatch, BookHistoryPatch, BookLibraryUiPatch, BookProgressPatch,
    ComicCategoryAssignmentPatch, ComicCategoryPatch, ComicChapterStatePatch, ComicEntryPatch,
    ComicHistoryPatch, ComicPageBookmarkPatch, ErrorDetail, EventClock, MutationBase,
    MutationEntityType, MutationInput, MutationOperation, MutationReceiptContext, MutationResult,
    MutationResultStatus, MutationsRequest, MutationsResponse, NovelBookmarkPatch,
    NovelCategoryAssignmentPatch, NovelCategoryPatch, NovelChapterAssetPatch, NovelChapterPatch,
    NovelClassificationPatch, NovelEntryPatch, NovelHistoryPatch, NovelPluginPatch,
    NovelProgressPatch, NovelRepositoryPatch, PortableChapterRefV3, PortableWorkRefV3,
    SharedAppState,
};
use crate::syncd::routes::assets::{validate_asset_reference, AssetReferenceError};

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
            event_clock: base.event_clock.clone(),
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
            &receipt_context.mutation_json,
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
        if let Some(error) = validate_event_clock(base.event_clock.as_ref()) {
            results.push(rejected_result(&mutation, error));
            continue;
        }
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
                    if let Some(error) = validate_book_entry_patch(&base.entity_id, patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    match db::book_entry_identity_conflict(
                        &state.pool,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                    )
                    .await
                    {
                        Ok(Some(conflict)) => {
                            results.push(rejected_result(
                                &mutation,
                                book_identity_conflict_error_detail(conflict),
                            ));
                            continue;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            return Err(AppError::Internal(format!(
                                "Failed to validate immutable book identity: {error}"
                            )));
                        }
                    }
                    match (&patch.asset_fingerprint, patch.byte_size) {
                        (Some(asset), Some(byte_size)) => {
                            match validate_asset_reference(
                                &state.config.data_dir,
                                asset,
                                &base.scope_id,
                                byte_size as u64,
                            )
                            .await
                            {
                                Ok(()) => {}
                                Err(error) => {
                                    results.push(rejected_result(
                                        &mutation,
                                        book_asset_reference_error_detail(error),
                                    ));
                                    continue;
                                }
                            }
                        }
                        (None, None) => {
                            // Legacy metadata-only records remain readable and updatable. New
                            // clients always publish immutable bytes before the book entry.
                        }
                        _ => {
                            results.push(rejected_result(
                                &mutation,
                                error_detail(
                                    "INCOMPLETE_BOOK_ASSET_REFERENCE",
                                    "Book assetFingerprint and byteSize must be provided together.",
                                    None,
                                ),
                            ));
                            continue;
                        }
                    }
                    match (
                        &patch.cover_asset_sha256,
                        patch.cover_asset_byte_size,
                        &patch.cover_asset_mime_type,
                    ) {
                        (Some(asset), Some(byte_size), Some(_)) => {
                            match validate_asset_reference(
                                &state.config.data_dir,
                                asset,
                                &base.scope_id,
                                byte_size as u64,
                            )
                            .await
                            {
                                Ok(()) => {}
                                Err(error) => {
                                    results.push(rejected_result(
                                        &mutation,
                                        book_cover_asset_reference_error_detail(error),
                                    ));
                                    continue;
                                }
                            }
                        }
                        (None, None, None) => {}
                        _ => {
                            results.push(rejected_result(
                                &mutation,
                                error_detail(
                                    "INCOMPLETE_BOOK_COVER_ASSET_REFERENCE",
                                    "Book cover hash, byte size, and MIME type must be provided together.",
                                    None,
                                ),
                            ));
                            continue;
                        }
                    }
                    match db::apply_book_entry_mutation(
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
                            if let Some(error) = book_entry_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to persist book entry mutation.".to_string(),
                            ));
                        }
                    }
                }
                MutationOperation::Delete => {
                    match db::delete_book_entry_mutation(
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
                            if let Some(error) = book_entry_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to delete book entry mutation.".to_string(),
                            ));
                        }
                    }
                }
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
                let canonical_book_id = base.entity_id.trim_start_matches("book.progress::");
                let canonical_entity_id = if base.entity_id.starts_with("book.progress::") {
                    format!("book.progress::{canonical_book_id}")
                } else {
                    canonical_book_id.to_string()
                };
                set_canonical_receipt(&mut session, &base.entity_id, &canonical_entity_id);
                match db::apply_book_progress_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &canonical_entity_id,
                    patch,
                    base.lamport,
                    base.event_clock.as_ref(),
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!("Failed to persist book progress mutation: {error}"))
                })? {
                    db::CausalMutationWriteOutcome::Applied(outcome) => outcome,
                    db::CausalMutationWriteOutcome::Superseded {
                        record,
                        winning_clock,
                        server_version,
                        applied_lamport,
                    } => {
                        current_server_version = current_server_version.max(server_version);
                        results.push(superseded_result(
                            &mutation,
                            record,
                            winning_clock,
                            server_version,
                            applied_lamport,
                        ));
                        continue;
                    }
                }
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
                if let Some(error) = validate_novel_portable_identity(requested_novel_id, patch) {
                    results.push(rejected_result(&mutation, error));
                    continue;
                }
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
                match db::apply_novel_progress_mutation(
                    &state.pool,
                    &session,
                    &base.scope_id,
                    &canonical_entity_id,
                    patch,
                    base.lamport,
                    base.event_clock.as_ref(),
                    state.config.retention_window,
                )
                .await
                .map_err(|error| {
                    AppError::Internal(format!(
                        "Failed to persist novel progress mutation: {error}"
                    ))
                })? {
                    db::CausalMutationWriteOutcome::Applied(outcome) => outcome,
                    db::CausalMutationWriteOutcome::Superseded {
                        record,
                        winning_clock,
                        server_version,
                        applied_lamport,
                    } => {
                        current_server_version = current_server_version.max(server_version);
                        results.push(superseded_result(
                            &mutation,
                            record,
                            winning_clock,
                            server_version,
                            applied_lamport,
                        ));
                        continue;
                    }
                }
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
            MutationInput::BookHighlight { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Highlight merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_book_highlight_patch(&base.entity_id, patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    db::apply_book_highlight_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|_| {
                        AppError::Internal("Failed to persist book highlight mutation.".to_string())
                    })?
                }
                MutationOperation::Delete => {
                    if patch.is_some() {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "DELETE_PATCH_NOT_ALLOWED",
                                "Highlight delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    db::delete_book_highlight_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    .map_err(|_| {
                        AppError::Internal("Failed to delete book highlight mutation.".to_string())
                    })?
                }
            },
            MutationInput::BookHistory { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Book history merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_book_history_patch(&base.entity_id, patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    db::apply_book_history_mutation(
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
                            "Failed to persist book history mutation: {error}"
                        ))
                    })?
                }
                MutationOperation::Delete => {
                    if patch.is_some() {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "DELETE_PATCH_NOT_ALLOWED",
                                "Book history delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    db::delete_book_history_mutation(
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
                            "Failed to delete book history mutation: {error}"
                        ))
                    })?
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
                    if let Some(error) = validate_novel_entry_patch(&base.entity_id, patch) {
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
                    match db::delete_novel_entry_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &canonical_entity_id,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            if let Some(error) = novel_category_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to delete novel entry mutation.".to_string(),
                            ));
                        }
                    }
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
                MutationOperation::Delete => match db::delete_novel_chapter_mutation(
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
                        if error.to_string().contains("FOREIGN KEY constraint failed") {
                            results.push(rejected_result(
                                &mutation,
                                error_detail(
                                    "NOVEL_CHAPTER_ASSETS_EXIST",
                                    "Novel chapter cannot be deleted while a downloaded asset references it.",
                                    None,
                                ),
                            ));
                            continue;
                        }
                        return Err(AppError::Internal(
                            "Failed to delete novel chapter mutation.".to_string(),
                        ));
                    }
                },
            },
            MutationInput::NovelChapterAsset { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Novel chapter asset merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_novel_chapter_asset_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    let canonical_novel_id =
                        db::resolve_novel_entity_id(&state.pool, &base.scope_id, &patch.novel_id)
                            .await
                            .map_err(|_| {
                                AppError::Internal(
                                    "Failed to resolve novel chapter asset owner.".to_string(),
                                )
                            })?;
                    let requested_entity_id =
                        canonical_novel_chapter_asset_id(&patch.novel_id, &patch.chapter_id);
                    let canonical_entity_id =
                        canonical_novel_chapter_asset_id(&canonical_novel_id, &patch.chapter_id);
                    if base.entity_id != requested_entity_id
                        && base.entity_id != canonical_entity_id
                    {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "ENTITY_ID_MISMATCH",
                                "Novel chapter asset entityId does not match novelId and chapterId.",
                                Some(json!({
                                    "expectedEntityId": canonical_entity_id,
                                    "receivedEntityId": base.entity_id,
                                })),
                            ),
                        ));
                        continue;
                    }
                    set_canonical_receipt(&mut session, &base.entity_id, &canonical_entity_id);
                    let mut canonical_patch = patch.clone();
                    canonical_patch.novel_id = canonical_novel_id;
                    match validate_asset_reference(
                        &state.config.data_dir,
                        &canonical_patch.blob_sha256,
                        &base.scope_id,
                        canonical_patch.byte_length as u64,
                    )
                    .await
                    {
                        Ok(()) => {}
                        Err(error) => {
                            results.push(rejected_result(
                                &mutation,
                                novel_chapter_asset_reference_error_detail(error),
                            ));
                            continue;
                        }
                    }
                    match db::apply_novel_chapter_asset_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &canonical_entity_id,
                        &canonical_patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            if let Some(error) = novel_chapter_asset_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to persist novel chapter asset mutation.".to_string(),
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
                                "Novel chapter asset delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    match db::delete_novel_chapter_asset_mutation(
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
                            if let Some(error) = novel_chapter_asset_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to delete novel chapter asset mutation.".to_string(),
                            ));
                        }
                    }
                }
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
            MutationInput::NovelRepository { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Novel repository merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    let canonical_url = match validate_novel_repository_patch(patch) {
                        Ok(value) => value,
                        Err(error) => {
                            results.push(rejected_result(&mutation, error));
                            continue;
                        }
                    };
                    let mut canonical_patch = patch.clone();
                    canonical_patch.canonical_url = canonical_url.clone();
                    canonical_patch.name = canonical_patch.name.trim().to_string();
                    let canonical_entity_id = db::resolve_novel_repository_merge_id(
                        &state.pool,
                        &base.scope_id,
                        &base.entity_id,
                        &canonical_url,
                    )
                    .await
                    .map_err(|_| {
                        AppError::Internal(
                            "Failed to resolve novel repository identity.".to_string(),
                        )
                    })?;
                    let expected_entity_id = canonical_novel_repository_id(&canonical_url);
                    if canonical_entity_id != expected_entity_id {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "REPOSITORY_IDENTITY_CONFLICT",
                                "Novel repository alias resolves to another canonical URL identity.",
                                Some(json!({
                                    "expectedEntityId": expected_entity_id,
                                    "resolvedEntityId": canonical_entity_id,
                                })),
                            ),
                        ));
                        continue;
                    }
                    set_canonical_receipt(&mut session, &base.entity_id, &canonical_entity_id);
                    match db::apply_novel_repository_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &canonical_entity_id,
                        &canonical_patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            results.push(rejected_result(
                                &mutation,
                                novel_plugin_persist_error_detail(error),
                            ));
                            continue;
                        }
                    }
                }
                MutationOperation::Delete => {
                    if patch.is_some() {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "DELETE_PATCH_NOT_ALLOWED",
                                "Novel repository delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    let canonical_entity_id = db::resolve_novel_repository_entity_id(
                        &state.pool,
                        &base.scope_id,
                        &base.entity_id,
                    )
                    .await
                    .map_err(|_| {
                        AppError::Internal("Failed to resolve novel repository delete.".to_string())
                    })?;
                    set_canonical_receipt(&mut session, &base.entity_id, &canonical_entity_id);
                    match db::delete_novel_repository_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &canonical_entity_id,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            results.push(rejected_result(
                                &mutation,
                                novel_plugin_persist_error_detail(error),
                            ));
                            continue;
                        }
                    }
                }
            },
            MutationInput::NovelPlugin { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Novel plugin merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_novel_plugin_patch(patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    let repository_id = db::resolve_novel_repository_entity_id(
                        &state.pool,
                        &base.scope_id,
                        &patch.repository_id,
                    )
                    .await
                    .map_err(|_| {
                        AppError::Internal("Failed to resolve novel plugin repository.".to_string())
                    })?;
                    let canonical_entity_id = db::resolve_novel_plugin_merge_id(
                        &state.pool,
                        &base.scope_id,
                        &base.entity_id,
                        &repository_id,
                        patch.plugin_id.trim(),
                        patch.source_id.trim(),
                    )
                    .await
                    .map_err(|_| {
                        AppError::Internal("Failed to resolve novel plugin identity.".to_string())
                    })?;
                    let expected_id = canonical_novel_plugin_id(
                        &repository_id,
                        patch.plugin_id.trim(),
                        patch.source_id.trim(),
                    );
                    if canonical_entity_id != expected_id {
                        results.push(rejected_result(&mutation, error_detail(
                            "PLUGIN_IDENTITY_CONFLICT", "Novel plugin alias resolves to another plugin identity.",
                            Some(json!({"expectedEntityId": expected_id, "resolvedEntityId": canonical_entity_id})),
                        )));
                        continue;
                    }
                    set_canonical_receipt(&mut session, &base.entity_id, &canonical_entity_id);
                    let mut canonical_patch = patch.clone();
                    canonical_patch.repository_id = repository_id;
                    canonical_patch.plugin_id = canonical_patch.plugin_id.trim().to_string();
                    canonical_patch.source_id = canonical_patch.source_id.trim().to_string();
                    canonical_patch.name = canonical_patch.name.trim().to_string();
                    canonical_patch.version = canonical_patch.version.trim().to_string();
                    canonical_patch.lang = canonical_patch.lang.trim().to_string();
                    // The record stores immutable dependency evidence. A client normally fetches
                    // the declared repository artifact, but the same hash may also reference an
                    // explicitly published, scope-granted Core asset when that exact version has
                    // disappeared upstream. Activation still requires a client-side user action,
                    // hash/size verification and runtime smoke test.
                    match db::apply_novel_plugin_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &canonical_entity_id,
                        &canonical_patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            results.push(rejected_result(
                                &mutation,
                                novel_plugin_persist_error_detail(error),
                            ));
                            continue;
                        }
                    }
                }
                MutationOperation::Delete => {
                    if patch.is_some() {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "DELETE_PATCH_NOT_ALLOWED",
                                "Novel plugin delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    let canonical_entity_id = db::resolve_novel_plugin_entity_id(
                        &state.pool,
                        &base.scope_id,
                        &base.entity_id,
                    )
                    .await
                    .map_err(|_| {
                        AppError::Internal("Failed to resolve novel plugin delete.".to_string())
                    })?;
                    set_canonical_receipt(&mut session, &base.entity_id, &canonical_entity_id);
                    match db::delete_novel_plugin_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &canonical_entity_id,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            results.push(rejected_result(
                                &mutation,
                                novel_plugin_persist_error_detail(error),
                            ));
                            continue;
                        }
                    }
                }
            },
            MutationInput::NovelCategory { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Novel category merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_novel_category_patch(&base.entity_id, patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    match db::apply_novel_category_mutation(
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
                            if let Some(error) = novel_category_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to persist novel category mutation.".to_string(),
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
                                "Novel category delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    match db::delete_novel_category_mutation(
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
                            if let Some(error) = novel_category_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to delete novel category mutation.".to_string(),
                            ));
                        }
                    }
                }
            },
            MutationInput::NovelCategoryAssignment { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Novel category assignment merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) =
                        validate_novel_category_assignment_patch(&base.entity_id, patch)
                    {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    let mut canonical_patch = patch.clone();
                    canonical_patch.novel_id =
                        db::resolve_novel_entity_id(&state.pool, &base.scope_id, &patch.novel_id)
                            .await
                            .map_err(|error| {
                                AppError::Internal(format!(
                                    "Failed to resolve novel category assignment owner: {error}"
                                ))
                            })?;
                    let canonical_assignment_id = canonical_novel_category_assignment_id(
                        &canonical_patch.novel_id,
                        &canonical_patch.category_id,
                    );
                    let requested_assignment_id =
                        canonical_novel_category_assignment_id(&patch.novel_id, &patch.category_id);
                    let uses_requested_identity = base.entity_id == requested_assignment_id
                        && canonical_patch.assignment_id == requested_assignment_id;
                    let uses_canonical_identity = base.entity_id == canonical_assignment_id
                        && canonical_patch.assignment_id == canonical_assignment_id;
                    if !uses_requested_identity && !uses_canonical_identity {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "NON_CANONICAL_ASSIGNMENT_ID",
                                "Novel category assignmentId must be the canonical SHA-256 identity for novelId and categoryId.",
                                Some(json!({
                                    "expectedAssignmentId": canonical_assignment_id,
                                    "receivedEntityId": base.entity_id,
                                    "receivedAssignmentId": canonical_patch.assignment_id,
                                    "canonicalNovelId": canonical_patch.novel_id,
                                    "categoryId": canonical_patch.category_id,
                                })),
                            ),
                        ));
                        continue;
                    }
                    canonical_patch.assignment_id = canonical_assignment_id.clone();
                    set_canonical_receipt(&mut session, &base.entity_id, &canonical_assignment_id);
                    match db::apply_novel_category_assignment_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &canonical_assignment_id,
                        &canonical_patch,
                        base.lamport,
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            if let Some(error) = novel_category_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to persist novel category assignment mutation.".to_string(),
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
                                "Novel category assignment delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    match db::delete_novel_category_assignment_mutation(
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
                            if let Some(error) = novel_category_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to delete novel category assignment mutation.".to_string(),
                            ));
                        }
                    }
                }
            },
            MutationInput::ComicEntry { base, patch } => {
                let validation = patch.as_ref().and_then(|patch| {
                    validate_comic_entry_patch(&base.scope_id, &base.entity_id, patch)
                });
                match persist_comic_sync_state(
                    &state,
                    &session,
                    &mutation,
                    base,
                    patch.as_ref(),
                    validation,
                )
                .await?
                {
                    ComicSyncRouteOutcome::Applied(outcome) => outcome,
                    ComicSyncRouteOutcome::Result(result) => {
                        if let Some(version) = result.applied_server_version {
                            current_server_version = current_server_version.max(version);
                        }
                        results.push(result);
                        continue;
                    }
                }
            }
            MutationInput::ComicCategory { base, patch } => {
                let validation = patch.as_ref().and_then(|patch| {
                    validate_comic_category_patch(&base.scope_id, &base.entity_id, patch)
                });
                match persist_comic_sync_state(
                    &state,
                    &session,
                    &mutation,
                    base,
                    patch.as_ref(),
                    validation,
                )
                .await?
                {
                    ComicSyncRouteOutcome::Applied(outcome) => outcome,
                    ComicSyncRouteOutcome::Result(result) => {
                        if let Some(version) = result.applied_server_version {
                            current_server_version = current_server_version.max(version);
                        }
                        results.push(result);
                        continue;
                    }
                }
            }
            MutationInput::ComicCategoryAssignment { base, patch } => {
                let validation = patch.as_ref().and_then(|patch| {
                    validate_comic_category_assignment_patch(&base.scope_id, &base.entity_id, patch)
                });
                match persist_comic_sync_state(
                    &state,
                    &session,
                    &mutation,
                    base,
                    patch.as_ref(),
                    validation,
                )
                .await?
                {
                    ComicSyncRouteOutcome::Applied(outcome) => outcome,
                    ComicSyncRouteOutcome::Result(result) => {
                        if let Some(version) = result.applied_server_version {
                            current_server_version = current_server_version.max(version);
                        }
                        results.push(result);
                        continue;
                    }
                }
            }
            MutationInput::ComicChapterState { base, patch } => {
                let validation = patch.as_ref().and_then(|patch| {
                    validate_comic_chapter_state_patch(&base.scope_id, &base.entity_id, patch)
                });
                match persist_comic_sync_state(
                    &state,
                    &session,
                    &mutation,
                    base,
                    patch.as_ref(),
                    validation,
                )
                .await?
                {
                    ComicSyncRouteOutcome::Applied(outcome) => outcome,
                    ComicSyncRouteOutcome::Result(result) => {
                        if let Some(version) = result.applied_server_version {
                            current_server_version = current_server_version.max(version);
                        }
                        results.push(result);
                        continue;
                    }
                }
            }
            MutationInput::ComicHistory { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Comic history merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_comic_history_patch(&base.entity_id, patch) {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    match db::apply_comic_history_mutation(
                        &state.pool,
                        &session,
                        &base.scope_id,
                        &base.entity_id,
                        patch,
                        base.lamport,
                        base.event_clock.as_ref(),
                        state.config.retention_window,
                    )
                    .await
                    {
                        Ok(db::CausalMutationWriteOutcome::Applied(outcome)) => outcome,
                        Ok(db::CausalMutationWriteOutcome::Superseded {
                            record,
                            winning_clock,
                            server_version,
                            applied_lamport,
                        }) => {
                            current_server_version = current_server_version.max(server_version);
                            results.push(superseded_result(
                                &mutation,
                                record,
                                winning_clock,
                                server_version,
                                applied_lamport,
                            ));
                            continue;
                        }
                        Err(error) => {
                            if let Some(error) = comic_state_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to persist comic history mutation.".to_string(),
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
                                "Comic history delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    match db::delete_comic_history_mutation(
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
                            if let Some(error) = comic_state_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to delete comic history mutation.".to_string(),
                            ));
                        }
                    }
                }
            },
            MutationInput::ComicPageBookmark { base, patch } => match base.op {
                MutationOperation::Merge => {
                    let Some(patch) = patch.as_ref() else {
                        results.push(rejected_result(
                            &mutation,
                            error_detail(
                                "MISSING_PATCH",
                                "Comic page bookmark merge mutations must include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    };
                    if let Some(error) = validate_comic_page_bookmark_patch(&base.entity_id, patch)
                    {
                        results.push(rejected_result(&mutation, error));
                        continue;
                    }
                    match db::apply_comic_page_bookmark_mutation(
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
                            if let Some(error) = comic_state_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to persist comic page bookmark mutation.".to_string(),
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
                                "Comic page bookmark delete mutations must not include a patch.",
                                None,
                            ),
                        ));
                        continue;
                    }
                    match db::delete_comic_page_bookmark_mutation(
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
                            if let Some(error) = comic_state_persist_error_detail(error) {
                                results.push(rejected_result(&mutation, error));
                                continue;
                            }
                            return Err(AppError::Internal(
                                "Failed to delete comic page bookmark mutation.".to_string(),
                            ));
                        }
                    }
                }
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
            event_clock: base.event_clock.clone(),
            record: Some(outcome.record),
            error: None,
        });
    }

    for result in &mut results {
        if result.status == MutationResultStatus::Applied {
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
    // Lamport is transport ordering metadata and may be reallocated after a lost response.
    // The persisted EventClock and command payload are the semantic idempotency identity.
    let mut hash_value = canonical;
    if let Some(object) = hash_value.as_object_mut() {
        object.remove("lamport");
    }
    let hash_json = serde_json::to_string(&hash_value)
        .map_err(|error| AppError::Internal(format!("Failed to hash mutation: {error}")))?;
    let mutation_hash = format!("{:x}", Sha256::digest(hash_json.as_bytes()));
    Ok((mutation_json, mutation_hash))
}

enum ComicSyncRouteOutcome {
    Applied(db::MutationWriteOutcome),
    Result(MutationResult),
}

async fn persist_comic_sync_state<T: Serialize>(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    mutation: &MutationInput,
    base: &MutationBase,
    patch: Option<&T>,
    validation: Option<ErrorDetail>,
) -> Result<ComicSyncRouteOutcome, AppError> {
    if let Some(error) = validation {
        return Ok(ComicSyncRouteOutcome::Result(rejected_result(
            mutation, error,
        )));
    }
    let outcome = match base.op {
        MutationOperation::Merge => {
            let Some(patch) = patch else {
                return Ok(ComicSyncRouteOutcome::Result(rejected_result(
                    mutation,
                    error_detail(
                        "MISSING_PATCH",
                        "Comic state merge mutations must include a patch.",
                        None,
                    ),
                )));
            };
            let record = serde_json::to_value(patch).map_err(|error| {
                AppError::Internal(format!("Failed to encode comic state mutation: {error}"))
            })?;
            db::apply_comic_sync_state_mutation(
                &state.pool,
                session,
                &base.scope_id,
                mutation.entity_type().as_str(),
                &base.entity_id,
                &record,
                base.lamport,
                base.event_clock.as_ref(),
                state.config.retention_window,
            )
            .await
        }
        MutationOperation::Delete => {
            if patch.is_some() {
                return Ok(ComicSyncRouteOutcome::Result(rejected_result(
                    mutation,
                    error_detail(
                        "DELETE_PATCH_NOT_ALLOWED",
                        "Comic state delete mutations must not include a patch.",
                        None,
                    ),
                )));
            }
            db::delete_comic_sync_state_mutation(
                &state.pool,
                session,
                &base.scope_id,
                mutation.entity_type().as_str(),
                &base.entity_id,
                base.lamport,
                base.event_clock.as_ref(),
                state.config.retention_window,
            )
            .await
        }
    };
    match outcome {
        Ok(db::CausalMutationWriteOutcome::Applied(outcome)) => {
            Ok(ComicSyncRouteOutcome::Applied(outcome))
        }
        Ok(db::CausalMutationWriteOutcome::Superseded {
            record,
            winning_clock,
            server_version,
            applied_lamport,
        }) => Ok(ComicSyncRouteOutcome::Result(superseded_result(
            mutation,
            record,
            winning_clock,
            server_version,
            applied_lamport,
        ))),
        Err(error) => {
            let diagnostic = error.to_string();
            if let Some(error) = comic_state_persist_error_detail(error) {
                Ok(ComicSyncRouteOutcome::Result(rejected_result(
                    mutation, error,
                )))
            } else {
                tracing::error!(error = %diagnostic, "failed to persist canonical comic state mutation");
                let message = if cfg!(test) {
                    format!("Failed to persist canonical comic state mutation: {diagnostic}")
                } else {
                    "Failed to persist canonical comic state mutation.".to_string()
                };
                Err(AppError::Internal(message))
            }
        }
    }
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
    if matches!(
        entity_type,
        MutationEntityType::NovelRepository | MutationEntityType::NovelPlugin
    ) && (entity_id != entity_id.trim() || entity_id.len() > 256 || entity_id.contains('\0'))
    {
        return Some(error_detail(
            "INVALID_ENTITY_ALIAS",
            "Repository and plugin entityId aliases must be trimmed, at most 256 bytes, and contain no NUL.",
            None,
        ));
    }

    match entity_type {
        MutationEntityType::BookEntry
        | MutationEntityType::BookCategory
        | MutationEntityType::BookCategoryAssignment
        | MutationEntityType::BookLibraryUi
        | MutationEntityType::BookProgress
        | MutationEntityType::BookBookmark
        | MutationEntityType::BookHighlight
        | MutationEntityType::BookHistory => {
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
        | MutationEntityType::NovelChapterAsset
        | MutationEntityType::NovelHistory
        | MutationEntityType::NovelProgress
        | MutationEntityType::NovelBookmark
        | MutationEntityType::NovelClassification
        | MutationEntityType::NovelRepository
        | MutationEntityType::NovelPlugin
        | MutationEntityType::NovelCategory
        | MutationEntityType::NovelCategoryAssignment => {
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
        MutationEntityType::ComicEntry
        | MutationEntityType::ComicCategory
        | MutationEntityType::ComicCategoryAssignment
        | MutationEntityType::ComicChapterState
        | MutationEntityType::ComicHistory
        | MutationEntityType::ComicPageBookmark => {
            if !scope_id.starts_with("comics:profile:") {
                return Some(error_detail(
                    "INVALID_SCOPE_FOR_ENTITY",
                    "Comic mutations must use comics:profile:<id>.",
                    Some(json!({
                        "entityType": entity_type.as_str(),
                        "expectedScopePattern": "comics:profile:<id>",
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

fn validate_book_entry_patch(entity_id: &str, patch: &BookEntryPatch) -> Option<ErrorDetail> {
    for (field, value) in [
        ("assetFingerprint", patch.asset_fingerprint.as_deref()),
        ("coverAssetSha256", patch.cover_asset_sha256.as_deref()),
    ] {
        if let Some(value) = value {
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Some(error_detail(
                    "INVALID_ASSET_SHA256",
                    "Book asset hashes must contain exactly 64 lowercase hexadecimal characters.",
                    Some(json!({ "field": field })),
                ));
            }
        }
    }
    if patch.byte_size.is_some_and(|size| size < 0) {
        return Some(error_detail(
            "INVALID_ASSET_BYTE_LENGTH",
            "Book byteSize must be zero or greater.",
            None,
        ));
    }
    if patch.asset_fingerprint.is_some() && patch.byte_size == Some(0) {
        return Some(error_detail(
            "INVALID_ASSET_BYTE_LENGTH",
            "Book assets must contain at least one byte.",
            None,
        ));
    }
    let complete_cover_reference = match (
        patch.cover_asset_sha256.as_deref(),
        patch.cover_asset_byte_size,
        patch.cover_asset_mime_type.as_deref(),
    ) {
        (None, None, None) => false,
        (Some(_), Some(size), Some(mime_type)) => {
            if size <= 0 {
                return Some(error_detail(
                    "INVALID_BOOK_COVER_BYTE_LENGTH",
                    "Book cover assets must contain at least one byte.",
                    None,
                ));
            }
            if !matches!(mime_type, "image/jpeg" | "image/png" | "image/webp") {
                return Some(error_detail(
                    "INVALID_BOOK_COVER_MIME_TYPE",
                    "Book cover MIME type must be image/jpeg, image/png, or image/webp.",
                    None,
                ));
            }
            true
        }
        _ => {
            return Some(error_detail(
                "INCOMPLETE_BOOK_COVER_ASSET_REFERENCE",
                "Book cover hash, byte size, and MIME type must be provided together.",
                None,
            ));
        }
    };
    if patch.mime_type.as_deref().is_some_and(|value| {
        value.trim().is_empty() || value.len() > 255 || value.chars().any(char::is_control)
    }) {
        return Some(error_detail(
            "INVALID_MIME_TYPE",
            "Book mimeType must be a non-empty safe media type.",
            None,
        ));
    }
    let subtype = patch.subtype.trim().to_ascii_lowercase();
    if subtype != "epub" && subtype != "pdf" {
        return Some(error_detail(
            "INVALID_SUBTYPE",
            "Book subtype must be epub or pdf.",
            None,
        ));
    }
    if let Some(asset) = patch.asset_fingerprint.as_deref() {
        let expected_id = format!("{subtype}:sha256:{asset}");
        if entity_id != expected_id {
            return Some(error_detail(
                "BOOK_IDENTITY_MISMATCH",
                "Book identity must match its immutable content type and SHA-256.",
                None,
            ));
        }
        let expected_mime = if subtype == "epub" {
            "application/epub+zip"
        } else {
            "application/pdf"
        };
        if patch.mime_type.as_deref() != Some(expected_mime) {
            return Some(error_detail(
                "BOOK_MIME_MISMATCH",
                "Book MIME type does not match its immutable subtype.",
                None,
            ));
        }
    }
    for (field, value) in [
        ("pageCount", patch.page_count),
        ("tocCount", patch.toc_count),
        ("spineCount", patch.spine_count),
        ("sectionCount", patch.section_count),
    ] {
        if value.is_some_and(|count| count < 0) {
            return Some(error_detail(
                "INVALID_BOOK_COUNT",
                "Book counts must be zero or greater.",
                Some(json!({ "field": field })),
            ));
        }
    }
    if patch.has_cover != complete_cover_reference {
        return Some(error_detail(
            "INVALID_BOOK_COVER",
            "Book hasCover must match its complete cover asset reference.",
            None,
        ));
    }
    if patch.title.trim().is_empty() {
        return Some(error_detail(
            "INVALID_TITLE",
            "Book entry patch must include a non-empty title.",
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
        .or_else(
            || match (&patch.portable_work_ref, &patch.portable_chapter_ref) {
                (None, None) => None,
                (Some(work), Some(chapter)) => work
                    .validate()
                    .and_then(|_| chapter.validate())
                    .err()
                    .map(|_| {
                        error_detail(
                            "INVALID_PORTABLE_NOVEL_REFERENCE",
                            "Portable novel progress references are invalid.",
                            None,
                        )
                    }),
                _ => Some(error_detail(
                    "INCOMPLETE_PORTABLE_NOVEL_REFERENCE",
                    "Portable novel progress requires both work and chapter references.",
                    None,
                )),
            },
        )
}

fn validate_novel_portable_identity(
    requested_novel_id: &str,
    patch: &NovelProgressPatch,
) -> Option<ErrorDetail> {
    let (Some(work), Some(chapter)) = (&patch.portable_work_ref, &patch.portable_chapter_ref)
    else {
        return None;
    };
    let PortableWorkRefV3::Novel { .. } = work else {
        return Some(error_detail(
            "PORTABLE_NOVEL_TYPE_MISMATCH",
            "Portable novel progress must reference a novel work.",
            None,
        ));
    };
    let PortableChapterRefV3::Novel {
        work: chapter_work, ..
    } = chapter
    else {
        return Some(error_detail(
            "PORTABLE_NOVEL_CHAPTER_TYPE_MISMATCH",
            "Portable novel progress must reference a novel chapter.",
            None,
        ));
    };
    let expected_work_id = canonical_portable_work_id(work);
    let expected_chapter_id = canonical_portable_chapter_id(chapter);
    if chapter_work != work
        || requested_novel_id != expected_work_id
        || patch.chapter_id.as_deref() != Some(expected_chapter_id.as_str())
    {
        return Some(error_detail(
            "PORTABLE_NOVEL_IDENTITY_MISMATCH",
            "Portable novel IDs must match their provider-owned references.",
            None,
        ));
    }
    None
}

fn validate_novel_entry_patch(entity_id: &str, patch: &NovelEntryPatch) -> Option<ErrorDetail> {
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
    if let Some(reference) = patch.portable_work_ref.as_ref() {
        if reference.validate().is_err() || !matches!(reference, PortableWorkRefV3::Novel { .. }) {
            return Some(error_detail(
                "INVALID_PORTABLE_REFERENCE",
                "Portable novel reference is invalid.",
                None,
            ));
        }
        let expected = canonical_portable_work_id(reference);
        if entity_id != expected || patch.identity_key != expected {
            return Some(error_detail(
                "PORTABLE_NOVEL_IDENTITY_MISMATCH",
                "Novel identity must be derived from its portable reference.",
                Some(json!({ "expectedNovelId": expected })),
            ));
        }
        let PortableWorkRefV3::Novel { novel_key, .. } = reference else {
            unreachable!()
        };
        if patch.path != *novel_key {
            return Some(error_detail(
                "PORTABLE_NOVEL_KEY_MISMATCH",
                "Novel path must preserve the provider-owned portable key.",
                None,
            ));
        }
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

fn validate_novel_chapter_asset_patch(patch: &NovelChapterAssetPatch) -> Option<ErrorDetail> {
    if patch.schema_version != 1 {
        return Some(error_detail(
            "UNSUPPORTED_CHAPTER_ASSET_SCHEMA",
            "Novel chapter asset schemaVersion must be 1.",
            Some(json!({ "receivedSchemaVersion": patch.schema_version })),
        ));
    }
    for (field, value) in [
        ("novelId", patch.novel_id.as_str()),
        ("chapterId", patch.chapter_id.as_str()),
    ] {
        if value.is_empty() || value != value.trim() || value.len() > 512 || value.contains('\0') {
            return Some(error_detail(
                "INVALID_CHAPTER_ASSET_ID",
                "Novel chapter asset identifiers must be non-empty, trimmed, at most 512 bytes, and contain no NUL.",
                Some(json!({ "field": field })),
            ));
        }
    }
    if patch.blob_sha256.len() != 64
        || !patch
            .blob_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Some(error_detail(
            "INVALID_ASSET_SHA256",
            "Novel chapter asset blobSha256 must contain exactly 64 lowercase hexadecimal characters.",
            None,
        ));
    }
    if patch.byte_length <= 0 {
        return Some(error_detail(
            "INVALID_ASSET_BYTE_LENGTH",
            "Novel chapter asset byteLength must be greater than zero.",
            Some(json!({ "receivedByteLength": patch.byte_length })),
        ));
    }
    if patch.archive_format != "zip" {
        return Some(error_detail(
            "UNSUPPORTED_ARCHIVE_FORMAT",
            "Novel chapter asset archiveFormat must be 'zip'.",
            Some(json!({ "receivedArchiveFormat": patch.archive_format })),
        ));
    }
    validate_non_negative_timestamp(patch.created_at_ms, "createdAtMs")
        .or_else(|| validate_non_negative_timestamp(patch.updated_at_ms, "updatedAtMs"))
        .or_else(|| {
            if patch.updated_at_ms < patch.created_at_ms {
                Some(error_detail(
                    "INVALID_TIMESTAMP_ORDER",
                    "Novel chapter asset updatedAtMs must not precede createdAtMs.",
                    None,
                ))
            } else {
                None
            }
        })
}

fn validate_book_bookmark_patch(patch: &BookBookmarkPatch) -> Option<ErrorDetail> {
    if patch.book_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_PARENT_ID",
            "Book bookmark patch must include a non-empty bookId.",
            None,
        ));
    }
    let created_at_ms = patch.effective_created_at_ms();
    let updated_at_ms = patch.effective_updated_at_ms();
    validate_progress_value(patch.progress_percent)
        .or_else(|| validate_non_negative_timestamp(created_at_ms, "createdAtMs"))
        .or_else(|| validate_non_negative_timestamp(updated_at_ms, "updatedAtMs"))
        .or_else(|| validate_non_negative_timestamp(patch.saved_at_ms, "savedAtMs"))
        .or_else(|| {
            if updated_at_ms < created_at_ms {
                Some(error_detail(
                    "INVALID_TIMESTAMP_ORDER",
                    "Book bookmark updatedAtMs must not precede createdAtMs.",
                    None,
                ))
            } else {
                None
            }
        })
}

fn validate_book_highlight_patch(
    entity_id: &str,
    patch: &BookHighlightPatch,
) -> Option<ErrorDetail> {
    if patch.highlight_id != entity_id {
        return Some(error_detail(
            "ENTITY_ID_MISMATCH",
            "Book highlight patch highlightId must exactly match entityId.",
            None,
        ));
    }
    if patch.book_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_PARENT_ID",
            "Book highlight patch must include a non-empty bookId.",
            None,
        ));
    }
    if !patch.start_locator_json.is_object() || !patch.end_locator_json.is_object() {
        return Some(error_detail(
            "INVALID_LOCATOR",
            "Book highlight locators must be JSON objects.",
            None,
        ));
    }
    if patch.selected_text.len() > 65_536 {
        return Some(error_detail(
            "HIGHLIGHT_TEXT_TOO_LARGE",
            "Book highlight selected text is too large.",
            None,
        ));
    }
    validate_non_negative_timestamp(patch.created_at_ms, "createdAtMs")
        .or_else(|| validate_non_negative_timestamp(patch.updated_at_ms, "updatedAtMs"))
        .or_else(|| {
            if patch.updated_at_ms < patch.created_at_ms {
                Some(error_detail(
                    "INVALID_TIMESTAMP_ORDER",
                    "Book highlight updatedAtMs must not precede createdAtMs.",
                    None,
                ))
            } else {
                None
            }
        })
}

fn validate_book_history_patch(entity_id: &str, patch: &BookHistoryPatch) -> Option<ErrorDetail> {
    if patch.history_id != entity_id {
        return Some(error_detail(
            "ENTITY_ID_MISMATCH",
            "Book history patch historyId must exactly match entityId.",
            Some(json!({
                "entityId": entity_id,
                "historyId": patch.history_id,
            })),
        ));
    }
    if patch.book_id.trim().is_empty() {
        return Some(error_detail(
            "INVALID_BOOK_ID",
            "Book history patch must include a non-empty bookId.",
            None,
        ));
    }
    if !matches!(patch.renderer.as_deref(), None | Some("epub") | Some("pdf")) {
        return Some(error_detail(
            "INVALID_RENDERER",
            "Book history renderer must be 'epub' or 'pdf'.",
            Some(json!({ "receivedRenderer": patch.renderer })),
        ));
    }
    if patch.page_index.is_some_and(|page| page < 0) {
        return Some(error_detail(
            "INVALID_PAGE_INDEX",
            "Book history pageIndex must be zero or greater.",
            Some(json!({ "receivedPageIndex": patch.page_index })),
        ));
    }
    validate_progress_value(patch.progress_percent)
        .or_else(|| validate_non_negative_timestamp(patch.read_at_ms, "readAtMs"))
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

fn validate_novel_repository_patch(patch: &NovelRepositoryPatch) -> Result<String, ErrorDetail> {
    let Some(canonical_url) = canonicalize_novel_repository_url(&patch.canonical_url) else {
        return Err(error_detail(
            "INVALID_REPOSITORY_URL",
            "Repository URL must be clean HTTPS without userinfo, query, or fragment.",
            None,
        ));
    };
    if patch.name.trim().is_empty() || patch.name.trim().len() > 200 {
        return Err(error_detail(
            "INVALID_REPOSITORY_NAME",
            "Repository name must contain 1 to 200 bytes after trimming.",
            None,
        ));
    }
    if patch.created_at_ms < 0 || patch.updated_at_ms < patch.created_at_ms {
        return Err(error_detail(
            "INVALID_TIMESTAMP_ORDER",
            "Repository timestamps are invalid.",
            None,
        ));
    }
    let _canonical_id = canonical_novel_repository_id(&canonical_url);
    Ok(canonical_url)
}

fn validate_novel_plugin_patch(patch: &NovelPluginPatch) -> Option<ErrorDetail> {
    for (field, value) in [
        ("repositoryId", patch.repository_id.as_str()),
        ("pluginId", patch.plugin_id.as_str()),
        ("sourceId", patch.source_id.as_str()),
    ] {
        if value.trim().is_empty()
            || value != value.trim()
            || value.len() > 256
            || value.contains('\0')
        {
            return Some(error_detail(
                "INVALID_PLUGIN_IDENTITY",
                "Plugin identity fields must be trimmed, non-empty, at most 256 bytes, and contain no NUL.",
                Some(json!({"field": field})),
            ));
        }
    }
    for (field, value, limit) in [
        ("name", patch.name.as_str(), 200usize),
        ("version", patch.version.as_str(), 100usize),
        ("lang", patch.lang.as_str(), 35usize),
    ] {
        if value.trim().is_empty() || value.trim().len() > limit {
            return Some(error_detail(
                "INVALID_PLUGIN_METADATA",
                "Plugin name, version, and language must be non-empty and within limits.",
                Some(json!({"field": field, "maxBytes": limit})),
            ));
        }
    }
    if patch.artifact_sha256.len() != 64
        || patch
            .artifact_sha256
            .bytes()
            .any(|value| !matches!(value, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Some(error_detail(
            "INVALID_ASSET_SHA256",
            "Plugin artifactSha256 must be a lowercase SHA-256 digest.",
            None,
        ));
    }
    if !(1..=2_097_152).contains(&patch.artifact_byte_length) {
        return Some(error_detail(
            "INVALID_PLUGIN_ARTIFACT_SIZE",
            "Plugin artifactByteLength must be between 1 byte and 2 MiB.",
            None,
        ));
    }
    if patch.created_at_ms < 0 || patch.updated_at_ms < patch.created_at_ms {
        return Some(error_detail(
            "INVALID_TIMESTAMP_ORDER",
            "Plugin timestamps are invalid.",
            None,
        ));
    }
    validate_syncable_public_settings(&patch.public_settings).err()
}

fn validate_syncable_public_settings(value: &Value) -> Result<(), ErrorDetail> {
    validate_public_settings(value)?;
    if value
        .as_object()
        .is_some_and(|settings| !settings.is_empty())
    {
        return Err(error_detail(
            "PUBLIC_SETTINGS_NOT_SYNCABLE",
            "publicSettings must be empty until a pre-execution public-key allowlist is available.",
            None,
        ));
    }
    Ok(())
}

fn validate_public_settings(value: &Value) -> Result<(), ErrorDetail> {
    if !value.is_object() {
        return Err(error_detail(
            "INVALID_PUBLIC_SETTINGS",
            "publicSettings must be a JSON object.",
            None,
        ));
    }
    let encoded = serde_json::to_vec(value).map_err(|_| {
        error_detail(
            "INVALID_PUBLIC_SETTINGS",
            "publicSettings is not valid JSON.",
            None,
        )
    })?;
    if encoded.len() > 32 * 1024 {
        return Err(error_detail(
            "PUBLIC_SETTINGS_TOO_LARGE",
            "publicSettings must not exceed 32 KiB.",
            Some(json!({"maxBytes": 32768, "receivedBytes": encoded.len()})),
        ));
    }
    let mut nodes = 0usize;
    validate_public_settings_node(value, 0, &mut nodes)
}

fn validate_public_settings_node(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), ErrorDetail> {
    *nodes += 1;
    if depth > 8 || *nodes > 256 {
        return Err(error_detail(
            "PUBLIC_SETTINGS_COMPLEXITY_LIMIT",
            "publicSettings exceeds the depth or node limit.",
            Some(json!({"maxDepth": 8, "maxNodes": 256})),
        ));
    }
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if key.len() > 128 || public_setting_key_is_secret(key) {
                    return Err(error_detail(
                        "SECRET_SETTING_REJECTED",
                        "Secret-looking publicSettings keys are never synchronized.",
                        Some(json!({"key": key})),
                    ));
                }
                validate_public_settings_node(value, depth + 1, nodes)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_public_settings_node(value, depth + 1, nodes)?;
            }
        }
        Value::String(value) => {
            if value.len() > 2048 || public_setting_value_is_secret(value) {
                return Err(error_detail(
                    "SECRET_SETTING_REJECTED",
                    "Secret-looking or oversized publicSettings values are never synchronized.",
                    None,
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn public_setting_key_is_secret(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|value| value.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "token",
        "password",
        "passwd",
        "secret",
        "cookie",
        "session",
        "auth",
        "apikey",
        "credential",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn public_setting_value_is_secret(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("bearer ") || lower.contains("cookie:") || lower.contains("set-cookie:") {
        return true;
    }
    let jwt = trimmed.split('.').collect::<Vec<_>>();
    if jwt.len() == 3
        && jwt.iter().all(|part| {
            part.len() >= 8
                && part
                    .bytes()
                    .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
        })
    {
        return true;
    }
    trimmed.len() >= 128
        && trimmed.bytes().all(|value| {
            value.is_ascii_alphanumeric() || matches!(value, b'+' | b'/' | b'=' | b'-' | b'_')
        })
}

fn validate_novel_category_patch(
    entity_id: &str,
    patch: &NovelCategoryPatch,
) -> Option<ErrorDetail> {
    validate_stable_id("categoryId", entity_id, &patch.category_id).or_else(|| {
        if patch.order < 0 {
            return Some(error_detail(
                "INVALID_CATEGORY_ORDER",
                "Novel category order must be zero or greater.",
                Some(json!({ "receivedOrder": patch.order })),
            ));
        }
        let name = patch.name.trim();
        if name.is_empty() || name.len() > 256 || name.contains('\0') {
            Some(error_detail(
                "INVALID_CATEGORY_NAME",
                "Novel category name must be non-empty, at most 256 bytes, and contain no NUL.",
                None,
            ))
        } else {
            None
        }
    })
}

fn validate_novel_category_assignment_patch(
    entity_id: &str,
    patch: &NovelCategoryAssignmentPatch,
) -> Option<ErrorDetail> {
    validate_stable_id("assignmentId", entity_id, &patch.assignment_id)
        .or_else(|| validate_identifier("novelId", &patch.novel_id))
        .or_else(|| validate_identifier("categoryId", &patch.category_id))
}

fn validate_stable_id(field: &str, entity_id: &str, value: &str) -> Option<ErrorDetail> {
    if value != entity_id {
        return Some(error_detail(
            "ENTITY_ID_MISMATCH",
            &format!("Novel category mutation {field} must exactly match entityId."),
            Some(json!({
                "field": field,
                "entityId": entity_id,
                "receivedId": value,
            })),
        ));
    }
    validate_identifier(field, value)
}

fn validate_identifier(field: &str, value: &str) -> Option<ErrorDetail> {
    if value.trim().is_empty() || value != value.trim() || value.len() > 512 || value.contains('\0')
    {
        return Some(error_detail(
            "INVALID_IDENTIFIER",
            &format!(
                "Novel category mutation {field} must be non-empty, at most 512 bytes, and contain no NUL."
            ),
            Some(json!({ "field": field })),
        ));
    }
    None
}

fn validate_comic_history_patch(entity_id: &str, patch: &ComicHistoryPatch) -> Option<ErrorDetail> {
    validate_payload_identity("historyId", entity_id, &patch.history_id)
        .or_else(|| {
            validate_comic_portable_or_legacy_identity(
                &patch.comic_id,
                &patch.chapter_id,
                patch.portable_work_ref.as_ref(),
                patch.portable_chapter_ref.as_ref(),
            )
        })
        .or_else(|| validate_comic_history_entity_id(entity_id, &patch.comic_id))
        .or_else(|| validate_bounded_identifier(&patch.chapter_id, "chapterId"))
        .or_else(|| validate_page_locator(patch.page_index, patch.page_count))
        .or_else(|| validate_progress_value(patch.progress_percent))
        .or_else(|| validate_non_negative_timestamp(patch.read_at_ms, "readAtMs"))
}

fn validate_comic_entry_patch(
    scope_id: &str,
    entity_id: &str,
    patch: &ComicEntryPatch,
) -> Option<ErrorDetail> {
    validate_payload_identity("comicId", entity_id, &patch.comic_id)
        .or_else(|| {
            validate_comic_work_or_legacy_identity(
                scope_id,
                &patch.comic_id,
                patch.portable_work_ref.as_ref(),
            )
        })
        .or_else(|| {
            (!patch.in_library).then(|| {
                error_detail(
                    "INVALID_LIBRARY_MEMBERSHIP",
                    "Comic entry merge requires inLibrary=true; use delete to remove membership.",
                    None,
                )
            })
        })
}

fn validate_comic_category_patch(
    scope_id: &str,
    entity_id: &str,
    patch: &ComicCategoryPatch,
) -> Option<ErrorDetail> {
    validate_payload_identity("categoryId", entity_id, &patch.category_id)
        .or_else(|| validate_scoped_suwayomi_id(scope_id, &patch.category_id, ":category:"))
        .or_else(|| {
            let name = patch.name.trim();
            (name.is_empty() || name != patch.name || name.len() > 256 || name.contains('\0'))
                .then(|| {
                    error_detail(
                        "INVALID_CATEGORY_NAME",
                        "Comic category name must be trimmed, non-empty, at most 256 bytes, and contain no NUL.",
                        None,
                    )
                })
        })
        .or_else(|| {
            (patch.order < 0).then(|| {
                error_detail(
                    "INVALID_CATEGORY_ORDER",
                    "Comic category order must be zero or greater.",
                    Some(json!({ "receivedOrder": patch.order })),
                )
            })
        })
}

fn validate_comic_category_assignment_patch(
    scope_id: &str,
    entity_id: &str,
    patch: &ComicCategoryAssignmentPatch,
) -> Option<ErrorDetail> {
    validate_payload_identity("assignmentId", entity_id, &patch.assignment_id)
        .or_else(|| {
            validate_comic_work_or_legacy_identity(
                scope_id,
                &patch.comic_id,
                patch.portable_work_ref.as_ref(),
            )
        })
        .or_else(|| validate_scoped_suwayomi_id(scope_id, &patch.category_id, ":category:"))
}

fn validate_comic_work_or_legacy_identity(
    scope_id: &str,
    comic_id: &str,
    work: Option<&PortableWorkRefV3>,
) -> Option<ErrorDetail> {
    let Some(work) = work else {
        return validate_scoped_suwayomi_id(scope_id, comic_id, ":manga:");
    };
    if work.validate().is_err() || !matches!(work, PortableWorkRefV3::Comic { .. }) {
        return Some(error_detail(
            "INVALID_PORTABLE_REFERENCE",
            "Portable comic reference is invalid.",
            None,
        ));
    }
    let expected = canonical_portable_work_id(work);
    (comic_id != expected).then(|| {
        error_detail(
            "NON_CANONICAL_PORTABLE_ID",
            "Comic ID must be derived from its portable reference.",
            Some(json!({ "expectedComicId": expected, "receivedComicId": comic_id })),
        )
    })
}

fn validate_comic_chapter_state_patch(
    scope_id: &str,
    entity_id: &str,
    patch: &ComicChapterStatePatch,
) -> Option<ErrorDetail> {
    validate_payload_identity("chapterStateId", entity_id, &patch.chapter_state_id)
        .or_else(|| {
            if patch.portable_work_ref.is_some() || patch.portable_chapter_ref.is_some() {
                validate_comic_portable_or_legacy_identity(
                    &patch.comic_id,
                    &patch.chapter_id,
                    patch.portable_work_ref.as_ref(),
                    patch.portable_chapter_ref.as_ref(),
                )
            } else {
                validate_scoped_suwayomi_id(scope_id, &patch.comic_id, ":manga:").or_else(|| {
                    validate_scoped_suwayomi_id(scope_id, &patch.chapter_id, ":chapter:")
                })
            }
        })
        .or_else(|| {
            let expected = format!(
                "comic.chapter_state::{}::{}",
                patch.comic_id, patch.chapter_id
            );
            (entity_id != expected).then(|| {
                error_detail(
                    "NON_CANONICAL_CHAPTER_STATE_ID",
                    "Comic chapter state entityId must be derived from comicId and chapterId.",
                    Some(json!({ "expectedEntityId": expected, "receivedEntityId": entity_id })),
                )
            })
        })
        .or_else(|| {
            patch.last_page_read.and_then(|page| {
                (page < 0).then(|| {
                    error_detail(
                        "INVALID_PAGE_INDEX",
                        "Comic lastPageRead must be zero or greater.",
                        Some(json!({ "receivedLastPageRead": page })),
                    )
                })
            })
        })
        .or_else(|| {
            patch
                .last_read_at_ms
                .and_then(|timestamp| validate_non_negative_timestamp(timestamp, "lastReadAtMs"))
        })
        .or_else(|| validate_non_negative_timestamp(patch.updated_at_ms, "updatedAtMs"))
}

fn validate_comic_page_bookmark_patch(
    entity_id: &str,
    patch: &ComicPageBookmarkPatch,
) -> Option<ErrorDetail> {
    validate_payload_identity("bookmarkId", entity_id, &patch.bookmark_id)
        .or_else(|| {
            validate_comic_portable_or_legacy_identity(
                &patch.comic_id,
                &patch.chapter_id,
                patch.portable_work_ref.as_ref(),
                patch.portable_chapter_ref.as_ref(),
            )
        })
        .or_else(|| validate_bounded_identifier(&patch.chapter_id, "chapterId"))
        .or_else(|| validate_page_locator(patch.page_index, patch.page_count))
        .or_else(|| {
            patch.label.as_deref().and_then(|label| {
                if label.contains('\0') || label.len() > 512 {
                    Some(error_detail(
                        "INVALID_LABEL",
                        "Comic page bookmark label must be at most 512 bytes and contain no NUL.",
                        None,
                    ))
                } else {
                    None
                }
            })
        })
        .or_else(|| validate_non_negative_timestamp(patch.saved_at_ms, "savedAtMs"))
}

fn validate_comic_portable_or_legacy_identity(
    comic_id: &str,
    chapter_id: &str,
    work: Option<&PortableWorkRefV3>,
    chapter: Option<&PortableChapterRefV3>,
) -> Option<ErrorDetail> {
    match (work, chapter) {
        (None, None) => validate_comic_media_key(comic_id)
            .or_else(|| validate_bounded_identifier(chapter_id, "chapterId")),
        (Some(work), Some(chapter)) => {
            if work.validate().is_err() || chapter.validate().is_err() {
                return Some(error_detail(
                    "INVALID_PORTABLE_REFERENCE",
                    "Portable comic references are invalid.",
                    None,
                ));
            }
            let PortableChapterRefV3::Comic {
                work: chapter_work, ..
            } = chapter
            else {
                return Some(error_detail(
                    "PORTABLE_REFERENCE_TYPE_MISMATCH",
                    "Comic state requires comic portable references.",
                    None,
                ));
            };
            if !matches!(work, PortableWorkRefV3::Comic { .. }) || chapter_work != work {
                return Some(error_detail(
                    "PORTABLE_REFERENCE_PARENT_MISMATCH",
                    "Portable chapter must belong to the supplied portable comic.",
                    None,
                ));
            }
            let expected_work = canonical_portable_work_id(work);
            let expected_chapter = canonical_portable_chapter_id(chapter);
            if comic_id != expected_work || chapter_id != expected_chapter {
                return Some(error_detail(
                    "NON_CANONICAL_PORTABLE_ID",
                    "Comic and chapter IDs must be derived from their portable references.",
                    Some(json!({
                        "expectedComicId": expected_work,
                        "expectedChapterId": expected_chapter,
                    })),
                ));
            }
            None
        }
        _ => Some(error_detail(
            "INCOMPLETE_PORTABLE_REFERENCE",
            "Portable work and chapter references must be supplied together.",
            None,
        )),
    }
}

fn validate_payload_identity(field: &str, entity_id: &str, value: &str) -> Option<ErrorDetail> {
    if value != entity_id {
        return Some(error_detail(
            "ENTITY_ID_MISMATCH",
            &format!("Comic mutation {field} must exactly match entityId."),
            Some(json!({
                "field": field,
                "entityId": entity_id,
                "receivedId": value,
            })),
        ));
    }
    validate_bounded_identifier(value, field)
}

fn validate_comic_history_entity_id(entity_id: &str, comic_id: &str) -> Option<ErrorDetail> {
    let expected = format!("comic.history::{comic_id}");
    if entity_id != expected {
        return Some(error_detail(
            "ENTITY_ID_MISMATCH",
            "Comic history entityId must be comic.history::<comicId>.",
            Some(json!({
                "expectedEntityId": expected,
                "receivedEntityId": entity_id,
                "comicId": comic_id,
            })),
        ));
    }
    None
}

fn validate_bounded_identifier(value: &str, field: &str) -> Option<ErrorDetail> {
    if value.trim().is_empty() || value != value.trim() || value.contains('\0') || value.len() > 512
    {
        return Some(error_detail(
            "INVALID_IDENTIFIER",
            &format!(
                "Comic mutation {field} must be non-empty, at most 512 bytes, and contain no NUL."
            ),
            Some(json!({ "field": field })),
        ));
    }
    None
}

fn validate_comic_media_key(comic_id: &str) -> Option<ErrorDetail> {
    if parse_scoped_suwayomi_id(comic_id, ":manga:").is_some() {
        return None;
    }
    let Some(rest) = comic_id.strip_prefix("suwayomi:") else {
        return Some(invalid_comic_id(comic_id));
    };
    let Some((fingerprint, manga_id)) = rest.rsplit_once(":manga:") else {
        return Some(invalid_comic_id(comic_id));
    };
    let valid_fingerprint = !fingerprint.is_empty()
        && fingerprint.len() <= 128
        && fingerprint.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        });
    let valid_manga_id = !manga_id.trim().is_empty()
        && manga_id == manga_id.trim()
        && manga_id.len() <= 256
        && !manga_id.contains('\0')
        && !manga_id.contains(":manga:");
    if !valid_fingerprint || !valid_manga_id {
        return Some(invalid_comic_id(comic_id));
    }
    None
}

fn invalid_comic_id(comic_id: &str) -> ErrorDetail {
    error_detail(
        "INVALID_COMIC_ID",
        "comicId must use suwayomi:<normalized-server-fingerprint>:manga:<manga-id>.",
        Some(json!({ "receivedComicId": comic_id })),
    )
}

fn validate_page_locator(page_index: i64, page_count: Option<i64>) -> Option<ErrorDetail> {
    if page_index < 0 {
        return Some(error_detail(
            "INVALID_PAGE_INDEX",
            "Comic pageIndex must be zero or greater.",
            Some(json!({ "receivedPageIndex": page_index })),
        ));
    }
    if let Some(page_count) = page_count {
        if page_count <= 0 || page_index >= page_count {
            return Some(error_detail(
                "INVALID_PAGE_COUNT",
                "Comic pageCount must be positive and greater than pageIndex.",
                Some(json!({
                    "receivedPageIndex": page_index,
                    "receivedPageCount": page_count,
                })),
            ));
        }
    }
    None
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

fn validate_event_clock(clock: Option<&EventClock>) -> Option<ErrorDetail> {
    let clock = clock?;
    if clock.physical_ms < 0 || clock.logical < 0 {
        return Some(error_detail(
            "INVALID_EVENT_CLOCK",
            "Mutation event clock values must be zero or greater.",
            None,
        ));
    }
    let generation = clock.device_generation_id.trim();
    if generation.is_empty()
        || generation.len() > 256
        || generation != clock.device_generation_id
        || generation.chars().any(char::is_control)
    {
        return Some(error_detail(
            "INVALID_EVENT_CLOCK",
            "Mutation device generation is invalid.",
            None,
        ));
    }
    None
}

fn validate_scoped_suwayomi_id(
    scope_id: &str,
    entity_id: &str,
    marker: &str,
) -> Option<ErrorDetail> {
    let expected_profile = scope_id.strip_prefix("comics:profile:").unwrap_or_default();
    match parse_scoped_suwayomi_id(entity_id, marker) {
        Some((profile_id, _)) if profile_id == expected_profile => None,
        _ => Some(error_detail(
            "INVALID_SUWAYOMI_ENTITY_ID",
            "Comic entity identity must belong to the authenticated Suwayomi profile.",
            Some(json!({
                "entityId": entity_id,
                "scopeId": scope_id,
                "expectedMarker": marker,
            })),
        )),
    }
}

fn parse_scoped_suwayomi_id<'a>(entity_id: &'a str, marker: &str) -> Option<(&'a str, i64)> {
    let profile_and_remote = if let Some(value) = entity_id.strip_prefix("suwayomi:profile:") {
        value
    } else {
        let value = entity_id.strip_prefix("suwayomi:server:")?;
        let profile_marker = value.find(":profile:")?;
        if profile_marker == 0 {
            return None;
        }
        &value[profile_marker + ":profile:".len()..]
    };
    let remote_marker = profile_and_remote.rfind(marker)?;
    let profile_id = &profile_and_remote[..remote_marker];
    if profile_id.is_empty() {
        return None;
    }
    let remote_id = profile_and_remote[remote_marker + marker.len()..]
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0 && *value <= i32::MAX as i64)?;
    Some((profile_id, remote_id))
}

fn superseded_result(
    mutation: &MutationInput,
    record: Value,
    winning_clock: EventClock,
    server_version: i64,
    applied_lamport: i64,
) -> MutationResult {
    let base = mutation.base();
    MutationResult {
        client_mutation_id: base.client_mutation_id.clone(),
        entity_type: mutation.entity_type(),
        entity_id: base.entity_id.clone(),
        canonical_entity_id: None,
        scope_id: base.scope_id.clone(),
        op: base.op,
        status: MutationResultStatus::Superseded,
        applied_server_version: Some(server_version),
        applied_lamport: Some(applied_lamport),
        event_clock: Some(winning_clock),
        record: Some(record),
        error: None,
    }
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
        event_clock: base.event_clock.clone(),
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

fn novel_chapter_asset_reference_error_detail(error: AssetReferenceError) -> ErrorDetail {
    match error {
        AssetReferenceError::InvalidSha256 => error_detail(
            "INVALID_ASSET_SHA256",
            "Novel chapter asset blobSha256 is invalid.",
            None,
        ),
        AssetReferenceError::NotAvailableForScope => error_detail(
            "ASSET_NOT_AVAILABLE_FOR_SCOPE",
            "The chapter archive must be uploaded and granted to this novel scope before publication.",
            None,
        ),
        AssetReferenceError::SizeMismatch => error_detail(
            "ASSET_SIZE_MISMATCH",
            "Novel chapter asset byteLength does not match the stored blob.",
            None,
        ),
        AssetReferenceError::Storage => error_detail(
            "ASSET_VALIDATION_UNAVAILABLE",
            "The Core could not validate the stored chapter archive.",
            None,
        ),
    }
}

fn book_asset_reference_error_detail(error: AssetReferenceError) -> ErrorDetail {
    match error {
        AssetReferenceError::InvalidSha256 => error_detail(
            "INVALID_ASSET_SHA256",
            "Book assetFingerprint is invalid.",
            None,
        ),
        AssetReferenceError::NotAvailableForScope => error_detail(
            "BOOK_ASSET_NOT_AVAILABLE_FOR_SCOPE",
            "The book file must be uploaded to this Books scope before publication.",
            None,
        ),
        AssetReferenceError::SizeMismatch => error_detail(
            "BOOK_ASSET_SIZE_MISMATCH",
            "Book byteSize does not match the stored blob.",
            None,
        ),
        AssetReferenceError::Storage => error_detail(
            "ASSET_VALIDATION_UNAVAILABLE",
            "The Core could not validate the stored book file.",
            None,
        ),
    }
}

fn book_cover_asset_reference_error_detail(error: AssetReferenceError) -> ErrorDetail {
    match error {
        AssetReferenceError::InvalidSha256 => error_detail(
            "INVALID_BOOK_COVER_ASSET_SHA256",
            "Book cover asset SHA-256 is invalid.",
            None,
        ),
        AssetReferenceError::NotAvailableForScope => error_detail(
            "BOOK_COVER_ASSET_NOT_AVAILABLE_FOR_SCOPE",
            "Book cover asset must be uploaded for the Books scope before its entry is published.",
            None,
        ),
        AssetReferenceError::SizeMismatch => error_detail(
            "BOOK_COVER_ASSET_SIZE_MISMATCH",
            "Book cover asset size does not match the published blob.",
            None,
        ),
        AssetReferenceError::Storage => error_detail(
            "BOOK_COVER_ASSET_STORAGE_UNAVAILABLE",
            "Book cover asset storage is temporarily unavailable.",
            None,
        ),
    }
}

fn book_identity_conflict_error_detail(error: db::BookEntryIdentityConflict) -> ErrorDetail {
    let field = match error {
        db::BookEntryIdentityConflict::AssetFingerprint => "assetFingerprint",
        db::BookEntryIdentityConflict::MimeType => "mimeType",
        db::BookEntryIdentityConflict::ByteSize => "byteSize",
        db::BookEntryIdentityConflict::Subtype => "subtype",
    };
    error_detail(
        "BOOK_IDENTITY_IMMUTABLE",
        "A synchronized book cannot change its immutable file identity.",
        Some(json!({ "field": field })),
    )
}

fn book_entry_persist_error_detail(error: anyhow::Error) -> Option<ErrorDetail> {
    let message = error.to_string();
    if message.contains("stale book entry mutation rejected by tombstone lamport") {
        Some(error_detail(
            "STALE_BOOK_ENTRY_MUTATION",
            "Book entry mutation is older than its deletion tombstone.",
            None,
        ))
    } else {
        None
    }
}

fn novel_chapter_asset_persist_error_detail(error: anyhow::Error) -> Option<ErrorDetail> {
    let message = error.to_string();
    if message.contains("stale novel chapter asset mutation") {
        Some(error_detail(
            "STALE_NOVEL_CHAPTER_ASSET_MUTATION",
            "Novel chapter asset mutation is older than its deletion tombstone.",
            None,
        ))
    } else if message.contains("references missing novel") {
        Some(error_detail(
            "NOVEL_NOT_FOUND",
            "Novel chapter asset references a novel that is not active.",
            None,
        ))
    } else if message.contains("references missing chapter") {
        Some(error_detail(
            "NOVEL_CHAPTER_NOT_FOUND",
            "Novel chapter asset references a chapter that is not active.",
            None,
        ))
    } else if message.contains("chapter belongs to another novel") {
        Some(error_detail(
            "NOVEL_CHAPTER_OWNER_MISMATCH",
            "Novel chapter asset chapterId does not belong to novelId.",
            None,
        ))
    } else if message.contains("parent identity is immutable") {
        Some(error_detail(
            "PARENT_ID_MISMATCH",
            "Novel chapter asset parent identity cannot be changed.",
            None,
        ))
    } else if message.contains("FOREIGN KEY constraint failed") {
        Some(error_detail(
            "NOVEL_CHAPTER_ASSET_REFERENCE_INVALID",
            "Novel chapter asset references are no longer active.",
            None,
        ))
    } else {
        None
    }
}

fn novel_plugin_persist_error_detail(error: anyhow::Error) -> ErrorDetail {
    let message = error.to_string();
    if message.contains("stale") && message.contains("tombstone") {
        error_detail("STALE_NOVEL_PLUGIN_MUTATION", &message, None)
    } else if message.contains("repository does not exist") {
        error_detail("NOVEL_REPOSITORY_NOT_FOUND", &message, None)
    } else if message.contains("still has active plugins") {
        error_detail("NOVEL_REPOSITORY_PLUGINS_EXIST", &message, None)
    } else if message.contains("artifact is immutable") {
        error_detail("PLUGIN_ARTIFACT_IMMUTABLE", &message, None)
    } else if message.contains("identity is immutable") {
        error_detail("PLUGIN_IDENTITY_IMMUTABLE", &message, None)
    } else if message.contains("alias already belongs") {
        error_detail("ENTITY_ALIAS_CONFLICT", &message, None)
    } else if message.contains("UNIQUE constraint failed") {
        error_detail("NOVEL_PLUGIN_IDENTITY_EXISTS", &message, None)
    } else if message.contains("FOREIGN KEY constraint failed") {
        error_detail("NOVEL_PLUGIN_REFERENCE_INVALID", &message, None)
    } else {
        error_detail("NOVEL_PLUGIN_MUTATION_REJECTED", &message, None)
    }
}

fn comic_state_persist_error_detail(error: anyhow::Error) -> Option<ErrorDetail> {
    let message = error.to_string();
    if message.contains("stale bookmark mutation rejected by tombstone lamport") {
        Some(error_detail("STALE_COMIC_STATE_MUTATION", &message, None))
    } else if message.contains("parent comic_id") {
        Some(error_detail("PARENT_ID_MISMATCH", &message, None))
    } else if message.contains("must match entity_id") {
        Some(error_detail("ENTITY_ID_MISMATCH", &message, None))
    } else {
        None
    }
}

fn novel_category_persist_error_detail(error: anyhow::Error) -> Option<ErrorDetail> {
    let message = error.to_string();
    if message.contains("stale novel category mutation rejected by tombstone lamport") {
        Some(error_detail(
            "STALE_NOVEL_CATEGORY_MUTATION",
            &message,
            None,
        ))
    } else if message.contains("references missing novel") {
        Some(error_detail("NOVEL_NOT_FOUND", &message, None))
    } else if message.contains("references missing category") {
        Some(error_detail("NOVEL_CATEGORY_NOT_FOUND", &message, None))
    } else if message.contains("still referenced by active") {
        Some(error_detail(
            "NOVEL_CATEGORY_ASSIGNMENTS_EXIST",
            &message,
            None,
        ))
    } else if message.contains("must match entity_id") {
        Some(error_detail("ENTITY_ID_MISMATCH", &message, None))
    } else if message.contains("UNIQUE constraint failed") {
        Some(error_detail(
            "NOVEL_CATEGORY_ASSIGNMENT_EXISTS",
            "A novel category assignment already exists for this novel and category.",
            None,
        ))
    } else if message.contains("FOREIGN KEY constraint failed") {
        Some(error_detail(
            "NOVEL_CATEGORY_REFERENCE_INVALID",
            "Novel category assignment references are no longer active.",
            None,
        ))
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

    #[test]
    fn portable_novel_progress_requires_ids_derived_from_opaque_refs() {
        let work = PortableWorkRefV3::Novel {
            plugin_id: "lnreader.plugin".to_string(),
            novel_key: "/Novel/KeepCase?token=A%2FB".to_string(),
        };
        let chapter = PortableChapterRefV3::Novel {
            work: work.clone(),
            chapter_key: "/Chapter/KeepCase".to_string(),
        };
        let patch = NovelProgressPatch {
            chapter_id: Some(canonical_portable_chapter_id(&chapter)),
            portable_work_ref: Some(work.clone()),
            portable_chapter_ref: Some(chapter),
            chapter_title: None,
            chapter_order_key: Some(1.0),
            progress_percent: 0.5,
            locator: Some("block:1:2".to_string()),
            locator_sort_key: Some(2.0),
            updated_at_ms: 1,
            reset: false,
        };

        assert!(
            validate_novel_portable_identity(&canonical_portable_work_id(&work), &patch,).is_none()
        );
        assert!(validate_novel_portable_identity("novel:local-id", &patch).is_some());
    }

    #[test]
    fn plugin_sync_v1_rejects_every_non_empty_public_settings_object() {
        for settings in [
            json!({"accountPin": "1234"}),
            json!({"header": "short-public-looking-value"}),
            json!({"theme": "sepia"}),
        ] {
            assert_eq!(
                validate_syncable_public_settings(&settings)
                    .unwrap_err()
                    .code,
                "PUBLIC_SETTINGS_NOT_SYNCABLE"
            );
        }
        assert!(validate_syncable_public_settings(&json!({})).is_ok());
    }

    #[test]
    fn public_plugin_settings_defense_in_depth_rejects_secret_values() {
        for settings in [
            json!({"apiKey": "value"}),
            json!({"nested": {"session_id": "value"}}),
            json!({"header": "Bearer abcdef"}),
            json!({"header": "Cookie: sid=value"}),
            json!({"header": "abcdefgh.ijklmnop.qrstuvwx"}),
            json!({"payload": "a".repeat(128)}),
        ] {
            assert_eq!(
                validate_public_settings(&settings).unwrap_err().code,
                "SECRET_SETTING_REJECTED"
            );
        }
    }

    #[test]
    fn public_plugin_settings_enforce_shape_and_complexity_limits() {
        assert_eq!(
            validate_public_settings(&json!(["not-an-object"]))
                .unwrap_err()
                .code,
            "INVALID_PUBLIC_SETTINGS"
        );
        let mut nested = json!(true);
        for _ in 0..10 {
            nested = json!({"public": nested});
        }
        assert_eq!(
            validate_public_settings(&nested).unwrap_err().code,
            "PUBLIC_SETTINGS_COMPLEXITY_LIMIT"
        );
    }

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
            &["books:global", "novels:profile:main", "comics:profile:main"],
        )
        .await
        .unwrap();
        ensure_test_token(
            &pool,
            "device-test",
            "test",
            &token_hash("test-token"),
            &["books:global", "novels:profile:test", "comics:profile:test"],
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

    async fn upload_asset(
        app: &axum::Router,
        token: &str,
        scope_query: &str,
        bytes: &[u8],
    ) -> String {
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let mut builder = Request::builder()
            .method("PUT")
            .uri(format!("/v1/assets/{sha256}?scopeId={scope_query}"));
        for (key, value) in auth_headers(token) {
            builder = builder.header(key, value);
        }
        let response = app
            .clone()
            .oneshot(
                builder
                    .header("content-length", bytes.len().to_string())
                    .body(Body::from(bytes.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        sha256
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

    fn book_entry_request(
        client_mutation_id: &str,
        asset_fingerprint: Option<&str>,
        byte_size: Option<usize>,
    ) -> Value {
        json!({
            "requestId": format!("request-{client_mutation_id}"),
            "mutations": [{
                "entityType": "book.entry",
                "clientMutationId": client_mutation_id,
                "scopeId": "books:global",
                "entityId": asset_fingerprint
                    .map(|sha256| format!("epub:sha256:{sha256}"))
                    .unwrap_or_else(|| "legacy-book".to_string()),
                "lamport": 1,
                "patch": {
                    "assetFingerprint": asset_fingerprint,
                    "mimeType": "application/epub+zip",
                    "byteSize": byte_size,
                    "coverAssetSha256": null,
                    "coverAssetByteSize": null,
                    "coverAssetMimeType": null,
                    "title": "Epigraph fixture book",
                    "author": "Epigraph",
                    "description": null,
                    "subtype": "epub",
                    "pageCount": null,
                    "tocCount": null,
                    "spineCount": null,
                    "sectionCount": null,
                    "sectionsSummaryJson": null,
                    "hasCover": false,
                    "createdAtMs": 1000,
                    "bookUpdatedAtMs": 1000
                }
            }]
        })
    }

    #[tokio::test]
    async fn book_entry_requires_complete_published_asset_reference() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);
        let bytes = b"immutable epub bytes";
        let sha256 = format!("{:x}", Sha256::digest(bytes));

        let missing = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                book_entry_request("book-before-upload", Some(&sha256), Some(bytes.len())),
            ))
            .await
            .unwrap();
        let missing = json_body(missing).await;
        assert_eq!(missing["results"][0]["status"], "rejected");
        assert_eq!(
            missing["results"][0]["error"]["code"],
            "BOOK_ASSET_NOT_AVAILABLE_FOR_SCOPE"
        );

        let incomplete = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                book_entry_request("book-incomplete", Some(&sha256), None),
            ))
            .await
            .unwrap();
        let incomplete = json_body(incomplete).await;
        assert_eq!(incomplete["results"][0]["status"], "rejected");
        assert_eq!(
            incomplete["results"][0]["error"]["code"],
            "INCOMPLETE_BOOK_ASSET_REFERENCE"
        );

        let uploaded = upload_asset(&app, "main-token", "books%3Aglobal", bytes).await;
        assert_eq!(uploaded, sha256);
        let accepted = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                book_entry_request("book-after-upload", Some(&sha256), Some(bytes.len())),
            ))
            .await
            .unwrap();
        let accepted = json_body(accepted).await;
        assert_eq!(accepted["results"][0]["status"], "applied");
        assert_eq!(accepted["results"][0]["record"]["assetFingerprint"], sha256);

        let mut metadata_only =
            book_entry_request("book-metadata-only", Some(&sha256), Some(bytes.len()));
        metadata_only["mutations"][0]["patch"]["assetFingerprint"] = Value::Null;
        metadata_only["mutations"][0]["patch"]["mimeType"] = Value::Null;
        metadata_only["mutations"][0]["patch"]["byteSize"] = Value::Null;
        metadata_only["mutations"][0]["patch"]["title"] = json!("Updated title");
        let metadata_only = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                metadata_only,
            ))
            .await
            .unwrap();
        let metadata_only = json_body(metadata_only).await;
        assert_eq!(metadata_only["results"][0]["status"], "applied");
        assert_eq!(
            metadata_only["results"][0]["record"]["assetFingerprint"],
            sha256
        );

        let mut conflicting =
            book_entry_request("book-conflicting-subtype", Some(&sha256), Some(bytes.len()));
        conflicting["mutations"][0]["patch"]["assetFingerprint"] = Value::Null;
        conflicting["mutations"][0]["patch"]["mimeType"] = Value::Null;
        conflicting["mutations"][0]["patch"]["byteSize"] = Value::Null;
        conflicting["mutations"][0]["patch"]["subtype"] = json!("pdf");
        let conflicting = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                conflicting,
            ))
            .await
            .unwrap();
        let conflicting = json_body(conflicting).await;
        assert_eq!(conflicting["results"][0]["status"], "rejected");
        assert_eq!(
            conflicting["results"][0]["error"]["code"],
            "BOOK_IDENTITY_IMMUTABLE"
        );

        let book_id = format!("epub:sha256:{sha256}");
        let deleted = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "delete-book-entry",
                    "mutations": [{
                        "entityType": "book.entry",
                        "clientMutationId": "delete-book-entry-1",
                        "scopeId": "books:global",
                        "entityId": book_id,
                        "op": "delete",
                        "lamport": 10
                    }]
                }),
            ))
            .await
            .unwrap();
        let deleted = json_body(deleted).await;
        assert_eq!(deleted["results"][0]["status"], "applied");

        let mut stale =
            book_entry_request("stale-book-resurrection", Some(&sha256), Some(bytes.len()));
        stale["mutations"][0]["lamport"] = json!(10);
        let stale = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", stale))
            .await
            .unwrap();
        let stale = json_body(stale).await;
        assert_eq!(stale["results"][0]["status"], "rejected");
        assert_eq!(
            stale["results"][0]["error"]["code"],
            "STALE_BOOK_ENTRY_MUTATION"
        );

        let mut newer =
            book_entry_request("newer-book-resurrection", Some(&sha256), Some(bytes.len()));
        newer["mutations"][0]["lamport"] = json!(11);
        let newer = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", newer))
            .await
            .unwrap();
        let newer = json_body(newer).await;
        assert_eq!(newer["results"][0]["status"], "applied");

        let snapshot = app
            .clone()
            .oneshot(request_without_body(
                "/v1/snapshot?scopeId=books%3Aglobal",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let snapshot = json_body(snapshot).await;
        assert!(snapshot["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "book.entry" && entity["entityId"] == book_id
            }));
        assert!(!snapshot["tombstones"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tombstone| {
                tombstone["entityType"] == "book.entry" && tombstone["entityId"] == book_id
            }));
    }

    #[tokio::test]
    async fn book_cover_requires_atomic_supported_published_asset_reference() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);
        let publication = b"immutable epub with a cover";
        let publication_sha = upload_asset(&app, "main-token", "books%3Aglobal", publication).await;
        let cover = b"\x89PNG\r\n\x1a\nminimal-cover";
        let cover_sha = format!("{:x}", Sha256::digest(cover));

        let mut incomplete = book_entry_request(
            "book-cover-incomplete",
            Some(&publication_sha),
            Some(publication.len()),
        );
        incomplete["mutations"][0]["patch"]["coverAssetSha256"] = json!(cover_sha);
        incomplete["mutations"][0]["patch"]["hasCover"] = json!(true);
        let incomplete = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", incomplete))
            .await
            .unwrap();
        let incomplete = json_body(incomplete).await;
        assert_eq!(
            incomplete["results"][0]["error"]["code"],
            "INCOMPLETE_BOOK_COVER_ASSET_REFERENCE"
        );

        let mut unsupported = book_entry_request(
            "book-cover-unsupported",
            Some(&publication_sha),
            Some(publication.len()),
        );
        unsupported["mutations"][0]["patch"]["coverAssetSha256"] = json!(cover_sha);
        unsupported["mutations"][0]["patch"]["coverAssetByteSize"] = json!(cover.len());
        unsupported["mutations"][0]["patch"]["coverAssetMimeType"] = json!("image/gif");
        unsupported["mutations"][0]["patch"]["hasCover"] = json!(true);
        let unsupported = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                unsupported,
            ))
            .await
            .unwrap();
        let unsupported = json_body(unsupported).await;
        assert_eq!(
            unsupported["results"][0]["error"]["code"],
            "INVALID_BOOK_COVER_MIME_TYPE"
        );

        let mut missing = book_entry_request(
            "book-cover-missing",
            Some(&publication_sha),
            Some(publication.len()),
        );
        missing["mutations"][0]["patch"]["coverAssetSha256"] = json!(cover_sha);
        missing["mutations"][0]["patch"]["coverAssetByteSize"] = json!(cover.len());
        missing["mutations"][0]["patch"]["coverAssetMimeType"] = json!("image/png");
        missing["mutations"][0]["patch"]["hasCover"] = json!(true);
        let missing = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", missing))
            .await
            .unwrap();
        let missing = json_body(missing).await;
        assert_eq!(
            missing["results"][0]["error"]["code"],
            "BOOK_COVER_ASSET_NOT_AVAILABLE_FOR_SCOPE"
        );

        let uploaded_cover = upload_asset(&app, "main-token", "books%3Aglobal", cover).await;
        assert_eq!(uploaded_cover, cover_sha);
        let mut wrong_size = book_entry_request(
            "book-cover-wrong-size",
            Some(&publication_sha),
            Some(publication.len()),
        );
        wrong_size["mutations"][0]["patch"]["coverAssetSha256"] = json!(cover_sha);
        wrong_size["mutations"][0]["patch"]["coverAssetByteSize"] = json!(cover.len() + 1);
        wrong_size["mutations"][0]["patch"]["coverAssetMimeType"] = json!("image/png");
        wrong_size["mutations"][0]["patch"]["hasCover"] = json!(true);
        let wrong_size = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", wrong_size))
            .await
            .unwrap();
        let wrong_size = json_body(wrong_size).await;
        assert_eq!(
            wrong_size["results"][0]["error"]["code"],
            "BOOK_COVER_ASSET_SIZE_MISMATCH"
        );

        let mut accepted = book_entry_request(
            "book-cover-accepted",
            Some(&publication_sha),
            Some(publication.len()),
        );
        accepted["mutations"][0]["patch"]["coverAssetSha256"] = json!(cover_sha);
        accepted["mutations"][0]["patch"]["coverAssetByteSize"] = json!(cover.len());
        accepted["mutations"][0]["patch"]["coverAssetMimeType"] = json!("image/png");
        accepted["mutations"][0]["patch"]["hasCover"] = json!(true);
        let accepted = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", accepted))
            .await
            .unwrap();
        let accepted = json_body(accepted).await;
        assert_eq!(accepted["results"][0]["status"], "applied");
        let record = &accepted["results"][0]["record"];
        assert_eq!(record["coverAssetSha256"], cover_sha);
        assert_eq!(record["coverAssetByteSize"], cover.len());
        assert_eq!(record["coverAssetMimeType"], "image/png");
        assert!(record.get("coverPath").is_none());
        assert!(record.get("assetPath").is_none());
        assert!(record.get("privatePath").is_none());
    }

    #[tokio::test]
    async fn novel_repository_plugin_alias_receipt_snapshot_and_parent_delete_contract() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let artifact = b"module.exports = { id: 'synthetic' };";
        let artifact_sha = format!("{:x}", Sha256::digest(artifact));

        let repository_request = json!({
            "requestId": "req-repository",
            "mutations": [{
                "entityType": "novel.repository",
                "clientMutationId": "repository-merge-1",
                "scopeId": "novels:profile:main",
                "entityId": "mobile-repository-alias",
                "lamport": 1,
                "patch": {
                    "canonicalUrl": "HTTPS://Example.COM:443/repository.json",
                    "name": "  Official repository  ",
                    "enabled": true,
                    "createdAtMs": 1000,
                    "updatedAtMs": 1000
                }
            }]
        });
        let first_repository = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                repository_request.clone(),
            ))
            .await
            .unwrap();
        let first_repository = json_body(first_repository).await;
        assert_eq!(first_repository["results"][0]["status"], "applied");
        assert_eq!(
            first_repository["results"][0]["record"]["name"],
            "Official repository"
        );
        let repository_id = first_repository["results"][0]["canonicalEntityId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            repository_id,
            canonical_novel_repository_id("https://example.com/repository.json")
        );
        let repository_version = first_repository["currentServerVersion"].as_i64().unwrap();

        let replay = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                repository_request,
            ))
            .await
            .unwrap();
        let replay = json_body(replay).await;
        assert_eq!(replay["currentServerVersion"], repository_version);
        assert_eq!(replay["results"][0], first_repository["results"][0]);

        let plugin_request = json!({
            "requestId": "req-plugin",
            "mutations": [{
                "entityType": "novel.plugin",
                "clientMutationId": "plugin-merge-1",
                "scopeId": "novels:profile:main",
                "entityId": "mobile-plugin-alias",
                "lamport": 1,
                "patch": {
                    "repositoryId": "mobile-repository-alias",
                    "pluginId": "synthetic.plugin",
                    "sourceId": "synthetic.source",
                    "name": "  Synthetic plugin  ",
                    "version": "  1.0.0  ",
                    "lang": "  en  ",
                    "enabled": true,
                    "artifactSha256": artifact_sha,
                    "artifactByteLength": artifact.len(),
                    "publicSettings": {},
                    "createdAtMs": 1000,
                    "updatedAtMs": 1000
                }
            }]
        });
        let plugin = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                plugin_request,
            ))
            .await
            .unwrap();
        let plugin = json_body(plugin).await;
        assert_eq!(plugin["results"][0]["status"], "applied");
        assert_eq!(plugin["results"][0]["record"]["name"], "Synthetic plugin");
        assert_eq!(plugin["results"][0]["record"]["version"], "1.0.0");
        assert_eq!(plugin["results"][0]["record"]["lang"], "en");
        let plugin_id = plugin["results"][0]["canonicalEntityId"]
            .as_str()
            .unwrap()
            .to_string();
        let plugin_version = plugin["results"][0]["appliedServerVersion"]
            .as_i64()
            .unwrap();

        let changes = app
            .clone()
            .oneshot(request_without_body(
                &format!(
                    "/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion={repository_version}"
                ),
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let changes = json_body(changes).await;
        assert!(changes["changes"].as_array().unwrap().iter().any(|change| {
            change["entityType"] == "novel.plugin" && change["entityId"] == plugin_id
        }));
        let events = app
            .clone()
            .oneshot(request_without_body(
                "/v1/events?scopeId=novels%3Aprofile%3Amain",
                "main-token",
                Some(plugin_version - 1),
            ))
            .await
            .unwrap();
        let events = collect_sse_change_events(events, 1).await;
        assert_eq!(events[0]["entityType"], "novel.plugin");
        assert_eq!(events[0]["entityId"], plugin_id);

        let snapshot = app
            .clone()
            .oneshot(request_without_body(
                "/v1/snapshot?scopeId=novels%3Aprofile%3Amain",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let snapshot = json_body(snapshot).await;
        assert!(snapshot["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "novel.repository" && entity["entityId"] == repository_id
            }));
        assert!(snapshot["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "novel.plugin" && entity["entityId"] == plugin_id
            }));

        let blocked_delete = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-delete-repository-blocked",
                    "mutations": [{
                        "entityType": "novel.repository",
                        "clientMutationId": "repository-delete-blocked",
                        "scopeId": "novels:profile:main",
                        "entityId": "mobile-repository-alias",
                        "op": "delete",
                        "lamport": 2
                    }]
                }),
            ))
            .await
            .unwrap();
        let blocked_delete = json_body(blocked_delete).await;
        assert_eq!(
            blocked_delete["results"][0]["error"]["code"],
            "NOVEL_REPOSITORY_PLUGINS_EXIST"
        );

        let deleted_plugin = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-delete-plugin",
                    "mutations": [{
                        "entityType": "novel.plugin",
                        "clientMutationId": "plugin-delete-1",
                        "scopeId": "novels:profile:main",
                        "entityId": "mobile-plugin-alias",
                        "op": "delete",
                        "lamport": 2
                    }]
                }),
            ))
            .await
            .unwrap();
        let deleted_plugin = json_body(deleted_plugin).await;
        assert_eq!(deleted_plugin["results"][0]["status"], "applied");
        assert_eq!(deleted_plugin["results"][0]["canonicalEntityId"], plugin_id);

        let stale_restore = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "req-stale-plugin",
                    "mutations": [{
                        "entityType": "novel.plugin",
                        "clientMutationId": "plugin-stale-restore",
                        "scopeId": "novels:profile:main",
                        "entityId": "mobile-plugin-alias",
                        "lamport": 1,
                        "patch": {
                            "repositoryId": "mobile-repository-alias",
                            "pluginId": "synthetic.plugin",
                            "sourceId": "synthetic.source",
                            "name": "Synthetic plugin",
                            "version": "1.0.0",
                            "lang": "en",
                            "enabled": true,
                            "artifactSha256": artifact_sha,
                            "artifactByteLength": artifact.len(),
                            "publicSettings": {},
                            "createdAtMs": 1000,
                            "updatedAtMs": 1000
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        let stale_restore = json_body(stale_restore).await;
        assert_eq!(
            stale_restore["results"][0]["error"]["code"],
            "STALE_NOVEL_PLUGIN_MUTATION"
        );
    }

    #[tokio::test]
    async fn novel_plugin_evidence_requires_exact_hash_size_and_is_immutable_per_version() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let repository_id = canonical_novel_repository_id("https://example.com/repository.json");
        let repository = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "asset-repository",
                    "mutations": [{
                        "entityType": "novel.repository",
                        "clientMutationId": "asset-repository-merge",
                        "scopeId": "novels:profile:main",
                        "entityId": repository_id,
                        "lamport": 1,
                        "patch": {
                            "canonicalUrl": "https://example.com/repository.json",
                            "name": "Repository",
                            "enabled": true,
                            "createdAtMs": 1,
                            "updatedAtMs": 1
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(repository).await["results"][0]["status"],
            "applied"
        );

        let first_sha = format!("{:x}", Sha256::digest(b"scoped plugin"));
        let cases = [
            (
                "invalid-hash",
                "A".repeat(64),
                1usize,
                "INVALID_ASSET_SHA256",
            ),
            (
                "empty",
                first_sha.clone(),
                0usize,
                "INVALID_PLUGIN_ARTIFACT_SIZE",
            ),
        ];
        for (suffix, sha, size, expected_code) in cases {
            let response = app
                .clone()
                .oneshot(request_with_json(
                    "/v1/mutations",
                    "main-token",
                    json!({
                        "requestId": format!("asset-{suffix}"),
                        "mutations": [{
                            "entityType": "novel.plugin",
                            "clientMutationId": format!("asset-plugin-{suffix}"),
                            "scopeId": "novels:profile:main",
                            "entityId": format!("alias-{suffix}"),
                            "lamport": 1,
                            "patch": {
                                "repositoryId": repository_id,
                                "pluginId": format!("plugin.{suffix}"),
                                "sourceId": format!("source.{suffix}"),
                                "name": "Synthetic",
                                "version": "1.0.0",
                                "lang": "en",
                                "enabled": true,
                                "artifactSha256": sha,
                                "artifactByteLength": size,
                                "publicSettings": {},
                                "createdAtMs": 1,
                                "updatedAtMs": 1
                            }
                        }]
                    }),
                ))
                .await
                .unwrap();
            let response = json_body(response).await;
            assert_eq!(response["results"][0]["error"]["code"], expected_code);
        }

        let plugin_id = canonical_novel_plugin_id(&repository_id, "plugin.immutable", "source");
        let valid_patch = |sha: &str, size: usize, client_id: &str, version: &str, lamport: i64| {
            json!({
                "requestId": client_id,
                "mutations": [{
                    "entityType": "novel.plugin",
                    "clientMutationId": client_id,
                    "scopeId": "novels:profile:main",
                    "entityId": plugin_id,
                    "lamport": lamport,
                    "patch": {
                        "repositoryId": repository_id,
                        "pluginId": "plugin.immutable",
                        "sourceId": "source",
                        "name": "Immutable",
                        "version": version,
                        "lang": "en",
                        "enabled": true,
                        "artifactSha256": sha,
                        "artifactByteLength": size,
                        "publicSettings": {},
                        "createdAtMs": 1,
                        "updatedAtMs": 2
                    }
                }]
            })
        };
        let valid = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                valid_patch(&first_sha, 13, "immutable-first", "1.0.0", 2),
            ))
            .await
            .unwrap();
        assert_eq!(json_body(valid).await["results"][0]["status"], "applied");
        let replacement_sha = format!("{:x}", Sha256::digest(b"replacement plugin"));
        let replaced = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                valid_patch(&replacement_sha, 18, "immutable-second", "1.0.0", 3),
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(replaced).await["results"][0]["error"]["code"],
            "PLUGIN_ARTIFACT_IMMUTABLE"
        );

        let upgraded = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                valid_patch(&replacement_sha, 18, "immutable-upgrade", "2.0.0", 4),
            ))
            .await
            .unwrap();
        assert_eq!(json_body(upgraded).await["results"][0]["status"], "applied");
        let rollback = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                valid_patch(&first_sha, 13, "immutable-rollback", "1.0.0", 5),
            ))
            .await
            .unwrap();
        assert_eq!(json_body(rollback).await["results"][0]["status"], "applied");

        let forged_sha = format!("{:x}", Sha256::digest(b"forged old version"));
        let forged_old_version = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                valid_patch(&forged_sha, 18, "immutable-forged-old-version", "1.0.0", 6),
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(forged_old_version).await["results"][0]["error"]["code"],
            "PLUGIN_ARTIFACT_IMMUTABLE"
        );
    }

    #[tokio::test]
    async fn concurrent_repository_aliases_converge_to_one_canonical_record() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let mutation = |alias: &str, client_id: &str, name: &str| {
            request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": format!("request-{client_id}"),
                    "mutations": [{
                        "entityType": "novel.repository",
                        "clientMutationId": client_id,
                        "scopeId": "novels:profile:main",
                        "entityId": alias,
                        "lamport": 1,
                        "patch": {
                            "canonicalUrl": "https://example.com/concurrent.json",
                            "name": name,
                            "enabled": true,
                            "createdAtMs": 1,
                            "updatedAtMs": 1
                        }
                    }]
                }),
            )
        };
        let first = app
            .clone()
            .oneshot(mutation("alias-one", "concurrent-one", "One"));
        let second = app
            .clone()
            .oneshot(mutation("alias-two", "concurrent-two", "Two"));
        let (first, second) = tokio::join!(first, second);
        let first = json_body(first.unwrap()).await;
        let second = json_body(second.unwrap()).await;
        let expected = canonical_novel_repository_id("https://example.com/concurrent.json");
        assert_eq!(first["results"][0]["canonicalEntityId"], expected);
        assert_eq!(second["results"][0]["canonicalEntityId"], expected);
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM novel_repositories WHERE scope_id = 'novels:profile:main'",
        )
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn deleted_repository_alias_cannot_rebind_to_another_url() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let alias = "stable-mobile-alias";
        let first_url = "https://example.com/first.json";
        let second_url = "https://example.com/second.json";
        let first_id = canonical_novel_repository_id(first_url);
        let second_id = canonical_novel_repository_id(second_url);

        let merged = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "alias-first-merge",
                    "mutations": [{
                        "entityType": "novel.repository",
                        "clientMutationId": "alias-first-merge",
                        "scopeId": "novels:profile:main",
                        "entityId": alias,
                        "lamport": 1,
                        "patch": {
                            "canonicalUrl": first_url,
                            "name": "First",
                            "enabled": true,
                            "createdAtMs": 1,
                            "updatedAtMs": 1
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(json_body(merged).await["results"][0]["status"], "applied");

        let deleted = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "alias-first-delete",
                    "mutations": [{
                        "entityType": "novel.repository",
                        "clientMutationId": "alias-first-delete",
                        "scopeId": "novels:profile:main",
                        "entityId": alias,
                        "op": "delete",
                        "lamport": 2
                    }]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(json_body(deleted).await["results"][0]["status"], "applied");

        let rebound = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "alias-rebind",
                    "mutations": [{
                        "entityType": "novel.repository",
                        "clientMutationId": "alias-rebind",
                        "scopeId": "novels:profile:main",
                        "entityId": alias,
                        "lamport": 3,
                        "patch": {
                            "canonicalUrl": second_url,
                            "name": "Second",
                            "enabled": true,
                            "createdAtMs": 1,
                            "updatedAtMs": 3
                        }
                    }]
                }),
            ))
            .await
            .unwrap();
        let rebound = json_body(rebound).await;
        assert_eq!(rebound["results"][0]["status"], "rejected");
        assert_eq!(
            rebound["results"][0]["error"]["code"],
            "REPOSITORY_IDENTITY_CONFLICT"
        );

        let snapshot = app
            .clone()
            .oneshot(request_without_body(
                "/v1/snapshot?scopeId=novels%3Aprofile%3Amain",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let snapshot = json_body(snapshot).await;
        assert!(!snapshot["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "novel.repository"
                    && (entity["entityId"] == first_id || entity["entityId"] == second_id)
            }));
        assert!(snapshot["tombstones"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tombstone| {
                tombstone["entityType"] == "novel.repository" && tombstone["entityId"] == first_id
            },));
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

    fn comic_state_batch(request_id: &str) -> Value {
        json!({
            "requestId": request_id,
            "mutations": [
                {
                    "entityType": "comic.history",
                    "clientMutationId": "comic-history-1",
                    "scopeId": "comics:profile:main",
                    "entityId": "comic.history::suwayomi:server-main:manga:42",
                    "lamport": 1,
                    "patch": {
                        "historyId": "comic.history::suwayomi:server-main:manga:42",
                        "comicId": "suwayomi:server-main:manga:42",
                        "chapterId": "chapter-7",
                        "pageIndex": 4,
                        "pageCount": 20,
                        "progressPercent": 0.25,
                        "readAtMs": 1000
                    }
                },
                {
                    "entityType": "comic.page_bookmark",
                    "clientMutationId": "comic-bookmark-1",
                    "scopeId": "comics:profile:main",
                    "entityId": "bookmark-1",
                    "lamport": 2,
                    "patch": {
                        "bookmarkId": "bookmark-1",
                        "comicId": "suwayomi:server-main:manga:42",
                        "chapterId": "chapter-7",
                        "pageIndex": 4,
                        "pageCount": 20,
                        "label": "Splash page",
                        "savedAtMs": 1001
                    }
                }
            ]
        })
    }

    #[tokio::test]
    async fn accepts_server_scoped_comic_catalog_state_and_queues_official_projections() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let comic_id = "suwayomi:server:desktop-a:profile:main:manga:42";
        let category_id = "suwayomi:server:desktop-a:profile:main:category:3";
        let chapter_id = "suwayomi:server:desktop-a:profile:main:chapter:7";
        let chapter_state_id = format!("comic.chapter_state::{comic_id}::{chapter_id}");

        let response = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                json!({
                    "requestId": "canonical-comic-state",
                    "mutations": [
                        {
                            "entityType": "comic.entry",
                            "clientMutationId": "comic-entry-merge",
                            "scopeId": "comics:profile:main",
                            "entityId": comic_id,
                            "lamport": 1,
                            "eventClock": { "physicalMs": 100, "logical": 1, "deviceGenerationId": "mobile-a" },
                            "patch": { "comicId": comic_id, "inLibrary": true }
                        },
                        {
                            "entityType": "comic.category",
                            "clientMutationId": "comic-category-merge",
                            "scopeId": "comics:profile:main",
                            "entityId": category_id,
                            "lamport": 2,
                            "eventClock": { "physicalMs": 101, "logical": 1, "deviceGenerationId": "mobile-a" },
                            "patch": { "categoryId": category_id, "name": "Reading", "order": 1 }
                        },
                        {
                            "entityType": "comic.category_assignment",
                            "clientMutationId": "comic-assignment-merge",
                            "scopeId": "comics:profile:main",
                            "entityId": "comic-category-assignment:test",
                            "lamport": 3,
                            "eventClock": { "physicalMs": 102, "logical": 1, "deviceGenerationId": "mobile-a" },
                            "patch": {
                                "assignmentId": "comic-category-assignment:test",
                                "comicId": comic_id,
                                "categoryId": category_id
                            }
                        },
                        {
                            "entityType": "comic.chapter_state",
                            "clientMutationId": "comic-chapter-state-merge",
                            "scopeId": "comics:profile:main",
                            "entityId": chapter_state_id,
                            "lamport": 4,
                            "eventClock": { "physicalMs": 103, "logical": 1, "deviceGenerationId": "mobile-a" },
                            "patch": {
                                "chapterStateId": chapter_state_id,
                                "comicId": comic_id,
                                "chapterId": chapter_id,
                                "read": true,
                                "bookmarked": false,
                                "lastPageRead": 8,
                                "lastReadAtMs": 103,
                                "updatedAtMs": 103,
                                "explicitProgressReset": false
                            }
                        }
                    ]
                }),
            ))
            .await
            .unwrap();

        let status = response.status();
        let payload = json_body(response).await;
        assert_eq!(status, StatusCode::OK, "{payload}");
        assert!(payload["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|result| result["status"] == "applied"));
        let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comic_sync_state")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(stored, 4);
        let projections: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM suwayomi_projection_outbox WHERE status = 'pending'",
        )
        .fetch_one(&state.pool)
        .await
        .unwrap();
        // Library membership, category rename/order, assignment and chapter state each
        // produce an independently confirmed Suwayomi projection.  Keeping category name and
        // order as separate operations mirrors Suwayomi's GraphQL API and makes a partial
        // confirmation observable instead of silently dropping one field.
        assert_eq!(projections, 5);
    }

    #[tokio::test]
    async fn comic_state_receipts_snapshot_changes_and_events_are_exact() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());

        let first = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                comic_state_batch("comic-state-first"),
            ))
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first_payload = json_body(first).await;
        assert_eq!(first_payload["currentServerVersion"], 2);
        assert_eq!(first_payload["results"][0]["status"], "applied");
        assert_eq!(first_payload["results"][1]["status"], "applied");

        let retry = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                comic_state_batch("comic-state-retry"),
            ))
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        let retry_payload = json_body(retry).await;
        assert_eq!(retry_payload["results"], first_payload["results"]);
        assert_eq!(retry_payload["currentServerVersion"], 2);

        let snapshot = app
            .clone()
            .oneshot(request_without_body(
                "/v1/snapshot?scopeId=comics:profile:main",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(snapshot.status(), StatusCode::OK);
        let snapshot = json_body(snapshot).await;
        assert_eq!(snapshot["scopeId"], "comics:profile:main");
        assert_eq!(snapshot["snapshotVersion"], 2);
        assert_eq!(snapshot["entities"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["entities"][0]["entityType"], "comic.history");
        assert_eq!(snapshot["entities"][1]["entityType"], "comic.page_bookmark");
        assert_eq!(snapshot["entities"][0]["record"]["pageIndex"], 4);
        assert_eq!(snapshot["tombstones"].as_array().unwrap().len(), 0);

        let changes = app
            .clone()
            .oneshot(request_without_body(
                "/v1/changes?scopeId=comics%3Aprofile%3Amain&sinceVersion=0",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        assert_eq!(changes.status(), StatusCode::OK);
        let changes = json_body(changes).await;
        assert_eq!(changes["changes"].as_array().unwrap().len(), 2);
        assert_eq!(changes["changes"][0]["entityType"], "comic.history");
        assert_eq!(changes["changes"][1]["entityType"], "comic.page_bookmark");

        let events = app
            .oneshot(request_without_body(
                "/v1/events?scopeId=comics:profile:main",
                "main-token",
                Some(0),
            ))
            .await
            .unwrap();
        assert_eq!(events.status(), StatusCode::OK);
        let events = collect_sse_change_events(events, 2).await;
        assert_eq!(events[0]["entityType"], "comic.history");
        assert_eq!(events[1]["entityType"], "comic.page_bookmark");
    }

    #[tokio::test]
    async fn rejects_comic_state_in_wrong_or_foreign_profile_scope() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);
        let wrong_entity_scope = json!({
            "requestId": "comic-wrong-entity-scope",
            "mutations": [{
                "entityType": "comic.history",
                "clientMutationId": "comic-wrong-entity-scope",
                "scopeId": "novels:profile:main",
                "entityId": "comic.history::suwayomi:server-main:manga:42",
                "lamport": 1,
                "patch": {
                    "historyId": "comic.history::suwayomi:server-main:manga:42",
                    "comicId": "suwayomi:server-main:manga:42",
                    "chapterId": "chapter-1",
                    "pageIndex": 0,
                    "pageCount": 1,
                    "progressPercent": 1.0,
                    "readAtMs": 1
                }
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                wrong_entity_scope,
            ))
            .await
            .unwrap();
        let payload = json_body(response).await;
        assert_eq!(
            payload["results"][0]["error"]["code"],
            "INVALID_SCOPE_FOR_ENTITY"
        );

        let mut foreign_profile = comic_state_batch("comic-foreign-profile");
        foreign_profile["mutations"][0]["clientMutationId"] =
            json!("comic-foreign-profile-history");
        foreign_profile["mutations"][0]["scopeId"] = json!("comics:profile:test");
        foreign_profile["mutations"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        let response = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                foreign_profile,
            ))
            .await
            .unwrap();
        let payload = json_body(response).await;
        assert_eq!(payload["results"][0]["error"]["code"], "FORBIDDEN_SCOPE");
    }

    #[tokio::test]
    async fn rejects_comic_payload_identity_and_parent_changes() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);
        let identity_mismatch = json!({
            "requestId": "comic-identity-mismatch",
            "mutations": [{
                "entityType": "comic.history",
                "clientMutationId": "comic-identity-mismatch",
                "scopeId": "comics:profile:main",
                "entityId": "comic.history::suwayomi:server-main:manga:42",
                "lamport": 1,
                "patch": {
                    "historyId": "history-other",
                    "comicId": "suwayomi:server-main:manga:42",
                    "chapterId": "chapter-1",
                    "pageIndex": 0,
                    "pageCount": 2,
                    "progressPercent": 0.5,
                    "readAtMs": 1
                }
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                identity_mismatch,
            ))
            .await
            .unwrap();
        let payload = json_body(response).await;
        assert_eq!(payload["results"][0]["error"]["code"], "ENTITY_ID_MISMATCH");

        let create = comic_state_batch("comic-parent-create");
        let response = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", create))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let reparent = json!({
            "requestId": "comic-parent-change",
            "mutations": [{
                "entityType": "comic.page_bookmark",
                "clientMutationId": "comic-parent-change",
                "scopeId": "comics:profile:main",
                "entityId": "bookmark-1",
                "lamport": 3,
                "patch": {
                    "bookmarkId": "bookmark-1",
                    "comicId": "suwayomi:server-main:manga:99",
                    "chapterId": "chapter-7",
                    "pageIndex": 4,
                    "pageCount": 20,
                    "label": null,
                    "savedAtMs": 1002
                }
            }]
        });
        let response = app
            .oneshot(request_with_json("/v1/mutations", "main-token", reparent))
            .await
            .unwrap();
        let payload = json_body(response).await;
        assert_eq!(payload["results"][0]["error"]["code"], "PARENT_ID_MISMATCH");
    }

    #[tokio::test]
    async fn comic_bookmark_delete_replay_tombstone_and_resurrection_converge() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state);
        let mut create = comic_state_batch("comic-delete-create");
        create["mutations"].as_array_mut().unwrap().remove(0);
        let response = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", create))
            .await
            .unwrap();
        assert_eq!(json_body(response).await["results"][0]["status"], "applied");

        let delete = json!({
            "requestId": "comic-delete",
            "mutations": [{
                "entityType": "comic.page_bookmark",
                "clientMutationId": "comic-bookmark-delete",
                "scopeId": "comics:profile:main",
                "entityId": "bookmark-1",
                "op": "delete",
                "lamport": 3
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                delete.clone(),
            ))
            .await
            .unwrap();
        let deleted = json_body(response).await;
        assert_eq!(deleted["results"][0]["status"], "applied");
        let response = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", delete))
            .await
            .unwrap();
        let replayed_delete = json_body(response).await;
        assert_eq!(
            replayed_delete["results"][0]["appliedServerVersion"],
            deleted["results"][0]["appliedServerVersion"]
        );
        assert_eq!(replayed_delete["currentServerVersion"], 2);

        let stale = json!({
            "requestId": "comic-stale-resurrection",
            "mutations": [{
                "entityType": "comic.page_bookmark",
                "clientMutationId": "comic-stale-resurrection",
                "scopeId": "comics:profile:main",
                "entityId": "bookmark-1",
                "lamport": 3,
                "patch": {
                    "bookmarkId": "bookmark-1",
                    "comicId": "suwayomi:server-main:manga:42",
                    "chapterId": "chapter-7",
                    "pageIndex": 5,
                    "pageCount": 20,
                    "label": null,
                    "savedAtMs": 1003
                }
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", stale))
            .await
            .unwrap();
        assert_eq!(
            json_body(response).await["results"][0]["error"]["code"],
            "STALE_COMIC_STATE_MUTATION"
        );

        let snapshot = app
            .clone()
            .oneshot(request_without_body(
                "/v1/snapshot?scopeId=comics:profile:main",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let snapshot = json_body(snapshot).await;
        assert_eq!(snapshot["entities"].as_array().unwrap().len(), 0);
        assert_eq!(snapshot["tombstones"].as_array().unwrap().len(), 1);
        assert_eq!(
            snapshot["tombstones"][0]["entityType"],
            "comic.page_bookmark"
        );

        let wrong_parent_resurrection = json!({
            "requestId": "comic-wrong-parent-resurrection",
            "mutations": [{
                "entityType": "comic.page_bookmark",
                "clientMutationId": "comic-wrong-parent-resurrection",
                "scopeId": "comics:profile:main",
                "entityId": "bookmark-1",
                "lamport": 4,
                "patch": {
                    "bookmarkId": "bookmark-1",
                    "comicId": "suwayomi:server-main:manga:99",
                    "chapterId": "chapter-7",
                    "pageIndex": 5,
                    "pageCount": 20,
                    "label": "Wrong parent",
                    "savedAtMs": 1004
                }
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                wrong_parent_resurrection,
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(response).await["results"][0]["error"]["code"],
            "PARENT_ID_MISMATCH"
        );

        let resurrect = json!({
            "requestId": "comic-valid-resurrection",
            "mutations": [{
                "entityType": "comic.page_bookmark",
                "clientMutationId": "comic-valid-resurrection",
                "scopeId": "comics:profile:main",
                "entityId": "bookmark-1",
                "lamport": 5,
                "patch": {
                    "bookmarkId": "bookmark-1",
                    "comicId": "suwayomi:server-main:manga:42",
                    "chapterId": "chapter-7",
                    "pageIndex": 5,
                    "pageCount": 20,
                    "label": "Restored",
                    "savedAtMs": 1005
                }
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", resurrect))
            .await
            .unwrap();
        assert_eq!(json_body(response).await["results"][0]["status"], "applied");

        let snapshot = app
            .clone()
            .oneshot(request_without_body(
                "/v1/snapshot?scopeId=comics:profile:main",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let snapshot = json_body(snapshot).await;
        assert_eq!(snapshot["entities"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["entities"][0]["record"]["label"], "Restored");
        assert_eq!(snapshot["tombstones"].as_array().unwrap().len(), 0);

        let changes = app
            .oneshot(request_without_body(
                "/v1/changes?scopeId=comics%3Aprofile%3Amain&sinceVersion=0",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let changes = json_body(changes).await;
        let ops = changes["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|change| change["op"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ops, vec!["merge", "delete", "merge"]);
    }

    #[tokio::test]
    async fn comic_payloads_reject_unknown_fields_before_persistence() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let mut request = comic_state_batch("comic-unknown-field");
        request["mutations"][0]["patch"]["accessToken"] = json!("must-not-pass");
        request["mutations"].as_array_mut().unwrap().truncate(1);
        let response = app
            .oneshot(request_with_json("/v1/mutations", "main-token", request))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            load_server_runtime(&state.pool)
                .await
                .unwrap()
                .current_server_version,
            0
        );
    }

    #[tokio::test]
    async fn concurrent_novel_category_assignments_converge_on_canonical_id() {
        let (_temp, state) = build_state().await;
        ensure_test_token(
            &state.pool,
            "device-secondary",
            "main",
            &token_hash("secondary-token"),
            &["novels:profile:main"],
        )
        .await
        .unwrap();
        let app = build_test_router(state.clone());
        let seed = json!({
            "requestId": "novel-category-concurrent-seed",
            "mutations": [
                {
                    "entityType": "novel.entry",
                    "clientMutationId": "novel-category-concurrent-entry",
                    "scopeId": "novels:profile:main",
                    "entityId": "novel-1",
                    "lamport": 1,
                    "patch": {
                        "identityKey": "novel-1",
                        "title": "Novel One",
                        "path": "/novel/1",
                        "tags": [],
                        "source": {},
                        "addedAtMs": 1,
                        "updatedAtMs": 1
                    }
                },
                {
                    "entityType": "novel.category",
                    "clientMutationId": "novel-category-concurrent-category",
                    "scopeId": "novels:profile:main",
                    "entityId": "favorites",
                    "lamport": 1,
                    "patch": {"categoryId": "favorites", "name": "Favorites", "order": 0}
                }
            ]
        });
        let response = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", seed))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let assignment_id = canonical_novel_category_assignment_id("novel-1", "favorites");
        let assignment = |request_id: &str, mutation_id: &str| {
            json!({
                "requestId": request_id,
                "mutations": [{
                    "entityType": "novel.category_assignment",
                    "clientMutationId": mutation_id,
                    "scopeId": "novels:profile:main",
                    "entityId": assignment_id,
                    "lamport": 1,
                    "patch": {
                        "assignmentId": assignment_id,
                        "novelId": "novel-1",
                        "categoryId": "favorites"
                    }
                }]
            })
        };
        let first = app.clone().oneshot(request_with_json(
            "/v1/mutations",
            "main-token",
            assignment("novel-category-concurrent-a", "novel-category-concurrent-a"),
        ));
        let second = app.clone().oneshot(request_with_json(
            "/v1/mutations",
            "secondary-token",
            assignment("novel-category-concurrent-b", "novel-category-concurrent-b"),
        ));
        let (first, second) = tokio::join!(first, second);
        let first = json_body(first.unwrap()).await;
        let second = json_body(second.unwrap()).await;
        assert_eq!(first["results"][0]["status"], "applied");
        assert_eq!(second["results"][0]["status"], "applied");
        assert_eq!(first["results"][0]["entityId"], assignment_id);
        assert_eq!(second["results"][0]["entityId"], assignment_id);

        let assignment_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM novel_category_assignments WHERE scope_id = ? AND novel_id = ? AND category_id = ?",
        )
        .bind("novels:profile:main")
        .bind("novel-1")
        .bind("favorites")
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(assignment_count, 1);

        let noncanonical = json!({
            "requestId": "novel-category-noncanonical",
            "mutations": [{
                "entityType": "novel.category_assignment",
                "clientMutationId": "novel-category-noncanonical",
                "scopeId": "novels:profile:main",
                "entityId": "arbitrary-id",
                "lamport": 2,
                "patch": {
                    "assignmentId": "arbitrary-id",
                    "novelId": "novel-1",
                    "categoryId": "favorites"
                }
            }]
        });
        let response = app
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                noncanonical,
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(response).await["results"][0]["error"]["code"],
            "NON_CANONICAL_ASSIGNMENT_ID"
        );
    }

    #[tokio::test]
    async fn novel_categories_are_referential_replayable_and_tombstone_safe() {
        let (_temp, state) = build_state().await;
        let app = build_test_router(state.clone());
        let assignment_id = canonical_novel_category_assignment_id("novel-1", "favorites");
        let seed = json!({
            "requestId": "novel-category-seed",
            "mutations": [
                {
                    "entityType": "novel.entry",
                    "clientMutationId": "novel-category-entry",
                    "scopeId": "novels:profile:main",
                    "entityId": "novel-1",
                    "lamport": 1,
                    "patch": {
                        "identityKey": "novel-1",
                        "title": "Novel One",
                        "path": "/novel/1",
                        "tags": [],
                        "source": {},
                        "addedAtMs": 1,
                        "updatedAtMs": 1
                    }
                },
                {
                    "entityType": "novel.category",
                    "clientMutationId": "novel-category-create",
                    "scopeId": "novels:profile:main",
                    "entityId": "favorites",
                    "lamport": 1,
                    "patch": {
                        "categoryId": "favorites",
                        "name": "Favorites",
                        "order": 0
                    }
                },
                {
                    "entityType": "novel.category_assignment",
                    "clientMutationId": "novel-category-assign",
                    "scopeId": "novels:profile:main",
                    "entityId": assignment_id,
                    "lamport": 1,
                    "patch": {
                        "assignmentId": assignment_id,
                        "novelId": "novel-1",
                        "categoryId": "favorites"
                    }
                }
            ]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                seed.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let seeded = json_body(response).await;
        assert!(seeded["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|result| result["status"] == "applied"));
        assert_eq!(seeded["currentServerVersion"], 3);

        let response = app
            .clone()
            .oneshot(request_with_json("/v1/mutations", "main-token", seed))
            .await
            .unwrap();
        let replay = json_body(response).await;
        assert_eq!(replay["currentServerVersion"], 3);
        assert_eq!(replay["results"][1]["appliedServerVersion"], 2);
        assert_eq!(replay["results"][2]["appliedServerVersion"], 3);

        let snapshot = app
            .clone()
            .oneshot(request_without_body(
                "/v1/snapshot?scopeId=novels%3Aprofile%3Amain",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let snapshot = json_body(snapshot).await;
        assert!(snapshot["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "novel.category"
                    && entity["record"]["categoryId"] == "favorites"
            }));
        assert!(snapshot["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "novel.category_assignment"
                    && entity["record"]["novelId"] == "novel-1"
                    && entity["record"]["categoryId"] == "favorites"
            }));

        let changes = app
            .clone()
            .oneshot(request_without_body(
                "/v1/changes?scopeId=novels%3Aprofile%3Amain&sinceVersion=0",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let changes = json_body(changes).await;
        assert_eq!(changes["changes"][1]["entityType"], "novel.category");
        assert_eq!(
            changes["changes"][2]["entityType"],
            "novel.category_assignment"
        );

        let events = app
            .clone()
            .oneshot(request_without_body(
                "/v1/events?scopeId=novels:profile:main",
                "main-token",
                Some(0),
            ))
            .await
            .unwrap();
        let events = collect_sse_change_events(events, 3).await;
        assert_eq!(events[1]["entityType"], "novel.category");
        assert_eq!(events[2]["entityType"], "novel.category_assignment");

        let blocked_parent_delete = json!({
            "requestId": "novel-category-block-parent-delete",
            "mutations": [{
                "entityType": "novel.entry",
                "clientMutationId": "novel-category-block-parent-delete",
                "scopeId": "novels:profile:main",
                "entityId": "novel-1",
                "op": "delete",
                "lamport": 2
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                blocked_parent_delete,
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(response).await["results"][0]["error"]["code"],
            "NOVEL_CATEGORY_ASSIGNMENTS_EXIST"
        );

        let blocked_category_delete = json!({
            "requestId": "novel-category-block-category-delete",
            "mutations": [{
                "entityType": "novel.category",
                "clientMutationId": "novel-category-block-category-delete",
                "scopeId": "novels:profile:main",
                "entityId": "favorites",
                "op": "delete",
                "lamport": 2
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                blocked_category_delete,
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(response).await["results"][0]["error"]["code"],
            "NOVEL_CATEGORY_ASSIGNMENTS_EXIST"
        );

        let delete_assignment = json!({
            "requestId": "novel-category-delete-assignment",
            "mutations": [{
                "entityType": "novel.category_assignment",
                "clientMutationId": "novel-category-delete-assignment",
                "scopeId": "novels:profile:main",
                "entityId": assignment_id,
                "op": "delete",
                "lamport": 2
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                delete_assignment,
            ))
            .await
            .unwrap();
        assert_eq!(json_body(response).await["results"][0]["status"], "applied");

        let stale_assignment = json!({
            "requestId": "novel-category-stale-assignment",
            "mutations": [{
                "entityType": "novel.category_assignment",
                "clientMutationId": "novel-category-stale-assignment",
                "scopeId": "novels:profile:main",
                "entityId": assignment_id,
                "lamport": 2,
                "patch": {
                    "assignmentId": assignment_id,
                    "novelId": "novel-1",
                    "categoryId": "favorites"
                }
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                stale_assignment,
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(response).await["results"][0]["error"]["code"],
            "STALE_NOVEL_CATEGORY_MUTATION"
        );

        let missing_assignment_id =
            canonical_novel_category_assignment_id("missing-novel", "favorites");
        let missing_parent = json!({
            "requestId": "novel-category-missing-parent",
            "mutations": [{
                "entityType": "novel.category_assignment",
                "clientMutationId": "novel-category-missing-parent",
                "scopeId": "novels:profile:main",
                "entityId": missing_assignment_id,
                "lamport": 3,
                "patch": {
                    "assignmentId": missing_assignment_id,
                    "novelId": "missing-novel",
                    "categoryId": "favorites"
                }
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                missing_parent,
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(response).await["results"][0]["error"]["code"],
            "NOVEL_NOT_FOUND"
        );

        let missing_category_assignment_id =
            canonical_novel_category_assignment_id("novel-1", "missing-category");
        let missing_category = json!({
            "requestId": "novel-category-missing-category",
            "mutations": [{
                "entityType": "novel.category_assignment",
                "clientMutationId": "novel-category-missing-category",
                "scopeId": "novels:profile:main",
                "entityId": missing_category_assignment_id,
                "lamport": 3,
                "patch": {
                    "assignmentId": missing_category_assignment_id,
                    "novelId": "novel-1",
                    "categoryId": "missing-category"
                }
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                missing_category,
            ))
            .await
            .unwrap();
        let missing_category = json_body(response).await;
        assert_eq!(
            missing_category["results"][0]["error"]["code"],
            "NOVEL_CATEGORY_NOT_FOUND"
        );
        assert!(!missing_category["results"][0]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("constraint failed"));

        let invalid_order = json!({
            "requestId": "novel-category-invalid-order",
            "mutations": [{
                "entityType": "novel.category",
                "clientMutationId": "novel-category-invalid-order",
                "scopeId": "novels:profile:main",
                "entityId": "invalid-order",
                "lamport": 1,
                "patch": {"categoryId": "invalid-order", "name": "Invalid", "order": -1}
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                invalid_order,
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(response).await["results"][0]["error"]["code"],
            "INVALID_CATEGORY_ORDER"
        );

        let delete_category = json!({
            "requestId": "novel-category-delete",
            "mutations": [{
                "entityType": "novel.category",
                "clientMutationId": "novel-category-delete",
                "scopeId": "novels:profile:main",
                "entityId": "favorites",
                "op": "delete",
                "lamport": 3
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                delete_category,
            ))
            .await
            .unwrap();
        assert_eq!(json_body(response).await["results"][0]["status"], "applied");

        let stale_category = json!({
            "requestId": "novel-category-stale-resurrection",
            "mutations": [{
                "entityType": "novel.category",
                "clientMutationId": "novel-category-stale-resurrection",
                "scopeId": "novels:profile:main",
                "entityId": "favorites",
                "lamport": 3,
                "patch": {
                    "categoryId": "favorites",
                    "name": "Old Favorites",
                    "order": 9
                }
            }]
        });
        let response = app
            .clone()
            .oneshot(request_with_json(
                "/v1/mutations",
                "main-token",
                stale_category,
            ))
            .await
            .unwrap();
        assert_eq!(
            json_body(response).await["results"][0]["error"]["code"],
            "STALE_NOVEL_CATEGORY_MUTATION"
        );

        let snapshot = app
            .clone()
            .oneshot(request_without_body(
                "/v1/snapshot?scopeId=novels%3Aprofile%3Amain",
                "main-token",
                None,
            ))
            .await
            .unwrap();
        let snapshot = json_body(snapshot).await;
        assert!(snapshot["tombstones"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "novel.category" && entity["entityId"] == "favorites"
            }));
        assert!(snapshot["tombstones"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| {
                entity["entityType"] == "novel.category_assignment"
                    && entity["entityId"] == assignment_id
            }));

        let other_profile = app
            .oneshot(request_without_body(
                "/v1/snapshot?scopeId=novels%3Aprofile%3Atest",
                "test-token",
                None,
            ))
            .await
            .unwrap();
        let other_profile = json_body(other_profile).await;
        assert!(other_profile["entities"].as_array().unwrap().is_empty());
        assert!(other_profile["tombstones"].as_array().unwrap().is_empty());
    }
}
