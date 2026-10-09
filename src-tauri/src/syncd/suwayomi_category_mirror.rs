//! Mirrors the desktop's Suwayomi comic categories and their title assignments into the syncd
//! replica, so category edits made on the desktop reach paired phones over the live feed instead
//! of waiting for the phone's next catalog reconciliation.
//!
//! Suwayomi is the source of truth here. Phone edits reach Suwayomi through the projection
//! outbox; while that outbox holds work the mirror stays out of the way, otherwise it could
//! write back the pre-projection Suwayomi state and revert the phone's edit.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::time::Duration;

use anyhow::Context;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::FromRow;

use super::models::{AuthenticatedSession, EventClock, SharedAppState};
use super::routes::suwayomi_catalog;
use super::{db, suwayomi_projection};

const CATEGORY_PAGE_SIZE: i64 = 100;
const MAX_CATEGORY_PAGES: usize = 20;

const CATEGORIES_WITH_MANGAS_QUERY: &str = r#"
  query EpigraphCategoryMirror($first: Int!, $offset: Int!) {
    categories(first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes {
        id
        name
        order
        default
        mangas { nodes { id } }
      }
    }
  }
"#;

#[derive(Clone, Debug, PartialEq, Eq)]
struct SuwayomiCategory {
    id: i64,
    name: String,
    order: i64,
    manga_ids: BTreeSet<i64>,
}

#[derive(FromRow)]
struct StoredRow {
    entity_type: String,
    entity_id: String,
    record_json: String,
}

/// Library titles the mirror may assign: Suwayomi manga id plus, when the title has a source
/// identity, its canonical portable comic id (the id a phone uses for titles it adopted).
pub(super) struct LibraryTitle {
    pub manga_id: i64,
    pub portable_comic_id: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn mirror_categories(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    scope_id: &str,
    server_id: &str,
    profile_id: &str,
    library: &[LibraryTitle],
    retention_window: Duration,
) -> anyhow::Result<usize> {
    if suwayomi_projection::pending_projection_count(state).await? > 0 {
        return Ok(0);
    }
    let observed_at_ms = db::now_ms();
    let categories = fetch_categories(state, session).await?;
    let stored = load_stored(state, scope_id).await?;
    // A phone edit may have been queued while Suwayomi was being read.
    if suwayomi_projection::pending_projection_count(state).await? > 0 {
        return Ok(0);
    }
    let plan = plan_category_mirror(server_id, profile_id, &categories, library, &stored);
    if plan.is_empty() {
        return Ok(0);
    }
    let event_clock = EventClock {
        physical_ms: observed_at_ms,
        logical: 0,
        device_generation_id: session.device_id.clone(),
    };
    let mut mirrored = 0usize;
    for (entity_type, entity_id, record) in &plan.merges {
        let _writer_guard = state.mutation_gate.lock().await;
        let outcome = db::apply_mirrored_comic_sync_state_mutation(
            &state.pool,
            session,
            scope_id,
            entity_type,
            entity_id,
            record,
            observed_at_ms,
            Some(&event_clock),
            retention_window,
        )
        .await?;
        if publish(state, &outcome) {
            mirrored += 1;
        }
    }
    for (entity_type, entity_id) in &plan.deletes {
        let _writer_guard = state.mutation_gate.lock().await;
        let outcome = db::delete_mirrored_comic_sync_state_mutation(
            &state.pool,
            session,
            scope_id,
            entity_type,
            entity_id,
            observed_at_ms,
            Some(&event_clock),
            retention_window,
        )
        .await?;
        if publish(state, &outcome) {
            mirrored += 1;
        }
    }
    if mirrored > 0 {
        tracing::debug!(mirrored, "Suwayomi category mirror published changes");
    }
    Ok(mirrored)
}

fn publish(state: &SharedAppState, outcome: &db::CausalMutationWriteOutcome) -> bool {
    match outcome {
        db::CausalMutationWriteOutcome::Applied(applied) => {
            let _ = state.change_sender.send(applied.envelope.clone());
            true
        }
        db::CausalMutationWriteOutcome::Superseded { .. } => false,
    }
}

async fn fetch_categories(
    state: &SharedAppState,
    session: &AuthenticatedSession,
) -> anyhow::Result<Vec<SuwayomiCategory>> {
    let mut categories = Vec::new();
    for page in 0..MAX_CATEGORY_PAGES {
        let offset = (page as i64).saturating_mul(CATEGORY_PAGE_SIZE);
        let data = suwayomi_catalog::execute_graphql_document(
            state,
            session,
            CATEGORIES_WITH_MANGAS_QUERY,
            json!({ "first": CATEGORY_PAGE_SIZE, "offset": offset }),
            false,
        )
        .await
        .map_err(|error| anyhow::anyhow!("category mirror query failed: {error:?}"))?;
        let connection = data
            .get("categories")
            .context("invalid category mirror response")?;
        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .context("invalid category mirror nodes")?;
        categories.extend(nodes.iter().filter_map(parse_category));
        let has_next = connection
            .get("pageInfo")
            .and_then(|value| value.get("hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !has_next {
            return Ok(categories);
        }
    }
    // A partial inventory would turn every unseen category into a delete.
    anyhow::bail!("category mirror page limit reached")
}

/// The default category (id 0) is Suwayomi's "uncategorized" bucket, not a user category.
fn parse_category(node: &Value) -> Option<SuwayomiCategory> {
    let id = node
        .get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0 && *id <= i32::MAX as i64)?;
    if node
        .get("default")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let name = node.get("name").and_then(Value::as_str)?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let manga_ids = node
        .get("mangas")
        .and_then(|value| value.get("nodes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|manga| manga.get("id").and_then(Value::as_i64))
        .filter(|id| *id > 0)
        .collect();
    Some(SuwayomiCategory {
        id,
        name,
        order: node.get("order").and_then(Value::as_i64).unwrap_or(0),
        manga_ids,
    })
}

async fn load_stored(state: &SharedAppState, scope_id: &str) -> anyhow::Result<Vec<StoredRow>> {
    sqlx::query_as::<_, StoredRow>(
        r#"
        SELECT entity_type, entity_id, record_json
        FROM comic_sync_state
        WHERE scope_id = ? AND entity_type IN ('comic.category', 'comic.category_assignment')
        "#,
    )
    .bind(scope_id)
    .fetch_all(&state.pool)
    .await
    .context("failed to load stored comic categories for the category mirror")
}

#[derive(Debug, Default, PartialEq)]
struct CategoryMirrorPlan {
    merges: Vec<(&'static str, String, Value)>,
    deletes: Vec<(&'static str, String)>,
}

impl CategoryMirrorPlan {
    fn is_empty(&self) -> bool {
        self.merges.is_empty() && self.deletes.is_empty()
    }
}

/// Compares Suwayomi with the replica. Only rows the mirror can map back to this server's
/// Suwayomi ids are reconciled; anything else (another server, an unbound portable title) is
/// left untouched.
fn plan_category_mirror(
    server_id: &str,
    profile_id: &str,
    categories: &[SuwayomiCategory],
    library: &[LibraryTitle],
    stored: &[StoredRow],
) -> CategoryMirrorPlan {
    let ids = LegacyIds::new(server_id, profile_id);
    let library_ids = library
        .iter()
        .map(|title| title.manga_id)
        .collect::<HashSet<_>>();
    let portable_to_manga = library
        .iter()
        .filter_map(|title| {
            title
                .portable_comic_id
                .as_ref()
                .map(|id| (id.as_str(), title.manga_id))
        })
        .collect::<HashMap<_, _>>();

    let mut stored_categories = HashMap::<i64, (String, Value)>::new();
    let mut stored_pairs = HashMap::<(i64, i64), Vec<String>>::new();
    for row in stored {
        let Ok(record) = serde_json::from_str::<Value>(&row.record_json) else {
            continue;
        };
        match row.entity_type.as_str() {
            "comic.category" => {
                let category_id = record
                    .get("categoryId")
                    .and_then(Value::as_str)
                    .unwrap_or(&row.entity_id);
                if let Some(id) = ids.category(category_id) {
                    stored_categories.insert(id, (row.entity_id.clone(), record));
                }
            }
            "comic.category_assignment" => {
                let category = record
                    .get("categoryId")
                    .and_then(Value::as_str)
                    .and_then(|id| ids.category(id));
                let manga = record
                    .get("comicId")
                    .and_then(Value::as_str)
                    .and_then(|id| ids.manga(id).or_else(|| portable_to_manga.get(id).copied()));
                if let (Some(manga), Some(category)) = (manga, category) {
                    stored_pairs
                        .entry((manga, category))
                        .or_default()
                        .push(row.entity_id.clone());
                }
            }
            _ => {}
        }
    }

    let mut plan = CategoryMirrorPlan::default();
    let mut live_categories = HashSet::new();
    let mut live_pairs = BTreeMap::<(i64, i64), ()>::new();
    for category in categories {
        live_categories.insert(category.id);
        let category_id = ids.category_id(category.id);
        let record = json!({
            "categoryId": category_id,
            "name": category.name,
            "order": category.order,
        });
        let unchanged = stored_categories
            .get(&category.id)
            .is_some_and(|(_, stored)| {
                stored.get("name").and_then(Value::as_str) == Some(category.name.as_str())
                    && stored.get("order").and_then(Value::as_i64) == Some(category.order)
            });
        if !unchanged {
            let entity_id = stored_categories
                .get(&category.id)
                .map(|(entity_id, _)| entity_id.clone())
                .unwrap_or_else(|| category_id.clone());
            plan.merges.push(("comic.category", entity_id, record));
        }
        for manga_id in category
            .manga_ids
            .iter()
            .filter(|id| library_ids.contains(id))
        {
            live_pairs.insert((*manga_id, category.id), ());
        }
    }
    for (manga_id, category_id) in live_pairs.keys() {
        if stored_pairs.contains_key(&(*manga_id, *category_id)) {
            continue;
        }
        let comic_id = ids.manga_id(*manga_id);
        let category_entity = ids.category_id(*category_id);
        let assignment_id = comic_category_assignment_id(&comic_id, &category_entity);
        plan.merges.push((
            "comic.category_assignment",
            assignment_id.clone(),
            json!({
                "assignmentId": assignment_id,
                "categoryId": category_entity,
                "comicId": comic_id,
            }),
        ));
    }
    let mut stale_assignments = Vec::new();
    for ((manga_id, category_id), entity_ids) in &stored_pairs {
        // A title outside the current library keeps its replica rows; the phone's catalog
        // reconciliation owns library membership.
        if !library_ids.contains(manga_id) || live_pairs.contains_key(&(*manga_id, *category_id)) {
            continue;
        }
        stale_assignments.extend(entity_ids.iter().cloned());
    }
    stale_assignments.sort();
    let mut stale_categories = stored_categories
        .iter()
        .filter(|(category_id, _)| !live_categories.contains(*category_id))
        .map(|(_, (entity_id, _))| entity_id.clone())
        .collect::<Vec<_>>();
    stale_categories.sort();
    plan.deletes.extend(
        stale_assignments
            .into_iter()
            .map(|entity_id| ("comic.category_assignment", entity_id)),
    );
    plan.deletes.extend(
        stale_categories
            .into_iter()
            .map(|entity_id| ("comic.category", entity_id)),
    );
    plan
}

/// Legacy Suwayomi ids, with and without the `server:S:` segment.
struct LegacyIds {
    server_prefix: String,
    bare_prefix: String,
}

impl LegacyIds {
    fn new(server_id: &str, profile_id: &str) -> Self {
        Self {
            server_prefix: format!("suwayomi:server:{server_id}:profile:{profile_id}"),
            bare_prefix: format!("suwayomi:profile:{profile_id}"),
        }
    }

    fn category_id(&self, id: i64) -> String {
        format!("{}:category:{id}", self.server_prefix)
    }

    fn manga_id(&self, id: i64) -> String {
        format!("{}:manga:{id}", self.server_prefix)
    }

    fn category(&self, value: &str) -> Option<i64> {
        self.parse(value, "category")
    }

    fn manga(&self, value: &str) -> Option<i64> {
        self.parse(value, "manga")
    }

    fn parse(&self, value: &str, kind: &str) -> Option<i64> {
        [&self.server_prefix, &self.bare_prefix]
            .into_iter()
            .find_map(|prefix| {
                value
                    .strip_prefix(prefix.as_str())?
                    .strip_prefix(':')?
                    .strip_prefix(kind)?
                    .strip_prefix(':')?
                    .parse::<i64>()
                    .ok()
            })
            .filter(|id| *id > 0)
    }
}

/// Same derivation as the phone and the projection outbox.
fn comic_category_assignment_id(comic_id: &str, category_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(comic_id.as_bytes());
    digest.update([0u8]);
    digest.update(category_id.as_bytes());
    let hex: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{}{hex}", db::COMIC_CATEGORY_ASSIGNMENT_ID_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "s1";

    fn category(id: i64, name: &str, order: i64, mangas: &[i64]) -> SuwayomiCategory {
        SuwayomiCategory {
            id,
            name: name.to_string(),
            order,
            manga_ids: mangas.iter().copied().collect(),
        }
    }

    fn library(ids: &[i64]) -> Vec<LibraryTitle> {
        ids.iter()
            .map(|id| LibraryTitle {
                manga_id: *id,
                portable_comic_id: Some(format!("comic:{id}")),
            })
            .collect()
    }

    fn stored_category(id: i64, name: &str, order: i64) -> StoredRow {
        let category_id = format!("suwayomi:server:{SERVER}:profile:main:category:{id}");
        StoredRow {
            entity_type: "comic.category".to_string(),
            entity_id: category_id.clone(),
            record_json: json!({ "categoryId": category_id, "name": name, "order": order })
                .to_string(),
        }
    }

    fn stored_assignment(comic_id: &str, category: i64) -> StoredRow {
        let category_id = format!("suwayomi:server:{SERVER}:profile:main:category:{category}");
        let assignment_id = comic_category_assignment_id(comic_id, &category_id);
        StoredRow {
            entity_type: "comic.category_assignment".to_string(),
            entity_id: assignment_id.clone(),
            record_json: json!({
                "assignmentId": assignment_id,
                "categoryId": category_id,
                "comicId": comic_id,
            })
            .to_string(),
        }
    }

    fn legacy_manga(id: i64) -> String {
        format!("suwayomi:server:{SERVER}:profile:main:manga:{id}")
    }

    #[test]
    fn parses_categories_and_skips_the_default_bucket() {
        let nodes = json!([
            { "id": 0, "name": "Default", "order": 0, "default": true, "mangas": { "nodes": [] } },
            { "id": 2, "name": " Lendo ", "order": 1, "default": false,
              "mangas": { "nodes": [{ "id": 7 }, { "id": -1 }] } },
            { "id": 3, "name": "", "order": 2, "default": false },
        ]);
        let parsed = nodes
            .as_array()
            .unwrap()
            .iter()
            .filter_map(parse_category)
            .collect::<Vec<_>>();
        assert_eq!(parsed, vec![category(2, "Lendo", 1, &[7])]);
    }

    #[test]
    fn unchanged_replica_needs_no_writes() {
        let plan = plan_category_mirror(
            SERVER,
            "main",
            &[category(1, "Lendo", 1, &[10])],
            &library(&[10]),
            &[
                stored_category(1, "Lendo", 1),
                stored_assignment(&legacy_manga(10), 1),
            ],
        );
        assert!(plan.is_empty(), "{plan:?}");
    }

    #[test]
    fn mirrors_renames_reorders_and_new_assignments() {
        let plan = plan_category_mirror(
            SERVER,
            "main",
            &[category(1, "Reading", 2, &[10, 11, 99])],
            &library(&[10, 11]),
            &[
                stored_category(1, "Lendo", 1),
                stored_assignment(&legacy_manga(10), 1),
            ],
        );
        assert!(plan.deletes.is_empty());
        assert_eq!(plan.merges.len(), 2);
        assert_eq!(plan.merges[0].0, "comic.category");
        assert_eq!(plan.merges[0].2["name"], "Reading");
        assert_eq!(plan.merges[0].2["order"], 2);
        // Title 99 is outside the library and is left to the phone's catalog reconciliation.
        assert_eq!(plan.merges[1].0, "comic.category_assignment");
        assert_eq!(plan.merges[1].2["comicId"], legacy_manga(11));
    }

    #[test]
    fn deletes_removed_categories_and_assignments() {
        let plan = plan_category_mirror(
            SERVER,
            "main",
            &[category(1, "Lendo", 1, &[])],
            &library(&[10, 12]),
            &[
                stored_category(1, "Lendo", 1),
                stored_category(33, "Gone", 3),
                stored_assignment(&legacy_manga(10), 1),
                stored_assignment(&legacy_manga(10), 33),
                // Not in the library: kept.
                stored_assignment(&legacy_manga(50), 1),
            ],
        );
        assert!(plan.merges.is_empty());
        let deleted_types = plan
            .deletes
            .iter()
            .map(|(kind, _)| *kind)
            .collect::<Vec<_>>();
        assert_eq!(
            deleted_types,
            vec![
                "comic.category_assignment",
                "comic.category_assignment",
                "comic.category"
            ]
        );
        assert_eq!(plan.deletes[2].1, stored_category(33, "", 0).entity_id);
    }

    #[test]
    fn portable_assignment_rows_count_as_the_same_pair() {
        let plan = plan_category_mirror(
            SERVER,
            "main",
            &[category(1, "Lendo", 1, &[10])],
            &library(&[10]),
            &[
                stored_category(1, "Lendo", 1),
                stored_assignment("comic:10", 1),
            ],
        );
        assert!(plan.is_empty(), "{plan:?}");
    }

    #[test]
    fn ignores_rows_of_other_servers() {
        let foreign = StoredRow {
            entity_type: "comic.category".to_string(),
            entity_id: "suwayomi:server:other:profile:main:category:5".to_string(),
            record_json: json!({ "categoryId": "suwayomi:server:other:profile:main:category:5", "name": "X", "order": 0 }).to_string(),
        };
        let plan = plan_category_mirror(SERVER, "main", &[], &library(&[]), &[foreign]);
        assert!(plan.is_empty(), "{plan:?}");
    }

    #[test]
    fn assignment_id_matches_projection_derivation() {
        assert_eq!(
            comic_category_assignment_id(
                "suwayomi:profile:main:manga:42",
                "suwayomi:profile:main:category:3",
            ),
            "comic-category-assignment:00c5f18254b2162d827bffb3f61ce9d9d3169ad7ff94970b101ad7273800251f"
        );
    }
}
