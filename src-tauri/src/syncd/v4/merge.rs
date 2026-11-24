//! Deterministic, domain-aware offline merge engine for Sync V4.
//!
//! Invariants:
//! 1. Commutative & associative for concurrent offline progress (reading chapters offline on
//!    Android and Desktop simultaneously never loses progress from either side).
//! 2. Explicit user actions (delete, un-favorite, mark-as-unread, explicit reset to page 0)
//!    always prevail when their HLC is newer than prior read state.
//! 3. Bookmark state has its own independent field HLC so bookmarking on one device while
//!    reading on another preserves both edits.

use serde_json::{Map, Value};
use std::collections::BTreeMap;

use super::hlc::Hlc;

pub(super) const FIELD_CLOCKS: &str = "__v4FieldHlc";
pub(super) const CHAPTER_CLOCKS: &str = "__v4ChapterHlc";
pub(super) const BOOK_POSITION_CLOCK: &str = "__v4BookPositionHlc";

#[derive(Debug, Clone, PartialEq)]
pub struct StoredRecordState {
    pub domain: String,
    pub entity_type: String,
    pub entity_key: String,
    pub payload: Value,
    pub deleted: bool,
    pub hlc: Hlc,
    pub origin_device_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergeOutcome {
    pub state: StoredRecordState,
    /// True if the canonical state changed and must be persisted + broadcast.
    pub changed: bool,
    /// True if incoming won cleanly or merged new fields into existing state.
    pub merged: bool,
}

pub fn merge_record(
    existing: Option<&StoredRecordState>,
    incoming: StoredRecordState,
) -> MergeOutcome {
    let Some(existing) = existing else {
        return MergeOutcome {
            state: incoming,
            changed: true,
            merged: false,
        };
    };

    // Identical payload, deleted flag, and clock => no-op.
    if existing.deleted == incoming.deleted
        && existing.hlc == incoming.hlc
        && existing.payload == incoming.payload
    {
        return MergeOutcome {
            state: existing.clone(),
            changed: false,
            merged: false,
        };
    }

    // Tombstone handling: explicit delete/undelete is strictly ordered by HLC.
    if existing.deleted || incoming.deleted {
        return match incoming.hlc.cmp(&existing.hlc) {
            std::cmp::Ordering::Greater => MergeOutcome {
                state: incoming,
                changed: true,
                merged: false,
            },
            _ => MergeOutcome {
                state: existing.clone(),
                changed: false,
                merged: false,
            },
        };
    }

    match incoming.entity_type.as_str() {
        "comic.chapter" | "novel.chapter" => merge_chapter_progress(existing, incoming),
        "book.progress" => merge_book_progress(existing, incoming),
        "comic.history" | "novel.history" => merge_history(existing, incoming),
        _ => merge_field_lww(existing, incoming),
    }
}

/// Merges concurrent offline chapter reading state (`comic.chapter` / `novel.chapter`).
///
/// Supported optional JSON fields:
/// - `isRead`: bool
/// - `lastPageRead`: i64 (comics) or `progressPercent`: f64 (novels)
/// - `isBookmarked`: bool
/// - `bookmarkHlc`: { tsMs, counter, deviceId } (optional; falls back to record HLC)
/// - `explicitResetHlc`: { tsMs, counter, deviceId } (stamped whenever user explicitly marks
///   a chapter unread or resets page to 0)
/// - `readAtMs`: i64
/// - metadata fields (`chapterNumber`, `name`, `scanlator`, `chapterUrl`, etc.)
fn merge_chapter_progress(
    existing: &StoredRecordState,
    incoming: StoredRecordState,
) -> MergeOutcome {
    let newer_is_incoming = incoming.hlc >= existing.hlc;
    let (winner, loser) = if newer_is_incoming {
        (&incoming, existing)
    } else {
        (existing, &incoming)
    };

    let mut merged_obj = winner.payload.as_object().cloned().unwrap_or_default();
    let loser_obj = loser.payload.as_object().cloned().unwrap_or_default();

    // Preserve non-empty metadata fields missing from the winner.
    for (k, v) in &loser_obj {
        if !merged_obj.contains_key(k) || merged_obj.get(k).is_some_and(Value::is_null) {
            merged_obj.insert(k.clone(), v.clone());
        }
    }

    // Determine effective explicitResetHlc (max of both).
    let ex_reset = extract_hlc(&existing.payload, "explicitResetHlc");
    let in_reset = extract_hlc(&incoming.payload, "explicitResetHlc");
    let effective_reset = max_opt_hlc(ex_reset.as_ref(), in_reset.as_ref());
    if let Some(reset_hlc) = &effective_reset {
        if let Ok(val) = serde_json::to_value(reset_hlc) {
            merged_obj.insert("explicitResetHlc".to_string(), val);
        }
    }

    let mut progress_clocks = Map::new();
    for (field, cleared) in [
        ("isRead", Value::Bool(false)),
        ("lastPageRead", Value::from(0)),
        ("progressPercent", Value::from(0.0)),
    ] {
        let mut candidates = [existing, &incoming]
            .into_iter()
            .flat_map(|record| chapter_progress_candidates(record, field))
            .filter(|(_, clock, _)| effective_reset.as_ref().is_none_or(|reset| clock > reset))
            .collect::<Vec<_>>();
        // A later reset can remove an older high position while preserving a more recent
        // lower one. Keep the nondominated positions ordered from newest to furthest.
        candidates
            .sort_unstable_by(|(a, ac, _), (b, bc, _)| bc.cmp(ac).then_with(|| b.total_cmp(a)));
        let mut maximum = f64::NEG_INFINITY;
        candidates.retain(|(order, _, _)| {
            if *order <= maximum {
                return false;
            }
            maximum = *order;
            true
        });
        if let Some((_, clock, value)) = candidates.last() {
            merged_obj.insert(field.to_owned(), (*value).clone());
            if candidates.len() > 1 || *clock != winner.hlc {
                progress_clocks.insert(
                    field.to_owned(),
                    Value::Array(
                        candidates
                            .iter()
                            .map(|(_, clock, value)| serde_json::json!([clock, value]))
                            .collect(),
                    ),
                );
            }
        } else if merged_obj.contains_key(field) {
            merged_obj.insert(field.to_owned(), cleared);
            if let Some(clock) = &effective_reset {
                progress_clocks.insert(
                    field.to_owned(),
                    serde_json::json!([[clock, merged_obj[field]]]),
                );
            }
        }
    }
    merged_obj.remove(CHAPTER_CLOCKS);
    if !progress_clocks.is_empty() {
        merged_obj.insert(CHAPTER_CLOCKS.to_owned(), Value::Object(progress_clocks));
    }

    // `readAtMs`: max timestamp if read/progressed, else winner's value.
    let ex_read_at = existing
        .payload
        .get("readAtMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let in_read_at = incoming
        .payload
        .get("readAtMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if ex_read_at > 0 || in_read_at > 0 {
        merged_obj.insert(
            "readAtMs".to_string(),
            Value::from(ex_read_at.max(in_read_at)),
        );
    }

    // A mutation that omits the bookmark must not change its clock. Keep the winning
    // field clock even when it originally came from the outer record.
    let bookmark = [existing, &incoming]
        .into_iter()
        .filter_map(|record| {
            let value = record.payload.get("isBookmarked")?.as_bool()?;
            let clock =
                extract_hlc(&record.payload, "bookmarkHlc").unwrap_or_else(|| record.hlc.clone());
            Some((clock, value))
        })
        .max_by(|(a, _), (b, _)| a.cmp(b));
    if let Some((clock, value)) = bookmark {
        merged_obj.insert("isBookmarked".to_string(), Value::Bool(value));
        if let Ok(clock) = serde_json::to_value(clock) {
            merged_obj.insert("bookmarkHlc".to_string(), clock);
        }
    }

    let merged_payload = Value::Object(merged_obj);
    let winning_hlc = existing.hlc.clone().max(incoming.hlc.clone());
    let winning_origin = if newer_is_incoming {
        incoming.origin_device_id.clone()
    } else {
        existing.origin_device_id.clone()
    };

    let changed = merged_payload != existing.payload || winning_hlc != existing.hlc;
    MergeOutcome {
        state: StoredRecordState {
            domain: winner.domain.clone(),
            entity_type: winner.entity_type.clone(),
            entity_key: winner.entity_key.clone(),
            payload: merged_payload,
            deleted: false,
            hlc: winning_hlc,
            origin_device_id: winning_origin,
        },
        changed,
        merged: changed && !newer_is_incoming,
    }
}

/// Merges `book.progress` records (EPUB CFI/locator or PDF page + progressPercent).
/// Uses HLC winner unless an explicit reset occurred; when two offline devices advance
/// progress without reset, prefers higher `progressPercent` (breaking ties by HLC).
fn merge_book_progress(existing: &StoredRecordState, incoming: StoredRecordState) -> MergeOutcome {
    let ex_reset = extract_hlc(&existing.payload, "explicitResetHlc");
    let in_reset = extract_hlc(&incoming.payload, "explicitResetHlc");
    let effective_reset = max_opt_hlc(ex_reset.as_ref(), in_reset.as_ref());
    let ex_clock =
        extract_hlc(&existing.payload, BOOK_POSITION_CLOCK).unwrap_or_else(|| existing.hlc.clone());
    let in_clock =
        extract_hlc(&incoming.payload, BOOK_POSITION_CLOCK).unwrap_or_else(|| incoming.hlc.clone());
    let choose_incoming = if let Some(reset) = &effective_reset {
        match (ex_clock > *reset, in_clock > *reset) {
            (false, false) => {
                let ex_at_reset = ex_reset.as_ref() == Some(reset);
                let in_at_reset = in_reset.as_ref() == Some(reset);
                (in_at_reset, &in_clock) > (ex_at_reset, &ex_clock)
            }
            (ex_valid, in_valid) => (in_valid, &in_clock) > (ex_valid, &ex_clock),
        }
    } else {
        let percentage = |record: &StoredRecordState| {
            record
                .payload
                .get("progressPercent")
                .and_then(Value::as_f64)
        };
        match (percentage(existing), percentage(&incoming)) {
            (Some(ep), Some(ip)) if (ip - ep).abs() > 1e-6 => ip > ep,
            _ => in_clock > ex_clock,
        }
    };
    let winning_hlc = existing.hlc.clone().max(incoming.hlc.clone());
    let (mut state, position_clock) = if choose_incoming {
        (incoming, in_clock)
    } else {
        (existing.clone(), ex_clock)
    };
    if let Some(payload) = state.payload.as_object_mut() {
        if let Some(reset) = effective_reset {
            payload.insert("explicitResetHlc".to_owned(), serde_json::json!(reset));
        }
        if position_clock != winning_hlc {
            payload.insert(
                BOOK_POSITION_CLOCK.to_owned(),
                serde_json::json!(position_clock),
            );
        } else {
            payload.remove(BOOK_POSITION_CLOCK);
        }
    }
    state.hlc = winning_hlc;
    let changed = state.payload != existing.payload || state.hlc != existing.hlc;
    MergeOutcome {
        state,
        changed,
        merged: changed && !choose_incoming,
    }
}

/// Merges `comic.history` / `novel.history` — keeps the latest `lastReadAtMs` and accumulates
/// non-decreasing reading duration while preserving the most recent chapter reference.
fn merge_history(existing: &StoredRecordState, incoming: StoredRecordState) -> MergeOutcome {
    let ex_ts = existing
        .payload
        .get("lastReadAtMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let in_ts = incoming
        .payload
        .get("lastReadAtMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let incoming_wins = in_ts > ex_ts || (in_ts == ex_ts && incoming.hlc > existing.hlc);
    let (winner, loser) = if incoming_wins {
        (&incoming, existing)
    } else {
        (existing, &incoming)
    };

    let mut obj = winner.payload.as_object().cloned().unwrap_or_default();
    if let Some(loser_obj) = loser.payload.as_object() {
        let dur_a = obj
            .get("readDurationMs")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let dur_b = loser_obj
            .get("readDurationMs")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if dur_a > 0 || dur_b > 0 {
            obj.insert("readDurationMs".to_string(), Value::from(dur_a.max(dur_b)));
        }
    }
    if existing.payload.get("historyEntries").is_some()
        || incoming.payload.get("historyEntries").is_some()
    {
        let mut entries = BTreeMap::<&str, &Value>::new();
        for record in [existing, &incoming] {
            let visits = record
                .payload
                .get("historyEntries")
                .and_then(Value::as_array);
            let candidates = visits
                .map(Vec::as_slice)
                .unwrap_or_else(|| std::slice::from_ref(&record.payload));
            for visit in candidates {
                let Some(key) = visit.get("chapterKey").and_then(Value::as_str) else {
                    continue;
                };
                let last_read = |value: &Value| {
                    value
                        .get("lastReadAtMs")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                };
                match entries.entry(key) {
                    std::collections::btree_map::Entry::Occupied(mut known)
                        if last_read(visit) > last_read(known.get()) =>
                    {
                        known.insert(visit);
                    }
                    std::collections::btree_map::Entry::Vacant(slot) => {
                        slot.insert(visit);
                    }
                    _ => {}
                }
            }
        }
        obj.insert(
            "historyEntries".to_owned(),
            Value::Array(entries.into_values().cloned().collect()),
        );
    }

    let merged_payload = Value::Object(obj);
    let winning_hlc = existing.hlc.clone().max(incoming.hlc.clone());
    let changed = merged_payload != existing.payload || winning_hlc != existing.hlc;
    MergeOutcome {
        state: StoredRecordState {
            domain: winner.domain.clone(),
            entity_type: winner.entity_type.clone(),
            entity_key: winner.entity_key.clone(),
            payload: merged_payload,
            deleted: false,
            hlc: winning_hlc,
            origin_device_id: if incoming_wins {
                incoming.origin_device_id
            } else {
                existing.origin_device_id.clone()
            },
        },
        changed,
        merged: changed && !incoming_wins,
    }
}

/// Retain each field's clock when an unrelated field advances the record watermark.
fn merge_field_lww(existing: &StoredRecordState, incoming: StoredRecordState) -> MergeOutcome {
    let incoming_wins = incoming.hlc >= existing.hlc;
    let winner = if incoming_wins { &incoming } else { existing };
    let next_payload = match (existing.payload.as_object(), incoming.payload.as_object()) {
        (Some(ex_obj), Some(in_obj)) => {
            let mut merged = Map::new();
            let mut clocks = Map::new();
            for key in ex_obj.keys().chain(in_obj.keys()) {
                if key == FIELD_CLOCKS || merged.contains_key(key) {
                    continue;
                }
                let Some((clock, value)) = [existing, &incoming]
                    .into_iter()
                    .filter_map(|record| {
                        let value = record.payload.get(key)?;
                        Some((payload_clock(record, FIELD_CLOCKS, key), value))
                    })
                    .max_by(|(a, _), (b, _)| a.cmp(b))
                else {
                    continue;
                };
                merged.insert(key.clone(), value.clone());
                if clock != winner.hlc {
                    clocks.insert(key.clone(), serde_json::json!(clock));
                }
            }
            if !clocks.is_empty() {
                merged.insert(FIELD_CLOCKS.to_owned(), Value::Object(clocks));
            }
            Value::Object(merged)
        }
        _ => winner.payload.clone(),
    };

    let changed = next_payload != existing.payload || winner.hlc != existing.hlc;
    MergeOutcome {
        state: StoredRecordState {
            payload: next_payload,
            ..winner.clone()
        },
        changed,
        merged: changed && !incoming_wins,
    }
}

fn payload_clock(record: &StoredRecordState, namespace: &str, field: &str) -> Hlc {
    record
        .payload
        .get(namespace)
        .and_then(|clocks| extract_hlc(clocks, field))
        .unwrap_or_else(|| record.hlc.clone())
}

fn chapter_progress_candidates<'a>(
    record: &'a StoredRecordState,
    field: &str,
) -> Vec<(f64, Hlc, &'a Value)> {
    fn progress_order(value: &Value) -> Option<f64> {
        match value {
            Value::Bool(value) => Some(f64::from(u8::from(*value))),
            Value::Number(value) => value.as_f64(),
            _ => None,
        }
    }

    if let Some(stored) = record
        .payload
        .get(CHAPTER_CLOCKS)
        .and_then(|clocks| clocks.get(field))
        .and_then(Value::as_array)
    {
        return stored
            .iter()
            .filter_map(|candidate| {
                let clock = serde_json::from_value(candidate.get(0)?.clone()).ok()?;
                let value = candidate.get(1)?;
                Some((progress_order(value)?, clock, value))
            })
            .collect();
    }
    record
        .payload
        .get(field)
        .and_then(|value| Some((progress_order(value)?, record.hlc.clone(), value)))
        .into_iter()
        .collect()
}

fn extract_hlc(payload: &Value, field: &str) -> Option<Hlc> {
    let val = payload.get(field)?;
    if val.is_null() {
        return None;
    }
    let hlc: Hlc = serde_json::from_value(val.clone()).ok()?;
    hlc.validate().ok()?;
    Some(hlc)
}

fn max_opt_hlc(a: Option<&Hlc>, b: Option<&Hlc>) -> Option<Hlc> {
    match (a, b) {
        (Some(x), Some(y)) => Some(if x >= y { x.clone() } else { y.clone() }),
        (Some(x), None) => Some(x.clone()),
        (None, Some(y)) => Some(y.clone()),
        (None, None) => None,
    }
}
