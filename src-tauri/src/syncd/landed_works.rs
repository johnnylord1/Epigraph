//! Which works synced changes just reached in Suwayomi. The desktop window asks for what landed
//! since its last reading and reads only those works, instead of the whole library.
//!
//! It is only a hint for the screen, so it stays in memory and bounded: a window that may have
//! missed an entry (Core restarted, the register overflowed, a change named no work) sees its
//! cursor below `floor` and reads the whole library once.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One sync can touch every work; past this the window reads the whole library anyway.
const MAX_LANDED_WORKS: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandedWork {
    pub profile_id: String,
    pub manga_id: i64,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandedWorksView {
    /// The cursor to ask from next.
    pub sequence: u64,
    /// A cursor below this may have missed works.
    pub floor: u64,
    /// Moves when library membership or categories changed, not when only reading progress did.
    pub catalog_sequence: u64,
    /// Works that landed after the requested cursor, oldest first. Each work appears once.
    #[serde(default)]
    pub works: Vec<LandedWork>,
}

struct LandedWorksRegister {
    sequence: u64,
    floor: u64,
    catalog_sequence: u64,
    works: HashMap<(String, i64), u64>,
    capacity: usize,
}

impl LandedWorksRegister {
    /// `start` is above every sequence of an earlier run, so a window that outlived Core notices.
    fn new(start: u64, capacity: usize) -> Self {
        Self {
            sequence: start,
            floor: start,
            catalog_sequence: start,
            works: HashMap::new(),
            capacity,
        }
    }

    fn advance(&mut self, catalog: bool) -> u64 {
        self.sequence += 1;
        if catalog {
            self.catalog_sequence = self.sequence;
        }
        self.sequence
    }

    fn record(&mut self, profile_id: &str, manga_id: i64, catalog: bool) {
        let sequence = self.advance(catalog);
        self.works.insert((profile_id.to_string(), manga_id), sequence);
        if self.works.len() > self.capacity {
            let oldest = self
                .works
                .iter()
                .min_by_key(|(_, sequence)| **sequence)
                .map(|(key, sequence)| (key.clone(), *sequence));
            if let Some((key, sequence)) = oldest {
                self.works.remove(&key);
                self.floor = self.floor.max(sequence);
            }
        }
    }

    /// A change this register cannot name a work for.
    fn record_unknown(&mut self, catalog: bool) {
        self.floor = self.advance(catalog);
    }

    fn view(&self, since: Option<u64>) -> LandedWorksView {
        let mut works: Vec<LandedWork> = since
            .map(|since| {
                self.works
                    .iter()
                    .filter(|(_, sequence)| **sequence > since)
                    .map(|((profile_id, manga_id), sequence)| LandedWork {
                        profile_id: profile_id.clone(),
                        manga_id: *manga_id,
                        sequence: *sequence,
                    })
                    .collect()
            })
            .unwrap_or_default();
        works.sort_by_key(|work| work.sequence);
        LandedWorksView {
            sequence: self.sequence,
            floor: self.floor,
            catalog_sequence: self.catalog_sequence,
            works,
        }
    }
}

static REGISTER: LazyLock<Mutex<LandedWorksRegister>> = LazyLock::new(|| {
    let start = u64::try_from(super::db::now_ms()).unwrap_or(0);
    Mutex::new(LandedWorksRegister::new(start, MAX_LANDED_WORKS))
});

fn with_register<T>(action: impl FnOnce(&mut LandedWorksRegister) -> T) -> T {
    let mut register = REGISTER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    action(&mut register)
}

/// A work whose details or chapter list changed, without touching library membership.
pub fn record_work(profile_id: &str, manga_id: i64) {
    with_register(|register| register.record(profile_id, manga_id, false));
}

/// A projection Suwayomi confirmed, with its resolved variables.
pub fn record_projection(profile_id: &str, operation: &str, variables: &Value) {
    let landing = projection_landing(operation, variables);
    with_register(|register| match landing {
        Landing::Work { manga_id, catalog } => register.record(profile_id, manga_id, catalog),
        Landing::Categories => {
            register.advance(true);
        }
        Landing::Unknown { catalog } => register.record_unknown(catalog),
    });
}

pub fn view(since: Option<u64>) -> LandedWorksView {
    with_register(|register| register.view(since))
}

#[derive(Debug, PartialEq, Eq)]
enum Landing {
    Work { manga_id: i64, catalog: bool },
    /// Categories changed, which no work's own fields show.
    Categories,
    Unknown { catalog: bool },
}

fn projection_landing(operation: &str, variables: &Value) -> Landing {
    let (field, catalog) = match operation {
        "UpdateManga" => ("id", true),
        "UpdateMangaCategories" => ("mangaId", true),
        "UpdateChaptersProgress" => ("mangaId", false),
        "UpdateCategory" | "DeleteCategory" | "UpdateCategoryOrder" => return Landing::Categories,
        _ => return Landing::Unknown { catalog: true },
    };
    match variables.get(field).and_then(Value::as_i64).filter(|id| *id > 0) {
        Some(manga_id) => Landing::Work { manga_id, catalog },
        None => Landing::Unknown { catalog },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manga_ids(view: &LandedWorksView) -> Vec<i64> {
        view.works.iter().map(|work| work.manga_id).collect()
    }

    #[test]
    fn many_changes_to_one_work_collapse_into_its_latest() {
        let mut register = LandedWorksRegister::new(100, 8);
        register.record("p", 7, false);
        register.record("p", 9, false);
        register.record("p", 7, false);
        let view = register.view(Some(100));
        assert_eq!(manga_ids(&view), [9, 7]);
        assert_eq!(view.sequence, 103);
        assert_eq!(view.works[1].sequence, 103);
    }

    #[test]
    fn answers_only_what_landed_after_the_cursor() {
        let mut register = LandedWorksRegister::new(100, 8);
        register.record("p", 1, false);
        let cursor = register.view(None).sequence;
        register.record("p", 2, false);
        assert_eq!(manga_ids(&register.view(Some(cursor))), [2]);
        assert!(register.view(Some(register.sequence)).works.is_empty());
        // Without a cursor it only reports where it stands, for the callers that just want counts.
        assert!(register.view(None).works.is_empty());
    }

    #[test]
    fn overflow_raises_the_floor_to_what_it_dropped() {
        let mut register = LandedWorksRegister::new(100, 2);
        register.record("p", 1, false);
        register.record("p", 2, false);
        assert_eq!(register.view(None).floor, 100);
        register.record("p", 3, false);
        let view = register.view(Some(100));
        assert_eq!(view.floor, 101);
        assert_eq!(manga_ids(&view), [2, 3]);
        // A window that had already seen the dropped work is not sent to a full read.
        assert!(register.view(Some(101)).floor <= 101);
    }

    #[test]
    fn a_change_naming_no_work_raises_the_floor_past_every_cursor() {
        let mut register = LandedWorksRegister::new(100, 8);
        register.record_unknown(false);
        let view = register.view(Some(100));
        assert_eq!(view.floor, 101);
        assert_eq!(view.sequence, 101);
        assert_eq!(view.catalog_sequence, 100);
    }

    #[test]
    fn only_catalog_changes_move_the_catalog_sequence() {
        let mut register = LandedWorksRegister::new(100, 8);
        register.record("p", 1, false);
        assert_eq!(register.view(None).catalog_sequence, 100);
        register.record("p", 1, true);
        assert_eq!(register.view(None).catalog_sequence, 102);
    }

    #[test]
    fn names_the_work_each_projection_changes() {
        let work = |manga_id, catalog| Landing::Work { manga_id, catalog };
        assert_eq!(
            projection_landing("UpdateManga", &json!({ "id": 5, "inLibrary": true })),
            work(5, true)
        );
        assert_eq!(
            projection_landing("UpdateMangaCategories", &json!({ "mangaId": 6 })),
            work(6, true)
        );
        assert_eq!(
            projection_landing("UpdateChaptersProgress", &json!({ "mangaId": 8, "ids": [90] })),
            work(8, false)
        );
        assert_eq!(projection_landing("DeleteCategory", &json!({ "id": 3 })), Landing::Categories);
        assert_eq!(
            projection_landing("UpdateChaptersProgress", &json!({ "ids": [90] })),
            Landing::Unknown { catalog: false }
        );
        assert_eq!(
            projection_landing("SomethingNew", &json!({})),
            Landing::Unknown { catalog: true }
        );
    }

    #[test]
    fn the_view_keeps_its_wire_names() {
        let mut register = LandedWorksRegister::new(100, 8);
        register.record("p", 1, true);
        assert_eq!(
            serde_json::to_value(register.view(Some(100))).unwrap(),
            json!({
                "sequence": 101,
                "floor": 100,
                "catalogSequence": 101,
                "works": [{ "profileId": "p", "mangaId": 1, "sequence": 101 }],
            })
        );
    }
}
