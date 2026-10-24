//! Revisions of the comic catalog a paired device applies, announced by `/v1/sync/status` so a
//! device whose last apply carried the same revision can skip reading the catalog again.
//!
//! The progress mirror computes them from the Suwayomi reads it already makes. A write that may
//! change what a revision covers drops it until the next computation, and a computation that
//! started before such a write is discarded. A device that gets no revision applies the catalog
//! in full, so dropping one is always safe; announcing a stale one is not.
//!
//! When a computation stores revisions that differ from the ones last stored for the profile, the
//! profile id goes out on [`subscribe`], so the live event stream can tell devices to read
//! `/v1/sync/status` now instead of on their next check.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use super::models::{AuthenticatedSession, SharedAppState};
use super::routes::{suwayomi_catalog, suwayomi_extensions};

/// Bumped when what a revision covers changes, so devices apply in full once after an update.
const REVISION_SCHEMA: u32 = 1;
/// A revision the mirror has not confirmed for this long is not announced (it ticks every 45 s).
const REVISION_TTL: Duration = Duration::from_secs(180);

const CATEGORIES_QUERY: &str = r#"
  query EpigraphCatalogRevisionCategories {
    categories {
      nodes {
        id
        name
        order
        default
        includeInUpdate
        includeInDownload
        mangas { nodes { id } }
      }
    }
  }
"#;

/// Mutation fields that change only reading progress, downloads, trackers or source browsing:
/// nothing a revision covers. Any other mutation drops the profile's revisions.
const CATALOG_NEUTRAL_MUTATIONS: &[&str] = &[
    "updateChapter",
    "updateChapters",
    "fetchChapterPages",
    "setChapterMeta",
    "deleteChapterMeta",
    "enqueueChapterDownload",
    "enqueueChapterDownloads",
    "dequeueChapterDownload",
    "dequeueChapterDownloads",
    "reorderChapterDownload",
    "startDownloader",
    "stopDownloader",
    "clearDownloader",
    "deleteDownloadedChapter",
    "deleteDownloadedChapters",
    "bindTrack",
    "updateTrack",
    "unbindTrack",
    "trackProgress",
    "fetchTrack",
    "loginTrackerOAuth",
    "loginTrackerCredentials",
    "logoutTracker",
    "fetchSourceManga",
];

/// What a paired device applies from this profile's catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComicRevisions {
    /// Library titles, categories and the extensions behind them: the catalog and manifest stages.
    pub library: String,
    /// Installed extensions and their sources: the extension stage.
    pub extensions: String,
}

/// Taken before reading Suwayomi; a computation is stored only when no write happened since.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Generation {
    epoch: u64,
    profile: u64,
}

struct Entry {
    revisions: ComicRevisions,
    generation: Generation,
    computed_at: Instant,
}

#[derive(Default)]
struct Registry {
    epoch: u64,
    generations: HashMap<String, u64>,
    entries: HashMap<String, Entry>,
    /// The revisions last stored per profile. Unlike `entries`, writes do not drop them, so a
    /// computation that finds the catalog unchanged after a write is not reported as a change.
    last_stored: HashMap<String, ComicRevisions>,
}

impl Registry {
    fn generation(&self, profile_id: &str) -> Generation {
        Generation {
            epoch: self.epoch,
            profile: self.generations.get(profile_id).copied().unwrap_or_default(),
        }
    }

    fn invalidate(&mut self, profile_id: &str) {
        *self.generations.entry(profile_id.to_string()).or_default() += 1;
        self.entries.remove(profile_id);
    }

    fn invalidate_all(&mut self) {
        self.epoch += 1;
        self.entries.clear();
    }

    fn store(&mut self, profile_id: &str, generation: Generation, revisions: ComicRevisions, now: Instant) -> Stored {
        if self.generation(profile_id) != generation {
            return Stored::Discarded;
        }
        let changed = self.last_stored.get(profile_id) != Some(&revisions);
        if changed {
            self.last_stored.insert(profile_id.to_string(), revisions.clone());
        }
        self.entries.insert(
            profile_id.to_string(),
            Entry { revisions, generation, computed_at: now },
        );
        if changed {
            Stored::Changed
        } else {
            Stored::Unchanged
        }
    }

    fn current(&self, profile_id: &str, now: Instant) -> Option<ComicRevisions> {
        self.entries
            .get(profile_id)
            .filter(|entry| entry.generation == self.generation(profile_id))
            .filter(|entry| now.duration_since(entry.computed_at) < REVISION_TTL)
            .map(|entry| entry.revisions.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stored {
    /// A write happened since the computation started.
    Discarded,
    Unchanged,
    Changed,
}

fn changes() -> &'static broadcast::Sender<String> {
    static CHANGES: OnceLock<broadcast::Sender<String>> = OnceLock::new();
    CHANGES.get_or_init(|| broadcast::channel(64).0)
}

/// Profile ids whose stored revisions changed. A receiver that lags has missed some, so it should
/// treat every profile as changed.
pub fn subscribe() -> broadcast::Receiver<String> {
    changes().subscribe()
}

/// Announces a change without a computation, for stream tests.
#[cfg(test)]
pub(crate) fn announce_change_for_test(profile_id: &str) {
    let _ = changes().send(profile_id.to_string());
}

fn registry() -> MutexGuard<'static, Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn generation(profile_id: &str) -> Generation {
    registry().generation(profile_id)
}

/// Drops the profile's revisions after a write that may have changed what they cover.
pub fn invalidate(profile_id: &str) {
    registry().invalidate(profile_id);
}

/// Drops every profile's revisions, for desktop edits that do not say which profile they touched.
pub fn invalidate_all() {
    registry().invalidate_all();
}

/// The revisions to announce for a profile, if a computation since its last write confirmed them.
pub fn current(profile_id: &str) -> Option<ComicRevisions> {
    registry().current(profile_id, Instant::now())
}

/// Whether a Suwayomi mutation document may change a revision; unknown fields count as changes.
pub fn mutation_may_change_catalog(document: &str) -> bool {
    let fields = top_level_fields(document);
    fields.is_empty() || fields.iter().any(|field| !CATALOG_NEUTRAL_MUTATIONS.contains(&field.as_str()))
}

/// Field names selected at the top of a GraphQL operation, aliases resolved.
fn top_level_fields(document: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut braces = 0usize;
    let mut parens = 0usize;
    let mut chars = document.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '#' => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        break;
                    }
                }
            }
            '"' => {
                let mut escaped = false;
                for next in chars.by_ref() {
                    match next {
                        '\\' if !escaped => escaped = true,
                        '"' if !escaped => break,
                        _ => escaped = false,
                    }
                }
            }
            '{' => braces += 1,
            '}' => braces = braces.saturating_sub(1),
            '(' => parens += 1,
            ')' => parens = parens.saturating_sub(1),
            ':' if braces == 1 && parens == 0 => {
                // `alias: field`: the next name is the field.
                fields.pop();
            }
            ch if (ch.is_ascii_alphabetic() || ch == '_') && braces == 1 && parens == 0 => {
                let mut name = String::from(ch);
                while let Some(next) = chars.peek().copied().filter(|c| c.is_ascii_alphanumeric() || *c == '_') {
                    name.push(next);
                    chars.next();
                }
                fields.push(name);
            }
            _ => {}
        }
    }
    fields
}

/// What a paired device applies of one library title (the Core catalog operation's fields),
/// leaving out the unread and download counts that change with every read on the desktop.
pub(super) fn title_input(node: &Value) -> Value {
    json!([
        node.get("id"),
        node.get("url"),
        node.get("sourceId"),
        node.get("title"),
        node.get("thumbnailUrl"),
        node.get("realUrl"),
        node.get("status"),
        node.get("genre"),
        node.get("description"),
        node.get("author"),
        node.get("artist"),
        node.pointer("/chapters/totalCount"),
    ])
}

/// Computes the profile's revisions from the mirror's library read and stores them unless a write
/// happened since `generation` was taken. Any failure drops them instead.
pub(super) async fn record(
    state: &SharedAppState,
    session: &AuthenticatedSession,
    server_id: &str,
    generation: Generation,
    titles: Option<Vec<Value>>,
) {
    let profile_id = session.profile_id.as_str();
    let Some(titles) = titles else {
        invalidate(profile_id);
        return;
    };
    let categories =
        match suwayomi_catalog::execute_graphql_document(state, session, CATEGORIES_QUERY, json!({}), false).await {
            Ok(data) => data.pointer("/categories/nodes").cloned().unwrap_or(Value::Null),
            Err(error) => {
                tracing::debug!(error = ?error, "catalog revision skipped: categories unavailable");
                invalidate(profile_id);
                return;
            }
        };
    let inventory = match suwayomi_extensions::load_inventory(state, session).await {
        Ok(inventory) => inventory,
        Err(error) => {
            tracing::debug!(error = ?error, "catalog revision skipped: extensions unavailable");
            invalidate(profile_id);
            return;
        }
    };
    let extensions = digest(&json!([
        REVISION_SCHEMA,
        server_id,
        profile_id,
        inventory.runtime_fingerprint,
        inventory.extensions,
    ]));
    let revisions = ComicRevisions {
        library: library_revision(server_id, profile_id, titles, &categories, &extensions),
        extensions,
    };
    let stored = registry().store(profile_id, generation, revisions, Instant::now());
    if stored == Stored::Changed {
        // No receiver means no device is streaming; the send has nothing to do then.
        let _ = changes().send(profile_id.to_string());
    }
}

fn library_revision(server_id: &str, profile_id: &str, mut titles: Vec<Value>, categories: &Value, extensions: &str) -> String {
    titles.sort_by_key(|title| title.get(0).and_then(Value::as_i64).unwrap_or_default());
    let mut categories = categories
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .map(|node| {
                    let mut titles = node
                        .pointer("/mangas/nodes")
                        .and_then(Value::as_array)
                        .map(|titles| titles.iter().filter_map(|title| title.get("id").and_then(Value::as_i64)).collect::<Vec<_>>())
                        .unwrap_or_default();
                    titles.sort_unstable();
                    json!([
                        node.get("id"),
                        node.get("name"),
                        node.get("order"),
                        node.get("default"),
                        node.get("includeInUpdate"),
                        node.get("includeInDownload"),
                        titles,
                    ])
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    categories.sort_by_key(|category| category.get(0).and_then(Value::as_i64).unwrap_or_default());
    digest(&json!([REVISION_SCHEMA, server_id, profile_id, titles, categories, extensions]))
}

fn digest(value: &Value) -> String {
    format!("sha256:{:x}", Sha256::digest(serde_json::to_vec(value).unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revisions(library: &str) -> ComicRevisions {
        ComicRevisions { library: library.to_string(), extensions: "e".to_string() }
    }

    #[test]
    fn stores_only_when_no_write_happened_since_the_read_started() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let before_write = registry.generation("p");
        registry.invalidate("p");
        assert_eq!(registry.store("p", before_write, revisions("stale"), now), Stored::Discarded);
        assert_eq!(registry.current("p", now), None);

        let after_write = registry.generation("p");
        assert_eq!(registry.store("p", after_write, revisions("fresh"), now), Stored::Changed);
        assert_eq!(registry.current("p", now), Some(revisions("fresh")));
    }

    #[test]
    fn writes_drop_announced_revisions() {
        let mut registry = Registry::default();
        let now = Instant::now();
        registry.store("p", registry.generation("p"), revisions("a"), now);
        registry.store("q", registry.generation("q"), revisions("b"), now);
        registry.invalidate("p");
        assert_eq!(registry.current("p", now), None);
        assert_eq!(registry.current("q", now), Some(revisions("b")));

        let before_desktop_edit = registry.generation("q");
        registry.invalidate_all();
        assert_eq!(registry.current("q", now), None);
        assert_eq!(registry.store("q", before_desktop_edit, revisions("b"), now), Stored::Discarded);
    }

    #[test]
    fn unconfirmed_revisions_expire() {
        let mut registry = Registry::default();
        let now = Instant::now();
        registry.store("p", registry.generation("p"), revisions("a"), now);
        assert_eq!(registry.current("p", now + REVISION_TTL), None);
    }

    #[test]
    fn reports_a_change_only_when_the_stored_revisions_differ() {
        let mut registry = Registry::default();
        let now = Instant::now();
        assert_eq!(registry.store("p", registry.generation("p"), revisions("a"), now), Stored::Changed);
        assert_eq!(registry.store("p", registry.generation("p"), revisions("a"), now), Stored::Unchanged);

        // A write drops what is announced, but a recomputation that finds the same catalog is not
        // a change devices need to hear about.
        registry.invalidate("p");
        assert_eq!(registry.store("p", registry.generation("p"), revisions("a"), now), Stored::Unchanged);
        registry.invalidate_all();
        assert_eq!(registry.store("p", registry.generation("p"), revisions("b"), now), Stored::Changed);
        assert_eq!(registry.store("q", registry.generation("q"), revisions("b"), now), Stored::Changed);
    }

    #[test]
    fn progress_downloads_and_trackers_keep_the_catalog_revision() {
        for document in [
            "mutation UpdateChaptersProgress($ids: [Int!]!) { updateChapters(input: { ids: $ids, patch: { isRead: true } }) { chapters { id } } }",
            "mutation EpigraphCoreFetchChapterPages($chapterId: Int!) {\n  fetchChapterPages(input: { chapterId: $chapterId }) { pages }\n}",
            "mutation { a: enqueueChapterDownloads(input: { ids: [1] }) { clientMutationId } b: updateTrack(input: { recordId: 1 }) { trackRecord { id } } }",
            "# reading\nmutation Read { updateChapter(input: { id: 1, patch: { lastPageRead: 3 } }) { chapter { id } } }",
        ] {
            assert!(!mutation_may_change_catalog(document), "{document}");
        }
    }

    #[test]
    fn library_category_extension_and_unknown_mutations_drop_the_catalog_revision() {
        for document in [
            "mutation UpdateManga($id: Int!, $inLibrary: Boolean) { updateManga(input: { id: $id, patch: { inLibrary: $inLibrary } }) { manga { id } } }",
            "mutation EpigraphFetchChapters($mangaId: Int!) { fetchChapters(input: { mangaId: $mangaId }) { chapters { id } } }",
            "mutation { updateChapters(input: { ids: [1] }) { clientMutationId } createCategory(input: { name: \"x\" }) { category { id } } }",
            "mutation { updateChapter: updateExtension(input: { id: \"x\" }) { extension { pkgName } } }",
            "mutation Unknown { somethingNew { id } }",
            "",
        ] {
            assert!(mutation_may_change_catalog(document), "{document}");
        }
    }

    #[test]
    fn library_revision_ignores_order_but_not_content() {
        let titles = vec![
            title_input(&json!({ "id": 2, "url": "/b", "sourceId": "1", "title": "B", "unreadCount": 4, "chapters": { "totalCount": 5 } })),
            title_input(&json!({ "id": 1, "url": "/a", "sourceId": "1", "title": "A", "unreadCount": 0, "chapters": { "totalCount": 3 } })),
        ];
        let categories = json!([
            { "id": 2, "name": "Y", "order": 2, "default": false, "includeInUpdate": "UNSET", "includeInDownload": "UNSET", "mangas": { "nodes": [{ "id": 2 }, { "id": 1 }] } },
            { "id": 1, "name": "X", "order": 1, "default": false, "includeInUpdate": "UNSET", "includeInDownload": "UNSET", "mangas": { "nodes": [] } }
        ]);
        let base = library_revision("s", "p", titles.clone(), &categories, "e");
        let mut reordered = titles.clone();
        reordered.reverse();
        let mut reordered_categories = categories.clone();
        reordered_categories.as_array_mut().unwrap().reverse();
        reordered_categories[1]["mangas"]["nodes"].as_array_mut().unwrap().reverse();
        assert_eq!(base, library_revision("s", "p", reordered, &reordered_categories, "e"));

        let read_on_desktop = vec![
            title_input(&json!({ "id": 2, "url": "/b", "sourceId": "1", "title": "B", "unreadCount": 0, "downloadCount": 2, "chapters": { "totalCount": 5 } })),
            titles[1].clone(),
        ];
        assert_eq!(base, library_revision("s", "p", read_on_desktop, &categories, "e"));

        let mut more_chapters = titles.clone();
        more_chapters[0][11] = json!(6);
        assert_ne!(base, library_revision("s", "p", more_chapters, &categories, "e"));
        let mut renamed = categories.clone();
        renamed[0]["name"] = json!("Z");
        assert_ne!(base, library_revision("s", "p", titles.clone(), &renamed, "e"));
        assert_ne!(base, library_revision("s", "p", titles.clone(), &categories, "f"));
        assert_ne!(base, library_revision("other-server", "p", titles, &categories, "e"));
    }
}
