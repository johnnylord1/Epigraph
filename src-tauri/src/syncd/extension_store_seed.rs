//! Applies extension stores supplied explicitly by the Core operator.
//!
//! The desktop UI and the headless Core keep separate Suwayomi profiles, and extension
//! store configuration only changed through the UI. An operator may mirror that
//! configuration into a persistent headless Core through the environment. No public
//! repository is selected or recommended by Epigraph itself.

use std::path::{Path, PathBuf};

const CONF_KEY: &str = "server.extensionStores";

/// Resolves the active managed profile root. Mirrors the layout used by the owned
/// Suwayomi supervisor (`%APPDATA%\<profile>`), overridable for tests and unusual
/// deployments through `EPIGRAPH_SYNCD_SUWAYOMI_ROOT`, then follows the root the Core
/// spawns its main instance with (`EPIGRAPH_LOCAL_SERVER_MAIN_ROOT`).
pub fn active_profile_root() -> PathBuf {
    if let Some(root) = std::env::var_os("EPIGRAPH_SYNCD_SUWAYOMI_ROOT")
        .or_else(|| std::env::var_os("EPIGRAPH_LOCAL_SERVER_MAIN_ROOT"))
    {
        return PathBuf::from(root);
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| dirs::data_dir())
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("epigraph-main")
}

fn parse_store_list(contents: &str) -> Vec<String> {
    let Some(start) = contents.find(&format!("{CONF_KEY} = [")) else {
        return Vec::new();
    };
    let after_key = &contents[start + CONF_KEY.len() + 3..];
    let Some(end) = after_key.find(']') else {
        return Vec::new();
    };
    after_key[..end]
        .split('"')
        .filter(|part| part.starts_with("http"))
        .map(str::to_string)
        .collect()
}

fn canonical(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Appends missing desired stores to the profile's `server.conf`. Returns the effective
/// list after seeding. Never removes entries. When the key is absent (fresh profile or a
/// Suwayomi rewrite), the list block is created from scratch.
pub fn ensure_extension_stores(root_dir: &Path, desired: &[String]) -> anyhow::Result<Vec<String>> {
    let conf_path = root_dir.join("server.conf");
    let contents = std::fs::read_to_string(&conf_path)?;

    let mut current = parse_store_list(&contents);
    let mut added = false;
    for url in desired {
        let target = canonical(url);
        if target.is_empty() {
            continue;
        }
        if !current.iter().any(|existing| canonical(existing) == target) {
            current.push(target);
            added = true;
        }
    }
    if !added && contents.contains(CONF_KEY) {
        return Ok(current);
    }

    let serialized_list = current
        .iter()
        .map(|url| format!("    \"{url}\","))
        .collect::<Vec<_>>()
        .join("\n");
    let patched = if contents.contains(CONF_KEY) {
        let start = contents
            .find(&format!("{CONF_KEY} = ["))
            .ok_or_else(|| anyhow::anyhow!("extension store list disappeared while seeding"))?;
        let list_start = contents[start..].find('[').expect("key implies list") + start;
        let list_end = contents[list_start..]
            .find(']')
            .expect("parse validated list bounds")
            + list_start;
        format!(
            "{}[\n{}\n{}",
            &contents[..list_start],
            serialized_list,
            &contents[list_end..]
        )
    } else {
        let mut trimmed = contents.trim_end().to_string();
        if !trimmed.is_empty() {
            trimmed.push_str("\n\n");
        }
        format!("{trimmed}{CONF_KEY} = [\n{serialized_list}\n]\n")
    };
    std::fs::write(&conf_path, patched)?;
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "server.ip = \"127.0.0.1\"\nserver.extensionStores = [\n    \"https://github.com/keiyoushi/extensions/raw/repo/index.pb\",\n] # default: []\n";

    #[test]
    fn seeds_missing_stores_and_preserves_existing_order() {
        let temp = tempfile::tempdir().unwrap();
        let conf = temp.path().join("server.conf");
        std::fs::write(&conf, SAMPLE).unwrap();
        let effective = ensure_extension_stores(
            temp.path(),
            &[
                "https://github.com/keiyoushi/extensions/raw/repo/index.pb".to_string(),
                "https://raw.githubusercontent.com/riztard/tachiyomi-extensions/repo/repo.json"
                    .to_string(),
            ],
        )
        .unwrap();
        assert_eq!(effective.len(), 2);
        let patched = std::fs::read_to_string(&conf).unwrap();
        assert!(patched.contains("riztard"));
        assert!(patched.contains("# default: []"));
    }

    #[test]
    fn is_idempotent_and_ignores_trailing_slashes() {
        let temp = tempfile::tempdir().unwrap();
        let conf = temp.path().join("server.conf");
        std::fs::write(&conf, SAMPLE).unwrap();
        ensure_extension_stores(
            temp.path(),
            &["https://github.com/keiyoushi/extensions/raw/repo/index.pb/".to_string()],
        )
        .unwrap();
        let before = std::fs::read_to_string(&conf).unwrap();
        ensure_extension_stores(
            temp.path(),
            &["https://github.com/keiyoushi/extensions/raw/repo/index.pb".to_string()],
        )
        .unwrap();
        assert_eq!(before, std::fs::read_to_string(&conf).unwrap());
    }

    #[test]
    fn creates_the_list_block_when_the_key_is_absent() {
        let temp = tempfile::tempdir().unwrap();
        let conf = temp.path().join("server.conf");
        std::fs::write(&conf, "server.ip = \"127.0.0.1\"\n").unwrap();
        let store = "https://store.example/index.pb";
        let effective = ensure_extension_stores(temp.path(), &[store.to_string()]).unwrap();
        assert_eq!(effective, vec![store]);
        let patched = std::fs::read_to_string(&conf).unwrap();
        assert!(patched.contains(CONF_KEY));
        assert!(patched.contains(store));
        assert!(patched.contains("server.ip = \"127.0.0.1\""));
    }
}
