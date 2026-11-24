//! Local book/novel storage. The Tauri commands still exchange library documents with the UI.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{Map, Value};

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS library_fields (
        name TEXT PRIMARY KEY,
        scalar_json TEXT
    );
    CREATE TABLE IF NOT EXISTS library_items (
        field TEXT NOT NULL REFERENCES library_fields(name) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(field, ordinal)
    );
    CREATE TABLE IF NOT EXISTS library_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1)
    );
";

pub(crate) fn database_path(legacy: &Path) -> PathBuf {
    legacy.with_extension("sqlite3")
}

pub(crate) fn load(legacy: &Path) -> Result<Option<String>, String> {
    let path = database_path(legacy);
    if !path.exists() && !legacy.exists() {
        return Ok(None);
    }
    let mut database = open(&path)?;
    migrate_if_needed(&mut database, legacy)?;
    let transaction = database.transaction().map_err(message)?;
    let document = read_document(&transaction)?;
    transaction.commit().map_err(message)?;
    document
        .map(|document| serde_json::to_string(&document).map_err(message))
        .transpose()
}

/// Writes the new document and returns the preceding snapshot from the same transaction.
pub(crate) fn save(legacy: &Path, contents: &str) -> Result<Option<String>, String> {
    let document = parse_document(contents)?;
    let mut database = open(&database_path(legacy))?;
    let transaction = database
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(message)?;
    initialize_document(&transaction, legacy)?;
    let previous = read_document(&transaction)?
        .map(|previous| serde_json::to_string(&previous).map_err(message))
        .transpose()?;
    write_document(&transaction, &document)?;
    transaction.commit().map_err(message)?;
    Ok(previous)
}

pub(crate) fn save_if_current(
    legacy: &Path,
    expected: &Map<String, Value>,
    contents: &str,
) -> Result<bool, String> {
    let document = parse_document(contents)?;
    let mut database = open(&database_path(legacy))?;
    let transaction = database
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(message)?;
    initialize_document(&transaction, legacy)?;
    if read_document(&transaction)?.as_ref() != Some(expected) {
        return Ok(false);
    }
    write_document(&transaction, &document)?;
    transaction.commit().map_err(message)?;
    Ok(true)
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(message)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(message)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(message)?;
    connection.execute_batch(SCHEMA).map_err(message)?;
    Ok(connection)
}

fn migrate_if_needed(connection: &mut Connection, legacy: &Path) -> Result<(), String> {
    if initialized(connection)? || !legacy.exists() {
        return Ok(());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(message)?;
    initialize_document(&transaction, legacy)?;
    transaction.commit().map_err(message)
}

fn initialized(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM library_state WHERE singleton = 1",
            [],
            |_| Ok(()),
        )
        .optional()
        .map(|state| state.is_some())
        .map_err(message)
}

fn initialize_document(transaction: &Transaction<'_>, legacy: &Path) -> Result<(), String> {
    if initialized(transaction)? {
        return Ok(());
    }
    let contents = match std::fs::read_to_string(legacy) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(message(error)),
    };
    write_document(transaction, &parse_document(&contents)?)
}

fn parse_document(contents: &str) -> Result<Map<String, Value>, String> {
    match serde_json::from_str(contents) {
        Ok(Value::Object(document)) => Ok(document),
        _ => Err("RESTORE_LIBRARY_INVALID_JSON".into()),
    }
}

fn read_document(connection: &Connection) -> Result<Option<Map<String, Value>>, String> {
    if !initialized(connection)? {
        return Ok(None);
    }
    let mut document = Map::new();
    let mut fields = connection
        .prepare("SELECT name, scalar_json FROM library_fields")
        .map_err(message)?;
    let pairs = fields
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(message)?;
    for pair in pairs {
        let (name, json) = pair.map_err(message)?;
        let value = match json {
            Some(json) => serde_json::from_str(&json).map_err(message)?,
            None => Value::Array(Vec::new()),
        };
        document.insert(name, value);
    }
    let mut items = connection
        .prepare("SELECT field, payload_json FROM library_items ORDER BY field, ordinal")
        .map_err(message)?;
    let records = items
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(message)?;
    for record in records {
        let (field, payload) = record.map_err(message)?;
        let values = document
            .get_mut(&field)
            .and_then(Value::as_array_mut)
            .ok_or("Invalid SQLite library rows")?;
        values.push(serde_json::from_str(&payload).map_err(message)?);
    }
    Ok(Some(document))
}

fn write_document(
    transaction: &Transaction<'_>,
    document: &Map<String, Value>,
) -> Result<(), String> {
    let mut names = transaction
        .prepare("SELECT name FROM library_fields")
        .map_err(message)?;
    let old = names
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(message)?;
    for name in old {
        let name = name.map_err(message)?;
        if !document.contains_key(&name) {
            transaction
                .execute("DELETE FROM library_fields WHERE name = ?", [name])
                .map_err(message)?;
        }
    }

    let mut field = transaction
        .prepare(
            "INSERT INTO library_fields (name, scalar_json) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET scalar_json = excluded.scalar_json
         WHERE scalar_json IS NOT excluded.scalar_json",
        )
        .map_err(message)?;
    let mut item = transaction
        .prepare(
            "INSERT INTO library_items (field, ordinal, payload_json) VALUES (?, ?, ?)
         ON CONFLICT(field, ordinal) DO UPDATE SET payload_json = excluded.payload_json
         WHERE payload_json <> excluded.payload_json",
        )
        .map_err(message)?;
    let mut truncate = transaction
        .prepare("DELETE FROM library_items WHERE field = ? AND ordinal >= ?")
        .map_err(message)?;
    for (name, value) in document {
        let array = value.as_array();
        let scalar = array
            .is_none()
            .then(|| serde_json::to_string(value))
            .transpose()
            .map_err(message)?;
        field.execute(params![name, scalar]).map_err(message)?;
        for (index, value) in array.into_iter().flatten().enumerate() {
            let payload = serde_json::to_string(value).map_err(message)?;
            item.execute(params![name, index as i64, payload])
                .map_err(message)?;
        }
        truncate
            .execute(params![name, array.map_or(0, |items| items.len() as i64)])
            .map_err(message)?;
    }
    transaction
        .execute(
            "INSERT OR IGNORE INTO library_state (singleton) VALUES (1)",
            [],
        )
        .map_err(message)?;
    Ok(())
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn migrates_existing_library_once_and_keeps_profiles_isolated() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main.json");
        let other = temp.path().join("other.json");
        let original = r#"{"entries":[{"id":"original"}],"unknown":null}"#;
        std::fs::write(&main, original).unwrap();
        let stored = load(&main).unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&stored).unwrap(),
            serde_json::from_str::<Value>(original).unwrap()
        );
        assert!(load(&other).unwrap().is_none());

        let current = json!({"entries": [], "progress": [{"percent": 0.2}]});
        assert_eq!(save(&main, &current.to_string()).unwrap().unwrap(), stored);
        assert_eq!(
            serde_json::from_str::<Value>(&load(&main).unwrap().unwrap()).unwrap(),
            current
        );
        assert_eq!(std::fs::read_to_string(&main).unwrap(), original);
        assert!(load(&other).unwrap().is_none());
    }

    #[test]
    fn invalid_or_partial_replacement_leaves_last_committed_document() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("books.json");
        let valid = r#"{"books":[{"id":"first"},{"id":"second"}],"bookmarks":[]}"#;
        assert!(save(&legacy, valid).unwrap().is_none());
        assert!(save(&legacy, "{invalid").is_err());
        assert_eq!(
            serde_json::from_str::<Value>(&load(&legacy).unwrap().unwrap()).unwrap(),
            serde_json::from_str::<Value>(valid).unwrap()
        );
        let next = json!({"books": [{"id": "second"}]});
        save(&legacy, &next.to_string()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&load(&legacy).unwrap().unwrap()).unwrap(),
            next
        );
    }

    #[test]
    fn repair_accepts_pretty_frontend_json_and_preserves_a_concurrent_write() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("books.json");
        let frontend = "{\n  \"books\": [\n    {\"id\":\"book\"}\n  ]\n}";
        save(&path, frontend).unwrap();
        let expected = parse_document(frontend).unwrap();
        let repaired = r#"{"books":[{"id":"book"}],"bookHistory":[{"id":"visit"}]}"#;
        assert!(save_if_current(&path, &expected, repaired).unwrap());
        let later = r#"{"books":[{"id":"later"}]}"#;
        save(&path, later).unwrap();
        assert!(!save_if_current(&path, &expected, repaired).unwrap());
        assert_eq!(
            parse_document(&load(&path).unwrap().unwrap()).unwrap(),
            parse_document(later).unwrap()
        );
    }
}
